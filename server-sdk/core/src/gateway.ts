import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { nanoid } from "nanoid";
import { WebSocket } from "ws";
import type { RawData } from "ws";
import type { DeviceAgentPairingService, PairedDeviceAgent, AgentDescriptor } from "./pairingService.js";
import type { AgentBinding, DeviceSnapshotBody, UnifiedDeviceRegistry } from "./registry.js";
import { GELATO_PROTOCOL, type ProtocolEnvelope } from "./types.js";
import { requestNetworkClass } from "./transport.js";
import { parseDeviceInput } from "./exchange.js";

interface GatewaySession {
  socket: WebSocket;
  request: IncomingMessage;
  authenticated: boolean;
  agent?: PairedDeviceAgent;
  authTimer: NodeJS.Timeout;
  lastLeaseAt: number;
}

interface ExternalTransport {
  agentId: string;
  send: (envelope: ProtocolEnvelope) => void;
}

const AUTH_TIMEOUT_MS = 10_000;
const LEASE_STALE_MS = 35_000;

export class AgentGateway extends EventEmitter {
  private readonly sessionsByDevice = new Map<string, GatewaySession>();
  private readonly externalByDevice = new Map<string, ExternalTransport>();

  constructor(
    private readonly pairing: DeviceAgentPairingService,
    readonly registry: UnifiedDeviceRegistry,
    private readonly trustLocalCloudflared = false
  ) {
    super();
    setInterval(() => this.expireLeases(), 5_000).unref();
  }

  attach(socket: WebSocket, request: IncomingMessage): void {
    const session: GatewaySession = {
      socket,
      request,
      authenticated: false,
      lastLeaseAt: Date.now(),
      authTimer: setTimeout(() => socket.close(1008, "Authentication timeout"), AUTH_TIMEOUT_MS)
    };
    socket.on("message", (data, binary) => {
      if (binary) {
        socket.close(1003, "Binary frames require a negotiated typed stream");
        return;
      }
      this.handleText(session, data);
    });
    socket.on("pong", () => this.touch(session));
    socket.on("close", () => this.close(session));
    socket.on("error", () => this.close(session));
  }

  send(deviceId: string, envelope: ProtocolEnvelope): void {
    const session = this.sessionsByDevice.get(deviceId);
    const external = this.externalByDevice.get(deviceId);
    if (external && envelope.type === "command.request") {
      // The iOS extension outlives the foreground socket. An OPEN socket can
      // already belong to a suspended app until its lease expires.
      external.send(envelope);
      return;
    }
    if (envelope.type === "command.cancel" && external) {
      external.send(envelope);
      // The command may predate the extension's connection. Cancellation is
      // idempotent, so notify both lifetimes of this same authenticated device connection.
      if (session?.socket.readyState === WebSocket.OPEN) session.socket.send(JSON.stringify(envelope));
      return;
    }
    if (session && session.socket.readyState === WebSocket.OPEN) {
      session.socket.send(JSON.stringify(envelope));
      return;
    }
    if (external) {
      external.send(envelope);
      return;
    }
    throw new Error(`Device ${deviceId} is not connected`);
  }

  isOnline(deviceId: string): boolean {
    const session = this.sessionsByDevice.get(deviceId);
    return Boolean(session && session.socket.readyState === WebSocket.OPEN)
      || this.externalByDevice.has(deviceId);
  }

  setExternalTransport(
    deviceId: string,
    agentId: string,
    send: ((envelope: ProtocolEnvelope) => void) | undefined
  ): void {
    if (!send) {
      this.externalByDevice.delete(deviceId);
      return;
    }
    if (!this.registry.get(deviceId)) {
      // Called only after PacketOverlay authenticates this device credential.
      // Binding restores identity, not authorization: control remains unknown
      // until a fresh device snapshot arrives from the live extension.
      const record = this.pairing.listPairings().find(value =>
        value.agentId === agentId && value.deviceId === deviceId && !value.revokedAt);
      if (!record) throw new Error("Device connection has no active pairing");
      this.registry.bind(binding(record));
    }
    const firstConnection = !this.externalByDevice.has(deviceId);
    this.externalByDevice.set(deviceId, { agentId, send });
    if (firstConnection) this.requestExternalSnapshot(deviceId);
  }

