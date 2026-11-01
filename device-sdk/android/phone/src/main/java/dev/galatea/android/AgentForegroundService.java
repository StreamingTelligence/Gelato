package dev.galatea.android;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.AlarmManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.RemoteInput;

public final class AgentForegroundService extends Service {
    static final String ACTION_START = "dev.galatea.android.START";
    static final String ACTION_STOP = "dev.galatea.android.STOP";
    static final String ACTION_PAIR_ADB = "dev.galatea.android.PAIR_ADB";
    static final String ACTION_RESTORE = "dev.galatea.android.RESTORE";
    static final String EXTRA_CONTROLLER_URL = "controllerUrl";
    static final String EXTRA_DISPLAY_NAME = "displayName";
    static final String EXTRA_PAIRING_CODE = "pairingCode";

    private static final int NOTIFICATION_ID = 1001;
    private static final String CHANNEL_ID = "agent-control";
    private static final String TAG = "ServerizedAgent";
    private static final String KEY_ADB_PAIRING_CODE = "adbPairingCode";

    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    private volatile boolean pairingInProgress;
    private volatile boolean explicitStop;

    static Intent startIntent(Context context, String controllerUrl, String displayName, String pairingCode) {
        Intent intent = new Intent(context, AgentForegroundService.class);
        intent.setAction(ACTION_START);
        intent.putExtra(EXTRA_CONTROLLER_URL, controllerUrl);
        intent.putExtra(EXTRA_DISPLAY_NAME, displayName);
        intent.putExtra(EXTRA_PAIRING_CODE, pairingCode);
        return intent;
    }

    static Intent stopIntent(Context context) {
        Intent intent = new Intent(context, AgentForegroundService.class);
        intent.setAction(ACTION_STOP);
        return intent;
    }

