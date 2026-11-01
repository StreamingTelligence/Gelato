import { UnifiedRemoteDeviceDriver } from '@gelato/server-core';

export class AndroidDeviceDriver extends UnifiedRemoteDeviceDriver {
  shell(deviceId: string, command: string, timeoutMs = 30_000) {
    return this.execute(deviceId, 'vendor.android.shell', { command }, timeoutMs);
  }

  logcat(deviceId: string, lines = 200) {
    return this.execute(deviceId, 'vendor.android.logcat', { lines }, 30_000, 'read-only');
  }

  askAiApp(deviceId: string, provider: string, question: string, timeoutMs = 90_000) {
    return this.execute(deviceId, 'vendor.serverized.ai.ask', { provider, question, timeoutMs }, timeoutMs + 5_000);
  }

  runAiTask(deviceId: string, taskId: string, action: string, args: Record<string, unknown>, timeoutMs = 120_000) {
    return this.execute(deviceId, 'vendor.serverized.task.execute',
      { taskId, action, arguments: args, timeoutMs }, timeoutMs + 15_000);
  }
}
