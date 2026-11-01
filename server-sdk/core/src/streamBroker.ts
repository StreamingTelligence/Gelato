import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import type { RawData } from "ws";
import type { DeviceAgentPairingService } from "./pairingService.js";
import type { ProtocolEnvelope, StreamOffer } from "./types.js";
import { GELATO_PROTOCOL } from "./types.js";
import { DeviceControlPausedError } from "./capabilityRouter.js";

interface StreamRecord extends StreamOffer {
  deviceId: string;
  agentId: string;
  state: "offered" | "uploading" | "downloading" | "complete" | "failed" | "closed";
  createdAt: string;
  updatedAt: string;
  bytesReceived: number;
  framesReceived: number;
  nextSequence: number;
  sha256?: string;
  error?: string;
  filePath: string;
  socket?: WebSocket;
}

export interface PublicStreamRecord extends Omit<StreamRecord, "filePath" | "socket"> {
  downloadPath?: string;
  agentPath?: string;
}

export interface AgentDownload {
  stream: PublicStreamRecord;
  filePath: string;
}

const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const IDLE_MS = 30_000;

export class StreamBroker extends EventEmitter {
  private readonly records = new Map<string, StreamRecord>();

  constructor(
    private readonly pairing: DeviceAgentPairingService,
    private readonly dataDir: string,
    private readonly controlAllowed: (deviceId: string) => boolean = () => true
  ) {
    super();
    setInterval(() => this.expireIdle(), 5_000).unref();
  }

  offer(agentId: string, deviceId: string, envelope: ProtocolEnvelope): PublicStreamRecord {
    if (!this.controlAllowed(deviceId)) throw new DeviceControlPausedError();
    const body = envelope.body as unknown as StreamOffer;
    if (!/^str_[A-Za-z0-9_-]{10,80}$/.test(body.streamId)) throw new Error("streamId is invalid");
    if (this.records.has(body.streamId)) throw new Error(`Stream ${body.streamId} already exists`);
    if (body.direction !== "agent-to-controller") throw new Error("Only device uploads are currently supported");
    if (!new Set(["audio", "screen", "file", "tunnel", "photo"]).has(body.purpose)) {
      throw new Error("Stream purpose is invalid");
    }
    const maxFrameBytes = bounded(body.maxFrameBytes, 1, MAX_FRAME_BYTES, "maxFrameBytes");
    const maxTotalBytes = bounded(body.maxTotalBytes, 1, MAX_TOTAL_BYTES, "maxTotalBytes");
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const now = new Date().toISOString();
    const record: StreamRecord = {
      ...body,
      deviceId,
      agentId,
      maxFrameBytes,
      maxTotalBytes,
      state: "offered",
      createdAt: now,
      updatedAt: now,
      bytesReceived: 0,
      framesReceived: 0,
      nextSequence: 0,
      filePath: path.join(this.dataDir, `${body.streamId}.bin`)
    };
    this.records.set(body.streamId, record);
    this.emit("offered", this.public(record));
    return this.public(record);
  }

  offerDownload(
    agentId: string,
    deviceId: string,
    payload: Buffer,
    options: {
      purpose: StreamOffer["purpose"];
      contentType: string;
      maxFrameBytes?: number;
      metadata?: Record<string, unknown>;
    }
  ): PublicStreamRecord {
    if (!this.controlAllowed(deviceId)) throw new DeviceControlPausedError();
    if (!new Set(["audio", "screen", "file", "tunnel", "photo"]).has(options.purpose)) {
      throw new Error("Stream purpose is invalid");
    }
    if (payload.length < 1 || payload.length > MAX_TOTAL_BYTES) {
      throw new Error("Stream payload size is invalid");
    }
    const streamId = `str_${randomBytes(18).toString("base64url")}`;
    const maxFrameBytes = bounded(
      options.maxFrameBytes ?? 256 * 1024,
      1,
      MAX_FRAME_BYTES,
      "maxFrameBytes"
    );
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const now = new Date().toISOString();
    const filePath = path.join(this.dataDir, `${streamId}.bin`);
    fs.writeFileSync(filePath, payload, { flag: "wx", mode: 0o600 });
    const record: StreamRecord = {
      streamId,
      purpose: options.purpose,
      direction: "controller-to-agent",
      contentType: options.contentType,
      maxFrameBytes,
      maxTotalBytes: payload.length,
      expectedBytes: payload.length,
      ...(options.metadata ? { metadata: options.metadata } : {}),
      deviceId,
      agentId,
      state: "offered",
      createdAt: now,
      updatedAt: now,
      bytesReceived: 0,
      framesReceived: 0,
      nextSequence: 0,
      sha256: createHash("sha256").update(payload).digest("hex"),
      filePath
    };
    this.records.set(streamId, record);
    this.emit("offered", this.public(record));
    return this.public(record);
  }

