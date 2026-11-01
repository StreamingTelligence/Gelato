import type { UnifiedDeviceRegistry } from "./registry.js";
import type { CapabilityDescriptor } from "./types.js";

export class DeviceControlPausedError extends Error {
  constructor() { super("Device owner has paused remote control"); }
}

export class CapabilityRouter {
  constructor(private readonly registry: UnifiedDeviceRegistry) {}

  resolve(deviceId: string, name: string, version = 1): CapabilityDescriptor {
    const device = this.registry.get(deviceId);
    if (!device) throw new Error(`Device ${deviceId} is not registered`);
    if (!device.connection.online) throw new Error(`Device ${deviceId} is offline`);
    if (device.hardware.controlAllowed !== true && name !== "device.describe") {
      throw new DeviceControlPausedError();
    }
    const capability = device.capabilities.find(
      (candidate) => candidate.name === name && candidate.version === version
    );
    if (!capability) {
      throw new Error(`Device ${deviceId} does not advertise ${name}@${version}`);
    }
    if (capability.consent && !device.hardware.connected) {
      throw new Error(`Capability ${name} requires ${capability.consent} and ready hardware`);
    }
    return capability;
  }
}
