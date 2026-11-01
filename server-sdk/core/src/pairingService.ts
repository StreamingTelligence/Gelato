import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { customAlphabet, nanoid } from "nanoid";
import { GELATO_PROTOCOL } from "./types.js";

const makeCode = customAlphabet("23456789ABCDEFGHJKLMNPQRSTUVWXYZ", 8);

export interface PairingSession {
  ownerUserId?: string;
  code: string;
  allowedAgentKind?: string;
  displayName?: string;
  controllerUrl: string;
  createdAt: number;
  expiresAt: number;
  pairedDeviceId?: string;
  pairedAt?: number;
}

export interface AgentDescriptor {
  installationId: string;
  agentKind: string;
  hostPlatform: string;
  deviceKind: string;
  displayName: string;
  agentVersion: string;
}

export interface PairedDeviceAgent extends AgentDescriptor {
  ownerUserId?: string;
  agentId: string;
  deviceId: string;
  credentialSalt: string;
  credentialHash: string;
  pairedAt: number;
  lastSeenAt: number;
  hardwareStableKey?: string;
  revokedAt?: number;
}

export interface PairingResult {
  accepted: boolean;
  reason?: string;
  agentId?: string;
  deviceId?: string;
  credential?: string;
  record?: PairedDeviceAgent;
}

interface Store {
  format: "gelato-pairings.v1";
  pairings: PairedDeviceAgent[];
  pending: PairingSession[];
}

export class DeviceAgentPairingService {
  private readonly pending = new Map<string, PairingSession>();
  private readonly pairings = new Map<string, PairedDeviceAgent>();

  constructor(private readonly storePath: string) {
    this.load();
    setInterval(() => this.expirePending(), 30_000).unref();
  }

  createSession(input: {
    ownerUserId?: string;
    controllerUrl: string;
    allowedAgentKind?: string;
    displayName?: string;
    ttlMs?: number;
  }): PairingSession & { setupUrl: string } {
    this.expirePending();
    const allowedAgentKind = input.allowedAgentKind?.trim();
    if (allowedAgentKind && !validAgentKind(allowedAgentKind)) throw new Error("allowedAgentKind is invalid");
    let code = makeCode();
    while (this.pending.has(code)) code = makeCode();
    const now = Date.now();
    const ttlMs = Math.max(60_000, Math.min(input.ttlMs ?? 10 * 60_000, 30 * 60_000));
    const session: PairingSession = {
      ...(input.ownerUserId ? { ownerUserId: input.ownerUserId } : {}),
      code,
      ...(allowedAgentKind ? { allowedAgentKind } : {}),
      ...(input.displayName?.trim() ? { displayName: input.displayName.trim() } : {}),
      controllerUrl: input.controllerUrl.replace(/\/+$/, ""),
      createdAt: now,
      expiresAt: now + ttlMs
    };
    this.pending.set(code, session);
    this.persist();
    return { ...session, setupUrl: setupUrl(session) };
  }

