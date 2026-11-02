import { describe, expect, it, vi } from "vitest";
import { deliverReply, parseContentParts, parseDeviceInput } from "../../server-sdk/core/src/exchange.js";
import type { AgentGateway } from "../../server-sdk/core/src/gateway.js";

describe("device input and replies", () => {
  it("parses text and media input without preserving unknown fields", () => {
    expect(parseDeviceInput({
      kind: "observation",
      parts: [
        { type: "text", text: "screen changed" },
        { type: "media", streamId: "str_teststream001", mimeType: "image/jpeg" }
      ]
    })).toEqual({
      kind: "observation",
      parts: [
        { type: "text", text: "screen changed" },
        { type: "media", streamId: "str_teststream001", mimeType: "image/jpeg" }
      ]
    });
    expect(parseContentParts([{ type: "text", text: "hello" }])).toEqual([{ type: "text", text: "hello" }]);
  });

  it.each([
    undefined,
    {},
    { kind: "invalid", parts: [{ type: "text", text: "x" }] },
    { kind: "instruction", parts: [] },
    { kind: "instruction", parts: Array.from({ length: 9 }, () => ({ type: "text", text: "x" })) },
    { kind: "instruction", parts: [{ type: "text", text: " " }] },
    { kind: "instruction", parts: [{ type: "media", streamId: "bad", mimeType: "image/jpeg" }] },
    { kind: "instruction", parts: [{ type: "media", streamId: "str_teststream001", mimeType: "bad" }] },
    { kind: "instruction", parts: [{ type: "text", text: "x", extra: true }] },
    { kind: "instruction", parts: [{ type: "text", text: "x" }], extra: true }
  ])("rejects malformed input %#", (value) => {
    expect(() => parseDeviceInput(value)).toThrow();
  });

  it("delivers a bounded reply and optional audio metadata", () => {
    const send = vi.fn();
    const gateway = { send } as unknown as AgentGateway;
    const id = deliverReply(gateway, "dev_testdevice0001", "done", "msg_testmessage001", {
      streamId: "str_teststream001",
      mimeType: "audio/pcm",
      sampleRateHz: 24_000,
      channels: 1,
      sizeBytes: 2,
      sha256: "a".repeat(64)
    });
    expect(id).toMatch(/^msg_/);
    expect(send).toHaveBeenCalledWith("dev_testdevice0001", expect.objectContaining({
      type: "reply.deliver",
      body: expect.objectContaining({ text: "done", inReplyTo: "msg_testmessage001" })
    }));
  });

  it.each([
    ["", undefined, undefined],
    ["ok", "bad", undefined],
    ["ok", undefined, { streamId: "bad", mimeType: "audio/pcm", sampleRateHz: 24_000, channels: 1, sizeBytes: 2, sha256: "a".repeat(64) }],
    ["ok", undefined, { streamId: "str_teststream001", mimeType: "audio/pcm", sampleRateHz: 16_000, channels: 1, sizeBytes: 2, sha256: "a".repeat(64) }]
  ])("rejects invalid replies %#", (text, replyTo, audio) => {
    expect(() => deliverReply({ send: vi.fn() } as unknown as AgentGateway,
      "dev_testdevice0001", text, replyTo, audio as never)).toThrow();
  });
});
