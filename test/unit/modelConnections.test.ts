import { describe, expect, it } from "vitest";
import { createModelConnection } from "../../model_interface/src/connections.js";
import { HttpModelEndpoint } from "../../model_interface/src/httpEndpoint.js";
import { ModelSessionEndpoint } from "../../model_interface/src/modelSessionEndpoint.js";

describe("createModelConnection", () => {
  it("disables models when no provider is configured", async () => {
    await expect(createModelConnection({ env: {} })).resolves.toBeUndefined();
  });

  it("selects safe HTTP and WebSocket adapters from explicit environment", async () => {
    const http = await createModelConnection({
      env: {
        GELATO_MODEL_PROVIDER: "http",
        GELATO_MODEL_ENDPOINT_URL: "http://127.0.0.1:9000/generate",
        GELATO_MODEL_API_KEY: "test-key"
      }
    });
    expect(http?.endpoint).toBeInstanceOf(HttpModelEndpoint);
    expect(http?.interactive).toBeUndefined();

    const ws = await createModelConnection({
      env: {
        GELATO_MODEL_PROVIDER: "codex",
        GELATO_MODEL_SESSION_URL: "ws://127.0.0.1:9001",
        GELATO_MODEL_API_KEY: "test-key"
      }
    });
    expect(ws?.endpoint).toBeInstanceOf(ModelSessionEndpoint);
    expect(ws?.interactive).toBe(true);
    ws?.endpoint.close?.();
  });

  it("infers HTTP only from an endpoint URL and rejects unknown or incomplete providers", async () => {
    const inferred = await createModelConnection({
      env: { GELATO_MODEL_ENDPOINT_URL: "http://127.0.0.1:9000/generate" }
    });
    expect(inferred?.endpoint).toBeInstanceOf(HttpModelEndpoint);

    await expect(createModelConnection({ env: { GELATO_MODEL_PROVIDER: "unknown" } }))
      .rejects.toThrow("must be qwen-live-harness, codex, ws or http");
    await expect(createModelConnection({ env: { GELATO_MODEL_PROVIDER: "qwen-live-harness" } }))
      .rejects.toThrow("DASHSCOPE_API_KEY");
    await expect(createModelConnection({ env: { GELATO_MODEL_PROVIDER: "ws" } }))
      .rejects.toThrow("URL is required");
  });
});