    static Intent restoreIntent(Context context) {
        Intent intent = new Intent(context, AgentForegroundService.class);
        intent.setAction(ACTION_RESTORE);
        return intent;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
        acquireKeepAliveLocks();
        AgentRuntime.init(this);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startAsConnectedDeviceService();
        acquireKeepAliveLocks();
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            explicitStop = true;
            cancelScheduledRestart();
            AgentRuntime.get().stop();
            releaseKeepAliveLocks();
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
            return START_NOT_STICKY;
        }
        if (intent != null && ACTION_PAIR_ADB.equals(intent.getAction())) {
            handleNotificationPairing(intent);
            return START_STICKY;
        }
        if (intent != null && ACTION_START.equals(intent.getAction())) {
            explicitStop = false;
            String controllerUrl = intent.getStringExtra(EXTRA_CONTROLLER_URL);
            String displayName = intent.getStringExtra(EXTRA_DISPLAY_NAME);
            String pairingCode = intent.getStringExtra(EXTRA_PAIRING_CODE);
            if (controllerUrl != null && !controllerUrl.trim().isEmpty()) {
                AgentRuntime.get().start(
                        controllerUrl,
                        displayName == null ? "" : displayName,
                        pairingCode == null ? "" : pairingCode
                );
            }
        } else if (intent == null || ACTION_RESTORE.equals(intent.getAction())) {
            // START_STICKY restarts arrive without the original Intent after
            // ColorOS kills the process under memory pressure. Restore both
            // keepers from persisted credentials instead of leaving an
            // apparently healthy foreground service permanently offline.
            AgentRuntime.get().resumeSavedConfiguration();
        }
        // ColorOS may kill the whole process when its task card is removed,
        // without delivering onTaskRemoved/onDestroy. Keep a lightweight,
        // self-renewing alarm outside the process so that saved sessions are
        // restored even on that OEM path.
        if (!explicitStop && AgentRuntime.get().canResumeSavedConfiguration()) {
            scheduleRestart(15_000L);
        }
        return START_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        if (!explicitStop && AgentRuntime.get().canResumeSavedConfiguration()) {
            scheduleRestart(1_500L);
        }
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        if (!explicitStop && AgentRuntime.get().canResumeSavedConfiguration()) {
            scheduleRestart(2_500L);
        }
        releaseKeepAliveLocks();
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private Notification buildNotification(String text) {
        Intent activityIntent = new Intent(this, MainActivity.class);
        PendingIntent pendingIntent = PendingIntent.getActivity(
                this,
                0,
                activityIntent,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );
        Intent pairIntent = new Intent(this, AgentForegroundService.class);
        pairIntent.setAction(ACTION_PAIR_ADB);
        PendingIntent pairPendingIntent = PendingIntent.getService(
                this,
                1,
                pairIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE
        );
        RemoteInput pairingCodeInput = new RemoteInput.Builder(KEY_ADB_PAIRING_CODE)
                .setLabel("6-digit pairing code")
                .build();
        NotificationCompat.Action pairAction = new NotificationCompat.Action.Builder(
                R.drawable.ic_agent,
                pairingInProgress ? "Pairing…" : "Enter wireless ADB code",
                pairPendingIntent
        ).addRemoteInput(pairingCodeInput).build();

        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_agent)
                .setContentTitle(getString(R.string.app_name))
                .setContentText(text)
                .setOngoing(true)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setContentIntent(pendingIntent)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setOnlyAlertOnce(true)
                .addAction(pairAction)
                .build();
    }

    private void handleNotificationPairing(Intent intent) {
        Bundle results = RemoteInput.getResultsFromIntent(intent);
        CharSequence value = results == null ? null : results.getCharSequence(KEY_ADB_PAIRING_CODE);
        String code = value == null ? "" : value.toString().trim();
        if (!code.matches("\\d{6}")) {
            updateNotification("Enter the 6-digit code shown by Android");
            return;
        }
        if (AgentRuntime.get().isAdbReady()) {
            updateNotification("Wireless ADB is already connected — remote control is ready");
            return;
        }
        if (pairingInProgress) {
            return;
        }
        pairingInProgress = true;
        updateNotification("Finding the Android pairing service…");
        AgentRuntime.get().pairAdb(code).whenComplete((paired, error) -> {
            pairingInProgress = false;
            if (error != null || !Boolean.TRUE.equals(paired)) {
                updateNotification("Pairing failed — open a new code and try again");
                Log.w(TAG, "Wireless ADB pairing from notification failed", error);
                return;
            }
            updateNotification("Wireless ADB paired — remote control is ready");
            Log.i(TAG, "Wireless ADB paired from notification");
        });
    }

    private void updateNotification(String text) {
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        manager.notify(NOTIFICATION_ID, buildNotification(text));
    }

    private void startAsConnectedDeviceService() {
        Notification notification = buildNotification("Gelato is keeping the device connection active");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
            );
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    @SuppressWarnings("deprecation")
    private void acquireKeepAliveLocks() {
        if (wakeLock == null) {
            PowerManager powerManager = (PowerManager) getSystemService(POWER_SERVICE);
            wakeLock = powerManager.newWakeLock(
                    PowerManager.PARTIAL_WAKE_LOCK,
                    getPackageName() + ":control-channel"
            );
            wakeLock.setReferenceCounted(false);
        }
        if (!wakeLock.isHeld()) {
            wakeLock.acquire();
        }

        if (wifiLock == null) {
            WifiManager wifiManager = (WifiManager) getApplicationContext()
                    .getSystemService(WIFI_SERVICE);
            wifiLock = wifiManager.createWifiLock(
                    WifiManager.WIFI_MODE_FULL_HIGH_PERF,
                    getPackageName() + ":adb-channel"
            );
            wifiLock.setReferenceCounted(false);
        }
        if (!wifiLock.isHeld()) {
            wifiLock.acquire();
        }
        Log.i(TAG, "Connected-device foreground keepalive acquired");
    }

    private void releaseKeepAliveLocks() {
        if (wifiLock != null && wifiLock.isHeld()) {
            wifiLock.release();
        }
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
        }
        Log.i(TAG, "Connected-device foreground keepalive released");
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                getString(R.string.agent_channel_name),
                NotificationManager.IMPORTANCE_LOW
        );
        manager.createNotificationChannel(channel);
    }

    private void scheduleRestart(long delayMs) {
        AlarmManager alarms = (AlarmManager) getSystemService(ALARM_SERVICE);
        PendingIntent pending = restartPendingIntent();
        alarms.setAndAllowWhileIdle(
                AlarmManager.ELAPSED_REALTIME_WAKEUP,
                android.os.SystemClock.elapsedRealtime() + delayMs,
                pending
        );
    }

    private void cancelScheduledRestart() {
        AlarmManager alarms = (AlarmManager) getSystemService(ALARM_SERVICE);
        alarms.cancel(restartPendingIntent());
    }

    private PendingIntent restartPendingIntent() {
        Intent restore = restoreIntent(this);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            return PendingIntent.getForegroundService(
                    this,
                    2,
                    restore,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );
        }
        return PendingIntent.getService(
                this,
                2,
                restore,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }
}
