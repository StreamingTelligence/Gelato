import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket, type ClientOptions } from "ws";
import { GelatoServer } from "../../server-sdk/core/src/server.js";
import type { ProtocolEnvelope } from "../../server-sdk/core/src/types.js";
import { descriptor, message, snapshot, tempDirectory } from "../helpers.js";

class Inbox {
  private readonly messages: ProtocolEnvelope[] = [];
  private readonly waiters = new Set<() => void>();
  readonly closed: Promise<unknown[]>;

  constructor(readonly socket: WebSocket) {
    this.closed = once(socket, "close");
    socket.on("message", (raw, binary) => {
      if (binary) return;
      this.messages.push(JSON.parse(raw.toString("utf8")) as ProtocolEnvelope);
      for (const wake of this.waiters) wake();
      this.waiters.clear();
    });
  }

  async next(type: string): Promise<ProtocolEnvelope> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const index = this.messages.findIndex((value) => value.type === type);
      if (index >= 0) return this.messages.splice(index, 1)[0];
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.waiters.delete(wake);
          reject(new Error(`Timed out waiting for ${type}`));
        }, Math.max(1, deadline - Date.now()));
        const wake = () => { clearTimeout(timer); resolve(); };
        this.waiters.add(wake);
      });
    }
    throw new Error(`Timed out waiting for ${type}`);
  }
}

async function open(url: string, options: ClientOptions = {}): Promise<Inbox> {
  const socket = new WebSocket(url, options);
  const inbox = new Inbox(socket);
  await once(socket, "open");
  return inbox;
}

async function close(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  const closed = once(socket, "close");
  socket.close();
  await closed;
}