  openAgentDownload(
    streamId: string,
    deviceId: string | undefined,
    agentId: string | undefined,
    credential: string | undefined
  ): AgentDownload | undefined {
    const record = this.records.get(streamId);
    if (
      !record
      || record.direction !== "controller-to-agent"
      || record.deviceId !== deviceId
      || record.agentId !== agentId
      || !agentId
      || !deviceId
      || !this.controlAllowed(deviceId)
      || !this.pairing.authenticateDevice(deviceId, agentId, credential)
      || !new Set(["offered", "downloading", "complete"]).has(record.state)
    ) {
      return undefined;
    }
    record.state = "downloading";
    record.updatedAt = new Date().toISOString();
    return { stream: this.public(record), filePath: record.filePath };
  }

  completeAgentDownload(streamId: string): void {
    const record = this.records.get(streamId);
    if (!record || record.direction !== "controller-to-agent" || record.state !== "downloading") {
      return;
    }
    record.state = "complete";
    record.bytesReceived = record.expectedBytes ?? record.maxTotalBytes;
    record.framesReceived = Math.ceil(record.bytesReceived / record.maxFrameBytes);
    record.updatedAt = new Date().toISOString();
    this.emit("complete", this.public(record));
  }

  attach(streamId: string, socket: WebSocket, request: IncomingMessage): void {
    const record = this.records.get(streamId);
    if (!record || record.state !== "offered" || !this.controlAllowed(record.deviceId)) {
      socket.close(1008, "Stream offer is missing or no longer attachable");
      return;
    }
    const bearer = bearerToken(request.headers.authorization);
    const agentId = header(request, "x-agent-id");
    if (!agentId || !this.pairing.authenticateDevice(record.deviceId, agentId, bearer)) {
      socket.close(1008, "Device stream credential is invalid");
      return;
    }
    if (agentId !== record.agentId) {
      socket.close(1008, "Stream belongs to another device connection");
      return;
    }
    this.begin(record, socket);
  }

  attachDirect(socket: WebSocket, request: IncomingMessage): void {
    const bearer = bearerToken(request.headers.authorization);
    const agentId = header(request, "x-agent-id");
    const deviceId = header(request, "x-device-id");
    if (!agentId || !deviceId || !this.pairing.authenticateDevice(deviceId, agentId, bearer)) {
      socket.close(1008, "Device stream credential is invalid");
      return;
    }
    const timer = setTimeout(() => socket.close(1008, "Stream offer timeout"), 10_000);
    socket.once("message", (data, binary) => {
      clearTimeout(timer);
      if (binary) {
        socket.close(1003, "The first direct-stream frame must be stream.offer JSON");
        return;
      }
      try {
        const envelope = JSON.parse(data.toString("utf8")) as ProtocolEnvelope;
        if (envelope.protocol !== GELATO_PROTOCOL || envelope.type !== "stream.offer" || envelope.deviceId !== deviceId) {
          throw new Error("Direct stream requires a valid stream.offer envelope");
        }
        const record = this.records.has(String((envelope.body as Record<string, unknown>).streamId))
          ? undefined
          : this.offer(agentId, deviceId, envelope);
        if (!record) throw new Error("Stream ID already exists");
        const internal = this.records.get(record.streamId);
        if (!internal) throw new Error("Stream offer was not registered");
        this.begin(internal, socket);
      } catch (error) {
        socket.close(1008, (error instanceof Error ? error.message : String(error)).slice(0, 120));
      }
    });
  }

