import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import type { ModelEndpoint, ModelRequest } from "./types.js";

const MODEL_PROTOCOL = "gelato.model.v1";
const MAX_MESSAGE_BYTES = 1024 * 1024;
const MEDIA_CHUNK_BYTES = 256 * 1024;
const MAX_MEDIA_BYTES = 8 * 1024 * 1024;
const SESSION_IDLE_MS = 20 * 60_000;

interface PendingTurn {
  turnId: string;
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  onDelta?: (text: string) => void;
  final?: string;
  activeAction?: string;
  seenProposals: Set<string>;
  actionAbort: AbortController;
}

export interface ModelActionProposal {
  deviceId: string;
  turnId: string;
  proposalId: string;
  capability: string;
  args: Record<string, unknown>;
}

export interface ModelActionOutcome {
  status: "rejected" | "completed" | "failed" | "unknown";
  commandId?: string;
  result?: Record<string, unknown>;
}

interface ModelSocketSession {
  socket: WebSocket;
  sessionId: string;
  deviceId: string;
  sendSeq: number;
  receiveSeq: number;
  seenEvents: Set<string>;
  capabilities: Set<string>;
  readyAccepted: boolean;
  ready: Promise<void>;
  resolveReady: () => void;
  rejectReady: (error: Error) => void;
  readyTimer: NodeJS.Timeout;
  pending?: PendingTurn;
  lastUsed: number;
  closed: boolean;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function keysOnly(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function modelId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,96}$/.test(value);
}

/** A vendor-neutral persistent client for the gelato.model.v1 WebSocket contract. */
export class ModelSessionEndpoint implements ModelEndpoint {
  private readonly sessions = new Map<string, ModelSocketSession>();
  private readonly opening = new Map<string, Promise<ModelSocketSession>>();
  private readonly reapTimer: NodeJS.Timeout;
  private closed = false;
  private readonly url: string;

