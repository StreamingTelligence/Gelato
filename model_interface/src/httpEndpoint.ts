import type { ModelEndpoint, ModelRequest } from "./types.js";

/** Small one-shot HTTP adapter; it does not claim gelato.model.v1 support. */
export class HttpModelEndpoint implements ModelEndpoint {
  private readonly url: string;

  constructor(private readonly options: {
    url: string;
    apiKey?: string;
    model?: string;
    timeoutMs?: number;
  }) {
    const parsed = new URL(options.url);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
    if ((parsed.protocol !== "https:" && !(loopback && parsed.protocol === "http:"))
        || parsed.username || parsed.password || parsed.hash) {
      throw new Error("Model endpoint must be HTTPS or loopback HTTP, without URL credentials");
    }
    this.url = parsed.toString();
  }

  async generate(input: ModelRequest): Promise<string> {
    const response = await fetch(this.url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 60_000),
      headers: {
        "Content-Type": "application/json",
        ...(this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {})
      },
      body: JSON.stringify({ protocol: "gelato.v1", model: this.options.model ?? "",
        input })
    });
    if (!response.ok) throw new Error(`Model endpoint returned HTTP ${response.status}`);
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > 1_000_000) throw new Error("Model response is too large");
    if (!response.body) throw new Error("Model response has no body");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1_000_000) throw new Error("Model response is too large");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const raw = Buffer.concat(chunks, size).toString("utf8");
    const value = JSON.parse(raw) as { text?: unknown };
    if (typeof value.text !== "string" || !value.text.trim() || value.text.length > 32_768) {
      throw new Error("Model endpoint returned an invalid text reply");
    }
    return value.text;
  }
}