  private begin(record: StreamRecord, socket: WebSocket): void {
    record.socket = socket;
    record.state = "uploading";
    record.updatedAt = new Date().toISOString();
    // Live visual observations are consumed as they arrive. Persisting every
    // screen/camera preview frame would silently create an endless recording.
    const visualPreview = record.purpose === "screen" ||
      record.purpose === "photo" && record.contentType === "image/jpeg";
    const transientAudio = record.purpose === "audio" && record.contentType === "audio/pcm"
      && record.metadata?.transient === true;
    const transient = transientAudio || visualPreview && record.metadata?.transient === true
      && (record.purpose === "screen" || record.metadata?.observationFraming === "image-per-message.v1");
    const output = transient ? undefined : fs.createWriteStream(record.filePath, { flags: "wx", mode: 0o600 });
    output?.on("error", (error: NodeJS.ErrnoException) => {
      // EACCES/ENOSPC are asynchronous stream errors, not catchable by the
      // message handler. One failed recording must never crash Controller.
      this.fail(record, `Stream storage is unavailable (${error.code ?? "write failed"})`);
    });
    const hash = createHash("sha256");
    const timed = record.metadata?.frameTiming === "source-time.v1";
    let pendingTiming: { sourceTimeS: number | null; capturedAtS: number | null } | undefined;
    socket.on("message", (data, binary) => {
      if (record.state !== "uploading") return;
      if (!this.controlAllowed(record.deviceId)) {
        this.fail(record, "Device control paused");
        return;
      }
      try {
        record.updatedAt = new Date().toISOString();
        if (binary) {
          if (timed && !pendingTiming) throw new Error("Timed stream frame is missing metadata");
          const frame = asBuffer(data);
          if (frame.length < 4) throw new Error("Stream frame is missing its sequence number");
          const sequence = frame.readUInt32BE(0);
          const payload = frame.subarray(4);
          if (sequence !== record.nextSequence) throw new Error(`Expected stream sequence ${record.nextSequence}, got ${sequence}`);
          if (payload.length > record.maxFrameBytes) throw new Error("Stream frame exceeds maxFrameBytes");
          if (record.bytesReceived + payload.length > record.maxTotalBytes) throw new Error("Stream exceeds maxTotalBytes");
          record.nextSequence += 1;
          record.framesReceived += 1;
          record.bytesReceived += payload.length;
          hash.update(payload);
          if (output && !output.write(payload)) {
            socket.pause();
            output.once("drain", () => { if (socket.readyState === WebSocket.OPEN) socket.resume(); });
          }
          this.emit("media.chunk", { deviceId: record.deviceId, streamId: record.streamId,
            sequence, payload, contentType: record.contentType,
            observationFraming: record.metadata?.observationFraming,
            sourceTimeS: pendingTiming?.sourceTimeS ?? null,
            capturedAtS: pendingTiming?.capturedAtS ?? record.metadata?.capturedAtS ?? null });
          pendingTiming = undefined;
          if (record.purpose === "screen" || record.purpose === "photo" && transient) {
            this.emit("frame", { deviceId: record.deviceId, streamId: record.streamId, payload });
          }
          return;
        }
        const message = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
        if (message.type === "stream.frame" && timed) {
          if (pendingTiming || message.sequence !== record.nextSequence
              || !(message.sourceTimeS === null || typeof message.sourceTimeS === "number" && Number.isFinite(message.sourceTimeS))
              || !(message.capturedAtS === null || typeof message.capturedAtS === "number" && Number.isFinite(message.capturedAtS))) {
            throw new Error("Invalid stream frame timing");
          }
          pendingTiming = { sourceTimeS: message.sourceTimeS as number | null, capturedAtS: message.capturedAtS as number | null };
          return;
        }
        if (message.type !== "stream.end") throw new Error("Only stream.end text frames are accepted");
        if (Number(message.totalBytes) !== record.bytesReceived) throw new Error("Stream byte count mismatch");
        const digest = hash.digest("hex");
        if (String(message.sha256 ?? "").toLowerCase() !== digest) throw new Error("Stream checksum mismatch");
        const finish = () => {
          if (record.state !== "uploading" || output?.errored) return;
          record.sha256 = digest;
          record.state = "complete";
          record.updatedAt = new Date().toISOString();
          socket.send(JSON.stringify({
            protocol: GELATO_PROTOCOL,
            type: "stream.complete",
            streamId: record.streamId,
            totalBytes: record.bytesReceived,
            sha256: digest
          }));
          socket.close(1000, "Stream complete");
          this.emit("complete", this.public(record));
          if (transient) this.records.delete(record.streamId);
        };
        if (output) output.end(finish);
        else finish();
      } catch (error) {
        output?.destroy();
        this.fail(record, error instanceof Error ? error.message : String(error));
      }
    });
    socket.on("close", () => {
      output?.destroy();
      if (record.state === "uploading") {
        this.fail(record, "Stream socket closed before stream.end");
      }
      if (transient) this.records.delete(record.streamId);
    });
    socket.on("error", (error) => {
      output?.destroy();
      this.fail(record, error.message);
    });
    const ready = () => {
      if (record.state !== "uploading" || socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({
      protocol: GELATO_PROTOCOL,
      type: "stream.ready",
      ...(timed ? { frameTiming: "source-time.v1" } : {}),
      streamId: record.streamId,
      maxFrameBytes: record.maxFrameBytes,
      maxTotalBytes: record.maxTotalBytes
      }));
    };
    if (output) output.once("open", ready);
    else ready();
  }