describe("GelatoServer device integration", () => {
  let directory: ReturnType<typeof tempDirectory>;
  let http: Server;
  let gelato: GelatoServer;
  let origin: string;
  const clients: WebSocket[] = [];

  beforeEach(async () => {
    directory = tempDirectory("gelato-gateway-");
    http = createServer((_request, response) => { response.writeHead(404); response.end(); });
    gelato = new GelatoServer({ stateDirectory: directory.path, grants: () => [] }).attach(http);
    http.listen(0, "127.0.0.1");
    await once(http, "listening");
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP listener");
    origin = `ws://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await Promise.all(clients.map((client) => close(client).catch(() => undefined)));
    await gelato.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    directory.cleanup();
  });

  async function connectPairing() {
    const pairing = gelato.pairing.createSession({
      ownerUserId: "user-test",
      controllerUrl: origin.replace("ws:", "http:"),
      allowedAgentKind: descriptor.agentKind
    });
    const inbox = await open(`${origin}/agent/control`);
    clients.push(inbox.socket);
    inbox.socket.send(JSON.stringify(message("pairing.request", {
      ...descriptor,
      pairingCode: pairing.code
    })));
    const accepted = await inbox.next("pairing.accepted");
    await inbox.next("device.snapshot.request");
    const body = accepted.body as { agentId: string; deviceId: string; credential: string };
    inbox.socket.send(JSON.stringify(message("device.snapshot", snapshot() as unknown as Record<string, unknown>, {
      deviceId: body.deviceId
    })));
    await inbox.next("device.snapshot.ack");
    return { inbox, ...body };
  }

  it("pairs, authenticates a reconnect, publishes state, and completes commands", async () => {
    const paired = await connectPairing();
    expect(gelato.devices.get(paired.deviceId)).toMatchObject({
      connection: { online: true },
      hardware: { controlAllowed: true }
    });

    const progress = new Promise<ProtocolEnvelope>((resolve) => gelato.commands.once("progress", resolve));
    const terminal = gelato.commands.execute(paired.deviceId, {
      commandId: "cmd_integration0001",
      capability: "screen.capture",
      arguments: { format: "jpeg" },
      idempotency: "read-only"
    });
    const request = await paired.inbox.next("command.request");
    paired.inbox.socket.send(JSON.stringify(message("command.progress", { stage: "capturing" }, {
      deviceId: paired.deviceId,
      commandId: request.commandId
    })));
    await progress;
    paired.inbox.socket.send(JSON.stringify(message("command.result", { result: { ok: true } }, {
      deviceId: paired.deviceId,
      commandId: request.commandId
    })));
    await expect(terminal).resolves.toMatchObject({ state: "completed", result: { ok: true } });
    await expect(gelato.commands.execute(paired.deviceId, {
      commandId: "cmd_integration0001",
      capability: "screen.capture"
    })).resolves.toMatchObject({ state: "completed" });

    await close(paired.inbox.socket);
    const reconnected = await open(`${origin}/agent/control`);
    clients.push(reconnected.socket);
    reconnected.socket.send(JSON.stringify(message("session.hello", {
      ...descriptor,
      agentId: paired.agentId,
      credential: paired.credential
    })));
    await expect(reconnected.next("session.accepted")).resolves.toBeTruthy();
    await expect(reconnected.next("device.snapshot.request")).resolves.toBeTruthy();
  });

  it("rejects invalid authentication, wrong protocol, and binary control frames", async () => {
    const paired = await connectPairing();

    const badCredential = await open(`${origin}/agent/control`);
    clients.push(badCredential.socket);
    badCredential.socket.send(JSON.stringify(message("session.hello", {
      ...descriptor,
      agentId: paired.agentId,
      credential: "wrong-credential"
    })));
    expect((await badCredential.next("session.rejected")).body).toMatchObject({
      error: expect.stringContaining("invalid")
    });
    const [badCode] = await badCredential.closed as [number, Buffer];
    expect(badCode).toBe(1008);

    const wrongProtocol = await open(`${origin}/agent/control`);
    clients.push(wrongProtocol.socket);
    wrongProtocol.socket.send(JSON.stringify({ ...message("session.hello", {}), protocol: "gelato.v2" }));
    expect((await wrongProtocol.next("protocol.error")).body).toMatchObject({
      error: expect.stringContaining("Unsupported protocol")
    });
    const [protocolCode] = await wrongProtocol.closed as [number, Buffer];
    expect(protocolCode).toBe(1008);

    const binary = await open(`${origin}/agent/control`);
    clients.push(binary.socket);
    binary.socket.send(Buffer.from("not-json"));
    const [binaryCode] = await binary.closed as [number, Buffer];
    expect(binaryCode).toBe(1003);
  });

  it("uploads an authenticated stream and isolates it from bad credentials", async () => {
    const paired = await connectPairing();
    paired.inbox.socket.send(JSON.stringify(message("stream.offer", {
      streamId: "str_integration001",
      purpose: "file",
      direction: "agent-to-controller",
      contentType: "application/octet-stream",
      maxFrameBytes: 1024,
      maxTotalBytes: 4096
    }, { deviceId: paired.deviceId })));
    const accepted = await paired.inbox.next("stream.accept");
    const path = (accepted.body as { path: string }).path;

    const unauthorized = await open(`${origin}${path}`, {
      headers: { Authorization: "Bearer wrong", "X-Agent-Id": paired.agentId }
    });
    clients.push(unauthorized.socket);
    const [unauthorizedCode] = await unauthorized.closed as [number, Buffer];
    expect(unauthorizedCode).toBe(1008);

    const stream = await open(`${origin}${path}`, {
      headers: { Authorization: `Bearer ${paired.credential}`, "X-Agent-Id": paired.agentId }
    });
    clients.push(stream.socket);
    await stream.next("stream.ready");
    const payload = Buffer.from("stream payload");
    const frame = Buffer.alloc(4 + payload.length);
    frame.writeUInt32BE(0);
    payload.copy(frame, 4);
    stream.socket.send(frame);
    stream.socket.send(JSON.stringify({
      type: "stream.end",
      totalBytes: payload.length,
      sha256: createHash("sha256").update(payload).digest("hex")
    }));
    await stream.next("stream.complete");
    const [closeCode] = await stream.closed as [number, Buffer];
    expect(closeCode).toBe(1000);
    expect(gelato.streams.get("str_integration001")).toMatchObject({
      state: "complete",
      bytesReceived: payload.length,
      framesReceived: 1
    });
    expect(gelato.streams.file("str_integration001")).toBeTruthy();
  });
});
