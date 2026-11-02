import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { DeviceAgentPairingService } from "../../server-sdk/core/src/pairingService.js";
import { StreamBroker } from "../../server-sdk/core/src/streamBroker.js";
import { DeviceControlPausedError } from "../../server-sdk/core/src/capabilityRouter.js";
import { descriptor, message, tempDirectory } from "../helpers.js";

class FakeStreamSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  readonly sent: Record<string, unknown>[] = [];
  readonly send = vi.fn((value: string) => this.sent.push(JSON.parse(value) as Record<string, unknown>));
  readonly pause = vi.fn();
  readonly resume = vi.fn();
  readonly close = vi.fn((code?: number, reason?: string) => {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit("close", code, Buffer.from(reason ?? ""));
  });
}

describe("StreamBroker", () => {
  let directory: ReturnType<typeof tempDirectory>;
  let pairing: DeviceAgentPairingService;
  let broker: StreamBroker;
  let identity: { agentId: string; deviceId: string; credential: string };

  beforeEach(() => {
    directory = tempDirectory("gelato-stream-");
    pairing = new DeviceAgentPairingService(join(directory.path, "pairings.json"));
    const session = pairing.createSession({ controllerUrl: "https://controller.test" });
    const paired = pairing.pair(session.code, descriptor);
    identity = { agentId: paired.agentId!, deviceId: paired.deviceId!, credential: paired.credential! };
    broker = new StreamBroker(pairing, join(directory.path, "media"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    directory.cleanup();
  });

  const offerBody = (overrides: Record<string, unknown> = {}) => ({
    streamId: "str_teststream001",
    purpose: "file",
    direction: "agent-to-controller",
    contentType: "application/octet-stream",
    maxFrameBytes: 1024,
    maxTotalBytes: 4096,
    ...overrides
  });

  async function openUpload(overrides: Record<string, unknown> = {}) {
    const body = offerBody(overrides);
    broker.offer(identity.agentId, identity.deviceId, message("stream.offer", body, {
      deviceId: identity.deviceId
    }));
    const socket = new FakeStreamSocket();
    broker.attach(String(body.streamId), socket as unknown as WebSocket, {
      headers: { authorization: `Bearer ${identity.credential}`, "x-agent-id": identity.agentId }
    } as never);
    await vi.waitFor(() => expect(socket.sent.some(value => value.type === "stream.ready")).toBe(true));
    return { socket, streamId: String(body.streamId) };
  }

  function frame(sequence: number, payload: Buffer): Buffer {
    const value = Buffer.alloc(4 + payload.length);
    value.writeUInt32BE(sequence);
    payload.copy(value, 4);
    return value;
  }

  it("registers bounded upload offers and rejects duplicates", () => {
    const offered = broker.offer(identity.agentId, identity.deviceId, message("stream.offer", offerBody(), {
      deviceId: identity.deviceId
    }));
    expect(offered).toMatchObject({ state: "offered", bytesReceived: 0, framesReceived: 0 });
    expect(broker.list(identity.deviceId)).toHaveLength(1);
    expect(() => broker.offer(identity.agentId, identity.deviceId,
      message("stream.offer", offerBody(), { deviceId: identity.deviceId }))).toThrow(/already exists/);
  });

  it.each([
    [{ streamId: "bad" }, /streamId/],
    [{ streamId: "str_teststream002", direction: "controller-to-agent" }, /uploads/],
    [{ streamId: "str_teststream003", purpose: "invalid" }, /purpose/],
    [{ streamId: "str_teststream004", maxFrameBytes: 0 }, /maxFrameBytes/],
    [{ streamId: "str_teststream005", maxTotalBytes: 134_217_729 }, /maxTotalBytes/]
  ] as const)("rejects malformed offer %#", (overrides, error) => {
    expect(() => broker.offer(identity.agentId, identity.deviceId,
      message("stream.offer", offerBody(overrides), { deviceId: identity.deviceId }))).toThrow(error);
  });

  it("creates authenticated private downloads and marks completion", () => {
    const completed = vi.fn();
    broker.on("complete", completed);
    const offered = broker.offerDownload(identity.agentId, identity.deviceId, Buffer.from("hello"), {
      purpose: "audio",
      contentType: "audio/pcm",
      maxFrameBytes: 2
    });
    expect(offered.agentPath).toBe(`/agent/streams/${offered.streamId}/content`);
    expect(broker.openAgentDownload(offered.streamId, identity.deviceId, identity.agentId, "wrong"))
      .toBeUndefined();
    const download = broker.openAgentDownload(
      offered.streamId,
      identity.deviceId,
      identity.agentId,
      identity.credential
    );
    expect(download?.filePath).toContain(offered.streamId);
    broker.completeAgentDownload(offered.streamId);
    expect(broker.get(offered.streamId)).toMatchObject({ state: "complete", bytesReceived: 5, framesReceived: 3 });
    expect(completed).toHaveBeenCalledOnce();
    expect(broker.file(offered.streamId)).toBeUndefined();
    expect(broker.openAgentDownload(offered.streamId, "dev_wrongdevice01", identity.agentId, identity.credential))
      .toBeUndefined();
    broker.completeAgentDownload("str_missingstream01");
  });

  it("validates controller-to-agent payload options", () => {
    expect(() => broker.offerDownload(identity.agentId, identity.deviceId, Buffer.alloc(0), {
      purpose: "file",
      contentType: "application/octet-stream"
    })).toThrow(/payload size/);
    expect(() => broker.offerDownload(identity.agentId, identity.deviceId, Buffer.from("x"), {
      purpose: "invalid" as never,
      contentType: "application/octet-stream"
    })).toThrow(/purpose/);
    expect(() => broker.offerDownload(identity.agentId, identity.deviceId, Buffer.from("x"), {
      purpose: "file",
      contentType: "application/octet-stream",
      maxFrameBytes: 0
    })).toThrow(/maxFrameBytes/);
  });

  it("cancels active streams by command and device", () => {
    const failed = vi.fn();
    broker.on("failed", failed);
    broker.offer(identity.agentId, identity.deviceId, message("stream.offer", offerBody({
      commandId: "cmd_testcommand001"
    }), { deviceId: identity.deviceId, commandId: "cmd_testcommand001" }));
    broker.cancelCommand(identity.deviceId, "cmd_testcommand001", "command ended");
    expect(broker.get("str_teststream001")).toMatchObject({ state: "failed", error: "command ended" });

    const download = broker.offerDownload(identity.agentId, identity.deviceId, Buffer.from("x"), {
      purpose: "file",
      contentType: "application/octet-stream"
    });
    broker.cancelDevice(identity.deviceId);
    expect(broker.get(download.streamId)?.state).toBe("failed");
    expect(failed).toHaveBeenCalledTimes(2);
  });

  it("denies streams while control is paused", () => {
    const denied = new StreamBroker(pairing, join(directory.path, "denied"), () => false);
    expect(() => denied.offer(identity.agentId, identity.deviceId,
      message("stream.offer", offerBody(), { deviceId: identity.deviceId })))
      .toThrow(DeviceControlPausedError);
    expect(() => denied.offerDownload(identity.agentId, identity.deviceId, Buffer.from("x"), {
      purpose: "file",
      contentType: "application/octet-stream"
    })).toThrow(DeviceControlPausedError);
  });

  it.each([
    ["missing sequence", Buffer.alloc(3), {}, "sequence number"],
    ["out of order", frame(1, Buffer.from("x")), {}, "Expected stream sequence"],
    ["oversized frame", frame(0, Buffer.from("abc")), { maxFrameBytes: 2 }, "maxFrameBytes"],
    ["oversized stream", frame(0, Buffer.from("abc")), { maxFrameBytes: 4, maxTotalBytes: 2 }, "maxTotalBytes"]
  ] as const)("fails an upload with %s", async (_name, bytes, overrides, error) => {
    const { socket } = await openUpload(overrides);
    socket.emit("message", bytes, true);
    expect(broker.get("str_teststream001")).toMatchObject({ state: "failed", error: expect.stringContaining(error) });
    expect(socket.close).toHaveBeenCalledWith(1011, expect.stringContaining(error));
  });

  it("rejects incorrect byte counts, checksums, and premature disconnects", async () => {
    let upload = await openUpload();
    upload.socket.emit("message", frame(0, Buffer.from("payload")), true);
    upload.socket.emit("message", Buffer.from(JSON.stringify({
      type: "stream.end", totalBytes: 1, sha256: "0".repeat(64)
    })), false);
    expect(broker.get(upload.streamId)).toMatchObject({ state: "failed", error: "Stream byte count mismatch" });

    broker = new StreamBroker(pairing, join(directory.path, "media-checksum"));
    upload = await openUpload();
    upload.socket.emit("message", frame(0, Buffer.from("payload")), true);
    upload.socket.emit("message", Buffer.from(JSON.stringify({
      type: "stream.end", totalBytes: 7, sha256: "0".repeat(64)
    })), false);
    expect(broker.get(upload.streamId)).toMatchObject({ state: "failed", error: "Stream checksum mismatch" });

    broker = new StreamBroker(pairing, join(directory.path, "media-disconnect"));
    upload = await openUpload();
    upload.socket.close(1001, "network lost");
    expect(broker.get(upload.streamId)).toMatchObject({
      state: "failed",
      error: "Stream socket closed before stream.end"
    });
  });

  it("requires valid timing metadata and completes a timed stream", async () => {
    let upload = await openUpload({ metadata: { frameTiming: "source-time.v1" } });
    upload.socket.emit("message", frame(0, Buffer.from("x")), true);
    expect(broker.get(upload.streamId)).toMatchObject({ state: "failed", error: "Timed stream frame is missing metadata" });

    broker = new StreamBroker(pairing, join(directory.path, "media-timed"));
    upload = await openUpload({ metadata: { frameTiming: "source-time.v1" } });
    upload.socket.emit("message", Buffer.from(JSON.stringify({
      type: "stream.frame", sequence: 0, sourceTimeS: 1.5, capturedAtS: 2
    })), false);
    upload.socket.emit("message", frame(0, Buffer.from("x")), true);
    upload.socket.emit("message", Buffer.from(JSON.stringify({
      type: "stream.end",
      totalBytes: 1,
      sha256: createHash("sha256").update("x").digest("hex")
    })), false);
    await vi.waitFor(() => expect(broker.get(upload.streamId)?.state).toBe("complete"));
  });

  it("does not persist transient previews and removes their records after completion", async () => {
    const completed = vi.fn();
    broker.on("complete", completed);
    const upload = await openUpload({
      purpose: "screen",
      contentType: "image/jpeg",
      metadata: { transient: true, observationFraming: "image-per-message.v1" }
    });
    upload.socket.emit("message", frame(0, Buffer.from("preview")), true);
    upload.socket.emit("message", Buffer.from(JSON.stringify({
      type: "stream.end",
      totalBytes: 7,
      sha256: createHash("sha256").update("preview").digest("hex")
    })), false);
    expect(completed).toHaveBeenCalledOnce();
    expect(broker.get(upload.streamId)).toBeUndefined();
    expect(broker.file(upload.streamId)).toBeUndefined();
  });

  it("fails safely when storage is unavailable or control pauses mid-upload", async () => {
    broker.offer(identity.agentId, identity.deviceId, message("stream.offer", offerBody(), {
      deviceId: identity.deviceId
    }));
    writeFileSync(join(directory.path, "media", "str_teststream001.bin"), "already exists");
    const storageSocket = new FakeStreamSocket();
    broker.attach("str_teststream001", storageSocket as unknown as WebSocket, {
      headers: { authorization: `Bearer ${identity.credential}`, "x-agent-id": identity.agentId }
    } as never);
    await vi.waitFor(() => expect(broker.get("str_teststream001")?.state).toBe("failed"));
    expect(broker.get("str_teststream001")?.error).toContain("EEXIST");

    let allowed = true;
    broker = new StreamBroker(pairing, join(directory.path, "media-paused"), () => allowed);
    const upload = await openUpload();
    allowed = false;
    upload.socket.emit("message", frame(0, Buffer.from("x")), true);
    expect(broker.get(upload.streamId)).toMatchObject({ state: "failed", error: "Device control paused" });
  });

  it("rejects direct streams with invalid authentication, first frames, duplicates, or timeout", () => {
    const unauthorized = new FakeStreamSocket();
    broker.attachDirect(unauthorized as unknown as WebSocket, { headers: {} } as never);
    expect(unauthorized.close).toHaveBeenCalledWith(1008, "Device stream credential is invalid");

    const binary = new FakeStreamSocket();
    broker.attachDirect(binary as unknown as WebSocket, {
      headers: {
        authorization: `Bearer ${identity.credential}`,
        "x-agent-id": identity.agentId,
        "x-device-id": identity.deviceId
      }
    } as never);
    binary.emit("message", Buffer.from("binary"), true);
    expect(binary.close).toHaveBeenCalledWith(1003, expect.stringContaining("stream.offer"));

    vi.useFakeTimers();
    const timeout = new FakeStreamSocket();
    broker.attachDirect(timeout as unknown as WebSocket, {
      headers: {
        authorization: `Bearer ${identity.credential}`,
        "x-agent-id": identity.agentId,
        "x-device-id": identity.deviceId
      }
    } as never);
    vi.advanceTimersByTime(10_001);
    expect(timeout.close).toHaveBeenCalledWith(1008, "Stream offer timeout");
  });

  it("expires idle streams and removes delivered private audio", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    broker.offer(identity.agentId, identity.deviceId, message("stream.offer", offerBody(), {
      deviceId: identity.deviceId
    }));
    vi.advanceTimersByTime(30_001);
    (broker as unknown as { expireIdle(): void }).expireIdle();
    expect(broker.get("str_teststream001")).toMatchObject({ state: "failed", error: "Stream idle timeout" });

    const download = broker.offerDownload(identity.agentId, identity.deviceId, Buffer.from("audio"), {
      purpose: "audio",
      contentType: "audio/pcm"
    });
    broker.openAgentDownload(download.streamId, identity.deviceId, identity.agentId, identity.credential);
    broker.completeAgentDownload(download.streamId);
    vi.advanceTimersByTime(5 * 60_000 + 1);
    (broker as unknown as { expireIdle(): void }).expireIdle();
    expect(broker.get(download.streamId)).toBeUndefined();
  });
});
