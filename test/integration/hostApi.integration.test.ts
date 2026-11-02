import { once } from "node:events";
import fs, { writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandService } from "../../server-sdk/core/src/commandService.js";
import { ObservationHub } from "../../server-sdk/core/src/http/observations.js";
import {
  createHostRouter,
  loadGrants,
  type AccessGrant
} from "../../server-sdk/core/src/http/routes.js";
import { DeviceAgentPairingService, type PairedDeviceAgent } from "../../server-sdk/core/src/pairingService.js";
import { UnifiedDeviceRegistry } from "../../server-sdk/core/src/registry.js";
import type { StreamBroker } from "../../server-sdk/core/src/streamBroker.js";
import { descriptor, snapshot, tempDirectory } from "../helpers.js";

const tokenA = "token-user-a-0000000000000001";
const tokenB = "token-user-b-0000000000000002";

function binding(record: PairedDeviceAgent) {
  return {
    agentId: record.agentId,
    installationId: record.installationId,
    agentKind: record.agentKind,
    hostPlatform: record.hostPlatform,
    agentVersion: record.agentVersion,
    deviceId: record.deviceId,
    deviceKind: record.deviceKind,
    displayName: record.displayName
  };
}

describe("host HTTP API", () => {
  let directory: ReturnType<typeof tempDirectory>;
  let pairing: DeviceAgentPairingService;
  let registry: UnifiedDeviceRegistry;
  let observations: ObservationHub;
  let record: PairedDeviceAgent;
  let grants: AccessGrant[];
  let grantsFailure: Error | undefined;
  let commands: {
    execute: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
  };
  const servers: Server[] = [];

  beforeEach(() => {
    directory = tempDirectory("gelato-host-api-");
    pairing = new DeviceAgentPairingService(join(directory.path, "pairings.json"));
    const session = pairing.createSession({
      ownerUserId: "user-a",
      controllerUrl: "https://controller.example.test",
      allowedAgentKind: descriptor.agentKind
    });
    const paired = pairing.pair(session.code, descriptor);
    if (!paired.accepted || !paired.record) throw new Error("Test pairing failed");
    record = paired.record;
    registry = new UnifiedDeviceRegistry();
    registry.bind(binding(record));
    registry.applySnapshot(record.deviceId, snapshot());
    observations = new ObservationHub();
    grants = [{
      token: tokenA,
      userId: "user-a",
      deviceIds: [record.deviceId],
      capabilities: ["device.describe", "screen.capture", "input.tap"],
      expiresAt: Date.now() + 60_000
    }, {
      token: tokenB,
      userId: "user-b",
      deviceIds: [record.deviceId],
      capabilities: ["screen.capture"],
      expiresAt: Date.now() + 60_000
    }];
    grantsFailure = undefined;
    commands = {
      execute: vi.fn(() => new Promise(() => {})),
      cancel: vi.fn(() => true),
      get: vi.fn()
    };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    observations.close();
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    directory.cleanup();
  });

  async function start(options: { stateFile?: string; streams?: StreamBroker } = {}) {
    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use("/harness/v1", createHostRouter({
      grants: () => {
        if (grantsFailure) throw grantsFailure;
        return grants;
      },
      registry,
      pairing,
      commands: commands as unknown as CommandService,
      observations,
      streams: options.streams,
      stateFile: options.stateFile ?? join(directory.path, `commands-${servers.length}.json`)
    }));
    const server = createServer(app);
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    return `http://127.0.0.1:${address.port}/harness/v1`;
  }

  async function request(base: string, route: string, init: RequestInit = {}, token = tokenA) {
    return fetch(base + route, {
      ...init,
      headers: {
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...init.headers
      }
    });
  }

  it("fails closed for missing, invalid, expired, or unavailable authorization", async () => {
    const base = await start();
    expect((await request(base, "/devices", {}, "")).status).toBe(401);
    expect((await request(base, "/devices", {}, "wrong-token")).status).toBe(401);
    grants[0].expiresAt = Date.now() - 1;
    expect((await request(base, "/devices")).status).toBe(401);
    grants[0].expiresAt = Date.now() + 60_000;
    grantsFailure = new Error("grant store unavailable");
    const unavailable = await request(base, "/devices");
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ error: "authorization_unavailable" });
    expect(unavailable.headers.get("cache-control")).toBe("no-store");
  });

  it("enforces account, device, consent, and observation cursor isolation", async () => {
    const base = await start();
    const devices = await request(base, "/devices");
    expect(devices.status).toBe(200);
    expect((await devices.json() as { devices: unknown[] }).devices).toHaveLength(1);
    const otherDevices = await request(base, "/devices", {}, tokenB);
    expect((await otherDevices.json() as { devices: unknown[] }).devices).toHaveLength(0);

    const denied = await request(base, `/devices/${record.deviceId}/observations`, {}, tokenB);
    expect(denied.status).toBe(403);
    registry.applyPatch(record.deviceId, {
      baseRevision: 1,
      revision: 2,
      patch: { hardware: { present: true, connected: true, controlAllowed: false, userAction: null } }
    });
    expect((await request(base, `/devices/${record.deviceId}/observations`)).status).toBe(403);

    registry.applyPatch(record.deviceId, {
      baseRevision: 2,
      revision: 3,
      patch: { hardware: { present: true, connected: true, controlAllowed: true, userAction: null } }
    });
    expect((await request(base, `/devices/${record.deviceId}/observations?after=bad`)).status).toBe(400);
    observations.publish(record.deviceId, "str_observation01", 0, Buffer.from("frame"), "image/jpeg");
    const allowed = await request(base, `/devices/${record.deviceId}/observations?after=0`);
    expect(allowed.status).toBe(200);
    expect((await allowed.json() as { frames: unknown[] }).frames).toHaveLength(1);
  });

  it("validates commands and enforces idempotency, conflicts, concurrency, ownership, and cancellation", async () => {
    const base = await start();
    const route = `/devices/${record.deviceId}/commands`;
    const body = {
      command_id: "cmd_hostcommand0001",
      capability: "input.tap",
      arguments: { x: 1, y: 2 },
      deadline_ms: 5000
    };
    const post = (value: unknown, token = tokenA) => request(base, route, {
      method: "POST",
      body: JSON.stringify(value)
    }, token);

    expect((await post({ ...body, command_id: "bad" })).status).toBe(400);
    expect((await post({ ...body, capability: "app.install" })).status).toBe(400);
    expect((await post({ ...body, extra: true })).status).toBe(400);
    expect((await post(body, tokenB)).status).toBe(403);

    const accepted = await post(body);
    expect(accepted.status).toBe(202);
    expect(commands.execute).toHaveBeenCalledOnce();
    const repeated = await post(body);
    expect(repeated.status).toBe(200);
    expect(commands.execute).toHaveBeenCalledOnce();
    expect((await post({ ...body, arguments: { x: 9 } })).status).toBe(409);
    expect((await post({ ...body, command_id: "cmd_hostcommand0002" })).status).toBe(409);

    const status = await request(base, "/commands/cmd_hostcommand0001");
    expect(status.status).toBe(200);
    expect((await request(base, "/commands/cmd_hostcommand0001", {}, tokenB)).status).toBe(404);
    const cancelled = await request(base, "/commands/cmd_hostcommand0001/cancel", { method: "POST", body: "{}" });
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({ state: "cancelled", effects_rolled_back: false });
    expect(commands.cancel).toHaveBeenCalledWith(record.deviceId, "cmd_hostcommand0001");
  });

  it("persists terminal results and marks running commands unknown after restart", async () => {
    commands.execute.mockResolvedValue({
      commandId: "cmd_hostcommand0003",
      deviceId: record.deviceId,
      state: "completed",
      result: { ok: true },
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString()
    });
    const stateFile = join(directory.path, "commands-restart.json");
    const first = await start({ stateFile });
    const created = await request(first, `/devices/${record.deviceId}/commands`, {
      method: "POST",
      body: JSON.stringify({
        command_id: "cmd_hostcommand0003",
        capability: "screen.capture",
        arguments: {}
      })
    });
    expect(created.status).toBe(202);
    await vi.waitFor(async () => {
      const status = await request(first, "/commands/cmd_hostcommand0003");
      expect(await status.json()).toMatchObject({ state: "completed", result: { ok: true } });
    });

    const raw = JSON.parse(await import("node:fs/promises").then(fs => fs.readFile(stateFile, "utf8"))) as Record<string, { state: string }>;
    raw.cmd_hostcommand0003.state = "running";
    writeFileSync(stateFile, JSON.stringify(raw));
    const restarted = await start({ stateFile });
    const recovered = await request(restarted, "/commands/cmd_hostcommand0003");
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({ state: "result_unknown" });
  });

  it("serves only complete media owned by the authorized device", async () => {
    const mediaFile = join(directory.path, "media.bin");
    writeFileSync(mediaFile, "media payload");
    const streams = {
      get: vi.fn((streamId: string) => streamId === "str_mediafile0001" ? {
        streamId,
        deviceId: record.deviceId,
        state: "complete",
        contentType: "application/octet-stream"
      } : undefined),
      file: vi.fn((streamId: string) => streamId === "str_mediafile0001" ? mediaFile : undefined)
    } as unknown as StreamBroker;
    const base = await start({ streams });

    const media = await request(base, `/devices/${record.deviceId}/streams/str_mediafile0001/content`);
    expect(media.status).toBe(200);
    expect(media.headers.get("content-type")).toBe("application/octet-stream");
    expect(await media.text()).toBe("media payload");
    expect((await request(base, `/devices/${record.deviceId}/streams/str_missingmedia01/content`)).status).toBe(404);
    expect((await request(base, `/devices/${record.deviceId}/streams/str_mediafile0001/content`, {}, tokenB)).status).toBe(403);
  });

  it("strictly validates grant files", () => {
    const file = join(directory.path, "grants.json");
    writeFileSync(file, JSON.stringify(grants));
    expect(loadGrants(file)).toEqual(grants);
    for (const invalid of [
      {},
      [{ ...grants[0], token: "short" }],
      [grants[0], { ...grants[0] }],
      [{ ...grants[0], deviceIds: ["bad"] }],
      [{ ...grants[0], capabilities: [1] }],
      [{ ...grants[0], expiresAt: "later" }]
    ]) {
      writeFileSync(file, JSON.stringify(invalid));
      expect(() => loadGrants(file)).toThrow();
    }
  });

  it("rejects commands without dispatch when the journal cannot be committed", async () => {
    const base = await start();
    const rename = vi.spyOn(fs, "renameSync")
      .mockImplementation(() => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); });
    const body = JSON.stringify({
      command_id: "cmd_journalfailure01",
      capability: "screen.capture",
      arguments: {}
    });
    const failed = await request(base, `/devices/${record.deviceId}/commands`, { method: "POST", body });
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: "command_journal_unavailable" });
    expect(commands.execute).not.toHaveBeenCalled();

    rename.mockRestore();
    const retried = await request(base, `/devices/${record.deviceId}/commands`, { method: "POST", body });
    expect(retried.status).toBe(202);
    expect(commands.execute).toHaveBeenCalledOnce();
  });

  it("fails closed when the existing command journal is truncated", async () => {
    const stateFile = join(directory.path, "commands-corrupt.json");
    writeFileSync(stateFile, '{"cmd_broken":');
    await expect(start({ stateFile })).rejects.toThrow();
    expect(commands.execute).not.toHaveBeenCalled();
  });
});