  constructor(private readonly options: {
    url: string;
    apiKey: string;
    model?: string;
    responseTimeoutMs?: number;
    onAction?: (proposal: ModelActionProposal, signal: AbortSignal) => Promise<ModelActionOutcome>;
  }) {
    if (!options.url.trim()) throw new Error("Model session URL is required");
    const url = new URL(options.url);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "wss:" && !(loopback && url.protocol === "ws:")) {
      throw new Error("Model session URL must use WSS or loopback WS");
    }
    if (url.username || url.password || url.hash
        || [...url.searchParams.keys()].some((key) => /api.?key|authorization|token/i.test(key))) {
      throw new Error("Model session URL must not contain credentials");
    }
    if (!options.apiKey.trim()) throw new Error("Model session service token is required");
    this.url = url.toString();
    this.reapTimer = setInterval(() => this.reapIdle(), 60_000);
    this.reapTimer.unref();
  }

  async generate(input: ModelRequest, options?: { onDelta?: (text: string) => void }): Promise<string> {
    if (this.closed) throw new Error("Model session endpoint is closed");
    const session = await this.getSession(input.deviceId);
    if (this.closed || session.closed) throw new Error("Model session endpoint is closed");
    if (session.pending) throw new Error("A model turn is already active for this device");
    for (const part of input.parts) {
      if (part.type === "text" && !session.capabilities.has("text")) {
        throw new Error("Model runtime does not support text input");
      }
      if (part.type === "media") {
        const capability = part.mimeType.startsWith("audio/") ? "audio" : "image";
        if (!session.capabilities.has(capability)) {
          throw new Error(`Model runtime does not support ${capability} input`);
        }
      }
    }
    const turnId = input.messageId;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.send(session, "turn.cancel", { turnId });
        this.fail(session, new Error("Model turn timed out"));
        this.dispose(session);
      }, this.options.responseTimeoutMs ?? 120_000);
      session.pending = { turnId, resolve, reject, timer, onDelta: options?.onDelta,
        seenProposals: new Set(), actionAbort: new AbortController() };
      session.lastUsed = Date.now();
      try {
        this.send(session, "input.begin", {
          turnId, kind: "instruction", sourceMessageId: input.messageId
        });
        for (const part of input.parts) {
          if (part.type === "text") {
            this.send(session, "input.append", { turnId, type: "text", text: part.text });
            continue;
          }
          const bytes = Buffer.from(part.dataBase64, "base64");
          if (bytes.length < 1 || bytes.length > MAX_MEDIA_BYTES
              || bytes.toString("base64") !== part.dataBase64) {
            throw new Error("Invalid model media input");
          }
          for (let offset = 0, index = 0; offset < bytes.length; offset += MEDIA_CHUNK_BYTES, index++) {
            const chunk = bytes.subarray(offset, offset + MEDIA_CHUNK_BYTES);
            this.send(session, "input.append", {
              turnId, type: "media", mimeType: part.mimeType, chunkIndex: index,
              dataBase64: chunk.toString("base64"), final: offset + chunk.length === bytes.length
            });
          }
        }
        this.send(session, "input.commit", { turnId });
      } catch (error) {
        this.fail(session, error instanceof Error ? error : new Error("Model input failed"));
        this.dispose(session);
      }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.reapTimer);
    for (const session of this.sessions.values()) this.dispose(session);
  }

  private async getSession(deviceId: string): Promise<ModelSocketSession> {
    const current = this.sessions.get(deviceId);
    if (current && !current.closed) return current;
    const existing = this.opening.get(deviceId);
    if (existing) return existing;
    const opening = this.openSession(deviceId).finally(() => this.opening.delete(deviceId));
    this.opening.set(deviceId, opening);
    return opening;
  }

  private async openSession(deviceId: string): Promise<ModelSocketSession> {
    const socket = new WebSocket(this.url, {
      headers: { Authorization: `Bearer ${this.options.apiKey}` },
      maxPayload: MAX_MESSAGE_BYTES,
      perMessageDeflate: false,
      handshakeTimeout: 8_000
    });
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const session: ModelSocketSession = {
      socket, deviceId, sessionId: randomUUID(), sendSeq: 0, receiveSeq: 0,
      seenEvents: new Set(), capabilities: new Set(), ready, resolveReady, rejectReady,
      readyAccepted: false,
      readyTimer: setTimeout(() => this.dispose(session), 10_000),
      lastUsed: Date.now(), closed: false
    };
    this.sessions.set(deviceId, session);
    socket.on("open", () => {
      try {
        this.send(session, "session.open", {
          deviceId, ...(this.options.model ? { model: this.options.model } : {})
        });
      } catch { this.dispose(session); }
    });
    socket.on("message", (raw, binary) => {
      if (binary) { this.dispose(session); return; }
      try { this.receive(session, JSON.parse(raw.toString()) as unknown); }
      catch { this.dispose(session); }
    });
    socket.on("error", () => this.dispose(session));
    socket.on("close", () => this.dispose(session));
    await ready;
    return session;
  }

  private send(session: ModelSocketSession, type: string, body: Record<string, unknown>): void {
    if (session.closed || session.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Model session disconnected");
    }
    const message = JSON.stringify({
      protocol: MODEL_PROTOCOL, type, eventId: randomUUID(),
      sessionId: session.sessionId, seq: ++session.sendSeq,
      sentAt: new Date().toISOString(), body
    });
    if (Buffer.byteLength(message) > MAX_MESSAGE_BYTES) throw new Error("Model event too large");
    if (session.socket.bufferedAmount > 2 * MAX_MESSAGE_BYTES) {
      throw new Error("Model session backpressure limit exceeded");
    }
    session.socket.send(message);
  }

  private receive(session: ModelSocketSession, value: unknown): void {
    const event = record(value);
    const body = record(event?.body);
    if (!event || !body || event.protocol !== MODEL_PROTOCOL
        || event.sessionId !== session.sessionId
        || !keysOnly(event, ["protocol", "type", "eventId", "sessionId", "seq", "sentAt", "body"])
        || typeof event.type !== "string" || !modelId(event.eventId)
        || typeof event.sentAt !== "string" || !Number.isFinite(Date.parse(event.sentAt))
        || !Number.isSafeInteger(event.seq) || event.seq !== session.receiveSeq + 1) {
      throw new Error("Invalid model event envelope");
    }
    session.receiveSeq += 1;
    if (session.seenEvents.has(event.eventId)) return;
    session.seenEvents.add(event.eventId);
    if (session.seenEvents.size > 4096) throw new Error("Model event history exceeded");
    if (event.type === "session.ready") {
      if (session.readyAccepted || !Array.isArray(body.capabilities)
          || !keysOnly(body, ["capabilities"])
          || body.capabilities.some((item) => typeof item !== "string"
            || !["text", "image", "audio", "action-proposal"].includes(item))
          || new Set(body.capabilities).size !== body.capabilities.length) {
        throw new Error("Invalid model capabilities");
      }
      session.capabilities = new Set(body.capabilities as string[]);
      session.readyAccepted = true;
      clearTimeout(session.readyTimer);
      session.resolveReady();
      return;
    }
    if (event.type === "session.error") {
      if (!keysOnly(body, ["code", "retryable", "message"])
          || typeof body.code !== "string" || !body.code || body.code.length > 80
          || typeof body.retryable !== "boolean"
          || (body.message !== undefined
            && (typeof body.message !== "string" || body.message.length > 300))) {
        throw new Error("Invalid model error");
      }
      this.dispose(session);
      return;
    }
    if (event.type === "session.close") {
      if (Object.keys(body).length !== 0) throw new Error("Invalid model close");
      this.dispose(session);
      return;
    }
    const pending = session.pending;
    if (!pending || body.turnId !== pending.turnId) throw new Error("Unexpected model turn event");
    if (event.type === "reply.delta") {
      if (!keysOnly(body, ["turnId", "text"])
          || typeof body.text !== "string" || !body.text || body.text.length > 16_384) {
        throw new Error("Invalid model text delta");
      }
      try { pending.onDelta?.(body.text as string); }
      catch { /* Presentation callbacks cannot break the model session. */ }
      return;
    }
    if (event.type === "reply.complete") {
      if (pending.final !== undefined || !keysOnly(body, ["turnId", "text"])
          || typeof body.text !== "string"
          || body.text.length > 32_768) throw new Error("Invalid final model reply");
      pending.final = body.text;
      return;
    }
    if (event.type === "action.propose") {
      if (!session.capabilities.has("action-proposal")
          || !keysOnly(body, ["turnId", "proposalId", "capability", "args"])
          || !modelId(body.proposalId)
          || typeof body.capability !== "string" || !body.capability || body.capability.length > 128
          || !record(body.args)) throw new Error("Invalid model action proposal");
      const proposalId = body.proposalId as string;
      if (pending.seenProposals.has(proposalId) || pending.activeAction) {
        this.send(session, "action.result", { turnId: pending.turnId, proposalId, status: "rejected" });
        return;
      }
      pending.seenProposals.add(proposalId);
      const onAction = this.options.onAction;
      if (!onAction) {
        this.send(session, "action.result", { turnId: pending.turnId, proposalId, status: "rejected" });
        return;
      }
      pending.activeAction = proposalId;
      void onAction({ deviceId: session.deviceId, turnId: pending.turnId, proposalId,
        capability: body.capability as string, args: body.args as Record<string, unknown> },
      pending.actionAbort.signal).then((outcome) => {
        if (session.closed || session.pending !== pending) return;
        if (!["rejected", "completed", "failed", "unknown"].includes(outcome.status)
            || (outcome.commandId !== undefined && !modelId(outcome.commandId))
            || (outcome.result !== undefined && !record(outcome.result))) {
          throw new Error("Invalid model action outcome");
        }
        this.send(session, "action.result", {
          turnId: pending.turnId, proposalId, status: outcome.status,
          ...(outcome.commandId ? { commandId: outcome.commandId } : {}),
          ...(outcome.result ? { result: outcome.result } : {})
        });
      }).catch(() => {
        if (session.closed || session.pending !== pending) return;
        try { this.send(session, "action.result", {
          turnId: pending.turnId, proposalId, status: "unknown"
        }); } catch { this.dispose(session); }
      }).finally(() => {
        if (session.pending === pending) pending.activeAction = undefined;
      });
      return;
    }
    if (event.type === "turn.cancel") {
      if (!keysOnly(body, ["turnId"])) throw new Error("Invalid model cancellation");
      return;
    }
    if (event.type === "turn.end") {
      if (pending.activeAction) throw new Error("Model turn ended with an active action");
      if (!keysOnly(body, ["turnId", "status"])
          || !["completed", "cancelled", "failed"].includes(String(body.status))) {
        throw new Error("Invalid model turn status");
      }
      if (body.status !== "completed" || !pending.final?.trim()) {
        this.fail(session, new Error("Model turn did not produce a final text reply"));
      } else {
        clearTimeout(pending.timer);
        session.pending = undefined;
        session.lastUsed = Date.now();
        pending.resolve(pending.final);
      }
      return;
    }
    throw new Error("Unsupported model event");
  }

  private fail(session: ModelSocketSession, error: Error): void {
    const pending = session.pending;
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.actionAbort.abort();
    session.pending = undefined;
    pending.reject(error);
  }

  private dispose(session: ModelSocketSession): void {
    if (session.closed) return;
    if (session.socket.readyState === WebSocket.OPEN) {
      try { this.send(session, "session.close", {}); } catch { /* Closing is best effort. */ }
    }
    session.closed = true;
    clearTimeout(session.readyTimer);
    session.rejectReady(new Error("Model session unavailable"));
    this.fail(session, new Error("Model session disconnected"));
    if (this.sessions.get(session.deviceId) === session) this.sessions.delete(session.deviceId);
    try { session.socket.close(); } catch { session.socket.terminate(); }
  }

  private reapIdle(): void {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (!session.pending && now - session.lastUsed > SESSION_IDLE_MS) this.dispose(session);
    }
  }
}
