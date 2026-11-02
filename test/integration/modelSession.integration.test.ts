import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { ModelSessionEndpoint, type ModelActionOutcome } from "../../model_interface/src/modelSessionEndpoint.js";

type Event = {
  protocol: string;
  type: string;
  eventId: string;
  sessionId: string;
  seq: number;
  sentAt: string;
  body: Record<string, unknown>;
};

describe("ModelSessionEndpoint integration", () => {
  let http: Server;
  let wss: WebSocketServer;
  let url: string;
  const endpoints: ModelSessionEndpoint[] = [];

  beforeEach(async () => {
    http = createServer();
    wss = new WebSocketServer({ server: http });
    http.listen(0, "127.0.0.1");
    await once(http, "listening");
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP listener");
    url = `ws://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    for (const endpoint of endpoints) endpoint.close();
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });

  function runtime(handler: (event: Event, send: (type: string, body: Record<string, unknown>) => void) => void) {
    wss.on("connection", (socket, request) => {
      expect(request.headers.authorization).toBe("Bearer test-model-token-1234567890");
      let sessionId = "";
      let sequence = 0;
      const send = (type: string, body: Record<string, unknown>) => socket.send(JSON.stringify({
        protocol: "gelato.model.v1",
        type,
        eventId: `event_${String(++sequence).padStart(4, "0")}`,
        sessionId,
        seq: sequence,
        sentAt: new Date().toISOString(),
        body
      }));
      socket.on("message", (raw) => {
        const event = JSON.parse(raw.toString("utf8")) as Event;
        sessionId ||= event.sessionId;
        if (event.type === "session.open") {
          send("session.ready", { capabilities: ["text", "image", "action-proposal"] });
        }
        handler(event, send);
      });
    });
  }

  it("streams deltas and completes a persistent text/image turn", async () => {
    const received: Event[] = [];
    runtime((event, send) => {
      received.push(event);
      if (event.type === "input.commit") {
        const turnId = event.body.turnId;
        send("reply.delta", { turnId, text: "part" });
        send("reply.complete", { turnId, text: "complete answer" });
        send("turn.end", { turnId, status: "completed" });
      }
    });
    const endpoint = new ModelSessionEndpoint({
      url,
      apiKey: "test-model-token-1234567890",
      responseTimeoutMs: 1_000
    });
    endpoints.push(endpoint);
    const deltas: string[] = [];
    await expect(endpoint.generate({
      deviceId: "dev_testdevice0001",
      messageId: "turn_text001",
      parts: [
        { type: "text", text: "hello" },
        { type: "media", mimeType: "image/jpeg", dataBase64: Buffer.from("jpeg").toString("base64") }
      ]
    }, { onDelta: (value) => deltas.push(value) })).resolves.toBe("complete answer");
    expect(deltas).toEqual(["part"]);
    expect(received.map((event) => event.type)).toEqual(expect.arrayContaining([
      "session.open", "input.begin", "input.append", "input.commit"
    ]));
    const media = received.find((event) => event.type === "input.append" && event.body.type === "media");
    expect(media?.body).toMatchObject({ chunkIndex: 0, final: true, mimeType: "image/jpeg" });
  });

  it("routes one action, rejects a duplicate, and reports the outcome", async () => {
    let resolveAction!: (value: ModelActionOutcome) => void;
    const onAction = vi.fn(() => new Promise<ModelActionOutcome>((resolve) => { resolveAction = resolve; }));
    const results: Event[] = [];
    runtime((event, send) => {
      if (event.type === "input.commit") {
        const turnId = event.body.turnId;
        send("action.propose", { turnId, proposalId: "proposal_001", capability: "screen.capture", args: {} });
        send("action.propose", { turnId, proposalId: "proposal_001", capability: "screen.capture", args: {} });
      }
      if (event.type === "action.result") {
        results.push(event);
        if (event.body.status === "rejected") {
          resolveAction({ status: "completed", commandId: "cmd_action00001", result: { ok: true } });
        } else if (event.body.status === "completed") {
          const turnId = event.body.turnId;
          setImmediate(() => {
            send("reply.complete", { turnId, text: "action complete" });
            send("turn.end", { turnId, status: "completed" });
          });
        }
      }
    });
    const endpoint = new ModelSessionEndpoint({
      url,
      apiKey: "test-model-token-1234567890",
      responseTimeoutMs: 1_000,
      onAction
    });
    endpoints.push(endpoint);
    await expect(endpoint.generate({
      deviceId: "dev_testdevice0001",
      messageId: "turn_action01",
      parts: [{ type: "text", text: "capture" }]
    })).resolves.toBe("action complete");
    expect(onAction).toHaveBeenCalledOnce();
    expect(results.map((event) => event.body.status)).toEqual(["rejected", "completed"]);
  });

  it("cancels and rejects a model turn that times out", async () => {
    const received: Event[] = [];
    runtime((event) => { received.push(event); });
    const endpoint = new ModelSessionEndpoint({
      url,
      apiKey: "test-model-token-1234567890",
      responseTimeoutMs: 40
    });
    endpoints.push(endpoint);
    await expect(endpoint.generate({
      deviceId: "dev_testdevice0001",
      messageId: "turn_timeout1",
      parts: [{ type: "text", text: "never answer" }]
    })).rejects.toThrow(/timed out/);
    await vi.waitFor(() => expect(received.some((event) => event.type === "turn.cancel")).toBe(true));
  });

  it("rejects invalid URLs and unsupported model capabilities", async () => {
    expect(() => new ModelSessionEndpoint({ url: "ws://public.example.test", apiKey: "token" }))
      .toThrow(/WSS or loopback/);
    expect(() => new ModelSessionEndpoint({ url: `${url}?token=secret`, apiKey: "token" }))
      .toThrow(/must not contain credentials/);

    wss.on("connection", (socket) => {
      socket.once("message", (raw) => {
        const open = JSON.parse(raw.toString("utf8")) as Event;
        socket.send(JSON.stringify({
          protocol: "gelato.model.v1",
          type: "session.ready",
          eventId: "event_0001",
          sessionId: open.sessionId,
          seq: 1,
          sentAt: new Date().toISOString(),
          body: { capabilities: ["text"] }
        }));
      });
    });
    const endpoint = new ModelSessionEndpoint({ url, apiKey: "test-model-token-1234567890" });
    endpoints.push(endpoint);
    await expect(endpoint.generate({
      deviceId: "dev_testdevice0001",
      messageId: "turn_image001",
      parts: [{ type: "media", mimeType: "image/jpeg", dataBase64: "aGVsbG8=" }]
    })).rejects.toThrow(/does not support image/);
  });

  it("disconnects on binary, malformed, out-of-sequence, or duplicate ready events", async () => {
    wss.on("connection", (socket) => {
      socket.once("message", (raw) => {
        const open = JSON.parse(raw.toString("utf8")) as Event;
        socket.send(Buffer.from("binary-provider-frame"), { binary: true });
        expect(open.type).toBe("session.open");
      });
    });
    let endpoint = new ModelSessionEndpoint({ url, apiKey: "test-model-token-1234567890", responseTimeoutMs: 500 });
    endpoints.push(endpoint);
    await expect(endpoint.generate({
      deviceId: "dev_hostilemodel001",
      messageId: "turn_hostile001",
      parts: [{ type: "text", text: "hello" }]
    })).rejects.toThrow(/unavailable/);

    for (const mode of ["malformed", "sequence", "duplicate-ready"] as const) {
      for (const client of wss.clients) client.terminate();
      wss.removeAllListeners("connection");
      wss.on("connection", (socket) => {
        let sessionId = "";
        socket.on("message", (raw) => {
          const event = JSON.parse(raw.toString("utf8")) as Event;
          sessionId ||= event.sessionId;
          if (event.type === "session.open") {
            socket.send(JSON.stringify({
              protocol: "gelato.model.v1", type: "session.ready", eventId: "event_ready0001",
              sessionId, seq: 1, sentAt: new Date().toISOString(), body: { capabilities: ["text"] }
            }));
          } else if (event.type === "input.begin") {
            if (mode === "malformed") socket.send("not-json");
            if (mode === "sequence") socket.send(JSON.stringify({
              protocol: "gelato.model.v1", type: "reply.delta", eventId: "event_delta0001",
              sessionId, seq: 99, sentAt: new Date().toISOString(),
              body: { turnId: "turn_hostile002", text: "bad" }
            }));
            if (mode === "duplicate-ready") socket.send(JSON.stringify({
              protocol: "gelato.model.v1", type: "session.ready", eventId: "event_ready0002",
              sessionId, seq: 2, sentAt: new Date().toISOString(), body: { capabilities: ["text"] }
            }));
          }
        });
      });
      endpoint = new ModelSessionEndpoint({ url, apiKey: "test-model-token-1234567890", responseTimeoutMs: 500 });
      endpoints.push(endpoint);
      await expect(endpoint.generate({
        deviceId: `dev_${mode.replace("-", "")}0001`,
        messageId: "turn_hostile002",
        parts: [{ type: "text", text: "hello" }]
      })).rejects.toThrow(/disconnected/);
    }
  });

  it("rejects concurrent turns and a pending turn when the provider disconnects", async () => {
    const received: Event[] = [];
    runtime((event) => { received.push(event); });
    const endpoint = new ModelSessionEndpoint({ url, apiKey: "test-model-token-1234567890", responseTimeoutMs: 2_000 });
    endpoints.push(endpoint);
    const first = endpoint.generate({
      deviceId: "dev_concurrent001",
      messageId: "turn_concurrent01",
      parts: [{ type: "text", text: "first" }]
    });
    await vi.waitFor(() => expect(received.some(event => event.type === "input.commit")).toBe(true));
    await expect(endpoint.generate({
      deviceId: "dev_concurrent001",
      messageId: "turn_concurrent02",
      parts: [{ type: "text", text: "second" }]
    })).rejects.toThrow("already active");
    for (const client of wss.clients) client.terminate();
    await expect(first).rejects.toThrow("disconnected");
  });

  it("requires a non-empty final reply and a valid terminal event order", async () => {
    runtime((event, send) => {
      if (event.type === "input.commit") {
        const turnId = event.body.turnId;
        send("reply.complete", { turnId, text: "   " });
        send("turn.end", { turnId, status: "completed" });
      }
    });
    const endpoint = new ModelSessionEndpoint({ url, apiKey: "test-model-token-1234567890", responseTimeoutMs: 1_000 });
    endpoints.push(endpoint);
    await expect(endpoint.generate({
      deviceId: "dev_emptyreply001",
      messageId: "turn_emptyreply01",
      parts: [{ type: "text", text: "hello" }]
    })).rejects.toThrow("did not produce");
  });

  it("accepts a bounded session error message and rejects the active turn", async () => {
    runtime((event, send) => {
      if (event.type === "input.begin") {
        send("session.error", { code: "provider_busy", retryable: true, message: "try again later" });
      }
    });
    const endpoint = new ModelSessionEndpoint({
      url, apiKey: "test-model-token-1234567890", responseTimeoutMs: 1_000
    });
    endpoints.push(endpoint);
    await expect(endpoint.generate({
      deviceId: "dev_sessionerror01",
      messageId: "turn_sessionerror1",
      parts: [{ type: "text", text: "hello" }]
    })).rejects.toThrow("disconnected");
  });

  it("reports failed action callbacks as unknown without duplicating commands", async () => {
    const results: Event[] = [];
    runtime((event, send) => {
      if (event.type === "input.commit") {
        send("action.propose", {
          turnId: event.body.turnId,
          proposalId: "proposal_error01",
          capability: "screen.capture",
          args: {}
        });
      }
      if (event.type === "action.result") {
        results.push(event);
        setImmediate(() => {
          send("reply.complete", { turnId: event.body.turnId, text: "recovered" });
          send("turn.end", { turnId: event.body.turnId, status: "completed" });
        });
      }
    });
    const onAction = vi.fn(async () => { throw new Error("controller failed"); });
    const endpoint = new ModelSessionEndpoint({
      url, apiKey: "test-model-token-1234567890", onAction, responseTimeoutMs: 1_000
    });
    endpoints.push(endpoint);
    await expect(endpoint.generate({
      deviceId: "dev_actionerror001",
      messageId: "turn_actionerror01",
      parts: [{ type: "text", text: "capture" }]
    })).resolves.toBe("recovered");
    expect(onAction).toHaveBeenCalledOnce();
    expect(results).toHaveLength(1);
    expect(results[0].body).toMatchObject({ status: "unknown" });
  });

  it("aborts an active action and rejects the turn when the endpoint closes", async () => {
    let actionSignal: AbortSignal | undefined;
    runtime((event, send) => {
      if (event.type === "input.commit") {
        send("action.propose", {
          turnId: event.body.turnId,
          proposalId: "proposal_abort01",
          capability: "screen.capture",
          args: {}
        });
      }
    });
    const endpoint = new ModelSessionEndpoint({
      url,
      apiKey: "test-model-token-1234567890",
      responseTimeoutMs: 2_000,
      onAction: (_proposal, signal) => {
        actionSignal = signal;
        return new Promise(() => {});
      }
    });
    endpoints.push(endpoint);
    const turn = endpoint.generate({
      deviceId: "dev_actionabort001",
      messageId: "turn_actionabort01",
      parts: [{ type: "text", text: "capture" }]
    });
    await vi.waitFor(() => expect(actionSignal).toBeTruthy());
    endpoint.close();
    expect(actionSignal?.aborted).toBe(true);
    await expect(turn).rejects.toThrow("disconnected");
    await expect(endpoint.generate({
      deviceId: "dev_actionabort001",
      messageId: "turn_actionabort02",
      parts: [{ type: "text", text: "again" }]
    })).rejects.toThrow("closed");
  });
});
