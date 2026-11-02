import { EventEmitter } from "node:events";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { AgentGateway } from "../../server-sdk/core/src/gateway.js";
import { DeviceAgentPairingService } from "../../server-sdk/core/src/pairingService.js";
import { UnifiedDeviceRegistry } from "../../server-sdk/core/src/registry.js";
import type { ProtocolEnvelope } from "../../server-sdk/core/src/types.js";
import { descriptor, message, snapshot, tempDirectory } from "../helpers.js";

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  readonly sent: ProtocolEnvelope[] = [];
  readonly close = vi.fn((code?: number, reason?: string) => {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit("close", code, Buffer.from(reason ?? ""));
  });
  readonly ping = vi.fn();
  readonly send = vi.fn((value: string) => {
    this.sent.push(JSON.parse(value) as ProtocolEnvelope);
  });
}

const request = {
  headers: {},
  socket: { remoteAddress: "127.0.0.1" }
};

describe("AgentGateway lifecycle", () => {
  let directory: ReturnType<typeof tempDirectory>;
  let pairing: DeviceAgentPairingService;
  let registry: UnifiedDeviceRegistry;
  let gateway: AgentGateway;

  beforeEach(() => {
    directory = tempDirectory("gelato-gateway-unit-");
    pairing = new DeviceAgentPairingService(join(directory.path, "pairings.json"));
    registry = new UnifiedDeviceRegistry();
    gateway = new AgentGateway(pairing, registry);
  });

  afterEach(() => {
    vi.useRealTimers();
    directory.cleanup();
  });

  function pair() {
    const session = pairing.createSession({
      ownerUserId: "user-a",
      controllerUrl: "https://controller.example.test",
      allowedAgentKind: descriptor.agentKind
    });
    const paired = pairing.pair(session.code, descriptor);
    if (!paired.accepted || !paired.record || !paired.credential) throw new Error("Test pairing failed");
    return paired;
  }

  function attachAuthenticated(paired = pair()) {
    const socket = new FakeSocket();
    gateway.attach(socket as unknown as WebSocket, request as never);
    socket.emit("message", Buffer.from(JSON.stringify(message("session.hello", {
      ...descriptor,
      agentId: paired.agentId,
      credential: paired.credential
    }))), false);
    return { socket, paired };
  }

  it("closes an unauthenticated connection after the bounded timeout", () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    gateway.attach(socket as unknown as WebSocket, request as never);
    vi.advanceTimersByTime(10_001);
    expect(socket.close).toHaveBeenCalledWith(1008, "Authentication timeout");
  });

  it("replaces duplicate device sessions and disconnects revoked agents", () => {
    const paired = pair();
    const first = attachAuthenticated(paired);
    expect(first.socket.sent.map(value => value.type)).toEqual(["session.accepted", "device.snapshot.request"]);
    const second = attachAuthenticated(paired);
    expect(first.socket.close).toHaveBeenCalledWith(1012, "Device connection replaced");
    expect(gateway.isOnline(paired.deviceId!)).toBe(true);

    gateway.disconnectAgent(paired.agentId!, "revoked by owner");
    expect(second.socket.close).toHaveBeenCalledWith(1008, "revoked by owner");
    expect(gateway.isOnline(paired.deviceId!)).toBe(false);
  });

  it("expires stale leases and marks the device offline", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { socket, paired } = attachAuthenticated();
    socket.sent.length = 0;
    vi.advanceTimersByTime(35_001);
    (gateway as unknown as { expireLeases(): void }).expireLeases();
    expect(socket.close).toHaveBeenCalledWith(1001, "Device connection lease expired");
    expect(registry.get(paired.deviceId!)?.connection.online).toBe(false);
  });

  it("binds an external transport, requests state, validates identity, and acknowledges messages", () => {
    const paired = pair();
    const send = vi.fn();
    gateway.setExternalTransport(paired.deviceId!, paired.agentId!, send);
    expect(registry.get(paired.deviceId!)).toBeTruthy();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "device.snapshot.request" }));

    gateway.ingestExternal(paired.deviceId!, paired.agentId!, message("device.snapshot", snapshot({
      hardware: { present: true, connected: true, controlAllowed: true, stableKey: "hardware-1", userAction: null }
    }) as unknown as Record<string, unknown>, { deviceId: paired.deviceId }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: "device.snapshot.ack",
      body: { revision: 1 }
    }));
    expect(registry.get(paired.deviceId!)?.hardware.controlAllowed).toBe(true);

    const before = send.mock.calls.length;
    gateway.ingestExternal(paired.deviceId!, "agt_wrongagent0001", message("lease.renew", {}, { deviceId: paired.deviceId }));
    expect(send).toHaveBeenCalledTimes(before);
    gateway.ingestExternal(paired.deviceId!, paired.agentId!, message("lease.renew", {}, {
      deviceId: "dev_wrongdevice0001"
    }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: "protocol.error",
      body: expect.objectContaining({ error: expect.stringContaining("deviceId") })
    }));
  });

  it("routes commands to the external lifetime and cancellation to both transports", () => {
    const { socket, paired } = attachAuthenticated();
    const external = vi.fn();
    gateway.setExternalTransport(paired.deviceId!, paired.agentId!, external);
    socket.sent.length = 0;
    external.mockClear();
    const command = message("command.request", {}, {
      deviceId: paired.deviceId,
      commandId: "cmd_gatewaycommand01"
    });
    gateway.send(paired.deviceId!, command);
    expect(external).toHaveBeenCalledWith(command);
    expect(socket.send).not.toHaveBeenCalledWith(JSON.stringify(command));

    const cancel = message("command.cancel", {}, {
      deviceId: paired.deviceId,
      commandId: "cmd_gatewaycommand01"
    });
    gateway.send(paired.deviceId!, cancel);
    expect(external).toHaveBeenCalledWith(cancel);
    expect(socket.sent).toContainEqual(cancel);

    gateway.setExternalTransport(paired.deviceId!, paired.agentId!, undefined);
    const socketOnly = message("lease.ack", {}, { deviceId: paired.deviceId });
    gateway.send(paired.deviceId!, socketOnly);
    expect(socket.sent).toContainEqual(socketOnly);
    socket.close();
    expect(() => gateway.send(paired.deviceId!, socketOnly)).toThrow("not connected");
  });

  it("rejects a changed hardware identity before applying state", () => {
    const { socket, paired } = attachAuthenticated();
    socket.emit("message", Buffer.from(JSON.stringify(message("device.snapshot", snapshot({
      hardware: { present: true, connected: true, controlAllowed: true, stableKey: "hardware-1", userAction: null }
    }) as unknown as Record<string, unknown>, { deviceId: paired.deviceId }))), false);
    expect(socket.sent.at(-1)?.type).toBe("device.snapshot.ack");

    socket.emit("message", Buffer.from(JSON.stringify(message("device.state.patch", {
      baseRevision: 1,
      revision: 2,
      patch: { hardware: { present: true, connected: true, controlAllowed: true, stableKey: "hardware-2" } }
    }, { deviceId: paired.deviceId }))), false);
    expect(socket.sent.at(-1)).toMatchObject({
      type: "session.rejected",
      body: { error: expect.stringContaining("identity changed") }
    });
    expect(socket.close).toHaveBeenCalledWith(1008, expect.stringContaining("identity changed"));
    expect(registry.get(paired.deviceId!)?.revision).toBe(1);
  });

  it("rejects invalid first messages and invalid external payloads without mutating revision", () => {
    const socket = new FakeSocket();
    gateway.attach(socket as unknown as WebSocket, request as never);
    socket.emit("message", Buffer.from(JSON.stringify(message("lease.renew", {}))), false);
    expect(socket.sent.at(-1)).toMatchObject({
      type: "protocol.error",
      body: { error: expect.stringContaining("First message") }
    });

    const paired = pair();
    const send = vi.fn();
    gateway.setExternalTransport(paired.deviceId!, paired.agentId!, send);
    gateway.ingestExternal(paired.deviceId!, paired.agentId!, {
      ...message("device.snapshot", snapshot() as unknown as Record<string, unknown>, { deviceId: paired.deviceId }),
      protocol: "gelato.v2" as "gelato.v1"
    });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "protocol.error" }));
    expect(registry.get(paired.deviceId!)?.revision).toBe(0);
  });

  it("dispatches authenticated foreground events and recovers from a stale patch", () => {
    const { socket, paired } = attachAuthenticated();
    const progress = vi.fn();
    const event = vi.fn();
    const input = vi.fn();
    const replyAck = vi.fn();
    const stream = vi.fn((_envelope: ProtocolEnvelope, reply: (value: ProtocolEnvelope) => void) => {
      reply(message("stream.accept", {}, { deviceId: paired.deviceId }));
    });
    const unknown = vi.fn();
    gateway.on("command.progress", progress);
    gateway.on("event", event);
    gateway.on("input", input);
    gateway.on("reply.ack", replyAck);
    gateway.on("stream.offer", stream);
    gateway.on("unknown", unknown);
    socket.sent.length = 0;

    socket.emit("message", Buffer.from(JSON.stringify(message("lease.renew", {}, {
      deviceId: paired.deviceId
    }))), false);
    expect(socket.sent.at(-1)).toMatchObject({ type: "lease.ack" });

    socket.emit("message", Buffer.from(JSON.stringify(message("device.snapshot", snapshot() as unknown as Record<string, unknown>, {
      deviceId: paired.deviceId
    }))), false);
    socket.emit("message", Buffer.from(JSON.stringify(message("device.state.patch", {
      baseRevision: 1,
      revision: 2,
      patch: { displayName: "Renamed phone" }
    }, { deviceId: paired.deviceId }))), false);
    expect(socket.sent.at(-1)).toMatchObject({
      type: "device.state.patch.ack",
      body: { revision: 2 }
    });

    const command = message("command.progress", { progress: 0.5 }, {
      deviceId: paired.deviceId,
      commandId: "cmd_gatewayevent001"
    });
    socket.emit("message", Buffer.from(JSON.stringify(command)), false);
    expect(progress).toHaveBeenCalledWith(command);

    const publishedEvent = message("event.publish", { name: "device.changed" }, {
      deviceId: paired.deviceId,
      eventId: "evt_gatewayevent001"
    });
    socket.emit("message", Buffer.from(JSON.stringify(publishedEvent)), false);
    expect(event).toHaveBeenCalledWith(publishedEvent);
    expect(socket.sent.at(-1)).toMatchObject({ type: "event.ack", eventId: publishedEvent.eventId });

    const publishedInput = message("input.publish", {
      kind: "instruction",
      parts: [{ type: "text", text: "Take a photo" }]
    }, { deviceId: paired.deviceId });
    socket.emit("message", Buffer.from(JSON.stringify(publishedInput)), false);
    expect(input).toHaveBeenCalledWith(publishedInput);

    const acknowledgement = message("reply.ack", { replyMessageId: "msg_gatewayreply001" }, {
      deviceId: paired.deviceId
    });
    socket.emit("message", Buffer.from(JSON.stringify(acknowledgement)), false);
    expect(replyAck).toHaveBeenCalledWith(acknowledgement);

    const offer = message("stream.offer", {}, { deviceId: paired.deviceId });
    socket.emit("message", Buffer.from(JSON.stringify(offer)), false);
    expect(stream).toHaveBeenCalledWith(offer, expect.any(Function));
    expect(socket.sent.at(-1)).toMatchObject({ type: "stream.accept" });

    socket.emit("message", Buffer.from(JSON.stringify(message("device.state.patch", {
      baseRevision: 0,
      revision: 1,
      patch: { displayName: "Stale update" }
    }, { deviceId: paired.deviceId }))), false);
    expect(socket.sent.slice(-2).map(value => value.type)).toEqual(["protocol.error", "device.snapshot.request"]);
    expect(registry.get(paired.deviceId!)?.revision).toBe(2);

    const unsupported = message("vendor.unsupported", {}, { deviceId: paired.deviceId });
    socket.emit("message", Buffer.from(JSON.stringify(unsupported)), false);
    expect(unknown).toHaveBeenCalledWith({ deviceId: paired.deviceId, envelope: unsupported });
  });

  it("dispatches and acknowledges external transport messages", () => {
    const paired = pair();
    const send = vi.fn();
    const result = vi.fn();
    const event = vi.fn();
    const input = vi.fn();
    const replyAck = vi.fn();
    const stream = vi.fn((_envelope: ProtocolEnvelope, reply: (value: ProtocolEnvelope) => void) => {
      reply(message("stream.accept", {}, { deviceId: paired.deviceId }));
    });
    gateway.on("command.result", result);
    gateway.on("event", event);
    gateway.on("input", input);
    gateway.on("reply.ack", replyAck);
    gateway.on("stream.offer", stream);
    gateway.setExternalTransport(paired.deviceId!, paired.agentId!, send);
    send.mockClear();

    gateway.ingestExternal(paired.deviceId!, paired.agentId!, message("device.snapshot", snapshot() as unknown as Record<string, unknown>, {
      deviceId: paired.deviceId
    }));
    gateway.ingestExternal(paired.deviceId!, paired.agentId!, message("device.state.patch", {
      baseRevision: 1,
      revision: 2,
      patch: { displayName: "Extension phone" }
    }, { deviceId: paired.deviceId }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: "device.state.patch.ack",
      body: { revision: 2 }
    }));

    const command = message("command.result", { value: "ok" }, {
      deviceId: paired.deviceId,
      commandId: "cmd_externalresult01"
    });
    gateway.ingestExternal(paired.deviceId!, paired.agentId!, command);
    expect(result).toHaveBeenCalledWith(command);

    const publishedEvent = message("event.publish", {}, {
      deviceId: paired.deviceId,
      eventId: "evt_externalevent001"
    });
    gateway.ingestExternal(paired.deviceId!, paired.agentId!, publishedEvent);
    expect(event).toHaveBeenCalledWith(publishedEvent);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: "event.ack",
      eventId: publishedEvent.eventId
    }));

    const publishedInput = message("input.publish", {
      kind: "observation",
      parts: [{ type: "media", streamId: "str_externalmedia001", mimeType: "image/jpeg" }]
    }, { deviceId: paired.deviceId });
    gateway.ingestExternal(paired.deviceId!, paired.agentId!, publishedInput);
    expect(input).toHaveBeenCalledWith(publishedInput);

    const acknowledgement = message("reply.ack", { replyMessageId: "msg_externalreply001" }, {
      deviceId: paired.deviceId
    });
    gateway.ingestExternal(paired.deviceId!, paired.agentId!, acknowledgement);
    expect(replyAck).toHaveBeenCalledWith(acknowledgement);

    const offer = message("stream.offer", {}, { deviceId: paired.deviceId });
    gateway.ingestExternal(paired.deviceId!, paired.agentId!, offer);
    expect(stream).toHaveBeenCalledWith(offer, expect.any(Function));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "stream.accept" }));

    gateway.ingestExternal(paired.deviceId!, paired.agentId!, message("capabilities.changed", {}, {
      deviceId: paired.deviceId
    }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: "device.snapshot.request",
      body: { revision: 3 }
    }));

    gateway.ingestExternal(paired.deviceId!, paired.agentId!, message("reply.ack", {
      replyMessageId: "invalid"
    }, { deviceId: paired.deviceId }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: "protocol.error",
      body: expect.objectContaining({ error: "Invalid reply acknowledgement" })
    }));

    gateway.ingestExternal(paired.deviceId!, paired.agentId!, message("vendor.unsupported", {}, {
      deviceId: paired.deviceId
    }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: "protocol.error",
      body: expect.objectContaining({ error: expect.stringContaining("Unsupported device message type") })
    }));
  });
});
