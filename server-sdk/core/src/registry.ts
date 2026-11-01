import { EventEmitter } from "node:events";
import type {
  CapabilityDescriptor,
  DeviceTransportState,
  DriverDescriptor,
  HardwareState,
  UnifiedDeviceRecord
} from "./types.js";

export interface AgentBinding {
  agentId: string;
  installationId: string;
  agentKind: string;
  hostPlatform: string;
  agentVersion: string;
  deviceId: string;
  deviceKind: string;
  displayName: string;
}

export interface DeviceSnapshotBody {
  revision: number;
  kind?: string;
  displayName?: string;
  os: { family: string; version: string };
  driver: DriverDescriptor;
  hardware: HardwareState;
  capabilities: CapabilityDescriptor[];
}

export class UnifiedDeviceRegistry extends EventEmitter {
  private readonly devices = new Map<string, UnifiedDeviceRecord>();

  bind(binding: AgentBinding): UnifiedDeviceRecord {
    const now = new Date().toISOString();
    const previous = this.devices.get(binding.deviceId);
    const record: UnifiedDeviceRecord = previous ?? {
      deviceId: binding.deviceId,
      kind: binding.deviceKind,
      displayName: binding.displayName,
      os: { family: binding.hostPlatform, version: "unknown" },
      agent: {
        agentId: binding.agentId,
        installationId: binding.installationId,
        kind: binding.agentKind,
        hostPlatform: binding.hostPlatform,
        version: binding.agentVersion
      },
      driver: {
        id: "unbound",
        version: "0",
        location: "device",
        state: "starting"
      },
      connection: {
        online: true,
        sessionState: "synchronizing",
        connectedAt: now,
        lastSeenAt: now
      },
      hardware: { present: true, connected: false, userAction: null },
      capabilities: [],
      revision: 0,
      updatedAt: now
    };
    const next: UnifiedDeviceRecord = {
      ...record,
      kind: binding.deviceKind || record.kind,
      displayName: binding.displayName || record.displayName,
      agent: {
        agentId: binding.agentId,
        installationId: binding.installationId,
        kind: binding.agentKind,
        hostPlatform: binding.hostPlatform,
        version: binding.agentVersion
      },
      connection: {
        ...record.connection,
        online: true,
        sessionState: "synchronizing",
        connectedAt: now,
        lastSeenAt: now
      },
      // Snapshot revisions are scoped to one authenticated device connection. Devices
      // legitimately restart their counter after an app/process restart.
      hardware: { ...record.hardware, ...(previous ? { controlAllowed: false } : {}) },
      driver: { ...record.driver, state: "starting" },
      revision: 0,
      updatedAt: now
    };
    return this.store(next);
  }

  applySnapshot(deviceId: string, body: DeviceSnapshotBody): UnifiedDeviceRecord {
    const current = this.require(deviceId);
    if (!Number.isInteger(body.revision) || body.revision < current.revision) {
      throw new Error(`Snapshot revision ${body.revision} is older than ${current.revision}`);
    }
    validateCapabilities(body.capabilities);
    const now = new Date().toISOString();
    return this.store({
      ...current,
      kind: body.kind ?? current.kind,
      displayName: body.displayName ?? current.displayName,
      os: body.os,
      driver: { ...body.driver, hostAgentId: current.agent.agentId },
      hardware: body.hardware,
      capabilities: body.capabilities,
      connection: {
        ...current.connection,
        online: true,
        sessionState: body.driver.state === "ready" ? "online" : "degraded",
        lastSeenAt: now
      },
      revision: body.revision,
      updatedAt: now
    });
  }

  applyPatch(
    deviceId: string,
    body: { baseRevision: number; revision: number; patch: Record<string, unknown> }
  ): UnifiedDeviceRecord {
    const current = this.require(deviceId);
    if (body.baseRevision !== current.revision || body.revision <= body.baseRevision) {
      throw new Error(
        `State patch revision mismatch: have ${current.revision}, base ${body.baseRevision}, next ${body.revision}`
      );
    }
    const allowed = new Set(["displayName", "os", "driver", "hardware", "capabilities"]);
    for (const key of Object.keys(body.patch)) {
      if (!allowed.has(key)) throw new Error(`State patch field ${key} is not mutable`);
    }
    const capabilities = (body.patch.capabilities ?? current.capabilities) as CapabilityDescriptor[];
    validateCapabilities(capabilities);
    const now = new Date().toISOString();
    const driver = (body.patch.driver ?? current.driver) as DriverDescriptor;
    return this.store({
      ...current,
      ...body.patch,
      agent: current.agent,
      deviceId: current.deviceId,
      kind: current.kind,
      driver: { ...driver, hostAgentId: current.agent.agentId },
      capabilities,
      connection: {
        ...current.connection,
        online: true,
        sessionState: driver.state === "ready" ? "online" : "degraded",
        lastSeenAt: now
      },
      revision: body.revision,
      updatedAt: now
    } as UnifiedDeviceRecord);
  }

