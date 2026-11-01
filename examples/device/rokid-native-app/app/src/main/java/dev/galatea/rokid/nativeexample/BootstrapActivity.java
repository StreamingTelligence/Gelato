package dev.galatea.rokid.nativeexample;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;

/** ADB-only visible launch point for OEMs that reject background service starts from shell. */
public final class BootstrapActivity extends Activity {
    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        Intent service = new Intent(this, RokidNativeService.class)
                .setAction(getIntent().getAction() == null ? RokidNativeService.ACTION_RESTORE : getIntent().getAction());
        if (getIntent().getExtras() != null) service.putExtras(getIntent().getExtras());
        startForegroundService(service);
        // On Rokid's Android 12 build, finishing in the same event turn makes
        // ActivityManager classify the queued FGS start as a background start.
        new Handler(Looper.getMainLooper()).postDelayed(this::finish, 3_000L);
    }
}
