package dev.galatea.android;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.provider.Settings;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.TimeZone;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArraySet;

public final class AgentRuntime implements AdbEngine.Listener {
    private static final String PREFS = "agent_runtime";
    private static final String KEY_CONTROLLER_URL = "controller_url";
    private static final String KEY_DISPLAY_NAME = "display_name";
    private static final String KEY_PAIRING_CODE = "pairing_code";
    private static volatile AgentRuntime instance;

    public static void init(@NonNull Context context) {
        if (instance == null) {
            synchronized (AgentRuntime.class) {
                if (instance == null) {
                    instance = new AgentRuntime(context.getApplicationContext());
                }
            }
        }
    }

    public static AgentRuntime get() {
        if (instance == null) {
            throw new IllegalStateException("AgentRuntime is not initialized");
        }
        return instance;
    }

    private final Context context;
    private final SharedPreferences preferences;
    private final Set<RuntimeListener> listeners = new CopyOnWriteArraySet<>();
    private final ArrayList<String> logs = new ArrayList<>();
    private final LifecycleTransition lifecycle = new LifecycleTransition(this);
    private final AdbEngine adbEngine;
    private final ControlClient controlClient;
    private final String deviceId;

    private String displayName;
    private String controllerUrl;
    private String pairingCode;
    private String appState = "APP_OFFLINE";
    private String engineState = "ADB_DISCONNECTED";
    private String screenState = "SCREEN_STOPPED";
    private String userActionCode = "ENABLE_ANDROID_WIRELESS_DEBUGGING";
    private boolean appOnline = false;
    private boolean engineReady = false;
    private boolean screenActive = false;
    private int screenWidth = 0;
    private int screenHeight = 0;
    private long lastHeartbeatAt = 0L;
    private String lastError = "";

    private AgentRuntime(@NonNull Context context) {
        this.context = context;
        this.preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        this.deviceId = buildDeviceId(context);
        this.displayName = preferences.getString(KEY_DISPLAY_NAME, Build.MANUFACTURER + " " + Build.MODEL);
        this.controllerUrl = preferences.getString(KEY_CONTROLLER_URL, "");
        this.pairingCode = preferences.getString(KEY_PAIRING_CODE, "");
        this.adbEngine = new AdbEngine(context, this);
        this.controlClient = new ControlClient(this);
        addLog("Runtime initialized for " + displayName + " (" + deviceId + ")");
    }

    void start(@NonNull String controllerUrl, @NonNull String displayName, @NonNull String pairingCode) {
        lifecycle.run(() -> {
            boolean keepingAuthenticatedSession = controlClient.isAuthenticated()
                    && this.controllerUrl.equals(controllerUrl.trim()) && pairingCode.trim().isEmpty();
            this.controllerUrl = controllerUrl.trim();
            this.displayName = displayName.trim().isEmpty() ? this.displayName : displayName.trim();
            if (!pairingCode.trim().isEmpty()) {
                this.pairingCode = pairingCode.trim();
            }
            preferences.edit()
                    .putString(KEY_CONTROLLER_URL, this.controllerUrl)
                    .putString(KEY_DISPLAY_NAME, this.displayName)
                    .putString(KEY_PAIRING_CODE, this.pairingCode)
                    .apply();
            appOnline = keepingAuthenticatedSession;
            appState = keepingAuthenticatedSession ? "APP_ONLINE" : "APP_CONNECTING";
            lastHeartbeatAt = System.currentTimeMillis();
            lastError = "";
            addLog("Connecting to controller " + this.controllerUrl);
            notifyChanged();
            return this.controllerUrl;
        }, url -> {
            controlClient.start(url);
            adbEngine.startKeeper();
        });
    }

    void resumeSavedConfiguration() {
        lifecycle.run(() -> new String[] { controllerUrl, displayName, pairingCode }, saved -> {
            if (saved[0].trim().isEmpty()) {
                addLog("Foreground service restarted without a saved Controller URL");
                return;
            }
            if (!controlClient.hasSavedCredentials() && saved[2].trim().isEmpty()) {
                addLog("Foreground service restarted without Controller credentials");
                return;
            }
            if (controlClient.hasSavedCredentials()) {
                pairingCode = "";
                preferences.edit().remove(KEY_PAIRING_CODE).apply();
                saved[2] = "";
            }
            addLog("Foreground service process restored; resuming Controller and ADB keepers");
            start(saved[0], saved[1], saved[2]);
        });
    }

