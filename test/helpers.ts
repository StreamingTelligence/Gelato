import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentDescriptor } from "../server-sdk/core/src/pairingService.js";
import type { DeviceSnapshotBody } from "../server-sdk/core/src/registry.js";
import type { ProtocolEnvelope } from "../server-sdk/core/src/types.js";

let sequence = 0;

export const descriptor: AgentDescriptor = {
  installationId: "inst_testdevice0001",
  agentKind: "android-phone",
  hostPlatform: "android",
  deviceKind: "android.phone",
  displayName: "Test phone",
  agentVersion: "1.0.0"
};

export function tempDirectory(prefix = "gelato-test-"): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

export function message(
  type: string,
  body: Record<string, unknown>,
  extra: Partial<ProtocolEnvelope> = {}
): ProtocolEnvelope {
  sequence += 1;
  return {
    protocol: "gelato.v1",
    type,
    messageId: `msg_testmessage${String(sequence).padStart(4, "0")}`,
    sentAt: new Date().toISOString(),
    body,
    ...extra
  };
}

export function snapshot(overrides: Partial<DeviceSnapshotBody> = {}): DeviceSnapshotBody {
  return {
    revision: 1,
    kind: "android.phone",
    displayName: "Test phone",
    os: { family: "android", version: "15" },
    driver: { id: "test-driver", version: "1.0.0", location: "device", state: "ready" },
    hardware: { present: true, connected: true, controlAllowed: true, userAction: null },
    capabilities: [
      { name: "device.describe", version: 1 },
      { name: "screen.capture", version: 1 }
    ],
    ...overrides
  };
}
