import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GelatoClient, GelatoError, GelatoHost } from "../../server-sdk/core/src/client.js";

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init
  });
}

describe("GelatoClient", () => {
  afterEach(() => vi.restoreAllMocks());

  it("accepts safe endpoints and rejects credential-bearing or remote HTTP URLs", () => {
    expect(() => new GelatoClient("http://127.0.0.1:8080", "token")).not.toThrow();
    expect(() => new GelatoClient("http://localhost:8080", "token")).not.toThrow();
    expect(() => new GelatoClient("https://api.example.test", "token")).not.toThrow();
    for (const url of [
      "http://api.example.test",
      "ftp://api.example.test",
      "https://user:pass@api.example.test",
      "https://api.example.test?token=secret",
      "https://api.example.test/#secret"
    ]) {
      expect(() => new GelatoClient(url, "token")).toThrow();
    }
  });

  it("builds bounded authenticated GET and POST requests", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ ok: true }));
    const client = new GelatoClient("https://api.example.test/", "fixed-token", {
      timeoutMs: 1234,
      fetchImpl: fetchImpl as typeof fetch
    });

    await expect(client.request("/health")).resolves.toEqual({ ok: true });
    await expect(client.request("/commands", { hello: "world" })).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenNthCalledWith(1, "https://api.example.test/v1/health", expect.objectContaining({
      method: "GET",
      redirect: "error",
      headers: expect.objectContaining({ authorization: "Bearer fixed-token" })
    }));
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "https://api.example.test/v1/commands", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ hello: "world" })
    }));
    await expect(client.request("https://evil.test/")).rejects.toThrow("Relative API path required");
    await expect(client.request("//evil.test/")).rejects.toThrow("Relative API path required");
  });

  it("uses the host prefix and encodes device and command identifiers", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ devices: [] }));
    const host = new GelatoHost("https://api.example.test", "token", { fetchImpl: fetchImpl as typeof fetch });
    await host.devices();
    await host.command("dev/a", "cmd/a", "screen.capture", {}, 5000);
    await host.status("cmd/a");
    await host.cancel("cmd/a");

    expect(fetchImpl.mock.calls.map(call => call[0])).toEqual([
      "https://api.example.test/harness/v1/devices",
      "https://api.example.test/harness/v1/devices/dev%2Fa/commands",
      "https://api.example.test/harness/v1/commands/cmd%2Fa",
      "https://api.example.test/harness/v1/commands/cmd%2Fa/cancel"
    ]);
  });

  it("turns HTTP errors into GelatoError and rejects empty or oversized responses", async () => {
    const forbidden = new GelatoClient("https://api.example.test", "token", {
      fetchImpl: vi.fn(async () => new Response("denied", { status: 403 })) as typeof fetch
    });
    await expect(forbidden.devices()).rejects.toEqual(expect.objectContaining<Partial<GelatoError>>({
      status: 403,
      code: "gelato_http_403"
    }));

    const empty = new GelatoClient("https://api.example.test", "token", {
      fetchImpl: vi.fn(async () => new Response(null, { status: 200 })) as typeof fetch
    });
    await expect(empty.devices()).rejects.toThrow("Empty response");

    const oversized = new GelatoClient("https://api.example.test", "token", {
      fetchImpl: vi.fn(async () => new Response(new Uint8Array(24 * 1024 * 1024 + 1))) as typeof fetch
    });
    await expect(oversized.devices()).rejects.toThrow("Response size limit exceeded");
  });

  it("validates observation cursors, ownership, and checksums", async () => {
    const data = Buffer.from("frame");
    const valid = {
      schema: "gelato.observation-batch.v1",
      epoch: "epoch-1",
      cursor: 1,
      oldest_sequence: 1,
      gap: false,
      frames: [{
        frame_ref: "obs_1", device_id: "dev_observation01", stream_id: "str_observation01",
        sequence: 0, cursor_sequence: 1, captured_at_s: null, source_time_s: null,
        received_at_s: 1, available_at_s: 1, mime_type: "image/jpeg",
        sha256: createHash("sha256").update(data).digest("hex"), data_base64: data.toString("base64")
      }]
    };
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(valid));
    const client = new GelatoClient("https://api.example.test", "token", { fetchImpl: fetchImpl as typeof fetch });

    await expect(client.observe("dev_observation01", { after: 0, epoch: "old epoch" })).resolves.toEqual(valid);
    expect(fetchImpl.mock.calls[0][0]).toContain("epoch=old%20epoch");
    await expect(client.observe("dev_observation01", { after: -1 })).rejects.toThrow("Invalid observation cursor");

    valid.frames[0].device_id = "dev_otherdevice01";
    await expect(client.observe("dev_observation01")).rejects.toThrow("Observation device or checksum mismatch");
    valid.frames[0].device_id = "dev_observation01";
    valid.frames[0].sha256 = "0".repeat(64);
    await expect(client.observe("dev_observation01")).rejects.toThrow("Observation device or checksum mismatch");
  });
});
