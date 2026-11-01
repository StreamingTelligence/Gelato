package dev.galatea.rokid.nativeexample;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.net.wifi.WifiManager;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import dev.galatea.device.AgentConfig;
import dev.galatea.device.DeviceAgentClient;
import dev.galatea.rokid.nativeglass.RokidNativeDriver;
import dev.galatea.rokid.nativeglass.RokidAudioDriver;

import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/** Headless glasses example: USB/shell enrollment, then independent Wi-Fi operation. */
public final class RokidNativeService extends Service implements DeviceAgentClient.Listener {
    public static final String ACTION_ENROLL = "dev.galatea.rokid.nativeexample.ENROLL";
    public static final String ACTION_CONTROL = "dev.galatea.rokid.nativeexample.CONTROL";
    public static final String ACTION_CONNECTION = "dev.galatea.rokid.nativeexample.CONNECTION";
    public static final String ACTION_RESTORE = "dev.galatea.rokid.nativeexample.RESTORE";
    private static final String TAG = "GelatoRokidNative";
    private static final String CHANNEL = "gelato-rokid-native";
    private static final int NOTIFICATION_ID = 18445;

    private final ScheduledExecutorService supervisor = Executors.newSingleThreadScheduledExecutor();
    private RokidNativeDriver driver;
    private RokidAudioDriver audioDriver;
    private DeviceAgentClient client;
    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    private volatile String connectionState = "offline";

    @Override public void onCreate() {
        super.onCreate();
        getSystemService(NotificationManager.class).createNotificationChannel(
                new NotificationChannel(CHANNEL, "Gelato glasses connection", NotificationManager.IMPORTANCE_LOW));
        driver = new RokidNativeDriver(this);
        audioDriver = new RokidAudioDriver(this);
        client = new DeviceAgentClient(this, new AgentConfig(
                "rokid-bolon-native", "android", "rokid.bolon", "Rokid BOLON",
                DeviceAgentClient.applicationVersion(this)), driver, this);
        supervisor.scheduleWithFixedDelay(this::refreshMedia, 1, 2, TimeUnit.SECONDS);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        startForeground(NOTIFICATION_ID, notification("Preparing glasses connection"));
        acquireLocks();
        String action = intent == null ? ACTION_RESTORE : intent.getAction();
        try {
            if (ACTION_ENROLL.equals(action)) {
                String url = intent.getStringExtra("controllerUrl");
                String code = intent.getStringExtra("pairingCode");
                if (url == null || code == null || code.isBlank()) throw new IllegalArgumentException("HTTPS origin and one-time code required");
                // Persist before opening the socket: a fast pairing.accepted callback
                // must never clear the code only for this method to write it back.
                getSharedPreferences("gelato_native", MODE_PRIVATE).edit()
                        .putString("controller_url", url.trim().replaceAll("/+$", ""))
                        .putString("pending_code", code)
                        .putBoolean("connection_enabled", true).commit();
                try {
                    client.start(url, code);
                } catch (RuntimeException error) {
                    getSharedPreferences("gelato_native", MODE_PRIVATE).edit()
                            .remove("pending_code").putBoolean("connection_enabled", false).commit();
                    throw error;
                }
                client.setControlAllowed(intent.getBooleanExtra("allowControl", false));
                Log.i(TAG, "Enrollment started; control allowed=" + client.isControlAllowed());
            } else if (ACTION_CONTROL.equals(action)) {
                client.setControlAllowed(intent.getBooleanExtra("enabled", false));
                Log.i(TAG, "Remote control allowed=" + client.isControlAllowed());
            } else if (ACTION_CONNECTION.equals(action)) {
                boolean enabled = intent.getBooleanExtra("enabled", false);
                getSharedPreferences("gelato_native", MODE_PRIVATE).edit().putBoolean("connection_enabled", enabled).apply();
                if (enabled) resumeSaved();
                else {
                    client.stop();
                    driver.stopLiveCamera();
                    audioDriver.stopCapture();
                    audioDriver.stopPlayback();
                    stopForeground(STOP_FOREGROUND_REMOVE);
                    stopSelf();
                    return START_NOT_STICKY;
                }
                Log.i(TAG, "Connection enabled=" + enabled);
            } else {
                resumeSaved();
            }
        } catch (Exception error) {
            Log.e(TAG, "Setup failed", error);
            updateNotification("Setup failed: " + error.getMessage());
        }
        refreshMedia();
        return START_STICKY;
    }

