import { Capacitor, registerPlugin } from "@capacitor/core";

export interface Step {
  id: string;
  phase: "before-pairing" | "before-control";
  required: boolean;
  title: string;
  detail: string;
  done: boolean;
  check: { state: "passed" | "failed" | "checking" | "unknown"; basis: "system" | "probe" | "inference" | "none" };
  action?: string;
  button?: string;
  disabled?: boolean;
  secondaryAction?: string;
  secondaryButton?: string;
}
export interface Snapshot {
  platform: "android" | "ios";
  deviceId?: string;
  displayName: string;
  controllerUrl: string;
  pendingControllerUrl?: string;
  pendingPairing?: boolean;
  pendingPairingExpired?: boolean;
  paired: boolean;
  pairingVerified?: boolean;
  connectionEnabled?: boolean;
  online: boolean;
  ready: boolean;
  controlAllowed: boolean;
  steps: Step[];
  error?: string;
  version: string;
  screenSharing?: boolean;
  topInsetDp?: number;
  lastReply?: string;
}
const native = registerPlugin<{
  request(args: Record<string, unknown>): Promise<unknown>;
}>("DeviceApp");
export const isNative = Capacitor.isNativePlatform();
export async function request<T>(
  operation: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  if (!isNative)
    throw new Error("请在已安装的设备助手中使用，浏览器不能读取本机配对。");
  return (await native.request({ operation, ...args })) as T;
}
