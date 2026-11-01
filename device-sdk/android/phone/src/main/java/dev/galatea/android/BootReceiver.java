package dev.galatea.android;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

public final class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        AgentRuntime.init(context);
        if (!AgentRuntime.get().canResumeSavedConfiguration()) return;
        Intent restore = AgentForegroundService.restoreIntent(context);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(restore);
        } else {
            context.startService(restore);
        }
    }
}