  pair(codeValue: string | undefined, descriptor: AgentDescriptor): PairingResult {
    const invalid = validateDescriptor(descriptor);
    if (invalid) return { accepted: false, reason: invalid };
    const code = normalizeCode(codeValue);
    const session = code ? this.pending.get(code) : undefined;
    if (!session) return { accepted: false, reason: "Pairing code is unknown or already used" };
    if (session.expiresAt <= Date.now()) {
      this.pending.delete(session.code);
      this.persist();
      return { accepted: false, reason: "Pairing code expired" };
    }
    if (session.allowedAgentKind && session.allowedAgentKind !== descriptor.agentKind) {
      return {
        accepted: false,
        reason: `Pairing code is for ${session.allowedAgentKind}, not ${descriptor.agentKind}`
      };
    }
    const duplicate = [...this.pairings.values()].find(
      (record) => record.installationId === descriptor.installationId
        && record.agentKind === descriptor.agentKind
        && !record.revokedAt
    );
    const credential = makeCredential();
    if (duplicate?.ownerUserId && duplicate.ownerUserId !== session.ownerUserId) {
      return { accepted: false, reason: "Device belongs to another account; unpair it before transferring" };
    }
    const salt = randomBytes(16);
    const now = Date.now();
    const record: PairedDeviceAgent = {
      ...descriptor,
      ...(session.ownerUserId ? { ownerUserId: session.ownerUserId } : {}),
      agentId: duplicate?.agentId ?? `agt_${nanoid(24)}`,
      deviceId: duplicate?.deviceId ?? `dev_${nanoid(24)}`,
      credentialSalt: salt.toString("base64url"),
      credentialHash: hashCredential(credential, salt),
      pairedAt: duplicate?.pairedAt ?? now,
      lastSeenAt: now
    };
    this.pairings.set(record.agentId, record);
    session.pairedAt = now;
    session.pairedDeviceId = record.deviceId;
    this.pending.delete(session.code);
    this.persist();
    return {
      accepted: true,
      agentId: record.agentId,
      deviceId: record.deviceId,
      credential,
      record
    };
  }

  authenticate(
    agentId: string,
    credential: string | undefined,
    descriptor?: AgentDescriptor
  ): PairingResult {
    const record = this.pairings.get(agentId);
    if (!record || record.revokedAt || !credential) {
      return { accepted: false, reason: "Device credential is invalid or revoked" };
    }
    const salt = Buffer.from(record.credentialSalt, "base64url");
    const actual = Buffer.from(hashCredential(credential, salt), "base64url");
    const expected = Buffer.from(record.credentialHash, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      return { accepted: false, reason: "Device credential is invalid or revoked" };
    }
    if (descriptor) {
      const invalid = validateDescriptor(descriptor);
      if (invalid) return { accepted: false, reason: invalid };
      if (
        descriptor.installationId !== record.installationId
        || descriptor.agentKind !== record.agentKind
      ) {
        return {
          accepted: false,
          reason: "Device connection descriptor does not match the paired installation"
        };
      }
      record.hostPlatform = descriptor.hostPlatform;
      record.deviceKind = descriptor.deviceKind;
      record.displayName = descriptor.displayName;
      record.agentVersion = descriptor.agentVersion;
    }
    record.lastSeenAt = Date.now();
    this.persist();
    return { accepted: true, agentId, deviceId: record.deviceId, record };
  }

  authenticateDevice(deviceId: string, agentId: string, credential: string | undefined): boolean {
    const result = this.authenticate(agentId, credential);
    return result.accepted && result.deviceId === deviceId;
  }

  bindHardwareKey(agentId: string, value: string): { accepted: boolean; reason?: string } {
    const stableKey = value.trim();
    if (!stableKey || stableKey.length > 200 || /[\u0000-\u001f]/.test(stableKey)) {
      return { accepted: false, reason: "Hardware stableKey is invalid" };
    }
    const record = this.pairings.get(agentId);
    if (!record || record.revokedAt) {
      return { accepted: false, reason: "Device credential is invalid or revoked" };
    }
    if (!record.hardwareStableKey) {
      record.hardwareStableKey = stableKey;
      this.persist();
      return { accepted: true };
    }
    if (record.hardwareStableKey !== stableKey) {
      return {
        accepted: false,
        reason: "Device hardware identity changed; pair the device again to rebind it"
      };
    }
    return { accepted: true };
  }

  sidecarToken(deviceId: string): string | undefined {
    const record = [...this.pairings.values()].find(
      (candidate) => candidate.deviceId === deviceId && !candidate.revokedAt
    );
    if (!record) return undefined;
    return scryptSync(record.credentialHash, `sidecar:${deviceId}`, 32).toString("base64url");
  }

  authenticateSidecar(deviceId: string, token: string | undefined): boolean {
    const expected = this.sidecarToken(deviceId);
    if (!expected || !token) return false;
    const actualBytes = Buffer.from(token);
    const expectedBytes = Buffer.from(expected);
    return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
  }

