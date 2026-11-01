import fs from "node:fs/promises";
import type { AgentGateway } from "./gateway.js";
import { deliverReply, parseDeviceInput, type ContentPart } from "./exchange.js";
import type { StreamBroker } from "./streamBroker.js";
import type { ProtocolEnvelope } from "./types.js";
import type { ModelEndpoint, ModelPart } from "@gelato/model-interface";

/** Connects device input/replies to a provider-neutral model endpoint. */
export class ModelBridge {
  private readonly listener = (message: ProtocolEnvelope) => { void this.handle(message); };
  private readonly inFlight = new Set<string>();
  private readonly recent = new Map<string, number[]>();

  constructor(
    private readonly gateway: AgentGateway,
    private readonly streams: StreamBroker,
    private readonly endpoint: ModelEndpoint
  ) {
    gateway.on("input", this.listener);
  }

  close(): void {
    this.gateway.off("input", this.listener);
    this.endpoint.close?.();
  }

  private async handle(message: ProtocolEnvelope): Promise<void> {
    const input = parseDeviceInput(message.body);
    if (input.kind !== "instruction" || !message.deviceId) return;
    const deviceId = message.deviceId;
    const now = Date.now();
    for (const [id, times] of this.recent) {
      const active = times.filter(time => now - time < 60_000);
      if (active.length) this.recent.set(id, active);
      else this.recent.delete(id);
    }
    const times = this.recent.get(deviceId) ?? [];
    if (this.inFlight.has(deviceId) || this.inFlight.size >= 4 || times.length >= 20) {
      this.safeReply(deviceId, "The model is busy. Please retry shortly.", message.messageId);
      return;
    }
    times.push(now);
    this.recent.set(deviceId, times);
    this.inFlight.add(deviceId);
    try {
      const parts: ModelPart[] = [];
      let mediaBytes = 0;
      for (const part of input.parts) {
        const converted = await this.modelPart(deviceId, part);
        if (converted.type === "media") {
          mediaBytes += Buffer.byteLength(converted.dataBase64, "base64");
          if (mediaBytes > 8 * 1024 * 1024) throw new Error("Media input is too large");
        }
        parts.push(converted);
      }
      const text = await this.endpoint.generate({ deviceId, messageId: message.messageId, parts });
      this.safeReply(deviceId, text, message.messageId);
    } catch {
      // Never send model credentials, request content, or upstream diagnostics to a device.
      this.safeReply(deviceId, "The model endpoint is unavailable.", message.messageId);
    } finally {
      this.inFlight.delete(deviceId);
    }
  }

  private safeReply(deviceId: string, text: string, inReplyTo: string): void {
    try { deliverReply(this.gateway, deviceId, text, inReplyTo); }
    catch { /* The device may have disconnected before delivery. */ }
  }

  private async modelPart(deviceId: string, part: ContentPart): Promise<ModelPart> {
    if (part.type === "text") return part;
    const stream = this.streams.get(part.streamId);
    const file = this.streams.file(part.streamId);
    if (!stream || !file || stream.deviceId !== deviceId || stream.contentType !== part.mimeType) {
      throw new Error("Media reference is unavailable");
    }
    const stat = await fs.stat(file);
    if (stat.size < 1 || stat.size > 8 * 1024 * 1024) throw new Error("Media reference is too large");
    const bytes = await fs.readFile(file);
    if (bytes.length > 8 * 1024 * 1024) throw new Error("Media reference is too large");
    return { type: "media", mimeType: part.mimeType, dataBase64: bytes.toString("base64") };
  }
}
