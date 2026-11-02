import { describe, expect, it, vi } from "vitest";
import { CapabilityRouter, DeviceControlPausedError } from "../../server-sdk/core/src/capabilityRouter.js";
import type { CommandService } from "../../server-sdk/core/src/commandService.js";
import { UnifiedDeviceRegistry } from "../../server-sdk/core/src/registry.js";
import { UnifiedRemoteDeviceDriver } from "../../server-sdk/core/src/remoteDriver.js";
import { snapshot } from "../helpers.js";

const binding = {
  agentId: "agt_routingagent001",
  installationId: "inst_routingdevice01",
  agentKind: "android-phone",
  hostPlatform: "android",
  agentVersion: "1.0.0",
  deviceId: "dev_routingdevice001",
  deviceKind: "android.phone",
  displayName: "Routing phone"
};

describe("CapabilityRouter", () => {
  it("enforces registration, online state, consent, and advertised versions", () => {
    const registry = new UnifiedDeviceRegistry();
    const router = new CapabilityRouter(registry);
    expect(() => router.resolve(binding.deviceId, "screen.capture")).toThrow("not registered");

    registry.bind(binding);
    registry.applySnapshot(binding.deviceId, snapshot({
      hardware: { present: true, connected: false, controlAllowed: true, userAction: null },
      capabilities: [
        { name: "device.describe", version: 1 },
        { name: "screen.capture", version: 1, consent: "screen-recording" }
      ]
    }));
    expect(() => router.resolve(binding.deviceId, "screen.capture", 2)).toThrow("does not advertise");
    expect(() => router.resolve(binding.deviceId, "screen.capture")).toThrow("ready hardware");

    registry.applyPatch(binding.deviceId, {
      baseRevision: 1,
      revision: 2,
      patch: { hardware: { present: true, connected: true, controlAllowed: true, userAction: null } }
    });
    expect(router.resolve(binding.deviceId, "screen.capture")).toMatchObject({
      name: "screen.capture",
      version: 1
    });
    registry.markOffline(binding.deviceId);
    expect(() => router.resolve(binding.deviceId, "screen.capture")).toThrow("offline");
  });

  it("permits describe while control is paused and blocks other capabilities", () => {
    const registry = new UnifiedDeviceRegistry();
    registry.bind(binding);
    registry.applySnapshot(binding.deviceId, snapshot({
      hardware: { present: true, connected: true, controlAllowed: false, userAction: null }
    }));
    const router = new CapabilityRouter(registry);
    expect(router.resolve(binding.deviceId, "device.describe").name).toBe("device.describe");
    expect(() => router.resolve(binding.deviceId, "screen.capture")).toThrow(DeviceControlPausedError);
  });
});

describe("UnifiedRemoteDeviceDriver", () => {
  it("maps convenience methods to bounded capability commands", async () => {
    const execute = vi.fn(async (_deviceId: string, request: { capability: string }) => ({
      commandId: "cmd_routingcommand01",
      deviceId: binding.deviceId,
      state: "completed" as const,
      result: { capability: request.capability },
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString()
    }));
    const commands = { execute } as unknown as CommandService;
    const driver = new UnifiedRemoteDeviceDriver(commands, new UnifiedDeviceRegistry());

    await driver.connect(binding.deviceId);
    await driver.tap(binding.deviceId, 1, 2);
    await driver.swipe(binding.deviceId, 1, 2, 3, 4, 500);
    await driver.typeText(binding.deviceId, "hello");
    await driver.launchApp(binding.deviceId, "com.example", "Main");
    await driver.getScreenshot(binding.deviceId);
    await driver.getUiTree(binding.deviceId);
    await driver.execute(binding.deviceId, "custom.action", { value: 1 }, 4000, "idempotent", "cmd_customcommand01");

    expect(execute.mock.calls.map(call => call[1])).toEqual([
      expect.objectContaining({ capability: "device.describe", deadlineMs: 15_000, idempotency: "read-only" }),
      expect.objectContaining({ capability: "input.tap", arguments: { x: 1, y: 2 } }),
      expect.objectContaining({ capability: "input.swipe", arguments: { fromX: 1, fromY: 2, toX: 3, toY: 4, durationMs: 500 } }),
      expect.objectContaining({ capability: "text.type", arguments: { text: "hello" } }),
      expect.objectContaining({ capability: "app.launch", arguments: { appId: "com.example", activity: "Main" } }),
      expect.objectContaining({ capability: "screen.capture", deadlineMs: 120_000, idempotency: "read-only" }),
      expect.objectContaining({ capability: "ui.tree", deadlineMs: 30_000, idempotency: "read-only" }),
      expect.objectContaining({ capability: "custom.action", deadlineMs: 4000, idempotency: "idempotent", commandId: "cmd_customcommand01" })
    ]);
  });

  it("provides a stable fallback result when a command has no payload", async () => {
    const commands = {
      execute: vi.fn(async () => ({
        commandId: "cmd_routingcommand02",
        deviceId: binding.deviceId,
        state: "completed",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString()
      }))
    } as unknown as CommandService;
    const driver = new UnifiedRemoteDeviceDriver(commands, new UnifiedDeviceRegistry());
    await expect(driver.tap(binding.deviceId, 1, 2)).resolves.toEqual({ type: "input.tap" });
  });
});