  listPending(): PairingSession[] {
    this.expirePending();
    return [...this.pending.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  claimOwner(agentId: string, userId: string): boolean {
    const record = this.pairings.get(agentId);
    if (!record || record.revokedAt || (record.ownerUserId && record.ownerUserId !== userId)) return false;
    record.ownerUserId = userId;
    this.persist();
    return true;
  }

  listPairings(): Omit<PairedDeviceAgent, "credentialSalt" | "credentialHash">[] {
    return [...this.pairings.values()]
      .map(({ credentialSalt: _salt, credentialHash: _hash, ...record }) => record)
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  revokeAgent(agentId: string): boolean {
    const record = this.pairings.get(agentId);
    if (!record || record.revokedAt) return false;
    record.revokedAt = Date.now();
    this.persist();
    return true;
  }

  revokeDevice(deviceId: string): string[] {
    const revoked: string[] = [];
    for (const record of this.pairings.values()) {
      if (record.deviceId !== deviceId || record.revokedAt) continue;
      record.revokedAt = Date.now();
      revoked.push(record.agentId);
    }
    if (revoked.length) this.persist();
    return revoked;
  }

  private expirePending(): void {
    const now = Date.now();
    let changed = false;
    for (const [code, session] of this.pending) {
      if (session.expiresAt > now) continue;
      this.pending.delete(code);
      changed = true;
    }
    if (changed) this.persist();
  }

  private load(): void {
    if (!fs.existsSync(this.storePath)) return;
    const data = JSON.parse(fs.readFileSync(this.storePath, "utf8")) as Partial<Store>;
    if (data.format !== "gelato-pairings.v1") {
      throw new Error("Unsupported Gelato pairing store format");
    }
    for (const record of data.pairings ?? []) {
      if (record.agentId && record.deviceId && record.credentialHash) this.pairings.set(record.agentId, record);
    }
    const now = Date.now();
    for (const session of data.pending ?? []) {
      if (session.code && session.expiresAt > now) this.pending.set(session.code, session);
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true, mode: 0o700 });
    const data: Store = {
      format: "gelato-pairings.v1",
      pairings: [...this.pairings.values()],
      pending: [...this.pending.values()]
    };
    fs.writeFileSync(this.storePath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(this.storePath, 0o600);
  }
}

function setupUrl(session: PairingSession): string {
  const url = new URL("gelato://pair");
  url.searchParams.set("controllerUrl", session.controllerUrl);
  url.searchParams.set("pairingCode", session.code);
  url.searchParams.set("protocol", GELATO_PROTOCOL);
  if (session.allowedAgentKind) url.searchParams.set("agentKind", session.allowedAgentKind);
  if (session.allowedAgentKind === "ios") url.searchParams.set("startVpn", "1");
  return url.toString();
}

function normalizeCode(value?: string): string | undefined {
  return value?.toUpperCase().replace(/[^0-9A-Z]/g, "") || undefined;
}

function validAgentKind(value: string): boolean {
  return /^[a-z][a-z0-9-]{1,63}$/.test(value);
}

function validateDescriptor(value: AgentDescriptor): string | undefined {
  if (!/^inst_[A-Za-z0-9_-]{12,80}$/.test(value.installationId)) return "installationId is invalid";
  if (!validAgentKind(value.agentKind)) return "agentKind is invalid";
  if (!/^[a-z][a-z0-9.-]{1,63}$/.test(value.deviceKind)) return "deviceKind is invalid";
  if (!value.hostPlatform.trim() || value.hostPlatform.length > 40) return "hostPlatform is invalid";
  if (!value.displayName.trim() || value.displayName.length > 100) return "displayName is invalid";
  if (!value.agentVersion.trim() || value.agentVersion.length > 40) return "agentVersion is invalid";
  return undefined;
}

function makeCredential(): string {
  return `agtcred_${randomBytes(32).toString("base64url")}`;
}

function hashCredential(credential: string, salt: Buffer): string {
  return scryptSync(credential, salt, 32).toString("base64url");
}
