import fs, { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeviceAgentPairingService } from "../../server-sdk/core/src/pairingService.js";
import { descriptor, tempDirectory } from "../helpers.js";

describe("DeviceAgentPairingService", () => {
  let directory: ReturnType<typeof tempDirectory>;
  let storePath: string;
  let service: DeviceAgentPairingService;

  beforeEach(() => {
    directory = tempDirectory("gelato-pairing-");
    storePath = join(directory.path, "pairings.json");
    service = new DeviceAgentPairingService(storePath);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    directory.cleanup();
  });

  function session(ownerUserId = "user-a", allowedAgentKind = descriptor.agentKind) {
    return service.createSession({
      ownerUserId,
      controllerUrl: "https://controller.example.test/",
      allowedAgentKind
    });
  }

  it("creates a bounded one-use session and persists a credential hash", () => {
    const pending = session();
    expect(pending.code).toMatch(/^[23456789A-Z]{8}$/);
    expect(pending.setupUrl).toContain("protocol=gelato.v1");
    expect(pending.setupUrl).not.toContain("user-a");

    const result = service.pair(pending.code.toLowerCase(), descriptor);
    expect(result).toMatchObject({ accepted: true });
    expect(result.agentId).toMatch(/^agt_/);
    expect(result.deviceId).toMatch(/^dev_/);
    expect(result.credential).toMatch(/^agtcred_/);
    expect(service.pair(pending.code, descriptor)).toMatchObject({ accepted: false });

    const stored = service.listPairings()[0];
    expect(stored).not.toHaveProperty("credentialHash");
    expect(stored).not.toHaveProperty("credentialSalt");
  });

  it("rejects expired, unknown, mismatched, and malformed pairing requests", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const expired = service.createSession({ controllerUrl: "https://controller.test", ttlMs: 60_000 });
    const iosOnly = service.createSession({ controllerUrl: "https://controller.test", allowedAgentKind: "ios" });
    vi.advanceTimersByTime(60_001);

    expect(service.pair(expired.code, descriptor).reason).toMatch(/unknown|expired/);
    expect(service.pair(iosOnly.code, descriptor).reason).toContain("not android-phone");
    expect(service.pair("NOT-A-CODE", descriptor).accepted).toBe(false);
    expect(service.pair(session().code, { ...descriptor, installationId: "bad" }).reason)
      .toContain("installationId");
    expect(() => service.createSession({ controllerUrl: "https://controller.test", allowedAgentKind: "Bad Kind" }))
      .toThrow(/allowedAgentKind/);
  });

  it("keeps identity for the same owner and prevents account transfer", () => {
    const first = service.pair(session("owner-a").code, descriptor);
    const repeated = service.pair(session("owner-a").code, { ...descriptor, displayName: "Renamed phone" });
    expect(repeated.agentId).toBe(first.agentId);
    expect(repeated.deviceId).toBe(first.deviceId);
    expect(repeated.credential).not.toBe(first.credential);

    const transfer = service.pair(session("owner-b").code, descriptor);
    expect(transfer).toMatchObject({ accepted: false });
    expect(transfer.reason).toContain("another account");
  });

  it("authenticates, updates safe descriptor fields, and rejects binding changes", () => {
    const paired = service.pair(session().code, descriptor);
    expect(service.authenticate(paired.agentId!, "wrong").accepted).toBe(false);
    expect(service.authenticate(paired.agentId!, paired.credential!, {
      ...descriptor,
      displayName: "Updated name",
      agentVersion: "1.1.0"
    })).toMatchObject({ accepted: true, deviceId: paired.deviceId });
    expect(service.authenticate(paired.agentId!, paired.credential!, {
      ...descriptor,
      installationId: "inst_anotherdevice01"
    }).reason).toContain("does not match");
    expect(service.authenticateDevice("dev_wrongdevice0001", paired.agentId!, paired.credential!)).toBe(false);
  });

  it("binds hardware identity once and validates sidecar credentials", () => {
    const paired = service.pair(session().code, descriptor);
    expect(service.bindHardwareKey(paired.agentId!, "hardware-1")).toEqual({ accepted: true });
    expect(service.bindHardwareKey(paired.agentId!, "hardware-1")).toEqual({ accepted: true });
    expect(service.bindHardwareKey(paired.agentId!, "hardware-2").accepted).toBe(false);
    expect(service.bindHardwareKey(paired.agentId!, "bad\u0000key").accepted).toBe(false);

    const token = service.sidecarToken(paired.deviceId!);
    expect(token).toBeTruthy();
    expect(service.authenticateSidecar(paired.deviceId!, token)).toBe(true);
    expect(service.authenticateSidecar(paired.deviceId!, "wrong")).toBe(false);
  });

  it("persists state, supports owner claims, and revokes credentials", () => {
    const unowned = service.createSession({ controllerUrl: "https://controller.test" });
    const paired = service.pair(unowned.code, descriptor);
    expect(service.claimOwner(paired.agentId!, "owner-a")).toBe(true);
    expect(service.claimOwner(paired.agentId!, "owner-b")).toBe(false);

    const reloaded = new DeviceAgentPairingService(storePath);
    expect(reloaded.authenticate(paired.agentId!, paired.credential!).accepted).toBe(true);
    expect(reloaded.revokeAgent(paired.agentId!)).toBe(true);
    expect(reloaded.revokeAgent(paired.agentId!)).toBe(false);
    expect(reloaded.authenticate(paired.agentId!, paired.credential!).accepted).toBe(false);
    expect(reloaded.sidecarToken(paired.deviceId!)).toBeUndefined();
  });

  it("fails closed on truncated or incompatible stores and protects file permissions", () => {
    session();
    expect(statSync(storePath).mode & 0o777).toBe(0o600);

    writeFileSync(storePath, '{"format":"gelato-pairings.v1"');
    expect(() => new DeviceAgentPairingService(storePath)).toThrow();
    writeFileSync(storePath, JSON.stringify({ format: "gelato-pairings.v2", pairings: [], pending: [] }));
    expect(() => new DeviceAgentPairingService(storePath)).toThrow("Unsupported Gelato pairing store format");
  });

  it("revokes every active credential for a device and persists the result", () => {
    const paired = service.pair(session().code, descriptor);
    expect(service.revokeDevice("dev_missingdevice01")).toEqual([]);
    expect(service.revokeDevice(paired.deviceId!)).toEqual([paired.agentId]);
    expect(service.authenticate(paired.agentId!, paired.credential!).accepted).toBe(false);
    const reloaded = new DeviceAgentPairingService(storePath);
    expect(reloaded.listPairings()[0].revokedAt).toEqual(expect.any(Number));
  });

  it("rolls back in-memory pairing and revocation when atomic persistence fails", () => {
    const pending = session();
    const rename = vi.spyOn(fs, "renameSync")
      .mockImplementation(() => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); });
    expect(() => service.pair(pending.code, descriptor)).toThrow("disk full");
    expect(service.listPairings()).toEqual([]);
    expect(service.listPending()).toHaveLength(1);

    rename.mockRestore();
    const paired = service.pair(pending.code, descriptor);
    expect(paired.accepted).toBe(true);
    const revokeRename = vi.spyOn(fs, "renameSync")
      .mockImplementation(() => { throw Object.assign(new Error("read only"), { code: "EACCES" }); });
    expect(() => service.revokeAgent(paired.agentId!)).toThrow("read only");
    expect(service.listPairings()[0].revokedAt).toBeUndefined();
    revokeRename.mockRestore();
    expect(service.authenticate(paired.agentId!, paired.credential!).accepted).toBe(true);
  });
});
