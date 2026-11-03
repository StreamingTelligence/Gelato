import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import type { ModelEndpoint, ModelRequest } from "./types.js";

const DEFAULT_ORIGIN = "https://streamingtelligence.com";
const MUX_PATH = "/v1/streamingmsa/mux";
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const MAX_QUEUED_FRAMES = 4;
const OPERATION_TIMEOUT_MS = 120_000;
const SESSION_IDLE_MS = 20 * 60_000;

type MuxEndpoint = "reset" | "ingest" | "query" | "cancel_query" | "release";

interface Frame {
  bytes: Buffer;
  mimeType: "image/jpeg" | "image/png";
  receivedAtMs: number;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface Pending {
  endpoint: MuxEndpoint;
  resolve: (value: { text: string; result: Record<string, unknown> }) => void;
  reject: (error: Error) => void;
  deltas: string[];
  onDelta?: (text: string) => void;
  timer: NodeJS.Timeout;
}

interface Session {
  deviceId: string;
  sessionId: string;
  socket: WebSocket;
  ready: Promise<void>;
  pending: Map<string, Pending>;
  queue: Frame[];
  draining?: Promise<void>;
  firstIngestWaiters: Set<{ resolve: () => void; reject: (error: Error) => void }>;
  ingested: boolean;
  receiptOriginMs?: number;
  lastFrameTimeS: number;
  activeQuery?: { id: string; done: Promise<unknown> };
  lastUsed: number;
  closing: boolean;
  closed: boolean;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function checkedFrame(bytes: Buffer, mimeType: string): bytes is Buffer {
  if (bytes.length < 4 || bytes.length > MAX_FRAME_BYTES) return false;
  if (mimeType === "image/jpeg") {
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
  }
  return mimeType === "image/png" && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
}

/** Native StreamingTelligence mux adapter, with one visual history per device. */
export class StreamingTelligenceEndpoint implements ModelEndpoint {
  private readonly url: string;
  private readonly sessions = new Map<string, Session>();
  private readonly latestBeforeQuery = new Map<string, Omit<Frame, "resolve" | "reject">>();
  private readonly reapTimer: NodeJS.Timeout;
  private closed = false;

  constructor(private readonly options: {
    apiKey: string;
    model: string;
    origin?: string;
    maxNewTokens?: number;
  }) {
    if (!options.apiKey || /\s/.test(options.apiKey)) throw new Error("STREAMINGTELLIGENCE_API_KEY is required");
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(options.model)) throw new Error("Invalid StreamingTelligence model ID");
    if (!Number.isSafeInteger(options.maxNewTokens ?? 64) || (options.maxNewTokens ?? 64) < 1
        || (options.maxNewTokens ?? 64) > 4096) throw new Error("Invalid response token limit");
    const origin = new URL(options.origin ?? DEFAULT_ORIGIN);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
    if ((origin.protocol !== "https:" && !(loopback && origin.protocol === "http:"))
        || origin.username || origin.password || origin.hash || origin.search
        || (origin.pathname !== "/" && origin.pathname !== "")) {
      throw new Error("StreamingTelligence origin must be HTTPS or loopback HTTP without credentials");
    }
    origin.protocol = origin.protocol === "https:" ? "wss:" : "ws:";
    origin.pathname = MUX_PATH;
    origin.searchParams.set("model", options.model);
    this.url = origin.toString();
    this.reapTimer = setInterval(() => this.reapIdle(), 60_000);
    this.reapTimer.unref();
  }

  /** Buffer only the newest pre-query frame; inference starts on explicit instruction. */
  pushLiveImage(deviceId: string, jpeg: Buffer): boolean {
    if (this.closed || !checkedFrame(jpeg, "image/jpeg")) return false;
    const frame = { bytes: Buffer.from(jpeg), mimeType: "image/jpeg" as const,
      receivedAtMs: Date.now() };
    const session = this.sessions.get(deviceId);
    if (!session) {
      this.latestBeforeQuery.set(deviceId, frame);
      return true;
    }
    const queued = this.enqueue(session, frame);
    if (!queued) return false;
    void queued.catch(() => {});
    return true;
  }

