import { describe, expect, it, vi } from "vitest";
import { UnifiedDeviceRegistry } from "../../server-sdk/core/src/registry.js";
import { snapshot } from "../helpers.js";

const binding = {
  agentId: "agt_testagent0001",
  installationId: "inst_testdevice0001",
  agentKind: "android-phone",
  hostPlatform: "android",
  agentVersion: "1.0.0",
  deviceId: "dev_testdevice0001",
  deviceKind: "android.phone",
  displayName: "Test phone"
};

describe("UnifiedDeviceRegistry", () => {
  it("binds, applies a snapshot, and emits cloned records", () => {
    const registry = new UnifiedDeviceRegistry();
    const changed = vi.fn();
    registry.on("changed", changed);
    const initial = registry.bind(binding);
    expect(initial.connection.sessionState).toBe("synchronizing");
    expect(initial.revision).toBe(0);

    const input = snapshot();
    const ready = registry.applySnapshot(binding.deviceId, input);
    expect(ready.connection.sessionState).toBe("online");
    expect(ready.driver.hostAgentId).toBe(binding.agentId);
    expect(ready.hardware.controlAllowed).toBe(true);
    input.displayName = "mutated outside";
    expect(registry.get(binding.deviceId)?.displayName).toBe("Test phone");
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("enforces snapshot and capability invariants", () => {
    const registry = new UnifiedDeviceRegistry();
    registry.bind(binding);
    registry.applySnapshot(binding.deviceId, snapshot({ revision: 2 }));
    expect(() => registry.applySnapshot(binding.deviceId, snapshot({ revision: 1 }))).toThrow(/older/);
    expect(() => registry.applySnapshot(binding.deviceId, snapshot({ revision: 2, capabilities: [] }))).toThrow(/device.describe/);
    expect(() => registry.applySnapshot(binding.deviceId, snapshot({
      revision: 2,
      capabilities: [
        { name: "device.describe", version: 1 },
        { name: "device.describe", version: 1 }
      ]
    }))).toThrow(/Duplicate/);
    expect(() => registry.applySnapshot(binding.deviceId, snapshot({
      revision: 2,
      capabilities: [{ name: "Invalid", version: 0 }]
    }))).toThrow();
  });

  it("only accepts monotonic patches to mutable fields", () => {
    const registry = new UnifiedDeviceRegistry();
    registry.bind(binding);
    registry.applySnapshot(binding.deviceId, snapshot());
    const patched = registry.applyPatch(binding.deviceId, {
      baseRevision: 1,
      revision: 2,
      patch: { displayName: "New name", hardware: { present: true, connected: false, controlAllowed: false } }
    });
    expect(patched.displayName).toBe("New name");
    expect(patched.hardware.controlAllowed).toBe(false);
    expect(() => registry.applyPatch(binding.deviceId, {
      baseRevision: 1,
      revision: 2,
      patch: {}
    })).toThrow(/revision mismatch/);
    expect(() => registry.applyPatch(binding.deviceId, {
      baseRevision: 2,
      revision: 3,
      patch: { deviceId: "dev_otherdevice001" }
    })).toThrow(/not mutable/);
  });

  it("resets connection-scoped state on reconnect", () => {
    const registry = new UnifiedDeviceRegistry();
    registry.bind(binding);
    registry.applySnapshot(binding.deviceId, snapshot({ revision: 9 }));
    const rebound = registry.bind({ ...binding, agentVersion: "1.1.0" });
    expect(rebound.revision).toBe(0);
    expect(rebound.hardware.controlAllowed).toBe(false);
    expect(rebound.driver.state).toBe("starting");
  });

  it("tracks independent transports and expires stale devices", () => {
    const registry = new UnifiedDeviceRegistry();
    registry.bind(binding);
    registry.applySnapshot(binding.deviceId, snapshot());
    const now = Date.parse("2026-01-01T00:00:00Z");
    registry.markTransport(binding.deviceId, "overlay", true, now, { networkClass: "lan" });
    registry.markTransport(binding.deviceId, "control-websocket", false, now + 1);
    expect(registry.get(binding.deviceId)?.connection.online).toBe(true);
    registry.markTransport(binding.deviceId, "overlay", false, now + 2);
    expect(registry.get(binding.deviceId)?.connection.sessionState).toBe("offline");

    registry.touch(binding.deviceId);
    registry.expire(1, Date.now() + 10);
    expect(registry.get(binding.deviceId)?.connection.online).toBe(false);
    expect(registry.getByAgentId(binding.agentId)?.deviceId).toBe(binding.deviceId);
    expect(registry.list()).toHaveLength(1);
    expect(registry.markOffline("dev_missingdevice01")).toBeUndefined();
  });
});
