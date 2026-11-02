import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PublicStreamRecord, StreamBroker } from "../../server-sdk/core/src/streamBroker.js";
import { ObservationHub } from "../../server-sdk/core/src/http/observations.js";
import { tempDirectory } from "../helpers.js";

class FakeStreams extends EventEmitter {
  files = new Map<string, string>();
  file(streamId: string): string | undefined { return this.files.get(streamId); }
}

describe("ObservationHub", () => {
  it("deduplicates frames and preserves capture timing and checksums", () => {
    const hub = new ObservationHub(undefined, 1024, 10, () => 123.5);
    const bytes = Buffer.from("frame");
    const first = hub.publish("dev_observation01", "str_observation01", 0, bytes, "image/jpeg", 120, 119);
    const duplicate = hub.publish("dev_observation01", "str_observation01", 0, bytes, "image/jpeg", 120, 119);

    expect(duplicate).toBe(first);
    expect(first).toMatchObject({
      cursor_sequence: 1,
      captured_at_s: 120,
      source_time_s: 119,
      received_at_s: 123.5,
      time_basis: "device_capture",
      data_base64: bytes.toString("base64")
    });
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(hub.read("dev_observation01", 0).frames).toHaveLength(1);
  });

  it("isolates devices, validates cursors, and resets a changed epoch", () => {
    const hub = new ObservationHub();
    hub.publish("dev_observation01", "str_observation01", 0, Buffer.from("one"), "image/png");
    hub.publish("dev_observation02", "str_observation02", 0, Buffer.from("two"), "image/webp");

    expect(hub.read("dev_observation01", 0).frames.map(frame => frame.device_id))
      .toEqual(["dev_observation01"]);
    expect(hub.read("dev_observation02", 0).frames.map(frame => frame.device_id))
      .toEqual(["dev_observation02"]);
    expect(hub.read("dev_observation01", 2, "old-epoch")).toMatchObject({ gap: true });
    expect(hub.read("dev_observation01", 2, hub.epoch)).toMatchObject({ gap: false, frames: [] });
    expect(() => hub.read("dev_observation01", -1)).toThrow("invalid_cursor");
    expect(() => hub.read("dev_observation01", 1.5)).toThrow("invalid_cursor");
  });

  it("evicts old rows by count or bytes and reports cursor gaps", () => {
    const byRows = new ObservationHub(undefined, 1024, 2);
    for (let sequence = 0; sequence < 3; sequence++) {
      byRows.publish("dev_observation01", "str_observation01", sequence, Buffer.from(String(sequence)), "image/jpeg");
    }
    expect(byRows.read("dev_observation01", 1)).toMatchObject({
      oldest_sequence: 2,
      gap: false
    });
    expect(byRows.read("dev_observation01", 0).frames.map(frame => frame.sequence)).toEqual([1, 2]);

    const byBytes = new ObservationHub(undefined, 5, 10);
    byBytes.publish("dev_observation01", "str_observation01", 0, Buffer.from("123"), "image/jpeg");
    byBytes.publish("dev_observation01", "str_observation01", 1, Buffer.from("456"), "image/jpeg");
    expect(byBytes.read("dev_observation01", 0).frames.map(frame => frame.sequence)).toEqual([1]);
    byBytes.publish("dev_observation01", "str_observation01", 2, Buffer.from("789"), "image/jpeg");
    expect(byBytes.read("dev_observation01", 1)).toMatchObject({ oldest_sequence: 3, gap: true });
  });

  it("rejects invalid observations and caps a response at 16 MiB", () => {
    const hub = new ObservationHub(undefined, 40 * 1024 * 1024, 10);
    expect(() => hub.publish("dev_observation01", "str_observation01", -1, Buffer.from("x"), "image/png"))
      .toThrow("invalid_observation");
    expect(() => hub.publish("dev_observation01", "str_observation01", 0, Buffer.from("x"), "text/plain"))
      .toThrow("invalid_observation");
    expect(() => hub.publish("dev_observation01", "str_observation01", 0, Buffer.alloc(10 * 1024 * 1024 + 1), "image/png"))
      .toThrow("invalid_observation");
    expect(() => hub.publish("dev_observation01", "str_observation01", 0, Buffer.from("x"), "image/png", Number.NaN))
      .toThrow("invalid_observation");

    hub.publish("dev_observation01", "str_observation01", 0, Buffer.alloc(9 * 1024 * 1024), "image/jpeg");
    hub.publish("dev_observation01", "str_observation01", 1, Buffer.alloc(9 * 1024 * 1024, 1), "image/jpeg");
    expect(hub.read("dev_observation01", 0).frames).toHaveLength(1);
  });

  it("consumes stream events, counts rejected frames, and removes listeners", () => {
    const directory = tempDirectory("gelato-observations-");
    const streams = new FakeStreams();
    const hub = new ObservationHub(streams as unknown as StreamBroker);
    const file = join(directory.path, "frame.jpg");
    writeFileSync(file, "complete-frame");
    streams.files.set("str_complete0001", file);

    streams.emit("media.chunk", {
      deviceId: "dev_observation01", streamId: "str_liveframe001", sequence: 0,
      payload: Buffer.from("live"), contentType: "image/jpeg",
      observationFraming: "image-per-message.v1", capturedAtS: 10, sourceTimeS: 9
    });
    streams.emit("media.chunk", {
      deviceId: "dev_observation01", streamId: "str_badframe0001", sequence: -1,
      payload: Buffer.from("bad"), contentType: "video/h264"
    });
    streams.files.set("str_missingfile001", join(directory.path, "missing.jpg"));
    streams.emit("complete", {
      streamId: "str_missingfile001", deviceId: "dev_observation01", agentId: "agt_observation01",
      direction: "agent-to-controller", purpose: "photo", contentType: "image/jpeg",
      maxFrameBytes: 1024, maxTotalBytes: 1024, state: "complete",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      bytesReceived: 1, framesReceived: 1, nextSequence: 1
    } satisfies PublicStreamRecord);
    streams.emit("complete", {
      streamId: "str_complete0001", deviceId: "dev_observation01", agentId: "agt_observation01",
      direction: "agent-to-controller", purpose: "photo", contentType: "image/jpeg",
      maxFrameBytes: 1024, maxTotalBytes: 1024, state: "complete",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      bytesReceived: 14, framesReceived: 1, nextSequence: 1,
      metadata: { capturedAtS: 11 }
    } satisfies PublicStreamRecord);

    expect(hub.read("dev_observation01", 0)).toMatchObject({
      rejected_observations: 2,
      frames: [{ sequence: 0 }, { sequence: 0 }]
    });
    expect(streams.listenerCount("media.chunk")).toBe(1);
    hub.close();
    expect(streams.listenerCount("media.chunk")).toBe(0);
    expect(streams.listenerCount("complete")).toBe(0);
    directory.cleanup();
  });
});