    synchronized boolean canResumeSavedConfiguration() {
        return !controllerUrl.trim().isEmpty()
                && (controlClient.hasSavedCredentials() || !pairingCode.trim().isEmpty());
    }

    void stop() {
        lifecycle.run(() -> {
            appOnline = false;
            appState = "APP_OFFLINE";
            engineReady = false;
            engineState = "ADB_DISCONNECTED";
            userActionCode = "ENABLE_ANDROID_WIRELESS_DEBUGGING";
            return null;
        }, unused -> {
            controlClient.stop();
            adbEngine.stop();
            notifyChanged();
        });
    }

    CompletableFuture<Boolean> pairAdb(int port, @NonNull String code) {
        return adbEngine.pair(port, code);
    }

    CompletableFuture<Boolean> pairAdb(@NonNull String code) {
        if (!code.trim().matches("\\d{6}")) {
            return CompletableFuture.completedFuture(false);
        }
        if (isAdbReady()) {
            return CompletableFuture.completedFuture(true);
        }
        return adbEngine.discoverPairingPort().thenCompose(port -> {
            if (port <= 0) {
                CompletableFuture<Boolean> failed = new CompletableFuture<>();
                failed.completeExceptionally(new IllegalStateException("Wireless debugging pairing service was not discovered"));
                return failed;
            }
            return adbEngine.pair(port, code);
        });
    }

    CompletableFuture<Boolean> connectAdb(int port) {
        return adbEngine.connect(port);
    }

    CompletableFuture<Integer> discoverPairingPort() {
        return adbEngine.discoverPairingPort();
    }

    synchronized boolean isAdbReady() {
        return engineReady && adbEngine.isReady();
    }

