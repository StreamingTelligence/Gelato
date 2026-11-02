import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelEndpoint } from "../../model_interface/src/types.js";
import type { AgentGateway } from "../../server-sdk/core/src/gateway.js";
import { ModelBridge } from "../../server-sdk/core/src/modelBridge.js";
import type { StreamBroker } from "../../server-sdk/core/src/streamBroker.js";
import type { ProtocolEnvelope } from "../../server-sdk/core/src/types.js";
import { message, tempDirectory } from "../helpers.js";

class FakeGateway extends EventEmitter {
  readonly send = vi.fn();
}

function input(deviceId: string, index: number, parts: Array<Record<string, unknown>>): ProtocolEnvelope {
  return message("input.publish", { kind: "instruction", parts }, {
    deviceId,
    messageId: `msg_modelinput${String(index).padStart(4, "0")}`
  });
}

describe("ModelBridge", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    vi.restoreAllMocks();
  });

  it("converts text input and delivers a correlated model reply", async () => {
    const gateway = new FakeGateway();
    const endpoint: ModelEndpoint = { generate: vi.fn(async () => "model reply") };
    const bridge = new ModelBridge(gateway as unknown as AgentGateway, {} as StreamBroker, endpoint);

    gateway.emit("input", input("dev_modeldevice001", 1, [{ type: "text", text: "hello" }]));
    await vi.waitFor(() => expect(endpoint.generate).toHaveBeenCalledOnce());
    expect(endpoint.generate).toHaveBeenCalledWith({
      deviceId: "dev_modeldevice001",
      messageId: "msg_modelinput0001",
      parts: [{ type: "text", text: "hello" }]
    });
    await vi.waitFor(() => expect(gateway.send).toHaveBeenCalledOnce());
    expect(gateway.send.mock.calls[0][1]).toMatchObject({
      type: "reply.deliver",
      deviceId: "dev_modeldevice001",
      body: { text: "model reply", inReplyTo: "msg_modelinput0001" }
    });
    bridge.close();
  });

  it("loads only media owned by the requesting device with the declared MIME type", async () => {
    const directory = tempDirectory("gelato-model-bridge-");
    cleanups.push(directory.cleanup);
    const file = join(directory.path, "media.bin");
    writeFileSync(file, "media-bytes");
    const gateway = new FakeGateway();
    const endpoint: ModelEndpoint = { generate: vi.fn(async () => "ok") };
    const streams = {
      get: vi.fn(() => ({
        streamId: "str_modelmedia001", deviceId: "dev_modeldevice001", contentType: "image/jpeg"
      })),
      file: vi.fn(() => file)
    };
    const bridge = new ModelBridge(gateway as unknown as AgentGateway, streams as unknown as StreamBroker, endpoint);

    gateway.emit("input", input("dev_modeldevice001", 2, [
      { type: "text", text: "describe" },
      { type: "media", streamId: "str_modelmedia001", mimeType: "image/jpeg" }
    ]));
    await vi.waitFor(() => expect(endpoint.generate).toHaveBeenCalledOnce());
    expect(endpoint.generate).toHaveBeenCalledWith(expect.objectContaining({
      parts: [
        { type: "text", text: "describe" },
        { type: "media", mimeType: "image/jpeg", dataBase64: Buffer.from("media-bytes").toString("base64") }
      ]
    }));
    bridge.close();
  });

  it("rejects missing, cross-device, mismatched, empty, and oversized media without calling the model", async () => {
    const directory = tempDirectory("gelato-model-bridge-errors-");
    cleanups.push(directory.cleanup);
    const empty = join(directory.path, "empty.bin");
    const large = join(directory.path, "large.bin");
    writeFileSync(empty, "");
    writeFileSync(large, Buffer.alloc(8 * 1024 * 1024 + 1));
    const cases = [
      { record: undefined, file: undefined },
      { record: { deviceId: "dev_otherdevice001", contentType: "image/jpeg" }, file: empty },
      { record: { deviceId: "dev_modeldevice001", contentType: "image/png" }, file: empty },
      { record: { deviceId: "dev_modeldevice001", contentType: "image/jpeg" }, file: empty },
      { record: { deviceId: "dev_modeldevice001", contentType: "image/jpeg" }, file: large }
    ];

    for (const [index, value] of cases.entries()) {
      const gateway = new FakeGateway();
      const endpoint: ModelEndpoint = { generate: vi.fn(async () => "must not run") };
      const streams = { get: vi.fn(() => value.record), file: vi.fn(() => value.file) };
      const bridge = new ModelBridge(gateway as unknown as AgentGateway, streams as unknown as StreamBroker, endpoint);
      gateway.emit("input", input("dev_modeldevice001", 10 + index, [
        { type: "media", streamId: "str_modelmedia001", mimeType: "image/jpeg" }
      ]));
      await vi.waitFor(() => expect(gateway.send).toHaveBeenCalledOnce());
      expect(endpoint.generate).not.toHaveBeenCalled();
      expect(gateway.send.mock.calls[0][1]).toMatchObject({
        body: { text: "The model endpoint is unavailable." }
      });
      bridge.close();
    }
  });

  it("limits per-device and global concurrency", async () => {
    const gateway = new FakeGateway();
    const resolvers: Array<(value: string) => void> = [];
    const endpoint: ModelEndpoint = {
      generate: vi.fn(() => new Promise<string>(resolve => resolvers.push(resolve)))
    };
    const bridge = new ModelBridge(gateway as unknown as AgentGateway, {} as StreamBroker, endpoint);

    gateway.emit("input", input("dev_modeldevice001", 30, [{ type: "text", text: "first" }]));
    gateway.emit("input", input("dev_modeldevice001", 31, [{ type: "text", text: "duplicate" }]));
    for (let index = 2; index <= 5; index++) {
      gateway.emit("input", input(`dev_modeldevice00${index}`, 30 + index, [{ type: "text", text: "parallel" }]));
    }

    await vi.waitFor(() => expect(endpoint.generate).toHaveBeenCalledTimes(4));
    await vi.waitFor(() => expect(gateway.send).toHaveBeenCalledTimes(2));
    for (const call of gateway.send.mock.calls) {
      expect(call[1]).toMatchObject({ body: { text: "The model is busy. Please retry shortly." } });
    }
    for (const resolve of resolvers) resolve("done");
    await vi.waitFor(() => expect(gateway.send).toHaveBeenCalledTimes(6));
    bridge.close();
  });

  it("rate limits the twenty-first request in a minute and recovers after the window", async () => {
    let now = Date.parse("2026-01-01T00:00:00Z");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const gateway = new FakeGateway();
    const endpoint: ModelEndpoint = { generate: vi.fn(async () => "ok") };
    const bridge = new ModelBridge(gateway as unknown as AgentGateway, {} as StreamBroker, endpoint);

    for (let index = 0; index < 20; index++) {
      gateway.emit("input", input("dev_modeldevice001", 100 + index, [{ type: "text", text: "request" }]));
      await Promise.resolve();
      await Promise.resolve();
    }
    expect(endpoint.generate).toHaveBeenCalledTimes(20);
    gateway.emit("input", input("dev_modeldevice001", 121, [{ type: "text", text: "limited" }]));
    await Promise.resolve();
    expect(endpoint.generate).toHaveBeenCalledTimes(20);
    expect(gateway.send.mock.calls.at(-1)?.[1]).toMatchObject({
      body: { text: "The model is busy. Please retry shortly." }
    });

    now += 60_001;
    gateway.emit("input", input("dev_modeldevice001", 122, [{ type: "text", text: "retry" }]));
    await Promise.resolve();
    expect(endpoint.generate).toHaveBeenCalledTimes(21);
    bridge.close();
  });

  it("sanitizes upstream failures, tolerates a disconnected device, and closes cleanly", async () => {
    const gateway = new FakeGateway();
    gateway.send.mockImplementation(() => { throw new Error("device disconnected"); });
    const close = vi.fn();
    const endpoint: ModelEndpoint = {
      generate: vi.fn(async () => { throw new Error("API key secret-key and private prompt"); }),
      close
    };
    const bridge = new ModelBridge(gateway as unknown as AgentGateway, {} as StreamBroker, endpoint);

    gateway.emit("input", input("dev_modeldevice001", 200, [{ type: "text", text: "private prompt" }]));
    await vi.waitFor(() => expect(gateway.send).toHaveBeenCalledOnce());
    expect(gateway.send.mock.calls[0][1]).toMatchObject({
      body: { text: "The model endpoint is unavailable." }
    });
    bridge.close();
    expect(close).toHaveBeenCalledOnce();
    expect(gateway.listenerCount("input")).toBe(0);
    gateway.emit("input", input("dev_modeldevice001", 201, [{ type: "text", text: "ignored" }]));
    expect(endpoint.generate).toHaveBeenCalledOnce();
  });
});
