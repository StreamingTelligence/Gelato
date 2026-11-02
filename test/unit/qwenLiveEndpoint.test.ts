import { afterEach, describe, expect, it, vi } from "vitest";
import { QwenLiveEndpoint } from "../../model_interface/src/qwenLiveEndpoint.js";

type Callbacks = {
  onResponseCreated(event: { responseId: string }): void;
  onOutputAudioDelta(event: { responseId: string; audio: Uint8Array }): void;
  onOutputTextDelta(event: { responseId: string; text: string; audioSuppressed?: boolean }): void;
  onOutputTextDone(event: { responseId: string; text: string; audioSuppressed?: boolean }): void;
  onResponseDone(event: { responseId: string; status: string }): void;
  onFunctionCall(): void;
  onError(): void;
  onClose(): void;
};

function harness(options: { pushAudio?: boolean; commit?: boolean } = {}) {
  let callbacks!: Callbacks;
  const live = {
    resumeUserText: vi.fn(() => true),
    pushAudio: vi.fn(() => options.pushAudio ?? true),
    pushImage: vi.fn(() => true),
    commitInputAudio: vi.fn(() => options.commit ?? true),
    cancelResponse: vi.fn(() => true),
    close: vi.fn()
  };
  const openRuntime = vi.fn(async (_config: Record<string, unknown>, value: Callbacks) => {
    callbacks = value;
    return live;
  });
  const replies: Array<{ deviceId: string; text: string; audio: Buffer }> = [];
  const endpoint = Reflect.construct(QwenLiveEndpoint, [{
    apiKey: "test-qwen-key",
    onLiveReply: (deviceId: string, text: string, audio: Buffer) => replies.push({ deviceId, text, audio })
  }, openRuntime]) as QwenLiveEndpoint;
  return { endpoint, openRuntime, live, replies, get callbacks() { return callbacks; } };
}

