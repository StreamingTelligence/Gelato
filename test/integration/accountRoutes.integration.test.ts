import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountClientAddress, accountRoutes } from "../../examples/server/control-room/src/account/routes.js";
import type { TinodeAccounts } from "../../examples/server/control-room/src/account/tinode.js";
import { DeviceAgentPairingService } from "../../server-sdk/core/src/pairingService.js";
import { UnifiedDeviceRegistry } from "../../server-sdk/core/src/registry.js";
import { descriptor, snapshot, tempDirectory } from "../helpers.js";

describe("account routes", () => {
  let directory: ReturnType<typeof tempDirectory>;
  let pairing: DeviceAgentPairingService;
  let registry: UnifiedDeviceRegistry;
  let accounts: {
    configured: boolean;
    login: ReturnType<typeof vi.fn>;
    register: ReturnType<typeof vi.fn>;
    verify: ReturnType<typeof vi.fn>;
  };
  let http: Server;
  let base: string;

  beforeEach(async () => {
    directory = tempDirectory("gelato-account-routes-");
    pairing = new DeviceAgentPairingService(join(directory.path, "pairings.json"));
    registry = new UnifiedDeviceRegistry();
    accounts = {
      configured: true,
      login: vi.fn(async () => ({ user: { id: "user-a", displayName: "Alice" }, token: "token", expiresAt: "2030-01-01T00:00:00Z" })),
      register: vi.fn(async () => ({ user: { id: "user-a", displayName: "Alice" }, token: "token", expiresAt: "2030-01-01T00:00:00Z" })),
      verify: vi.fn(async () => ({ user: { id: "user-a", displayName: "Alice" } }))
    };
    const app = express();
    app.use(express.json());
    app.use("/account", accountRoutes(
      accounts as unknown as TinodeAccounts,
      pairing as never,
      registry as never,
      () => "https://controller.example.test/",
      true
    ));
    http = createServer(app);
    http.listen(0, "127.0.0.1");
    await once(http, "listening");
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("Expected listener");
    base = `http://127.0.0.1:${address.port}/account`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await new Promise<void>(resolve => http.close(() => resolve()));
    directory.cleanup();
  });

  function request(path: string, init: RequestInit = {}, token = "session-token") {
    return fetch(base + path, {
      ...init,
      headers: {
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...init.headers
      }
    });
  }

  it("reports provider status, authenticates sessions, and never caches account responses", async () => {
    const status = await request("/status", {}, "");
    expect(status.status).toBe(200);
    expect(status.headers.get("cache-control")).toBe("no-store");
    expect(await status.json()).toEqual({ available: true, provider: "tinode" });

    expect((await request("/me", {}, "")).status).toBe(401);
    const me = await request("/me");
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ user: { id: "user-a", displayName: "Alice" } });
    expect(accounts.verify).toHaveBeenCalledWith("session-token");
  });

  it("rate limits login attempts by trusted client address", async () => {
    for (let index = 0; index < 12; index++) {
      expect((await request("/login", {
        method: "POST",
        headers: { "cf-connecting-ip": "8.8.8.8" },
        body: JSON.stringify({ username: "alice", password: "password" })
      }, "")).status).toBe(200);
    }
    const limited = await request("/login", {
      method: "POST",
      headers: { "cf-connecting-ip": "8.8.8.8" },
      body: JSON.stringify({ username: "alice", password: "password" })
    }, "");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(accounts.login).toHaveBeenCalledTimes(12);
  });

  it("validates enrollment type, HTTPS root URL, and public origin", async () => {
    const post = (value: unknown) => request("/enroll", { method: "POST", body: JSON.stringify(value) });
    expect((await post({ agentKind: "unknown", controllerUrl: "https://controller.example.test/" })).status).toBe(400);
    expect((await post({ agentKind: "ios", controllerUrl: "http://controller.example.test/" })).status).toBe(400);
    expect((await post({ agentKind: "ios", controllerUrl: "https://controller.example.test/path" })).status).toBe(400);
    expect((await post({ agentKind: "ios", controllerUrl: "https://other.example.test/" })).status).toBe(400);

    const accepted = await post({
      agentKind: "ios",
      controllerUrl: "https://controller.example.test/",
      displayName: "Test iPhone"
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      session: { allowedAgentKind: "ios", controllerUrl: "https://controller.example.test" }
    });
    expect(pairing.listPending()).toHaveLength(1);
  });

  it("isolates device listing and prevents claiming a device owned by another account", async () => {
    const session = pairing.createSession({
      ownerUserId: "user-a",
      controllerUrl: "https://controller.example.test",
      allowedAgentKind: descriptor.agentKind
    });
    const paired = pairing.pair(session.code, descriptor);
    if (!paired.record) throw new Error("Pairing failed");
    registry.bind({
      agentId: paired.record.agentId,
      deviceId: paired.record.deviceId,
      installationId: paired.record.installationId,
      agentKind: paired.record.agentKind,
      hostPlatform: paired.record.hostPlatform,
      agentVersion: paired.record.agentVersion,
      deviceKind: paired.record.deviceKind,
      displayName: paired.record.displayName
    });
    registry.applySnapshot(paired.record.deviceId, snapshot());

    const devices = await request("/devices");
    expect(devices.status).toBe(200);
    expect((await devices.json() as { devices: unknown[] }).devices).toHaveLength(1);

    accounts.verify.mockResolvedValueOnce({ user: { id: "user-b", displayName: "Bob" } });
    const claim = await request("/claim", {
      method: "POST",
      body: JSON.stringify({ agentId: paired.agentId, credential: paired.credential })
    });
    expect(claim.status).toBe(409);
    expect(pairing.listPairings()[0].ownerUserId).toBe("user-a");
  });

  it("trusts Cloudflare client addresses only from an explicitly trusted loopback peer", () => {
    expect(accountClientAddress({
      socket: { remoteAddress: "127.0.0.1" },
      headers: { "cf-connecting-ip": "8.8.8.8" }
    } as never, true)).toBe("8.8.8.8");
    expect(accountClientAddress({
      socket: { remoteAddress: "10.0.0.2" },
      headers: { "cf-connecting-ip": "8.8.8.8" }
    } as never, true)).toBe("10.0.0.2");
    expect(accountClientAddress({
      socket: { remoteAddress: "127.0.0.1" },
      headers: { "cf-connecting-ip": "not-an-ip" }
    } as never, true)).toBe("127.0.0.1");
  });
});