  touch(deviceId: string): UnifiedDeviceRecord {
    const current = this.require(deviceId);
    const now = new Date().toISOString();
    return this.store({
      ...current,
      connection: { ...current.connection, online: true, lastSeenAt: now },
      updatedAt: now
    });
  }

  markTransport(
    deviceId: string,
    transport: string,
    online: boolean,
    seenAt = Date.now(),
    metadata: Omit<Partial<DeviceTransportState>, "online" | "lastSeenAt"> = {}
  ): UnifiedDeviceRecord | undefined {
    const current = this.devices.get(deviceId);
    if (!current) return undefined;
    const lastSeenAt = new Date(seenAt).toISOString();
    const transports = {
      ...(current.connection.transports ?? {}),
      [transport]: {
        ...current.connection.transports?.[transport],
        ...metadata,
        online,
        lastSeenAt
      }
    };
    const anyTransportOnline = online || Object.entries(transports).some(
      ([name, value]) => name !== transport && value.online
    );
    return this.store({
      ...current,
      connection: {
        ...current.connection,
        online: anyTransportOnline,
        sessionState: anyTransportOnline
          ? current.driver.state === "ready" ? "online" : "degraded"
          : "offline",
        lastSeenAt: anyTransportOnline ? lastSeenAt : current.connection.lastSeenAt,
        transports
      },
      updatedAt: lastSeenAt
    });
  }

  markOffline(deviceId: string): UnifiedDeviceRecord | undefined {
    const current = this.devices.get(deviceId);
    if (!current) return undefined;
    const now = new Date().toISOString();
    const transports = current.connection.transports ?? {};
    const externalOnline = Object.values(transports).some((value) => value.online);
    return this.store({
      ...current,
      connection: {
        ...current.connection,
        online: externalOnline,
        sessionState: externalOnline
          ? current.driver.state === "ready" ? "online" : "degraded"
          : "offline",
        lastSeenAt: now
      },
      updatedAt: now
    });
  }

  expire(staleMs: number, now = Date.now()): void {
    for (const device of this.devices.values()) {
      if (device.connection.online && now - Date.parse(device.connection.lastSeenAt) > staleMs) {
        this.markOffline(device.deviceId);
      }
    }
  }

  get(deviceId: string): UnifiedDeviceRecord | undefined {
    return this.devices.get(deviceId);
  }

  getByAgentId(agentId: string): UnifiedDeviceRecord | undefined {
    return [...this.devices.values()].find((device) => device.agent.agentId === agentId);
  }

  list(): UnifiedDeviceRecord[] {
    return [...this.devices.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  private require(deviceId: string): UnifiedDeviceRecord {
    const record = this.devices.get(deviceId);
    if (!record) throw new Error(`Unified device ${deviceId} is not registered`);
    return record;
  }

  private store(record: UnifiedDeviceRecord): UnifiedDeviceRecord {
    const frozen = structuredClone(record);
    this.devices.set(record.deviceId, frozen);
    this.emit("changed", frozen);
    return frozen;
  }
}

function validateCapabilities(capabilities: CapabilityDescriptor[]): void {
  if (!Array.isArray(capabilities)) throw new Error("capabilities must be an array");
  if (!capabilities.some(value => value.name === "device.describe" && value.version === 1)) {
    throw new Error("Gelato v1 requires device.describe@1");
  }
  const seen = new Set<string>();
  for (const capability of capabilities) {
    if (!/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/.test(capability.name)) {
      throw new Error(`Invalid capability name ${capability.name}`);
    }
    if (!Number.isInteger(capability.version) || capability.version < 1) {
      throw new Error(`Invalid capability version for ${capability.name}`);
    }
    const key = `${capability.name}@${capability.version}`;
    if (seen.has(key)) throw new Error(`Duplicate capability ${key}`);
    seen.add(key);
  }
}
