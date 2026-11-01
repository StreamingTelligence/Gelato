package dev.galatea.rokid.nativeexample;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

public final class BootReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        if (context.getSharedPreferences("gelato_native", Context.MODE_PRIVATE)
                .getBoolean("connection_enabled", false)) {
            Intent service = new Intent(context, RokidNativeService.class).setAction(RokidNativeService.ACTION_RESTORE);
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(service);
            else context.startService(service);
        }
    }
}
