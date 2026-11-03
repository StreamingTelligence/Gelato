import { HttpModelEndpoint } from "./httpEndpoint.js";
import { ModelSessionEndpoint, type ModelActionOutcome, type ModelActionProposal } from "./modelSessionEndpoint.js";
import { QwenLiveEndpoint } from "./qwenLiveEndpoint.js";
import { StreamingTelligenceEndpoint } from "./streamingTelligenceEndpoint.js";
import type { ModelEndpoint } from "./types.js";

/** Optional realtime input shared by adapters that actually support it. */
export interface LiveModelInput {
  pushAudio(deviceId: string, pcm16: Buffer): boolean;
  pushImage(deviceId: string, jpeg: Buffer): boolean;
  stop(deviceId: string): void;
}

export interface ModelConnection {
  endpoint: ModelEndpoint;
  live?: LiveModelInput;
  continuousVisual?: boolean;
  interactive?: boolean;
}

export interface ModelConnectionOptions {
  env: NodeJS.ProcessEnv;
  onAction?: (proposal: ModelActionProposal, signal: AbortSignal) => Promise<ModelActionOutcome>;
  onLiveReply?: (deviceId: string, text: string, pcm16: Buffer) => void;
}

/** Provider selection lives here, not in a Controller or device implementation. */
export async function createModelConnection(options: ModelConnectionOptions): Promise<ModelConnection | undefined> {
  const env = options.env;
  const selected = env.GELATO_MODEL_PROVIDER?.trim() ?? "";
  const provider = selected || (env.GELATO_MODEL_ENDPOINT_URL ? "http" : "");
  if (!provider) return undefined;
  if (provider === "streamingtelligence") {
    const endpoint = new StreamingTelligenceEndpoint({
      apiKey: env.STREAMINGTELLIGENCE_API_KEY ?? "",
      model: env.STREAMINGTELLIGENCE_MODEL ?? "kairos-v2",
      origin: env.STREAMINGTELLIGENCE_ORIGIN,
      maxNewTokens: env.STREAMINGTELLIGENCE_MAX_NEW_TOKENS
        ? Number(env.STREAMINGTELLIGENCE_MAX_NEW_TOKENS) : undefined
    });
    return { endpoint, continuousVisual: true, live: {
      pushAudio: () => false,
      pushImage: (deviceId, jpeg) => endpoint.pushLiveImage(deviceId, jpeg),
      stop: deviceId => endpoint.stopLive(deviceId)
    } };
  }
  if (provider === "qwen-live-harness") {
    const endpoint = await QwenLiveEndpoint.create({
      apiKey: env.DASHSCOPE_API_KEY ?? "",
      endpoint: env.QWEN_LIVE_ENDPOINT,
      model: env.QWEN_LIVE_MODEL,
      voice: env.QWEN_LIVE_VOICE,
      onLiveReply: options.onLiveReply
    });
    return { endpoint, live: {
      pushAudio: (deviceId, pcm16) => endpoint.pushLiveAudio(deviceId, pcm16),
      pushImage: (deviceId, jpeg) => endpoint.pushLiveImage(deviceId, jpeg),
      stop: deviceId => endpoint.stopLive(deviceId)
    } };
  }
  if (provider === "codex" || provider === "ws") {
    return { interactive: true, endpoint: new ModelSessionEndpoint({
      url: env.GELATO_MODEL_SESSION_URL ?? "",
      apiKey: env.GELATO_MODEL_API_KEY ?? "",
      model: env.GELATO_MODEL_ID,
      responseTimeoutMs: 6 * 60_000,
      onAction: options.onAction
    }) };
  }
  if (provider === "http") {
    return { endpoint: new HttpModelEndpoint({
      url: env.GELATO_MODEL_ENDPOINT_URL ?? "",
      apiKey: env.GELATO_MODEL_API_KEY,
      model: env.GELATO_MODEL_ID
    }) };
  }
  throw new Error("GELATO_MODEL_PROVIDER must be streamingtelligence, qwen-live-harness, codex, ws or http");
}