  async generate(input: ModelRequest, options?: { onDelta?: (text: string) => void }): Promise<string> {
    if (this.closed) throw new Error("StreamingTelligence endpoint is closed");
    const question = input.parts.filter(part => part.type === "text")
      .map(part => part.type === "text" ? part.text : "").join("\n");
    if (!question.trim() || question.length > 32_768) throw new Error("A bounded text question is required");
    if (input.parts.some(part => part.type === "media" && !["image/jpeg", "image/png"].includes(part.mimeType))) {
      throw new Error("StreamingTelligence mux accepts image observations, not this media type");
    }
    const session = await this.getSession(input.deviceId);
    if (session.activeQuery || session.closing) throw new Error("A model query is already active for this device");
    for (const part of input.parts) {
      if (part.type !== "media") continue;
      const bytes = Buffer.from(part.dataBase64, "base64");
      if (bytes.toString("base64") !== part.dataBase64 || !checkedFrame(bytes, part.mimeType)) {
        throw new Error("Invalid model image input");
      }
      const queued = this.enqueue(session, { bytes, mimeType: part.mimeType as "image/jpeg" | "image/png",
        receivedAtMs: Date.now() });
      if (!queued) throw new Error("StreamingTelligence image backlog is full");
      await queued;
    }
    if (!session.ingested) await this.waitForFirstIngest(session);
    if (session.closed || session.closing) throw new Error("StreamingTelligence session is closed");
    const operation = this.submit(session, "query", {
      session_id: session.sessionId,
      question,
      response_max_new_tokens: this.options.maxNewTokens ?? 64,
      return_deltas: true,
      cancellable: true
    }, options?.onDelta);
    session.activeQuery = { id: operation.id, done: operation.done };
    try {
      const { text } = await operation.done;
      if (!text.trim() || text.length > 32_768) throw new Error("StreamingTelligence returned no valid text reply");
      session.lastUsed = Date.now();
      return text;
    } finally {
      if (session.activeQuery?.id === operation.id) session.activeQuery = undefined;
    }
  }

  stopLive(deviceId: string): void {
    void this.releaseDevice(deviceId);
  }

  async releaseDevice(deviceId: string): Promise<boolean> {
    this.latestBeforeQuery.delete(deviceId);
    const session = this.sessions.get(deviceId);
    if (!session || session.closing) return false;
    session.closing = true;
    for (const frame of session.queue.splice(0)) frame.reject(new Error("Visual session stopped"));
    return this.release(session);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.reapTimer);
    this.latestBeforeQuery.clear();
    for (const deviceId of this.sessions.keys()) this.stopLive(deviceId);
  }

  private async getSession(deviceId: string): Promise<Session> {
    let session = this.sessions.get(deviceId);
    if (!session) {
      const socket = new WebSocket(this.url, {
        headers: { Authorization: `Bearer ${this.options.apiKey}` },
        handshakeTimeout: 20_000, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false
      });
      session = {
        deviceId, sessionId: randomUUID(), socket, ready: Promise.resolve(),
        pending: new Map(), queue: [], firstIngestWaiters: new Set(), ingested: false,
        lastFrameTimeS: -1, lastUsed: Date.now(), closing: false, closed: false
      };
      this.sessions.set(deviceId, session);
      socket.on("message", (raw, binary) => {
        if (binary) { this.dispose(session!); return; }
        try { this.receive(session!, JSON.parse(raw.toString("utf8")) as unknown); }
        catch { this.dispose(session!); }
      });
      socket.on("error", () => this.dispose(session!));
      socket.on("close", () => this.dispose(session!));
      session.ready = this.open(session);
      const buffered = this.latestBeforeQuery.get(deviceId);
      this.latestBeforeQuery.delete(deviceId);
      if (buffered && Date.now() - buffered.receivedAtMs < 3_000) {
        const queued = this.enqueue(session, buffered);
        if (queued) void queued.catch(() => {});
      }
    }
    await session.ready;
    if (session.closed) throw new Error("StreamingTelligence session is closed");
    return session;
  }

