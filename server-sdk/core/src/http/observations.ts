import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import type { StreamBroker, PublicStreamRecord } from "../streamBroker.js";

export interface Observation {
  cursor_sequence: number;
  frame_ref: string;
  device_id: string;
  stream_id: string;
  sequence: number;
  captured_at_s: number | null;
  source_time_s: number | null;
  received_at_s: number;
  available_at_s: number;
  time_basis: "device_capture" | "gateway_receive";
  mime_type: string;
  sha256: string;
  data_base64: string;
}

/** Bounded live fan-out; durable retention is a host policy, not implicit deletion. */
export class ObservationHub {
  readonly epoch = randomUUID();
  private sequence = 0;
  private bytes = 0;
  private rejected = 0;
  private rows: Observation[] = [];
  private listeners: [string, (...args: any[]) => void][] = [];

  constructor(private streams?: StreamBroker, private maxBytes = 32 * 1024 * 1024,
              private maxRows = 240, private clock = () => Date.now() / 1000) {
    if (!streams) return;
    const chunk = (value: any) => {
      // Legacy H264 remains a coded chunk, not a fabricated image/frame.
      if (value.contentType === "video/h264" || value.observationFraming === "image-per-message.v1") {
        try {
          this.publish(value.deviceId, value.streamId, value.sequence, value.payload,
                       value.contentType, value.capturedAtS ?? null, value.sourceTimeS ?? null);
        } catch { this.rejected++; }
      }
    };
    const complete = (stream: PublicStreamRecord) => {
      if (stream.direction !== "agent-to-controller" || stream.metadata?.observationFraming === "image-per-message.v1"
          || !["image/png", "image/jpeg", "image/webp"].includes(stream.contentType)) return;
      const file = streams.file(stream.streamId);
      if (file && fs.statSync(file).size <= 10 * 1024 * 1024) {
        try {
          this.publish(stream.deviceId, stream.streamId, 0, fs.readFileSync(file), stream.contentType,
                       typeof stream.metadata?.capturedAtS === "number" ? stream.metadata.capturedAtS : null);
        } catch { this.rejected++; }
      }
    };
    this.listeners = [["media.chunk", chunk], ["complete", complete]];
    for (const [name, listener] of this.listeners) streams.on(name, listener);
  }

  publish(deviceId: string, streamId: string, sequence: number, data: Buffer,
          mime: string, capturedAt: number | null = null, sourceTime: number | null = null): Observation {
    if (!["image/png", "image/jpeg", "image/webp", "video/h264"].includes(mime) || data.length > 10 * 1024 * 1024
        || !Number.isSafeInteger(sequence) || sequence < 0 || (capturedAt !== null && !Number.isFinite(capturedAt))
        || (sourceTime !== null && !Number.isFinite(sourceTime))) {
      throw new Error("invalid_observation");
    }
    const sha256 = createHash("sha256").update(data).digest("hex");
    const frameRef = "obs_" + createHash("sha256").update(JSON.stringify([deviceId, streamId, sequence, sha256])).digest("hex");
    const prior = this.rows.find(row => row.frame_ref === frameRef);
    if (prior) return prior;
    const now = this.clock();
    const row: Observation = { cursor_sequence: ++this.sequence, frame_ref: frameRef,
      device_id: deviceId, stream_id: streamId, sequence, captured_at_s: capturedAt,
      source_time_s: sourceTime,
      received_at_s: now, available_at_s: now,
      time_basis: capturedAt === null ? "gateway_receive" : "device_capture", mime_type: mime,
      sha256, data_base64: data.toString("base64") };
    this.rows.push(row); this.bytes += row.data_base64.length;
    while (this.bytes > this.maxBytes || this.rows.length > this.maxRows) {
      this.bytes -= this.rows.shift()!.data_base64.length;
    }
    return row;
  }

  read(deviceId: string, after: number, epoch?: string) {
    if (!Number.isSafeInteger(after) || after < 0) throw new Error("invalid_cursor");
    const changed = epoch !== undefined && epoch !== this.epoch;
    if (changed) after = 0;
    const oldest = this.rows[0]?.cursor_sequence ?? this.sequence + 1;
    let bytes = 0;
    const frames: Observation[] = [];
    for (const row of this.rows) {
      if (row.cursor_sequence <= after || row.device_id !== deviceId) continue;
      if (bytes + row.data_base64.length > 16 * 1024 * 1024) break;
      frames.push(row); bytes += row.data_base64.length;
    }
    return { schema: "gelato.observation-batch.v1", epoch: this.epoch,
      cursor: frames.at(-1)?.cursor_sequence ?? Math.max(after, this.sequence),
      oldest_sequence: oldest, gap: changed || (after > 0 && after < oldest - 1), rejected_observations: this.rejected, frames };
  }

  close() {
    for (const [name, listener] of this.listeners) this.streams?.off(name, listener);
  }
}