    private void resumeSaved() {
        var values = getSharedPreferences("gelato_native", MODE_PRIVATE);
        if (!values.getBoolean("connection_enabled", false)) return;
        String url = values.getString("controller_url", "");
        String code = values.getString("pending_code", "");
        if (url != null && !url.isBlank() && (client.hasCredential() || code != null && !code.isBlank())) {
            client.start(url, code == null || code.isBlank() ? null : code);
        }
    }

    private void refreshMedia() {
        if (client == null || driver == null || audioDriver == null) return;
        boolean allowed = getSharedPreferences("gelato_native", MODE_PRIVATE).getBoolean("connection_enabled", false)
                && client.isAuthenticated() && client.isControlAllowed() && "online".equals(connectionState);
        if (allowed) {
            driver.startLiveCamera(client::sendLiveCameraJpegFrame);
            audioDriver.startCapture(client::sendLiveAudioPcmFrame);
        } else {
            driver.stopLiveCamera();
            audioDriver.stopCapture();
            audioDriver.stopPlayback();
        }
    }

    private void acquireLocks() {
        if (wakeLock == null) {
            PowerManager power = (PowerManager) getSystemService(Context.POWER_SERVICE);
            wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "gelato:rokid-native");
            wakeLock.setReferenceCounted(false);
            wakeLock.acquire();
        }
        if (wifiLock == null) {
            WifiManager wifi = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wifi != null) {
                wifiLock = wifi.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "gelato:rokid-native");
                wifiLock.setReferenceCounted(false);
                wifiLock.acquire();
            }
        }
    }

    private Notification notification(String text) {
        return new Notification.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_menu_camera)
                .setContentTitle("Gelato Rokid Native")
                .setContentText(text)
                .setOngoing(true).build();
    }

    private void updateNotification(String text) {
        // Re-post through startForeground: NotificationManager.notify with the
        // same ID strips the system FGS flag on Rokid's Android build, and the
        // OS then kills camera streaming as an idle background service.
        startForeground(NOTIFICATION_ID, notification(text));
    }

    @Override public void onConnectionState(@NonNull String state, @Nullable String error) {
        connectionState = state;
        Log.i(TAG, "Controller " + state + (error == null ? "" : ": " + error));
        updateNotification(error == null ? "Controller: " + state : "Controller: " + state + " (see log)");
        refreshMedia();
    }

    @Override public void onReplyAudio(@NonNull byte[] pcm16, int sampleRateHz) {
        if (client != null && client.isAuthenticated() && client.isControlAllowed()
                && getSharedPreferences("gelato_native", MODE_PRIVATE).getBoolean("connection_enabled", false)) {
            audioDriver.playPcm16(pcm16, sampleRateHz);
        }
    }

    @Override public void onPairingAccepted(@NonNull String agentId, @NonNull String deviceId) {
        getSharedPreferences("gelato_native", MODE_PRIVATE).edit().remove("pending_code").apply();
        Log.i(TAG, "Session accepted for device " + deviceId);
    }

    @Override public void onPairingRejected(@NonNull String error) {
        getSharedPreferences("gelato_native", MODE_PRIVATE).edit()
                .remove("pending_code").putBoolean("connection_enabled", false).apply();
        Log.w(TAG, "Pairing rejected: " + error);
        updateNotification("Pairing rejected (see log)");
        stopSelf();
    }

    @Override public void onMediaStreamError(@NonNull String error) {
        Log.w(TAG, "Media reconnecting: " + error);
    }

    @Override public void onDestroy() {
        supervisor.shutdownNow();
        driver.close();
        audioDriver.close();
        client.close();
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        super.onDestroy();
    }

    @Nullable @Override public IBinder onBind(Intent intent) { return null; }
}
