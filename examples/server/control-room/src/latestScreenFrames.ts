import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface LatestScreenFrame {
  jpeg: Buffer;
  sequence: number;
  receivedAt: number;
}

interface Decoder {
  streamId: string;
  process: ChildProcessWithoutNullStreams;
  output: Buffer;
  lastFrame?: LatestScreenFrame;
  lastPublishedAt: number;
}

const MAX_JPEG_BYTES = 4 * 1024 * 1024;
const MAX_INPUT_BACKLOG = 8 * 1024 * 1024;
const FRESH_MS = 3_000;

/** Reads authenticated JPEG frames or samples H.264 without requesting screenshots. */
export class LatestScreenFrames {
  private readonly decoders = new Map<string, Decoder>();
  private readonly directFrames = new Map<string, LatestScreenFrame>();
  private readonly sequences = new Map<string, number>();
  private ffmpegUnavailable = false;

  accept(value: {
    deviceId: string;
    streamId: string;
    payload: Buffer;
    contentType: string;
  }): void {
    if (value.contentType === "image/jpeg") {
      if (value.payload.length < 4 || value.payload.length > MAX_JPEG_BYTES
          || value.payload[0] !== 0xff || value.payload[1] !== 0xd8
          || value.payload.at(-2) !== 0xff || value.payload.at(-1) !== 0xd9) return;
      const sequence = (this.sequences.get(value.deviceId) ?? 0) + 1;
      this.sequences.set(value.deviceId, sequence);
      this.directFrames.set(value.deviceId, {
        jpeg: Buffer.from(value.payload), sequence, receivedAt: Date.now()
      });
      return;
    }
    if (value.contentType !== "video/h264" || this.ffmpegUnavailable) return;
    let decoder = this.decoders.get(value.deviceId);
    if (decoder?.streamId !== value.streamId) {
      this.clear(value.deviceId);
      decoder = this.start(value.deviceId, value.streamId);
    }
    if (!decoder || decoder.process.stdin.destroyed) return;
    // Never allow a slow decoder to accumulate an unbounded queue of video.
    if (decoder.process.stdin.writableLength > MAX_INPUT_BACKLOG) {
      this.clear(value.deviceId);
      return;
    }
    decoder.process.stdin.write(value.payload);
  }

  latest(deviceId: string): LatestScreenFrame | undefined {
    const direct = this.directFrames.get(deviceId);
    const decoded = this.decoders.get(deviceId)?.lastFrame;
    const frame = direct && (!decoded || direct.receivedAt >= decoded.receivedAt) ? direct : decoded;
    return frame && Date.now() - frame.receivedAt <= FRESH_MS ? frame : undefined;
  }

  clear(deviceId: string): void {
    this.directFrames.delete(deviceId);
    this.sequences.delete(deviceId);
    const decoder = this.decoders.get(deviceId);
    if (!decoder) return;
    this.decoders.delete(deviceId);
    decoder.process.stdin.destroy();
    decoder.process.kill();
  }

  close(): void {
    for (const deviceId of this.decoders.keys()) this.clear(deviceId);
    this.directFrames.clear();
    this.sequences.clear();
  }

  private start(deviceId: string, streamId: string): Decoder {
    const process = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-threads", "1",
      "-probesize", "2048", "-analyzeduration", "0", "-f", "h264",
      "-i", "pipe:0", "-an", "-vf", "scale=960:-2:force_original_aspect_ratio=decrease,format=yuvj420p",
      "-threads", "1", "-f", "image2pipe", "-c:v", "mjpeg", "-q:v", "4",
      "-flush_packets", "1", "pipe:1"
    ], { stdio: ["pipe", "pipe", "pipe"] });
    const decoder: Decoder = { streamId, process, output: Buffer.alloc(0), lastPublishedAt: 0 };
    this.decoders.set(deviceId, decoder);
    process.stdout.on("data", (chunk: Buffer) => this.readJpegs(deviceId, decoder, chunk));
    process.stderr.resume();
    process.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") this.ffmpegUnavailable = true;
      if (this.decoders.get(deviceId) === decoder) this.clear(deviceId);
    });
    process.on("exit", () => {
      if (this.decoders.get(deviceId) === decoder) this.decoders.delete(deviceId);
    });
    return decoder;
  }

  private readJpegs(deviceId: string, decoder: Decoder, chunk: Buffer): void {
    if (this.decoders.get(deviceId) !== decoder) return;
    decoder.output = Buffer.concat([decoder.output, chunk]);
    while (decoder.output.length) {
      const start = decoder.output.indexOf(Buffer.from([0xff, 0xd8]));
      if (start < 0) {
        decoder.output = Buffer.alloc(0);
        return;
      }
      if (start > 0) decoder.output = decoder.output.subarray(start);
      const end = decoder.output.indexOf(Buffer.from([0xff, 0xd9]), 2);
      if (end < 0) {
        if (decoder.output.length > MAX_JPEG_BYTES) this.clear(deviceId);
        return;
      }
      const jpeg = Buffer.from(decoder.output.subarray(0, end + 2));
      decoder.output = decoder.output.subarray(end + 2);
      const receivedAt = Date.now();
      if (receivedAt - decoder.lastPublishedAt < 950) continue;
      decoder.lastPublishedAt = receivedAt;
      const sequence = (this.sequences.get(deviceId) ?? 0) + 1;
      this.sequences.set(deviceId, sequence);
      decoder.lastFrame = { jpeg, sequence, receivedAt };
    }
  }
}
