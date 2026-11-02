import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket, type ClientOptions } from "ws";
import { GelatoServer } from "../../server-sdk/core/src/server.js";
import { tempDirectory } from "../helpers.js";

describe("GelatoServer WebSocket boundary", () => {
  let directory: ReturnType<typeof tempDirectory>;
  let http: Server;
  let gelato: GelatoServer;
  let origin: string;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    directory = tempDirectory("gelato-server-boundary-");
    http = createServer((_request, response) => { response.writeHead(404); response.end(); });
    gelato = new GelatoServer({
      stateDirectory: directory.path,
      grants: () => [],
      allowedOrigins: ["https://trusted.example.test"]
    }).attach(http);
    http.listen(0, "127.0.0.1");
    await once(http, "listening");
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("Expected listener");
    origin = `ws://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    for (const socket of sockets) socket.terminate();
    await gelato.close();
    await new Promise<void>(resolve => http.close(() => resolve()));
    directory.cleanup();
  });

  async function expectRejected(path: string, options: ClientOptions = {}) {
    const socket = new WebSocket(origin + path, options);
    sockets.push(socket);
    const error = await new Promise<Error>(resolve => socket.once("error", resolve));
    expect(error).toBeInstanceOf(Error);
    expect(socket.readyState).not.toBe(WebSocket.OPEN);
  }

  it("accepts only configured origins while permitting clients without an Origin header", async () => {
    const trusted = new WebSocket(`${origin}/agent/control`, { origin: "https://trusted.example.test" });
    sockets.push(trusted);
    await once(trusted, "open");
    trusted.close();
    await once(trusted, "close");

    const nativeClient = new WebSocket(`${origin}/agent/control`);
    sockets.push(nativeClient);
    await once(nativeClient, "open");
    nativeClient.close();
    await once(nativeClient, "close");

    await expectRejected("/agent/control", { origin: "https://evil.example.test" });
  });

  it("rejects unknown or encoded upgrade routes without affecting valid query strings", async () => {
    await expectRejected("/unknown");
    await expectRejected("/agent/streams/not-a-stream");
    await expectRejected("/agent%2Fcontrol");

    const valid = new WebSocket(`${origin}/agent/control?client=device`);
    sockets.push(valid);
    await once(valid, "open");
    valid.close();
    await once(valid, "close");
  });

  it("enforces the control WebSocket maximum message size", async () => {
    const socket = new WebSocket(`${origin}/agent/control`);
    sockets.push(socket);
    await once(socket, "open");
    socket.send("x".repeat(10 * 1024 * 1024 + 5));
    const [code] = await once(socket, "close") as [number, Buffer];
    expect(code).toBe(1009);
  });

  it("prevents duplicate attachment and removes the upgrade listener on close", async () => {
    expect(() => gelato.attach(http)).toThrow("already attached");
    expect(http.listenerCount("upgrade")).toBe(1);
    await gelato.close();
    expect(http.listenerCount("upgrade")).toBe(0);
    gelato.attach(http);
    expect(http.listenerCount("upgrade")).toBe(1);
  });
});
