import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ModelEndpoint, ModelRequest } from "./types.js";

// Qwen Live Harness 1.0.0 exposes its realtime client in the npm tarball but
// not through a public package subpath. Keep this version fence in this
// provider adapter, not in the Gelato device or Controller SDKs.
const QWEN_LIVE_VERSION = "1.0.0";
const SESSION_IDLE_MS = 20 * 60_000;
const RESPONSE_TIMEOUT_MS = 120_000;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const AUDIO_CHUNK_BYTES = 32 * 1024;
const MAX_LIVE_IMAGE_BYTES = 600_000;

function defaultVoice(model: string): string {
  if (model.startsWith("qwen3-omni-flash-realtime")) return "Cherry";
  if (model.startsWith("qwen-omni-turbo-realtime")) return "Chelsie";
  // Qwen Live Harness 1.0.0 uses Tina for Qwen 3.8/3.5 Omni Realtime.
  // Omitting voice lets the provider fall back to Chelsie, which Qwen 3.8 rejects.
  return "Tina";
}

interface LiveSession {
  resumeUserText?: (input: { itemId: string; text: string }) => boolean;
  pushAudio: (bytes: Uint8Array) => boolean;
  pushImage: (jpegBase64: string) => boolean;
  commitInputAudio: () => boolean;
  cancelResponse: () => boolean;
  close: () => void;
}

interface LiveCallbacks {
  onResponseCreated: (event: { responseId: string }) => void;
  onOutputAudioDelta: (event: { responseId: string; audio: Uint8Array }) => void;
  onOutputTextDelta: (event: { responseId: string; text: string; audioSuppressed?: boolean }) => void;
  onOutputTextDone: (event: { responseId: string; text: string; audioSuppressed?: boolean }) => void;
  onResponseDone: (event: { responseId: string; status: string }) => void;
  onFunctionCall: () => void;
  onError: () => void;
  onClose: () => void;
}

type OpenLiveSession = (
  config: {
    endpoint: string;
    apiKey: string;
    model: string;
    voice: string;
    callEpoch: string;
    instructions: string;
    tools: readonly never[];
  },
  callbacks: LiveCallbacks
) => Promise<LiveSession>;

interface PendingTurn {
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  delta: string;
  final?: string;
  timer: NodeJS.Timeout;
  onDelta?: (text: string) => void;
}

interface DeviceSession {
  live?: LiveSession;
  opening?: Promise<LiveSession>;
  pending?: PendingTurn;
  lastUsed: number;
  liveMode?: boolean;
  liveAudioStarted?: boolean;
  liveOutput?: { responseId: string; delta: string; final?: string; chunks: Buffer[]; bytes: number };
}

function runtimeLoader(): Promise<OpenLiveSession> {
  const require = createRequire(import.meta.url);
  const packagePath = require.resolve("qwen-live-harness/package.json");
  const pkg = require(packagePath) as { version?: string };
  if (pkg.version !== QWEN_LIVE_VERSION) {
    throw new Error(`Qwen Live Harness ${QWEN_LIVE_VERSION} is required`);
  }
  const moduleUrl = pathToFileURL(join(dirname(packagePath), "dist/realtime/realtime-session.js"));
  return import(moduleUrl.href).then((value: unknown) => {
    if (!value || typeof value !== "object"
        || typeof (value as { openQwenRealtimeSession?: unknown }).openQwenRealtimeSession !== "function") {
      throw new Error("Qwen Live Harness realtime client is unavailable");
    }
    return (value as { openQwenRealtimeSession: OpenLiveSession }).openQwenRealtimeSession;
  });
}

/** Per-device, persistent Qwen Live realtime sessions for a Gelato Controller. */
export class QwenLiveEndpoint implements ModelEndpoint {
  private readonly sessions = new Map<string, DeviceSession>();
  private readonly retryAt = new Map<string, { failures: number; at: number }>();
  private readonly reapTimer: NodeJS.Timeout;
  private closed = false;

