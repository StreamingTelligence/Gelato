import { UnifiedRemoteDeviceDriver } from '@gelato/server-core';

export { PacketOverlayHub } from './packetOverlay.js';
export type { PacketOverlaySessionInfo } from './packetOverlay.js';

export class IosDeviceDriver extends UnifiedRemoteDeviceDriver {
  wdaHttpRequest(deviceId: string, method: string, path: string, body?: unknown, timeoutMs = 30_000) {
    return this.execute(deviceId, 'vendor.apple.wda-http', { method, path, body }, timeoutMs);
  }

  showPairingPin(deviceId: string, pin: string, expiresAt: number) {
    return this.execute(deviceId, 'device.system-pairing.pin.show', { pin, expiresAt }, 5_000);
  }

  confirmPairing(deviceId: string) {
    return this.execute(deviceId, 'device.system-pairing.confirm', {}, 5_000);
  }

  requireUpdate(deviceId: string, requiredBuild: string, manifestUrl?: string) {
    return this.execute(deviceId, 'agent.update.require',
      { requiredBuild, ...(manifestUrl ? { manifestUrl } : {}) }, 5_000);
  }
}
