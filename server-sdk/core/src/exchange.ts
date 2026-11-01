import { nanoid } from "nanoid";
import type { AgentGateway } from "./gateway.js";
import { GELATO_PROTOCOL, type ProtocolEnvelope } from "./types.js";

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "media"; streamId: string; mimeType: string };

export interface DeviceInput {
  kind: "instruction" | "observation";
  parts: ContentPart[];
}

/** Optional, authenticated media attached to a user-facing reply. */
export interface ReplyAudio {
  streamId: string;
  mimeType: "audio/pcm";
  sampleRateHz: 24000;
  channels: 1;
  sizeBytes: number;
  sha256: string;
}

export function parseDeviceInput(value: unknown): DeviceInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid input body");
  const body = value as Record<string, unknown>;
  if (body.kind !== "instruction" && body.kind !== "observation") throw new Error("Invalid input kind");
  if (Object.keys(body).some(key => key !== "kind" && key !== "parts")) throw new Error("Invalid input body");
  return { kind: body.kind, parts: parseContentParts(body.parts) };
}

export function parseContentParts(value: unknown): ContentPart[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) throw new Error("Invalid content parts");
  return value.map((part: unknown) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) throw new Error("Invalid content part");
    const item = part as Record<string, unknown>;
    if (item.type === "text" && typeof item.text === "string"
        && item.text.trim().length > 0 && item.text.length <= 16_384
        && Object.keys(item).every(key => key === "type" || key === "text")) {
      return { type: "text", text: item.text };
    }
    if (item.type === "media" && typeof item.streamId === "string"
        && /^str_[A-Za-z0-9_-]{10,80}$/.test(item.streamId)
        && typeof item.mimeType === "string" && item.mimeType.length <= 200
        && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(item.mimeType)
        && Object.keys(item).every(key => ["type", "streamId", "mimeType"].includes(key))) {
      return { type: "media", streamId: item.streamId, mimeType: item.mimeType };
    }
    throw new Error("Invalid content part");
  });
}

export function deliverReply(
  gateway: AgentGateway,
  deviceId: string,
  text: string,
  inReplyTo?: string,
  audio?: ReplyAudio
): string {
  if (typeof text !== "string" || !text.trim() || text.length > 32_768) throw new Error("Invalid reply text");
  if (inReplyTo !== undefined && !/^msg_[A-Za-z0-9_-]{10,80}$/.test(inReplyTo)) {
    throw new Error("Invalid input message ID");
  }
  if (audio && (!/^str_[A-Za-z0-9_-]{10,80}$/.test(audio.streamId)
      || audio.mimeType !== "audio/pcm" || audio.sampleRateHz !== 24000
      || audio.channels !== 1 || !Number.isSafeInteger(audio.sizeBytes)
      || audio.sizeBytes < 2 || audio.sizeBytes > 8 * 1024 * 1024
      || !/^[a-f0-9]{64}$/.test(audio.sha256))) {
    throw new Error("Invalid reply audio");
  }
  const messageId = `msg_${nanoid(24)}`;
  const message: ProtocolEnvelope = {
    protocol: GELATO_PROTOCOL,
    type: "reply.deliver",
    messageId,
    deviceId,
    sentAt: new Date().toISOString(),
    body: { text, ...(inReplyTo ? { inReplyTo } : {}), ...(audio ? { audio } : {}) }
  };
  gateway.send(deviceId, message);
  return messageId;
}