  private async open(session: Session): Promise<void> {
    const socket = session.socket;
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("StreamingTelligence handshake timed out")), 20_000);
        socket.once("open", () => { clearTimeout(timer); resolve(); });
        socket.once("error", () => { clearTimeout(timer); reject(new Error("StreamingTelligence handshake failed")); });
        socket.once("close", () => { clearTimeout(timer); reject(new Error("StreamingTelligence connection closed")); });
      });
      await this.submit(session, "reset", { session_id: session.sessionId }).done;
    } catch {
      this.dispose(session);
      throw new Error("StreamingTelligence session could not be opened");
    }
  }

  private enqueue(session: Session, input: Omit<Frame, "resolve" | "reject">): Promise<void> | undefined {
    if (session.closed || session.closing || session.queue.length >= MAX_QUEUED_FRAMES) return undefined;
    const done = new Promise<void>((resolve, reject) => {
      session.queue.push({ ...input, resolve, reject });
    });
    this.kickDrain(session);
    return done;
  }

  private kickDrain(session: Session): void {
    if (session.draining || session.closed || session.closing || !session.queue.length) return;
    session.draining = this.drain(session).finally(() => {
      session.draining = undefined;
      this.kickDrain(session);
    });
  }

  private async drain(session: Session): Promise<void> {
    let frame: Frame | undefined;
    try {
      await session.ready;
      while (!session.closed && !session.closing && (frame = session.queue.shift())) {
        const relativeS = Math.max((frame.receivedAtMs - (session.receiptOriginMs ?? frame.receivedAtMs)) / 1000,
          session.lastFrameTimeS + 0.001);
        session.receiptOriginMs ??= frame.receivedAtMs;
        await this.submit(session, "ingest", {
          session_id: session.sessionId,
          frames: [`data:${frame.mimeType};base64,${frame.bytes.toString("base64")}`],
          frame_times_s: [relativeS], ts_start: relativeS, ts_end: relativeS
        }).done;
        session.lastFrameTimeS = relativeS;
        session.ingested = true;
        session.lastUsed = Date.now();
        frame.resolve();
        for (const waiter of session.firstIngestWaiters) waiter.resolve();
        session.firstIngestWaiters.clear();
      }
    } catch (error) {
      const failure = error instanceof Error ? error : new Error("Visual ingest failed");
      frame?.reject(failure);
      this.dispose(session);
    }
  }

  private waitForFirstIngest(session: Session): Promise<void> {
    if (session.ingested) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve: () => { clearTimeout(timer); session.firstIngestWaiters.delete(waiter); resolve(); },
        reject: (error: Error) => { clearTimeout(timer); session.firstIngestWaiters.delete(waiter); reject(error); }
      };
      const timer = setTimeout(() => {
        waiter.reject(new Error("No visual observation reached the model"));
        this.stopLive(session.deviceId);
      }, 8_000);
      session.firstIngestWaiters.add(waiter);
    });
  }

  private submit(session: Session, endpoint: MuxEndpoint, payload: Record<string, unknown>,
                 onDelta?: (text: string) => void): { id: string; done: Promise<{ text: string; result: Record<string, unknown> }> } {
    if (session.closed || session.socket.readyState !== WebSocket.OPEN) throw new Error("Model session disconnected");
    const id = randomUUID();
    const message = JSON.stringify({ id, endpoint, payload });
    if (Buffer.byteLength(message) > MAX_MESSAGE_BYTES || session.socket.bufferedAmount > 2 * MAX_MESSAGE_BYTES) {
      throw new Error("StreamingTelligence send backlog exceeded");
    }
    const done = new Promise<{ text: string; result: Record<string, unknown> }>((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(id);
        reject(new Error(`${endpoint} completion is unresolved`));
        this.dispose(session);
      }, OPERATION_TIMEOUT_MS);
      session.pending.set(id, { endpoint, resolve, reject, deltas: [], onDelta, timer });
    });
    session.socket.send(message, error => { if (error) this.dispose(session); });
    return { id, done };
  }

  private receive(session: Session, value: unknown): void {
    const event = object(value);
    if (!event || typeof event.id !== "string" || typeof event.type !== "string") throw new Error("Invalid mux event");
    const pending = session.pending.get(event.id);
    if (!pending) return;
    if (event.type === "chat.delta") {
      if (pending.endpoint !== "query" || typeof event.text !== "string") throw new Error("Invalid query delta");
      pending.deltas.push(event.text);
      if (pending.deltas.join("").length > 32_768) throw new Error("Model reply is too large");
      try { pending.onDelta?.(event.text); } catch { /* A display callback cannot break the session. */ }
      return;
    }
    if (event.type === "result") {
      const result = object(event.result);
      if (!Number.isSafeInteger(event.status) || !result
          || (result.session_id !== undefined && result.session_id !== session.sessionId)) {
        throw new Error("Invalid mux terminal result");
      }
      clearTimeout(pending.timer);
      session.pending.delete(event.id);
      if ((event.status as number) < 200 || (event.status as number) >= 300 || result.ok === false) {
        pending.reject(new Error(`${pending.endpoint} was rejected by StreamingTelligence`));
      } else {
        pending.resolve({ text: pending.deltas.join(""), result });
      }
      return;
    }
    if (event.type === "error") {
      clearTimeout(pending.timer);
      session.pending.delete(event.id);
      pending.reject(new Error(`${pending.endpoint} failed`));
    }
  }

  private async release(session: Session): Promise<boolean> {
    try {
      await session.ready;
      const activeQuery = session.activeQuery;
      if (activeQuery) {
        try { await this.submit(session, "cancel_query", {
          session_id: session.sessionId, request_id: activeQuery.id
        }).done; } catch { /* The query may already have finished. */ }
        await activeQuery.done.catch(() => {});
      }
      await session.draining?.catch(() => {});
      if (session.closed) return false;
      await this.submit(session, "release", { session_id: session.sessionId }).done;
      return true;
    } catch { return false; }
    finally { this.dispose(session); }
  }

  private dispose(session: Session): void {
    if (session.closed) return;
    session.closed = true;
    if (this.sessions.get(session.deviceId) === session) this.sessions.delete(session.deviceId);
    const failure = new Error("StreamingTelligence session closed with unresolved work");
    for (const frame of session.queue.splice(0)) frame.reject(failure);
    for (const waiter of session.firstIngestWaiters) waiter.reject(failure);
    session.firstIngestWaiters.clear();
    for (const pending of session.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(failure);
    }
    session.pending.clear();
    session.socket.terminate();
  }

  private reapIdle(): void {
    const now = Date.now();
    for (const [deviceId, session] of this.sessions) {
      if (!session.activeQuery && !session.draining && now - session.lastUsed > SESSION_IDLE_MS) this.stopLive(deviceId);
    }
    for (const [deviceId, frame] of this.latestBeforeQuery) {
      if (now - frame.receivedAtMs > 3_000) this.latestBeforeQuery.delete(deviceId);
    }
  }
}