  static async create(options: {
    apiKey: string;
    endpoint?: string;
    model?: string;
    voice?: string;
    instructions?: string;
    onLiveReply?: (deviceId: string, text: string, pcm16: Buffer) => void;
  }): Promise<QwenLiveEndpoint> {
    if (!options.apiKey.trim()) throw new Error("DASHSCOPE_API_KEY is required for Qwen Live Harness");
    const endpoint = new URL(options.endpoint ?? "https://dashscope.aliyuncs.com");
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname);
    if (!["https:", "wss:"].includes(endpoint.protocol)
        && !(loopback && ["http:", "ws:"].includes(endpoint.protocol))) {
      throw new Error("Qwen Live endpoint must use HTTPS/WSS or loopback HTTP/WS");
    }
    if (endpoint.username || endpoint.password || endpoint.hash
        || [...endpoint.searchParams.keys()].some((key) => /api.?key|authorization|token/i.test(key))) {
      throw new Error("Qwen Live endpoint URL must not contain credentials");
    }
    return new QwenLiveEndpoint(options, await runtimeLoader());
  }

  private constructor(
    private readonly options: {
      apiKey: string;
      endpoint?: string;
      model?: string;
      voice?: string;
      instructions?: string;
      onLiveReply?: (deviceId: string, text: string, pcm16: Buffer) => void;
    },
    private readonly openRuntime: OpenLiveSession
  ) {
    this.reapTimer = setInterval(() => this.reapIdle(), 60_000);
    this.reapTimer.unref();
  }

  /** Accept an authenticated live microphone frame without creating an HTTP model turn. */
  pushLiveAudio(deviceId: string, bytes: Buffer): boolean {
    if (this.closed || bytes.length < 2 || bytes.length > AUDIO_CHUNK_BYTES || bytes.length % 2 !== 0) return false;
    if ((this.retryAt.get(deviceId)?.at ?? 0) > Date.now()) return false;
    const state = this.sessions.get(deviceId) ?? { lastUsed: Date.now() };
    if (state.pending) return false;
    state.liveMode = true;
    state.lastUsed = Date.now();
    this.sessions.set(deviceId, state);
    if (!state.live) {
      if (!state.opening) void this.session(deviceId, state).catch(() => {
        this.noteLiveFailure(deviceId);
        this.dispose(deviceId, state);
      });
      return false;
    }
    try {
      const accepted = state.live.pushAudio(bytes);
      if (accepted) state.liveAudioStarted = true;
      return accepted;
    } catch {
      this.noteLiveFailure(deviceId);
      this.dispose(deviceId, state);
      return false;
    }
  }

  /** The 1 fps camera stream is evidence for the live Omni session, never a command. */
  pushLiveImage(deviceId: string, jpeg: Buffer): boolean {
    if (this.closed || jpeg.length < 4 || jpeg.length > MAX_LIVE_IMAGE_BYTES
        || jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg.at(-2) !== 0xff || jpeg.at(-1) !== 0xd9) return false;
    const state = this.sessions.get(deviceId);
    if (!state?.liveMode || !state.liveAudioStarted || !state.live) return false;
    state.lastUsed = Date.now();
    try { return state.live.pushImage(jpeg.toString("base64")); }
    catch {
      this.noteLiveFailure(deviceId);
      this.dispose(deviceId, state);
      return false;
    }
  }

  stopLive(deviceId: string): void {
    const state = this.sessions.get(deviceId);
    if (state?.liveMode) this.dispose(deviceId, state);
    this.retryAt.delete(deviceId);
  }

  async generate(input: ModelRequest, options?: { onDelta?: (text: string) => void }): Promise<string> {
    if (this.closed) throw new Error("Qwen Live endpoint is closed");
    const textParts = input.parts.filter((part) => part.type === "text");
    const mediaParts = input.parts.filter((part) => part.type === "media");
    if (mediaParts.some((part) => part.type === "media" && part.mimeType !== "audio/pcm")) {
      throw new Error("Qwen Live example accepts text or 16 kHz mono PCM16 audio, not this media type");
    }
    if (textParts.length && mediaParts.length) {
      throw new Error("Qwen Live example does not support mixed text/audio turns");
    }
    if (mediaParts.length > 1) throw new Error("Qwen Live example accepts one audio part per turn");
    const text = textParts.map((part) => part.type === "text" ? part.text : "").join("\n");
    if (!text.trim() && mediaParts.length === 0) throw new Error("Model input is empty");

    const state = this.sessions.get(input.deviceId) ?? { lastUsed: Date.now() };
    if (state.liveMode) throw new Error("A live model conversation is already active for this device");
    if (state.pending) throw new Error("A model turn is already active for this device");
    this.sessions.set(input.deviceId, state);
    const live = await this.session(input.deviceId, state);
    if (state.pending) throw new Error("A model turn is already active for this device");
    state.lastUsed = Date.now();
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        live.cancelResponse();
        this.fail(state, new Error("Qwen Live response timed out"));
        this.dispose(input.deviceId, state);
      }, RESPONSE_TIMEOUT_MS);
      state.pending = { resolve, reject, delta: "", timer, onDelta: options?.onDelta };
      try {
        if (text.trim()) {
          // Upstream uses this method when restoring a real user's text turn.
          // It sends conversation.item.create + response.create; the example
          // confines this private API to a pinned package version.
          if (!live.resumeUserText?.({ itemId: input.messageId, text })) {
            throw new Error("Qwen Live text input is unavailable");
          }
        } else {
          const media = mediaParts[0]!;
          if (media.type !== "media") throw new Error("Invalid audio input");
          const bytes = Buffer.from(media.dataBase64, "base64");
          if (bytes.length < 2 || bytes.length > MAX_AUDIO_BYTES || bytes.length % 2 !== 0
              || bytes.toString("base64") !== media.dataBase64) {
            throw new Error("Invalid PCM16 audio input");
          }
          for (let offset = 0; offset < bytes.length; offset += AUDIO_CHUNK_BYTES) {
            if (!live.pushAudio(bytes.subarray(offset, offset + AUDIO_CHUNK_BYTES))) {
              throw new Error("Qwen Live audio input was not accepted");
            }
          }
          if (!live.commitInputAudio()) throw new Error("Qwen Live audio commit failed");
        }
      } catch (error) {
        this.fail(state, error instanceof Error ? error : new Error("Qwen Live input failed"));
        this.dispose(input.deviceId, state);
      }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.reapTimer);
    for (const [deviceId, state] of this.sessions) {
      this.fail(state, new Error("Qwen Live endpoint closed"));
      this.dispose(deviceId, state);
    }
  }

  private async session(deviceId: string, state: DeviceSession): Promise<LiveSession> {
    if (state.live) return state.live;
    if (state.opening) return state.opening;
    state.opening = this.openRuntime({
      endpoint: this.options.endpoint ?? "https://dashscope.aliyuncs.com",
      apiKey: this.options.apiKey,
      model: this.options.model ?? "qwen3.8-omni-flash-realtime",
      voice: this.options.voice ?? defaultVoice(this.options.model ?? "qwen3.8-omni-flash-realtime"),
      callEpoch: randomUUID(),
      instructions: this.options.instructions ?? "You are a helpful assistant. Reply to the user's device in the same language as the user. Do not claim to have performed device actions.",
      tools: []
    }, {
      onResponseCreated: (event) => {
        if (state.liveMode) state.liveOutput = { responseId: event.responseId, delta: "", chunks: [], bytes: 0 };
      },
      onOutputAudioDelta: (event) => {
        const output = state.liveMode ? state.liveOutput : undefined;
        if (!output || output.responseId !== event.responseId || event.audio.length === 0) return;
        if (output.bytes + event.audio.length > MAX_AUDIO_BYTES || event.audio.length % 2 !== 0) {
          this.dispose(deviceId, state);
          return;
        }
        output.chunks.push(Buffer.from(event.audio));
        output.bytes += event.audio.length;
      },
      onOutputTextDelta: (event) => {
        if (!event.audioSuppressed && state.pending && state.pending.delta.length < 32_768) {
          state.pending.delta += event.text;
          try { state.pending.onDelta?.(event.text); }
          catch { /* Presentation callbacks cannot break the model session. */ }
        }
        if (!event.audioSuppressed && state.liveMode && state.liveOutput?.responseId === event.responseId
            && state.liveOutput.delta.length + event.text.length <= 32_768) {
          state.liveOutput.delta += event.text;
        }
      },
      onOutputTextDone: (event) => {
        if (!event.audioSuppressed && state.pending && event.text.trim()) state.pending.final = event.text;
        if (!event.audioSuppressed && state.liveMode && state.liveOutput?.responseId === event.responseId && event.text.trim()) {
          state.liveOutput.final = event.text;
        }
      },
      onResponseDone: (event) => {
        const pending = state.pending;
        if (!pending) {
          const output = state.liveOutput;
          if (!output || output.responseId !== event.responseId) return;
          state.liveOutput = undefined;
          if (state.liveMode && output && event.status === "completed" && output.bytes > 0) {
            const text = (output.final ?? output.delta).trim() || "语音回复";
            if (text.length <= 32_768) {
              try { this.options.onLiveReply?.(deviceId, text, Buffer.concat(output.chunks, output.bytes)); }
              catch { /* Device delivery must not break the model session. */ }
            }
          }
          return;
        }
        if (event.status !== "completed") {
          this.fail(state, new Error("Qwen Live response did not complete"));
          this.dispose(deviceId, state);
          return;
        }
        const answer = (pending.final ?? pending.delta).trim();
        if (!answer || answer.length > 32_768) {
          this.fail(state, new Error("Qwen Live returned no valid text reply"));
          this.dispose(deviceId, state);
          return;
        }
        clearTimeout(pending.timer);
        state.pending = undefined;
        state.lastUsed = Date.now();
        pending.resolve(answer);
      },
      onFunctionCall: () => {
        this.fail(state, new Error("Qwen Live emitted an unconfigured tool call"));
        this.dispose(deviceId, state);
      },
      onError: () => {
        if (state.liveMode && this.sessions.get(deviceId) === state) this.noteLiveFailure(deviceId);
        this.fail(state, new Error("Qwen Live provider error"));
        this.dispose(deviceId, state);
      },
      onClose: () => {
        if (state.liveMode && this.sessions.get(deviceId) === state) this.noteLiveFailure(deviceId);
        this.fail(state, new Error("Qwen Live connection closed"));
        this.dispose(deviceId, state);
      }
    }).then((live) => {
      if (this.closed || this.sessions.get(deviceId) !== state) {
        live.close();
        throw new Error("Qwen Live session no longer active");
      }
      state.live = live;
      this.retryAt.delete(deviceId);
      return live;
    }).finally(() => { state.opening = undefined; });
    return state.opening;
  }

  private fail(state: DeviceSession, error: Error): void {
    const pending = state.pending;
    if (!pending) return;
    clearTimeout(pending.timer);
    state.pending = undefined;
    pending.reject(error);
  }

  private dispose(deviceId: string, state: DeviceSession): void {
    if (this.sessions.get(deviceId) !== state) return;
    this.sessions.delete(deviceId);
    const live = state.live;
    state.live = undefined;
    live?.close();
  }

  private noteLiveFailure(deviceId: string): void {
    const failures = Math.min(6, (this.retryAt.get(deviceId)?.failures ?? 0) + 1);
    this.retryAt.set(deviceId, { failures, at: Date.now() + Math.min(30_000, 1000 * 2 ** failures) });
  }

  private reapIdle(): void {
    const now = Date.now();
    for (const [deviceId, state] of this.sessions) {
      if (!state.pending && !state.opening && now - state.lastUsed > SESSION_IDLE_MS) {
        this.dispose(deviceId, state);
      }
    }
  }
}
