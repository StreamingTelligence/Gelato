import { EventEmitter } from "node:events";
import { nanoid } from "nanoid";
import type { AgentGateway } from "./gateway.js";
import { DeviceControlPausedError, type CapabilityRouter } from "./capabilityRouter.js";
import { GELATO_PROTOCOL, type CommandRequest, type CommandTerminal, type ProtocolEnvelope } from "./types.js";

interface Pending {
  deviceId: string;
  capability: string;
  commandId: string;
  startedAt: string;
  resolve: (result: CommandTerminal) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export function commandDeadlineMs(capability: string, requested?: number): number {
  // Media transfers have a longer bounded deadline than interaction commands.
  const value = requested ?? (capability === "screen.capture" ? 120_000 : 30_000);
  if (!Number.isFinite(value) || value <= 0) throw new Error("Command deadline must be a positive finite number");
  return Math.max(1_000, Math.min(value, 5 * 60_000));
}

export class CommandService extends EventEmitter {
  private readonly pending = new Map<string, Pending>();
  private readonly terminal = new Map<string, CommandTerminal>();

  constructor(
    private readonly gateway: AgentGateway,
    private readonly router: CapabilityRouter
  ) {
    super();
    gateway.on("command.progress", (message: ProtocolEnvelope) => this.onProgress(message));
    gateway.on("command.result", (message: ProtocolEnvelope) => this.onTerminal(message, true));
    gateway.on("command.error", (message: ProtocolEnvelope) => this.onTerminal(message, false));
  }

  execute(deviceId: string, request: CommandRequest): Promise<CommandTerminal> {
    const version = request.capabilityVersion ?? 1;
    this.router.resolve(deviceId, request.capability, version);
    const commandId = request.commandId ?? `cmd_${nanoid(24)}`;
    const cached = this.terminal.get(commandId);
    if (cached) {
      if (cached.deviceId !== deviceId) throw new Error(`commandId ${commandId} belongs to another device`);
      return Promise.resolve(cached);
    }
    if (this.pending.has(commandId)) throw new Error(`Command ${commandId} is already running`);
    const timeoutMs = commandDeadlineMs(request.capability, request.deadlineMs);
    const startedAt = new Date().toISOString();
    const deadline = new Date(Date.now() + timeoutMs).toISOString();
    const envelope: ProtocolEnvelope = {
      protocol: GELATO_PROTOCOL,
      type: "command.request",
      messageId: `msg_${nanoid(24)}`,
      deviceId,
      commandId,
      sentAt: startedAt,
      body: {
        commandId,
        capability: request.capability,
        capabilityVersion: version,
        arguments: request.arguments ?? {},
        deadline,
        idempotency: request.idempotency ?? "side-effecting",
        ...(request.consentRef ? { consentRef: request.consentRef } : {})
      }
    };
    return new Promise<CommandTerminal>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(commandId);
        const result: CommandTerminal = {
          commandId,
          deviceId,
          state: "timed-out",
          error: `Command timed out after ${timeoutMs}ms`,
          startedAt,
          completedAt: new Date().toISOString()
        };
        this.cache(result);
        this.emit("cancel", { deviceId, commandId, reason: "Command deadline exceeded" });
        try {
          this.gateway.send(deviceId, envelopeFor("command.cancel", deviceId, commandId, { reason: "deadline" }));
        } catch {
          // The timeout result remains authoritative if the device connection is already gone.
        }
        reject(new Error(result.error));
      }, timeoutMs);
      this.pending.set(commandId, { deviceId, capability: request.capability, commandId, startedAt, resolve, reject, timer });
      try {
        this.gateway.send(deviceId, envelope);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(commandId);
        reject(error);
      }
    });
  }

  cancel(deviceId: string, commandId: string): boolean {
    const pending = this.pending.get(commandId);
    if (!pending || pending.deviceId !== deviceId) return false;
    this.emit("cancel", { deviceId, commandId, reason: "Command cancelled by operator" });
    this.gateway.send(deviceId, envelopeFor("command.cancel", deviceId, commandId, { reason: "operator" }));
    return true;
  }

  get(commandId: string): CommandTerminal | undefined {
    return this.terminal.get(commandId);
  }

  cancelDevice(deviceId: string, reason = "Device control paused"): void {
    for (const [commandId, pending] of this.pending) {
      if (pending.deviceId !== deviceId || pending.capability === "device.describe") continue;
      clearTimeout(pending.timer);
      this.pending.delete(commandId);
      this.cache({ commandId, deviceId, state: "cancelled", error: reason,
        startedAt: pending.startedAt, completedAt: new Date().toISOString() });
      this.emit("cancel", { deviceId, commandId, reason });
      try { this.gateway.send(deviceId, envelopeFor("command.cancel", deviceId, commandId, { reason })); }
      catch { /* Local authorization remains authoritative even after transport teardown. */ }
      pending.reject(reason === "Device control paused" ? new DeviceControlPausedError() : new Error(reason));
    }
  }

  private onProgress(message: ProtocolEnvelope): void {
    if (!message.commandId || !this.pending.has(message.commandId)) return;
    this.emit("progress", message);
  }

  private onTerminal(message: ProtocolEnvelope, ok: boolean): void {
    if (!message.commandId) return;
    const pending = this.pending.get(message.commandId);
    if (!pending || pending.deviceId !== message.deviceId) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.commandId);
    const body = message.body as Record<string, unknown>;
    const terminal: CommandTerminal = {
      commandId: message.commandId,
      deviceId: pending.deviceId,
      state: ok ? "completed" : body.cancelled === true ? "cancelled" : "failed",
      ...(ok ? { result: (body.result ?? body) as Record<string, unknown> } : { error: String(body.error ?? "Command failed") }),
      startedAt: pending.startedAt,
      completedAt: new Date().toISOString()
    };
    this.cache(terminal);
    if (ok) pending.resolve(terminal);
    else pending.reject(new Error(terminal.error));
  }

  private cache(result: CommandTerminal): void {
    this.terminal.set(result.commandId, result);
    while (this.terminal.size > 1_000) this.terminal.delete(this.terminal.keys().next().value!);
  }
}

function envelopeFor(
  type: string,
  deviceId: string,
  commandId: string,
  body: Record<string, unknown>
): ProtocolEnvelope {
  return {
    protocol: GELATO_PROTOCOL,
    type,
    messageId: `msg_${nanoid(24)}`,
    deviceId,
    commandId,
    sentAt: new Date().toISOString(),
    body: { commandId, ...body }
  };
}
