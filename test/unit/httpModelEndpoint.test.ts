import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpModelEndpoint } from "../../model_interface/src/httpEndpoint.js";

const input = {
  deviceId: "dev_modeldevice001",
  messageId: "msg_modelmessage001",
  parts: [{ type: "text" as const, text: "hello" }]
};

describe("HttpModelEndpoint", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("requires HTTPS except for loopback and forbids URL credentials", () => {
    expect(() => new HttpModelEndpoint({ url: "http://127.0.0.1:9000/generate" })).not.toThrow();
    expect(() => new HttpModelEndpoint({ url: "https://model.example.test/generate" })).not.toThrow();
    for (const url of [
      "http://model.example.test/generate",
      "ftp://model.example.test/generate",
      "https://user:pass@model.example.test/generate",
      "https://model.example.test/generate#secret"
    ]) {
      expect(() => new HttpModelEndpoint({ url })).toThrow();
    }
  });

  it("sends a bounded authenticated request and returns valid text", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ text: "model reply" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);
    const endpoint = new HttpModelEndpoint({
      url: "https://model.example.test/generate",
      apiKey: "secret-key",
      model: "fake-model",
      timeoutMs: 4321
    });

    await expect(endpoint.generate(input)).resolves.toBe("model reply");
    expect(fetchMock).toHaveBeenCalledWith("https://model.example.test/generate", expect.objectContaining({
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer secret-key"
      },
      body: JSON.stringify({ protocol: "gelato.v1", model: "fake-model", input })
    }));
  });

  it("rejects upstream HTTP failures, missing bodies, and declared oversized replies", async () => {
    const endpoint = new HttpModelEndpoint({ url: "https://model.example.test/generate" });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
    await expect(endpoint.generate(input)).rejects.toThrow("HTTP 503");

    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
    await expect(endpoint.generate(input)).rejects.toThrow("no body");

    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", {
      status: 200,
      headers: { "content-length": "1000001" }
    })));
    await expect(endpoint.generate(input)).rejects.toThrow("too large");
  });

  it("enforces streamed size and validates JSON reply text", async () => {
    const endpoint = new HttpModelEndpoint({ url: "https://model.example.test/generate" });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(600_000));
        controller.enqueue(new Uint8Array(400_001));
        controller.close();
      }
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream)));
    await expect(endpoint.generate(input)).rejects.toThrow("too large");

    for (const body of ["not-json", "{}", JSON.stringify({ text: "   " }), JSON.stringify({ text: "x".repeat(32_769) })]) {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(body)));
      await expect(endpoint.generate(input)).rejects.toThrow();
    }
  });
});