    CompletableFuture<JSONObject> handleControlCommand(@NonNull JSONObject command) {
        String type = command.optString("type");
        if ("pairAdb".equals(type)) {
            int port = command.optInt("port", -1);
            String pairingCode = command.optString("pairingCode", "");
            CompletableFuture<Boolean> pairing = port > 0
                    ? adbEngine.pair(port, pairingCode)
                    : pairAdb(pairingCode);
            return pairing.thenApply(ok -> {
                try {
                    return new JSONObject()
                            .put("type", "pairAdb")
                            .put("paired", ok);
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
            });
        }
        if ("connectAdb".equals(type)) {
            int port = command.optInt("port", -1);
            return adbEngine.connect(port).thenApply(ok -> {
                try {
                    return new JSONObject()
                            .put("type", "connectAdb")
                            .put("connected", ok);
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
            });
        }
        if ("discoverPairingPort".equals(type)) {
            return adbEngine.discoverPairingPort().thenApply(port -> {
                try {
                    return new JSONObject()
                            .put("type", "discoverPairingPort")
                            .put("port", port);
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
            });
        }
        return adbEngine.executeControlCommand(command);
    }

    void sendScreenFrame(@NonNull byte[] data) {
        controlClient.sendScreenFrame(data);
    }

    void sendScreenFrame(@NonNull byte[] data, double sourceTimeS) {
        controlClient.sendScreenFrame(data, sourceTimeS);
    }

    void sendScreenJpegFrame(@NonNull byte[] data, double sourceTimeS) {
        controlClient.sendScreenJpegFrame(data, sourceTimeS);
    }

    synchronized void setScreenActive(boolean active, int width, int height, @Nullable String error) {
        screenActive = active;
        screenWidth = active ? width : 0;
        screenHeight = active ? height : 0;
        screenState = active ? "SCREEN_ACTIVE" : "SCREEN_STOPPED";
        if (error != null) {
            lastError = error;
            addLog("Screen stream error: " + error);
        } else if (active) {
            addLog("Screen stream active " + width + "x" + height);
        } else {
            addLog("Screen stream stopped");
        }
        notifyChanged();
        controlClient.sendStatus();
    }

    synchronized void markControllerConnected() {
        appOnline = true;
        appState = "APP_ONLINE";
        lastHeartbeatAt = System.currentTimeMillis();
        lastError = "";
        addLog("Controller channel connected");
        notifyChanged();
    }

    synchronized void markControllerDisconnected(@Nullable String error) {
        appOnline = false;
        appState = "RECOVERING";
        if (error != null) {
            lastError = error;
            addLog("Controller channel disconnected: " + error);
        } else {
            addLog("Controller channel disconnected");
        }
        notifyChanged();
    }

    synchronized AgentSnapshot snapshot() {
        return new AgentSnapshot(
                deviceId,
                displayName,
                controllerUrl,
                appState,
                engineState,
                screenState,
                userActionCode,
                appOnline,
                engineReady,
                screenActive,
                screenWidth,
                screenHeight,
                lastHeartbeatAt,
                lastError
        );
    }

    synchronized List<String> currentLogs() {
        return new ArrayList<>(logs);
    }

    void addListener(@NonNull RuntimeListener listener) {
        listeners.add(listener);
        listener.onRuntimeChanged(snapshot(), currentLogs());
    }

    void removeListener(@NonNull RuntimeListener listener) {
        listeners.remove(listener);
    }

    String getDeviceId() {
        return deviceId;
    }

    String getDisplayName() {
        return displayName;
    }

    Context getApplicationContext() {
        return context;
    }

    static String hardwareStableKey() {
        AgentRuntime runtime = get();
        String androidId = Settings.Secure.getString(
                runtime.context.getContentResolver(), Settings.Secure.ANDROID_ID);
        return androidId == null ? "android-unknown" : "android-" + androidId.toLowerCase(Locale.US);
    }

    String getControllerUrl() {
        return controllerUrl;
    }

    synchronized String getPairingCode() {
        return pairingCode == null ? "" : pairingCode;
    }

    synchronized boolean isControllerPaired() {
        return controlClient.hasSavedCredentials();
    }

    public dev.galatea.device.DeviceAgentClient protocolClient() {
        return controlClient.protocolClient();
    }

    void pauseRemoteWork() { adbEngine.pauseRemoteWork(); }

    synchronized void acceptDeviceAgentPairing(@NonNull String agentId, @NonNull String assignedDeviceId) {
        pairingCode = "";
        preferences.edit().remove(KEY_PAIRING_CODE).apply();
        addLog("Controller pairing accepted: " + assignedDeviceId + " via " + agentId);
        notifyChanged();
    }

    synchronized void rejectControllerPairing(@NonNull String reason) {
        pairingCode = "";
        preferences.edit().remove(KEY_PAIRING_CODE).apply();
        lastError = reason;
        addLog("Controller pairing rejected: " + reason);
        notifyChanged();
    }

    @Override
    public synchronized void onEngineState(String state, boolean ready, String userActionCode, String error) {
        this.engineState = state;
        this.engineReady = ready;
        if (ready) {
            this.userActionCode = "";
            this.lastError = "";
        } else if (userActionCode != null) {
            this.userActionCode = userActionCode;
        }
        if (error != null && !error.isEmpty()) {
            this.lastError = error;
        }
        notifyChanged();
        controlClient.sendStatus();
    }

    @Override
    public void onLog(String line) {
        addLog(line);
    }

    synchronized void addLog(@NonNull String line) {
        String stamp = new SimpleDateFormat("HH:mm:ss", Locale.US).format(new Date());
        logs.add(stamp + "  " + line);
        while (logs.size() > 120) {
            logs.remove(0);
        }
        notifyChanged();
    }

    private void notifyChanged() {
        AgentSnapshot snapshot = snapshot();
        List<String> logs = currentLogs();
        for (RuntimeListener listener : listeners) {
            listener.onRuntimeChanged(snapshot, logs);
        }
    }

    private static String buildDeviceId(@NonNull Context context) {
        String androidId = Settings.Secure.getString(context.getContentResolver(), Settings.Secure.ANDROID_ID);
        if (androidId == null || androidId.trim().isEmpty()) {
            androidId = Build.SERIAL == null ? "unknown" : Build.SERIAL;
        }
        return "android-" + androidId.toLowerCase(Locale.US);
    }
}