  ingestExternal(deviceId: string, agentId: string, envelope: ProtocolEnvelope): void {
    const transport = this.externalByDevice.get(deviceId);
    if (!transport || transport.agentId !== agentId) return;
    try {
      validateEnvelope(envelope);
      if (envelope.deviceId !== deviceId) throw new Error("Envelope deviceId does not match authenticated device");
      const device = this.registry.get(deviceId);
      if (!device || device.agent.agentId !== agentId) throw new Error("Device connection binding is invalid");
      this.registry.touch(deviceId);
      switch (envelope.type) {
        case "lease.renew":
          this.replyExternal(transport, deviceId, "lease.ack", { leaseExpiresInMs: LEASE_STALE_MS });
          if (this.sessionsByDevice.get(deviceId)?.socket.readyState !== WebSocket.OPEN) {
            this.requestExternalSnapshot(deviceId);
          }
          break;
        case "device.snapshot":
          this.requireHardwareBinding(agentId, envelope.body as unknown as DeviceSnapshotBody);
          this.registry.applySnapshot(deviceId, envelope.body as unknown as DeviceSnapshotBody);
          this.replyExternal(transport, deviceId, "device.snapshot.ack", {
            revision: Number((envelope.body as Record<string, unknown>).revision)
          });
          break;
        case "device.state.patch": {
          const body = envelope.body as {
            baseRevision: number;
            revision: number;
            patch: Record<string, unknown>;
          };
          this.requireHardwareBinding(agentId, body.patch);
          this.registry.applyPatch(deviceId, body);
          this.replyExternal(transport, deviceId, "device.state.patch.ack", { revision: body.revision });
          break;
        }
        case "capabilities.changed":
          this.requestExternalSnapshot(deviceId);
          break;
        case "command.progress":
        case "command.result":
        case "command.error":
          this.emit(envelope.type, envelope);
          break;
        case "stream.offer":
        case "stream.close":
          this.emit(envelope.type, envelope, (reply: ProtocolEnvelope) => transport.send(reply));
          break;
        case "event.publish":
          this.emit("event", envelope);
          if (envelope.eventId) {
            this.replyExternal(transport, deviceId, "event.ack", {}, { eventId: envelope.eventId });
          }
          break;
        case "input.publish":
          parseDeviceInput(envelope.body);
          this.emit("input", envelope);
          break;
        case "reply.ack":
          if (!/^msg_[A-Za-z0-9_-]{10,80}$/.test(String((envelope.body as Record<string, unknown>).replyMessageId ?? ""))) {
            throw new Error("Invalid reply acknowledgement");
          }
          this.emit("reply.ack", envelope);
          break;
        default:
          this.replyExternal(transport, deviceId, "protocol.error", {
            requestMessageId: envelope.messageId,
            error: `Unsupported device message type ${envelope.type}`
          });
      }
    } catch (error) {
      this.replyExternal(transport, deviceId, "protocol.error", {
        requestMessageId: envelope.messageId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  disconnectAgent(agentId: string, reason = "Device credential revoked"): void {
    for (const session of this.sessionsByDevice.values()) {
      if (session.agent?.agentId === agentId) session.socket.close(1008, reason);
    }
  }

  private requestExternalSnapshot(deviceId: string): void {
    const transport = this.externalByDevice.get(deviceId);
    const device = this.registry.get(deviceId);
    if (!transport || !device) return;
    this.replyExternal(transport, deviceId, "device.snapshot.request", {
      revision: device.revision + 1
    });
  }

  private handleText(session: GatewaySession, data: RawData): void {
    let envelope: ProtocolEnvelope;
    try {
      envelope = parseEnvelope(data.toString("utf8"));
    } catch (error) {
      this.reject(session, error instanceof Error ? error.message : String(error));
      return;
    }
    if (!session.authenticated) {
      this.authenticate(session, envelope);
      return;
    }
    if (envelope.deviceId !== session.agent?.deviceId) {
      this.reject(session, "Envelope deviceId does not match authenticated device");
      return;
    }
    const agent = session.agent;
    if (!agent) {
      this.reject(session, "Authenticated session is missing its device binding");
      return;
    }
    this.touch(session);
    try {
      switch (envelope.type) {
        case "lease.renew":
          this.registry.touch(agent.deviceId);
          this.reply(session, "lease.ack", { leaseExpiresInMs: LEASE_STALE_MS });
          break;
        case "device.snapshot":
          {
            const bindingError = this.hardwareBindingError(
              agent.agentId,
              envelope.body as unknown as DeviceSnapshotBody
            );
            if (bindingError) {
              this.reject(session, bindingError, "session.rejected");
              return;
            }
          }
          this.registry.applySnapshot(agent.deviceId, envelope.body as unknown as DeviceSnapshotBody);
          this.reply(session, "device.snapshot.ack", {
            revision: Number((envelope.body as Record<string, unknown>).revision)
          });
          break;
        case "device.state.patch": {
          const body = envelope.body as {
            baseRevision: number;
            revision: number;
            patch: Record<string, unknown>;
          };
          const bindingError = this.hardwareBindingError(agent.agentId, body.patch);
          if (bindingError) {
            this.reject(session, bindingError, "session.rejected");
            return;
          }
          this.registry.applyPatch(agent.deviceId, body);
          this.reply(session, "device.state.patch.ack", { revision: body.revision });
          break;
        }
        case "capabilities.changed":
          this.emit("snapshotRequested", agent.deviceId);
          this.reply(session, "device.snapshot.request", {});
          break;
        case "command.progress":
        case "command.result":
        case "command.error":
          this.emit(envelope.type, envelope);
          break;
        case "event.publish":
          this.emit("event", envelope);
          if (envelope.eventId) this.reply(session, "event.ack", {}, { eventId: envelope.eventId });
          break;
        case "input.publish":
          parseDeviceInput(envelope.body);
          this.emit("input", envelope);
          break;
        case "reply.ack":
          if (!/^msg_[A-Za-z0-9_-]{10,80}$/.test(String((envelope.body as Record<string, unknown>).replyMessageId ?? ""))) {
            throw new Error("Invalid reply acknowledgement");
          }
          this.emit("reply.ack", envelope);
          break;
        case "stream.offer":
        case "stream.close":
          this.emit(envelope.type, envelope, (reply: ProtocolEnvelope) => {
            if (session.socket.readyState !== WebSocket.OPEN) throw new Error("Stream source transport disconnected");
            session.socket.send(JSON.stringify(reply));
          });
          break;
        default:
          this.emit("unknown", { deviceId: agent.deviceId, envelope });
      }
    } catch (error) {
      this.reply(session, "protocol.error", {
        requestMessageId: envelope.messageId,
        error: error instanceof Error ? error.message : String(error)
      });
      if (envelope.type === "device.state.patch") this.reply(session, "device.snapshot.request", {});
    }
  }

  private authenticate(session: GatewaySession, envelope: ProtocolEnvelope): void {
    const body = envelope.body as Record<string, unknown>;
    let result;
    if (envelope.type === "pairing.request") {
      result = this.pairing.pair(string(body.pairingCode), descriptor(body));
    } else if (envelope.type === "session.hello") {
      result = this.pairing.authenticate(
        string(body.agentId) ?? "",
        string(body.credential),
        descriptor(body)
      );
    } else {
      this.reject(session, "First message must authenticate the device connection");
      return;
    }
    if (!result.accepted || !result.record || !result.agentId || !result.deviceId) {
      this.reject(
        session,
        result.reason ?? "Device connection authentication rejected",
        envelope.type === "session.hello" ? "session.rejected" : "pairing.rejected"
      );
      return;
    }
    clearTimeout(session.authTimer);
    session.authenticated = true;
    session.agent = result.record;
    session.lastLeaseAt = Date.now();
    const previous = this.sessionsByDevice.get(result.deviceId);
    if (previous && previous !== session) previous.socket.close(1012, "Device connection replaced");
    this.sessionsByDevice.set(result.deviceId, session);
    this.registry.bind(binding(result.record));
    this.registry.markTransport(result.deviceId, "control-websocket", true, Date.now(), {
      networkClass: requestNetworkClass(session.request, this.trustLocalCloudflared)
    });
    this.reply(session, envelope.type === "session.hello" ? "session.accepted" : "pairing.accepted", {
      agentId: result.agentId,
      deviceId: result.deviceId,
      ...(result.credential ? { credential: result.credential } : {}),
      leaseIntervalMs: 10_000,
      leaseStaleMs: LEASE_STALE_MS
    });
    this.reply(session, "device.snapshot.request", {});
    this.emit("online", result.deviceId);
  }

  private touch(session: GatewaySession): void {
    if (!session.authenticated || !session.agent) return;
    session.lastLeaseAt = Date.now();
    this.registry.markTransport(session.agent.deviceId, "control-websocket", true, session.lastLeaseAt, {
      networkClass: requestNetworkClass(session.request, this.trustLocalCloudflared)
    });
  }

  private requireHardwareBinding(agentId: string, body: unknown): void {
    const error = this.hardwareBindingError(agentId, body);
    if (error) throw new Error(error);
  }

  private hardwareBindingError(agentId: string, body: unknown): string | undefined {
    if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
    const hardware = (body as Record<string, unknown>).hardware;
    if (!hardware || typeof hardware !== "object" || Array.isArray(hardware)) return undefined;
    const stableKey = (hardware as Record<string, unknown>).stableKey;
    if (stableKey === undefined) return undefined;
    if (typeof stableKey !== "string") return "Hardware stableKey is invalid";
    const result = this.pairing.bindHardwareKey(agentId, stableKey);
    return result.accepted ? undefined : result.reason;
  }

  private expireLeases(): void {
    const now = Date.now();
    for (const [deviceId, session] of this.sessionsByDevice) {
      if (now - session.lastLeaseAt <= LEASE_STALE_MS) {
        if (session.socket.readyState === WebSocket.OPEN) session.socket.ping();
        continue;
      }
      session.socket.close(1001, "Device connection lease expired");
      this.sessionsByDevice.delete(deviceId);
      this.registry.markOffline(deviceId);
    }
    this.registry.expire(LEASE_STALE_MS, now);
  }

  private close(session: GatewaySession): void {
    clearTimeout(session.authTimer);
    if (!session.agent) return;
    if (this.sessionsByDevice.get(session.agent.deviceId) !== session) return;
    this.sessionsByDevice.delete(session.agent.deviceId);
    this.registry.markTransport(session.agent.deviceId, "control-websocket", false);
    this.registry.markOffline(session.agent.deviceId);
    this.emit("offline", session.agent.deviceId);
  }

  private reject(session: GatewaySession, reason: string, type = "protocol.error"): void {
    this.reply(session, type, { error: reason });
    session.socket.close(1008, reason.slice(0, 120));
  }

  private reply(
    session: GatewaySession,
    type: string,
    body: Record<string, unknown>,
    extra: Partial<ProtocolEnvelope> = {}
  ): void {
    if (session.socket.readyState !== WebSocket.OPEN) return;
    const envelope: ProtocolEnvelope = {
      protocol: GELATO_PROTOCOL,
      type,
      messageId: `msg_${nanoid(24)}`,
      ...(session.agent ? { deviceId: session.agent.deviceId } : {}),
      sentAt: new Date().toISOString(),
      body,
      ...extra
    };
    session.socket.send(JSON.stringify(envelope));
  }

  private replyExternal(
    transport: ExternalTransport,
    deviceId: string,
    type: string,
    body: Record<string, unknown>,
    extra: Partial<ProtocolEnvelope> = {}
  ): void {
    transport.send({
      protocol: GELATO_PROTOCOL,
      type,
      messageId: `msg_${nanoid(24)}`,
      deviceId,
      sentAt: new Date().toISOString(),
      body,
      ...extra
    });
  }
}

function parseEnvelope(text: string): ProtocolEnvelope {
  const value = JSON.parse(text) as Partial<ProtocolEnvelope>;
  validateEnvelope(value);
  return value as ProtocolEnvelope;
}

function validateEnvelope(value: Partial<ProtocolEnvelope>): void {
  if (value.protocol !== GELATO_PROTOCOL) throw new Error("Unsupported protocol version");
  if (!value.type || typeof value.type !== "string") throw new Error("Envelope type is required");
  if (!value.messageId || !/^msg_[A-Za-z0-9_-]{10,80}$/.test(value.messageId)) {
    throw new Error("Envelope messageId is invalid");
  }
  if (value.deviceId !== undefined && !/^dev_[A-Za-z0-9_-]{10,80}$/.test(value.deviceId)) {
    throw new Error("Envelope deviceId is invalid");
  }
  if (value.commandId !== undefined && !/^cmd_[A-Za-z0-9_-]{10,80}$/.test(value.commandId)) {
    throw new Error("Envelope commandId is invalid");
  }
  if (value.eventId !== undefined && !/^evt_[A-Za-z0-9_-]{10,80}$/.test(value.eventId)) {
    throw new Error("Envelope eventId is invalid");
  }
  if (!value.sentAt || !Number.isFinite(Date.parse(value.sentAt))) throw new Error("Envelope sentAt is invalid");
  if (!value.body || typeof value.body !== "object" || Array.isArray(value.body)) {
    throw new Error("Envelope body must be an object");
  }
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function descriptor(body: Record<string, unknown>): AgentDescriptor {
  return {
    installationId: string(body.installationId) ?? "",
    agentKind: string(body.agentKind) ?? "",
    hostPlatform: string(body.hostPlatform) ?? "",
    deviceKind: string(body.deviceKind) ?? "",
    displayName: string(body.displayName) ?? "",
    agentVersion: string(body.agentVersion) ?? ""
  };
}

function binding(record: Omit<PairedDeviceAgent, "credentialSalt" | "credentialHash">): AgentBinding {
  return {
    agentId: record.agentId,
    deviceId: record.deviceId,
    installationId: record.installationId,
    agentKind: record.agentKind,
    hostPlatform: record.hostPlatform,
    agentVersion: record.agentVersion,
    deviceKind: record.deviceKind,
    displayName: record.displayName
  };
}
