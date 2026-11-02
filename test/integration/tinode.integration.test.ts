import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { AccountError, TinodeAccounts } from "../../examples/server/control-room/src/account/tinode.js";

describe("TinodeAccounts", () => {
  let http: Server;
  let wss: WebSocketServer;
  let url: string;

  beforeEach(async () => {
    http = createServer();
    wss = new WebSocketServer({ server: http });
    http.listen(0, "127.0.0.1");
    await once(http, "listening");
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("Expected listener");
    url = `ws://127.0.0.1:${address.port}/v0/channels`;
  });

  afterEach(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await new Promise<void>(resolve => http.close(() => resolve()));
  });

  function successfulProvider() {
    const commands: Array<Record<string, unknown>> = [];
    wss.on("connection", (socket, request) => {
      expect(new URL(request.url ?? "", url).searchParams.get("apikey")).toBe("application-key");
      socket.on("message", raw => {
        const frame = JSON.parse(raw.toString()) as Record<string, Record<string, unknown>>;
        commands.push(frame);
        if (frame.hi) {
          socket.send(JSON.stringify({ ctrl: { id: "hi", code: 200 } }));
        } else {
          socket.send(JSON.stringify({ ctrl: {
            id: "account",
            code: 200,
            params: { user: "usr_test", token: "user-token", expires: "2030-01-01T00:00:00Z" }
          } }));
        }
      });
    });
    return commands;
  }

  it("performs the hi/login flow without placing user credentials in the URL", async () => {
    const commands = successfulProvider();
    const accounts = new TinodeAccounts(url, "application-key");
    await expect(accounts.login(" alice ", "correct horse battery staple")).resolves.toEqual({
      user: { id: "usr_test", displayName: "alice" },
      token: "user-token",
      expiresAt: "2030-01-01T00:00:00Z"
    });
    expect(commands.map(frame => Object.keys(frame)[0])).toEqual(["hi", "login"]);
    expect(commands[1].login).toMatchObject({ scheme: "basic" });
    expect(JSON.stringify(commands[1])).not.toContain("correct horse battery staple");
  });

  it("supports registration and token verification while validating local input", async () => {
    successfulProvider();
    const accounts = new TinodeAccounts(url, "application-key");
    await expect(accounts.register("new_user", "long-password", "Display Name"))
      .resolves.toMatchObject({ user: { displayName: "Display Name" } });
    await expect(accounts.verify("existing-token")).resolves.toEqual({
      user: { id: "usr_test", displayName: "usr_test" }
    });
    await expect(accounts.login("bad:name", "password")).rejects.toMatchObject({ status: 400 });
    await expect(accounts.register("x", "short", "Name")).rejects.toMatchObject({ status: 400 });
    await expect(accounts.verify("")).rejects.toBeInstanceOf(AccountError);
    await expect(new TinodeAccounts("", "").login("alice", "password"))
      .rejects.toMatchObject({ status: 503 });
  });

  it("maps provider conflicts, malformed responses, and disconnects to bounded account errors", async () => {
    let mode: "conflict" | "malformed" | "disconnect" = "conflict";
    wss.on("connection", socket => {
      socket.on("message", raw => {
        const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
        if ("hi" in frame) {
          socket.send(JSON.stringify({ ctrl: { id: "hi", code: 200 } }));
          return;
        }
        if (mode === "conflict") socket.send(JSON.stringify({ ctrl: { id: "account", code: 409 } }));
        if (mode === "malformed") socket.send("not-json");
        if (mode === "disconnect") socket.close();
      });
    });
    const accounts = new TinodeAccounts(url, "application-key");
    await expect(accounts.register("new_user", "long-password", "Name"))
      .rejects.toMatchObject({ status: 409 });
    mode = "malformed";
    await expect(accounts.login("alice", "password")).rejects.toMatchObject({ status: 502 });
    mode = "disconnect";
    await expect(accounts.login("alice", "password")).rejects.toMatchObject({ status: 503 });
  });
});