  get(streamId: string): PublicStreamRecord | undefined {
    const record = this.records.get(streamId);
    return record ? this.public(record) : undefined;
  }

  cancelCommand(deviceId: string, commandId: string, reason: string): void {
    for (const record of this.records.values()) {
      if (record.deviceId === deviceId && record.commandId === commandId
          && record.direction === "agent-to-controller"
          && (record.state === "offered" || record.state === "uploading")) {
        this.fail(record, reason);
      }
    }
  }

  cancelDevice(deviceId: string, reason = "Device control paused"): void {
    for (const record of this.records.values()) {
      if (record.deviceId === deviceId && ["offered", "uploading", "downloading"].includes(record.state)) {
        this.fail(record, reason);
      }
    }
  }

  list(deviceId?: string): PublicStreamRecord[] {
    return [...this.records.values()]
      .filter((record) => !deviceId || record.deviceId === deviceId)
      .map((record) => this.public(record));
  }

  file(streamId: string): string | undefined {
    const record = this.records.get(streamId);
    return record?.direction === "agent-to-controller" && record.state === "complete"
      && record.metadata?.transient !== true
      ? record.filePath
      : undefined;
  }

  private fail(record: StreamRecord, error: string): void {
    if (record.state === "failed" || record.state === "complete") return;
    record.state = "failed";
    record.error = error;
    record.updatedAt = new Date().toISOString();
    record.socket?.close(1011, error.slice(0, 120));
    this.emit("failed", this.public(record));
  }

  private expireIdle(): void {
    const now = Date.now();
    for (const record of this.records.values()) {
      const idleMs = record.direction === "controller-to-agent" ? 5 * 60_000 : IDLE_MS;
      if ((record.state === "offered" || record.state === "uploading" || record.state === "downloading")
          && now - Date.parse(record.updatedAt) > idleMs) {
        this.fail(record, "Stream idle timeout");
      }
      // Speech replies are short-lived private content. Keep a small retry
      // window after delivery, then remove both the record and its 0600 file.
      if (record.direction === "controller-to-agent" && record.purpose === "audio"
          && (record.state === "complete" || record.state === "failed")
          && now - Date.parse(record.updatedAt) > 5 * 60_000) {
        try { fs.unlinkSync(record.filePath); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
        }
        this.records.delete(record.streamId);
      }
    }
  }

  private public(record: StreamRecord): PublicStreamRecord {
    const { filePath: _filePath, socket: _socket, ...result } = record;
    return {
      ...result,
      ...(record.direction === "agent-to-controller" && record.state === "complete"
        && record.metadata?.transient !== true
        ? { downloadPath: `/api/streams/${record.streamId}/content` }
        : {}),
      ...(record.direction === "controller-to-agent"
        ? { agentPath: `/agent/streams/${record.streamId}/content` }
        : {})
    };
  }
}

function bounded(value: number, min: number, max: number, label: string): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} is invalid`);
  return value;
}

function bearerToken(value: string | undefined): string | undefined {
  const match = /^Bearer\s+(.+)$/i.exec(value ?? "");
  return match?.[1]?.trim();
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function asBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}
