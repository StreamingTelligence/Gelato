import type { CommandService } from "./commandService.js";
import type { UnifiedDeviceRegistry } from "./registry.js";

export type DeviceAgentCommandResult = Record<string, unknown>;

/** Public control adapter. Routing is exclusively capability based. */
export class UnifiedRemoteDeviceDriver {
  constructor(
    private readonly commands: CommandService,
    readonly registry: UnifiedDeviceRegistry
  ) {}

  async connect(deviceId: string): Promise<void> {
    await this.execute(deviceId, "device.describe", {}, 15_000, "read-only");
  }

  tap(deviceId: string, x: number, y: number): Promise<DeviceAgentCommandResult> {
    return this.execute(deviceId, "input.tap", { x, y });
  }

  swipe(
    deviceId: string,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    durationMs = 450
  ): Promise<DeviceAgentCommandResult> {
    return this.execute(deviceId, "input.swipe", { fromX, fromY, toX, toY, durationMs });
  }

  typeText(deviceId: string, text: string): Promise<DeviceAgentCommandResult> {
    return this.execute(deviceId, "text.type", { text });
  }

  launchApp(deviceId: string, appId: string, activity = ""): Promise<DeviceAgentCommandResult> {
    return this.execute(deviceId, "app.launch", { appId, activity });
  }

  getScreenshot(deviceId: string): Promise<DeviceAgentCommandResult> {
    return this.execute(deviceId, "screen.capture", {}, 120_000, "read-only");
  }

  getUiTree(deviceId: string): Promise<DeviceAgentCommandResult> {
    return this.execute(deviceId, "ui.tree", {}, 30_000, "read-only");
  }

  execute(
    deviceId: string,
    capability: string,
    args: Record<string, unknown>,
    deadlineMs = 30_000,
    idempotency: "read-only" | "idempotent" | "side-effecting" = "side-effecting",
    commandId?: string
  ): Promise<DeviceAgentCommandResult> {
    return this.commands.execute(deviceId, {
      commandId,
      capability,
      capabilityVersion: 1,
      arguments: args,
      deadlineMs,
      idempotency
    }).then((terminal) => terminal.result ?? { type: capability });
  }
}