describe("QwenLiveEndpoint", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("rejects missing credentials and unsafe provider URLs before loading a runtime", async () => {
    await expect(QwenLiveEndpoint.create({ apiKey: "" })).rejects.toThrow("DASHSCOPE_API_KEY");
    for (const endpoint of [
      "http://provider.example.test",
      "ftp://provider.example.test",
      "https://user:pass@provider.example.test",
      "https://provider.example.test/#token",
      "https://provider.example.test/?api_key=secret"
    ]) {
      await expect(QwenLiveEndpoint.create({ apiKey: "key", endpoint })).rejects.toThrow();
    }
  });

  it("streams text deltas and resolves a bounded final reply", async () => {
    const test = harness();
    const deltas: string[] = [];
    const result = test.endpoint.generate({
      deviceId: "dev_qwendevice0001",
      messageId: "msg_qwenmessage001",
      parts: [{ type: "text", text: "hello" }]
    }, { onDelta: value => deltas.push(value) });
    await vi.waitFor(() => expect(test.live.resumeUserText).toHaveBeenCalledOnce());
    expect(test.openRuntime.mock.calls[0][0]).toMatchObject({
      endpoint: "https://dashscope.aliyuncs.com",
      model: "qwen3.8-omni-flash-realtime",
      voice: "Tina",
      tools: []
    });
    test.callbacks.onOutputTextDelta({ responseId: "response-1", text: "partial" });
    test.callbacks.onOutputTextDone({ responseId: "response-1", text: "final answer" });
    test.callbacks.onResponseDone({ responseId: "response-1", status: "completed" });
    await expect(result).resolves.toBe("final answer");
    expect(deltas).toEqual(["partial"]);
    test.endpoint.close();
  });

  it("validates media types and chunks PCM16 audio before committing", async () => {
    const test = harness();
    await expect(test.endpoint.generate({
      deviceId: "dev_qwendevice0001",
      messageId: "msg_qwenmessage002",
      parts: [{ type: "media", mimeType: "image/jpeg", dataBase64: "aGVsbG8=" }]
    })).rejects.toThrow("text or 16 kHz");
    await expect(test.endpoint.generate({
      deviceId: "dev_qwendevice0001",
      messageId: "msg_qwenmessage003",
      parts: [
        { type: "text", text: "mixed" },
        { type: "media", mimeType: "audio/pcm", dataBase64: Buffer.from([0, 0]).toString("base64") }
      ]
    })).rejects.toThrow("mixed");

    const audio = Buffer.alloc(32 * 1024 * 2 + 2);
    const result = test.endpoint.generate({
      deviceId: "dev_qwendevice0001",
      messageId: "msg_qwenmessage004",
      parts: [{ type: "media", mimeType: "audio/pcm", dataBase64: audio.toString("base64") }]
    });
    await vi.waitFor(() => expect(test.live.commitInputAudio).toHaveBeenCalledOnce());
    expect(test.live.pushAudio).toHaveBeenCalledTimes(3);
    test.callbacks.onOutputTextDone({ responseId: "response-2", text: "audio answer" });
    test.callbacks.onResponseDone({ responseId: "response-2", status: "completed" });
    await expect(result).resolves.toBe("audio answer");
    test.endpoint.close();
  });

  it("rejects invalid PCM, refused input, provider errors, and incomplete replies", async () => {
    let test = harness();
    await expect(test.endpoint.generate({
      deviceId: "dev_qwendevice0001",
      messageId: "msg_qwenmessage005",
      parts: [{ type: "media", mimeType: "audio/pcm", dataBase64: Buffer.from([1]).toString("base64") }]
    })).rejects.toThrow("Invalid PCM16");

    test = harness({ pushAudio: false });
    await expect(test.endpoint.generate({
      deviceId: "dev_qwendevice0002",
      messageId: "msg_qwenmessage006",
      parts: [{ type: "media", mimeType: "audio/pcm", dataBase64: Buffer.from([0, 0]).toString("base64") }]
    })).rejects.toThrow("not accepted");

    test = harness();
    const failed = test.endpoint.generate({
      deviceId: "dev_qwendevice0003",
      messageId: "msg_qwenmessage007",
      parts: [{ type: "text", text: "fail" }]
    });
    await vi.waitFor(() => expect(test.live.resumeUserText).toHaveBeenCalledOnce());
    test.callbacks.onError();
    await expect(failed).rejects.toThrow("provider error");

    test = harness();
    const incomplete = test.endpoint.generate({
      deviceId: "dev_qwendevice0004",
      messageId: "msg_qwenmessage008",
      parts: [{ type: "text", text: "empty" }]
    });
    await vi.waitFor(() => expect(test.live.resumeUserText).toHaveBeenCalledOnce());
    test.callbacks.onResponseDone({ responseId: "response-3", status: "completed" });
    await expect(incomplete).rejects.toThrow("no valid text");
  });

  it("supports bounded live audio/image evidence and emits one live reply", async () => {
    const test = harness();
    const audio = Buffer.from([0, 0, 1, 0]);
    expect(test.endpoint.pushLiveAudio("dev_qwenlive0001", audio)).toBe(false);
    await vi.waitFor(() => expect(test.openRuntime).toHaveBeenCalledOnce());
    expect(test.endpoint.pushLiveAudio("dev_qwenlive0001", audio)).toBe(true);
    expect(test.endpoint.pushLiveAudio("dev_qwenlive0001", Buffer.from([1]))).toBe(false);
    expect(test.endpoint.pushLiveImage("dev_qwenlive0001", Buffer.from("not-jpeg"))).toBe(false);
    const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9]);
    expect(test.endpoint.pushLiveImage("dev_qwenlive0001", jpeg)).toBe(true);

    test.callbacks.onResponseCreated({ responseId: "live-response" });
    test.callbacks.onOutputAudioDelta({ responseId: "live-response", audio: new Uint8Array([0, 0, 1, 0]) });
    test.callbacks.onOutputTextDone({ responseId: "live-response", text: "live answer" });
    test.callbacks.onResponseDone({ responseId: "live-response", status: "completed" });
    expect(test.replies).toEqual([{
      deviceId: "dev_qwenlive0001",
      text: "live answer",
      audio: Buffer.from([0, 0, 1, 0])
    }]);
    test.endpoint.stopLive("dev_qwenlive0001");
    expect(test.live.close).toHaveBeenCalledOnce();
    test.endpoint.close();
  });

  it("rejects a pending turn and all future work when closed", async () => {
    const test = harness();
    const pending = test.endpoint.generate({
      deviceId: "dev_qwenclose0001",
      messageId: "msg_qwenmessage009",
      parts: [{ type: "text", text: "pending" }]
    });
    await vi.waitFor(() => expect(test.live.resumeUserText).toHaveBeenCalledOnce());
    test.endpoint.close();
    await expect(pending).rejects.toThrow("closed");
    expect(test.live.close).toHaveBeenCalledOnce();
    await expect(test.endpoint.generate({
      deviceId: "dev_qwenclose0001",
      messageId: "msg_qwenmessage010",
      parts: [{ type: "text", text: "again" }]
    })).rejects.toThrow("closed");
    expect(test.endpoint.pushLiveAudio("dev_qwenclose0001", Buffer.from([0, 0]))).toBe(false);
  });
});
