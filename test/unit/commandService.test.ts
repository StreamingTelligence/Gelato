import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandService, commandDeadlineMs } from "../../server-sdk/core/src/commandService.js";
import { DeviceControlPausedError } from "../../server-sdk/core/src/capabilityRouter.js";
import type { AgentGateway } from "../../server-sdk/core/src/gateway.js";
import type { ProtocolEnvelope } from "../../server-sdk/core/src/types.js";

class FakeGateway extends EventEmitter {
  send = vi.fn<(deviceId: string, envelope: ProtocolEnvelope) => void>();
}

describe("CommandService", () => {
  let gateway: FakeGateway;
  let service: CommandService;
  const router = { resolve: vi.fn(() => ({ name: "screen.capture", version: 1 })) };

  beforeEach(() => {
    gateway = new FakeGateway();
    router.resolve.mockClear();
    service = new CommandService(gateway as unknown as AgentGateway, router as never);
  });

  afterEach(() => vi.useRealTimers());

  it("bounds command deadlines", () => {
    expect(commandDeadlineMs("screen.capture")).toBe(120_000);
    expect(commandDeadlineMs("device.describe")).toBe(30_000);
    expect(commandDeadlineMs("x", 1)).toBe(1_000);
    expect(commandDeadlineMs("x", 999_999)).toBe(300_000);
    expect(() => commandDeadlineMs("x", 0)).toThrow(/positive finite/);
    expect(() => commandDeadlineMs("x", Number.NaN)).toThrow(/positive finite/);
  });

  it("sends a bounded request and resolves a matching terminal result", async () => {
    const pending = service.execute("dev_testdevice0001", {
      commandId: "cmd_testcommand001",
      capability: "screen.capture",
      arguments: { format: "jpeg" },
      idempotency: "read-only"
    });
    const request = gateway.send.mock.calls[0][1];
    expect(request).toMatchObject({
      type: "command.request",
      deviceId: "dev_testdevice0001",
      commandId: "cmd_testcommand001",
      body: { capability: "screen.capture", arguments: { format: "jpeg" }, idempotency: "read-only" }
    });
    gateway.emit("command.result", {
      ...request,
      type: "command.result",
      body: { result: { streamId: "str_teststream001" } }
    });
    await expect(pending).resolves.toMatchObject({
      state: "completed",
      result: { streamId: "str_teststream001" }
    });
    expect(service.get("cmd_testcommand001")?.state).toBe("completed");
  });

  it("rejects failed commands and ignores terminals from another device", async () => {
    const pending = service.execute("dev_testdevice0001", {
      commandId: "cmd_testcommand002",
      capability: "device.describe"
    });
    const request = gateway.send.mock.calls[0][1];
    gateway.emit("command.result", { ...request, deviceId: "dev_otherdevice001", body: {} });
    gateway.emit("command.error", { ...request, type: "command.error", body: { error: "denied" } });
    await expect(pending).rejects.toThrow("denied");
    expect(service.get("cmd_testcommand002")?.state).toBe("failed");
  });

  it("times out, caches the result, and sends cancellation", async () => {
    vi.useFakeTimers();
    const pending = service.execute("dev_testdevice0001", {
      commandId: "cmd_testcommand003",
      capability: "screen.capture",
      deadlineMs: 1_000
    });
    const rejected = expect(pending).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;
    expect(service.get("cmd_testcommand003")?.state).toBe("timed-out");
    expect(gateway.send.mock.calls.at(-1)?.[1].type).toBe("command.cancel");
    await expect(service.execute("dev_testdevice0001", {
      commandId: "cmd_testcommand003",
      capability: "screen.capture"
    })).resolves.toMatchObject({ state: "timed-out" });
    expect(() => service.execute("dev_otherdevice001", {
      commandId: "cmd_testcommand003",
      capability: "screen.capture"
    })).toThrow(/another device/);
  });

  it("prevents duplicate pending IDs and cleans up a failed send", async () => {
    const first = service.execute("dev_testdevice0001", {
      commandId: "cmd_testcommand004",
      capability: "device.describe"
    });
    expect(() => service.execute("dev_testdevice0001", {
      commandId: "cmd_testcommand004",
      capability: "device.describe"
    })).toThrow(/already running/);
    gateway.emit("command.result", { ...gateway.send.mock.calls[0][1], type: "command.result", body: {} });
    await first;

    gateway.send.mockImplementationOnce(() => { throw new Error("offline"); });
    await expect(service.execute("dev_testdevice0001", {
      commandId: "cmd_testcommand005",
      capability: "device.describe"
    })).rejects.toThrow("offline");
  });

  it("cancels matching commands when local control is paused", async () => {
    const action = service.execute("dev_testdevice0001", {
      commandId: "cmd_testcommand006",
      capability: "screen.capture"
    });
    const describe = service.execute("dev_testdevice0001", {
      commandId: "cmd_testcommand007",
      capability: "device.describe"
    });
    service.cancelDevice("dev_testdevice0001");
    await expect(action).rejects.toBeInstanceOf(DeviceControlPausedError);
    expect(service.get("cmd_testcommand006")?.state).toBe("cancelled");
    expect(service.cancel("dev_otherdevice001", "cmd_testcommand007")).toBe(false);
    expect(service.cancel("dev_testdevice0001", "cmd_testcommand007")).toBe(true);
    gateway.emit("command.result", {
      ...gateway.send.mock.calls.find(([, envelope]) => envelope.commandId === "cmd_testcommand007")![1],
      type: "command.result",
      body: {}
    });
    await describe;
  });
});
