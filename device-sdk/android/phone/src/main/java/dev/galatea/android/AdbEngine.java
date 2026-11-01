package dev.galatea.android;

import android.content.Context;
import android.os.Build;

import androidx.annotation.NonNull;

import org.json.JSONObject;
import org.json.JSONArray;

import java.io.IOException;
import java.io.InputStream;
import java.util.Locale;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

import io.github.muntashirakon.adb.AbsAdbConnectionManager;
import io.github.muntashirakon.adb.AdbPairingRequiredException;
import io.github.muntashirakon.adb.AdbStream;
import io.github.muntashirakon.adb.android.AdbMdns;
import io.github.muntashirakon.adb.android.AndroidUtils;

final class AdbEngine {
    interface Listener {
        void onEngineState(String state, boolean ready, String userActionCode, String error);
        void onLog(String line);
    }

    private final Context context;
    private final Listener listener;
    private final ScheduledExecutorService executor = Executors.newSingleThreadScheduledExecutor();
    private final ScheduledExecutorService timeoutExecutor = Executors.newSingleThreadScheduledExecutor();
    private final AtomicBoolean keeperStarted = new AtomicBoolean(false);
    private final AtomicReference<AdbStream> activeRemoteStream = new AtomicReference<>();
    private final java.util.concurrent.atomic.AtomicLong accessGeneration = new java.util.concurrent.atomic.AtomicLong();
    private final ThreadLocal<Long> commandGeneration = new ThreadLocal<>();
    private final ThreadLocal<RemoteCommandCancellation> commandCancellation = new ThreadLocal<>();

    void pauseRemoteWork() {
        accessGeneration.incrementAndGet();
        AdbStream stream = activeRemoteStream.getAndSet(null);
        if (stream != null) try { stream.close(); } catch (Exception ignored) {}
    }

    private void requireAccess() throws IOException {
        RemoteCommandCancellation cancellation = commandCancellation.get();
        if (cancellation != null) cancellation.requireActive();
        Long generation = commandGeneration.get();
        if (generation != null && (generation != accessGeneration.get() ||
                !context.getSharedPreferences("device_access", Context.MODE_PRIVATE).getBoolean("allowed", false))) {
            throw new IOException("Device owner has paused remote control");
        }
    }

    AdbEngine(@NonNull Context context, @NonNull Listener listener) {
        this.context = context.getApplicationContext();
        this.listener = listener;
    }

    void startKeeper() {
        if (!keeperStarted.compareAndSet(false, true)) {
            return;
        }
        executor.execute(this::autoConnectBlocking);
        executor.scheduleWithFixedDelay(this::healthCheckBlocking, 5, 5, TimeUnit.SECONDS);
    }

    void stop() {
        try {
            AdbConnectionManager.getInstance(context).disconnect();
        } catch (Exception ignored) {
        }
        keeperStarted.set(false);
        listener.onEngineState("ADB_DISCONNECTED", false, "ENABLE_ANDROID_WIRELESS_DEBUGGING", null);
    }

    CompletableFuture<Boolean> pair(int port, @NonNull String pairingCode) {
        return CompletableFuture.supplyAsync(() -> {
            try {
                listener.onEngineState("ADB_PAIRING", false, null, null);
                AbsAdbConnectionManager manager = AdbConnectionManager.getInstance(context);
                if (manager.isConnected()) {
                    listener.onEngineState("ADB_READY", true, null, null);
                    listener.onLog("ADB is already connected; skipped redundant pairing");
                    return true;
                }
                boolean paired = manager.pair(AndroidUtils.getHostIpAddress(context), port, pairingCode.trim());
                listener.onLog("ADB pairing " + (paired ? "succeeded" : "failed") + " on port " + port);
                if (paired) {
                    autoConnectBlocking();
                } else {
                    listener.onEngineState("ADB_PAIRING_FAILED", false, "ENTER_ANDROID_PAIRING_CODE", "Pairing failed");
                }
                return paired;
            } catch (Exception e) {
                listener.onEngineState("ADB_PAIRING_FAILED", false, "ENTER_ANDROID_PAIRING_CODE", e.getMessage());
                listener.onLog("ADB pairing error: " + e.getMessage());
                return false;
            }
        }, executor);
    }

    CompletableFuture<Boolean> connect(int port) {
        return CompletableFuture.supplyAsync(() -> connectBlocking(port), executor);
    }

    CompletableFuture<Integer> discoverPairingPort() {
        return CompletableFuture.supplyAsync(() -> {
            final int[] foundPort = new int[]{-1};
            final Object lock = new Object();
            AdbMdns mdns = new AdbMdns(context, AdbMdns.SERVICE_TYPE_TLS_PAIRING, (hostAddress, port) -> {
                synchronized (lock) {
                    foundPort[0] = port;
                    lock.notifyAll();
                }
            });
            listener.onLog("Discovering ADB pairing port via mDNS");
            mdns.start();
            try {
                synchronized (lock) {
                    lock.wait(TimeUnit.SECONDS.toMillis(30));
                }
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            } finally {
                mdns.stop();
            }
            listener.onLog("Pairing port discovery result: " + foundPort[0]);
            return foundPort[0];
        }, executor);
    }

    CompletableFuture<JSONObject> executeControlCommand(@NonNull JSONObject command) {
        final long generation = accessGeneration.get();
        RemoteCommandCancellation cancellation = new RemoteCommandCancellation();
        CompletableFuture<JSONObject> execution = CompletableFuture.supplyAsync(() -> {
            commandGeneration.set(generation);
            commandCancellation.set(cancellation);
            try {
                requireAccess();
                ensureConnectedBlocking();
                String type = command.optString("type");
                JSONObject result = new JSONObject().put("type", type);
                switch (type) {
                    case "tap": {
                        int x = command.getInt("x");
                        int y = command.getInt("y");
                        result.put("output", executeShell(String.format(Locale.US, "input tap %d %d", x, y)));
                        return result;
                    }
                    case "swipe": {
                        int fromX = command.getInt("fromX");
                        int fromY = command.getInt("fromY");
                        int toX = command.getInt("toX");
                        int toY = command.getInt("toY");
                        int durationMs = command.optInt("durationMs", 450);
                        result.put("output", executeShell(String.format(Locale.US,
                                "input swipe %d %d %d %d %d", fromX, fromY, toX, toY, durationMs)));
                        return result;
                    }
                    case "typeText": {
                        String text = command.optString("text", "");
                        if (FocusedTextEdit.needsUnicodeInput(text)) {
                            // libadb 3.1.1 OPEN uses character count for UTF-8 bytes,
                            // and shell `input text` cannot reliably synthesize Unicode.
                            // UiAutomation uses the already paired shell authority, not a
                            // user-enabled AccessibilityService or a replacement keyboard.
                            boolean verified = typeFocusedTextViaShell(text);
                            result.put("inputMethod", "android.uiautomation.ACTION_SET_TEXT");
                            result.put("verification", verified ? "verified" : "accepted-unverified");
                            result.put("output", "Text action accepted; inspect the focused field before further actions");
                            return result;
                        }
                        result.put("output", executeShell("input text " + shellQuote(toAdbInputText(text))));
                        return result;
                    }
                    case "launchApp": {
                        String packageName = command.optString("packageName", command.optString("appId", ""));
                        String activity = command.optString("activity", "");
                        if (!activity.isEmpty()) {
                            String component = packageName + "/" + activity;
                            result.put("output", executeShell("am start -n " + shellQuote(component)));
                        } else {
                            result.put("output", executeShell("monkey -p " + shellQuote(packageName)
                                    + " -c android.intent.category.LAUNCHER 1"));
                        }
                        return result;
                    }
                    case "shell": {
                        result.put("output", executeShell(command.getString("command")));
                        return result;
                    }
                    case "getUiTree": {
                        result.put("output", executeShell("uiautomator dump /dev/tty"));
                        return result;
                    }
                    case "getAccessibilityTree": {
                        JSONArray nodes = new JSONArray();
                        for (AgentAccessibilityService.NodeSnapshot node
                                : AgentAccessibilityService.activeWindowSnapshot()) {
                            nodes.put(new JSONObject()
                                    .put("text", node.text)
                                    .put("contentDescription", node.contentDescription)
                                    .put("className", node.className)
                                    .put("packageName", node.packageName)
                                    .put("resourceId", node.resourceId)
                                    .put("clickable", node.clickable)
                                    .put("bounds", node.bounds.flattenToString()));
                        }
                        result.put("nodes", nodes);
                        return result;
                    }
                    case "logcat": {
                        int lines = Math.max(1, Math.min(2000, command.optInt("lines", 200)));
                        result.put("output", executeShell("logcat -d -t " + lines));
                        return result;
                    }
                    case "getScreenshot": {
                        long captureStarted = android.os.SystemClock.elapsedRealtime();
                        result.put("mimeType", "image/png");
                        result.put("base64", executeShell("screencap -p | base64").replaceAll("\\s+", ""));
                        result.put("captureDurationMs", android.os.SystemClock.elapsedRealtime() - captureStarted);
                        return result;
                    }
                    case "status": {
                        result.put("output", executeShell("echo ok"));
                        return result;
                    }
                    case "askXiaohongshu": {
                        JSONObject aiResult = new AiAppAutomation(
                                context,
                                this::executeShell,
                                listener::onLog
                        ).ask(
                                "xiaohongshu",
                                command.getString("question"),
                                command.optLong("timeoutMs", 90_000L)
                        );
                        aiResult.put("type", "askXiaohongshu");
                        return aiResult;
                    }
                    case "askAiApp": {
                        return new AiAppAutomation(
                                context,
                                this::executeShell,
                                listener::onLog
                        ).ask(
                                command.getString("provider"),
                                command.getString("question"),
                                command.optLong("timeoutMs", 90_000L)
                        );
                    }
                    case "executeAiTask": {
                        return new AiTaskAutomation(
                                context,
                                this::executeShell,
                                listener::onLog
                        ).execute(command);
                    }
                    default:
                        throw new IllegalArgumentException("Unsupported command type: " + type);
                }
            } catch (Exception e) {
                throw new RuntimeException(e);
            } finally {
                commandGeneration.remove();
                commandCancellation.remove();
            }
        }, executor);
        execution.whenComplete((ignored, error) -> { if (execution.isCancelled()) cancellation.cancel(); });
        return execution;
    }

    boolean isReady() {
        try {
            return AdbConnectionManager.getInstance(context).isConnected();
        } catch (Exception e) {
            return false;
        }
    }

    private void healthCheckBlocking() {
        if (!keeperStarted.get()) {
            return;
        }
        try {
            if (!isReady()) {
                autoConnectBlocking();
                return;
            }
            String output = executeShell("echo ok").trim();
            if ("ok".equals(output)) {
                listener.onEngineState("ADB_READY", true, null, null);
            } else {
                listener.onEngineState("ADB_RECOVERING", false, null, "Unexpected health output: " + output);
                autoConnectBlocking();
            }
        } catch (Exception e) {
            listener.onEngineState("ADB_RECOVERING", false, null, e.getMessage());
            autoConnectBlocking();
        }
    }

    private void ensureConnectedBlocking() throws Exception {
        if (!isReady()) {
            autoConnectBlocking();
        }
        if (!isReady()) {
            throw new IllegalStateException("ADB engine is not ready");
        }
    }

    private void autoConnectBlocking() {
        if (!keeperStarted.get()) {
            return;
        }
        try {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
                listener.onEngineState("ADB_UNSUPPORTED", false,
                        "ENABLE_ANDROID_WIRELESS_DEBUGGING", "Android 11+ is required");
                return;
            }
            listener.onEngineState("ADB_CONNECTING", false, null, null);
            AbsAdbConnectionManager manager = AdbConnectionManager.getInstance(context);
            try {
                boolean connected = manager.autoConnect(context, 10000);
                if (connected || manager.isConnected()) {
                    listener.onEngineState("ADB_READY", true, null, null);
                    listener.onLog("ADB connected via mDNS TLS service");
                    return;
                }
            } catch (AdbPairingRequiredException e) {
                listener.onEngineState("ADB_PERMISSION_REQUIRED", false,
                        "ENTER_ANDROID_PAIRING_CODE", e.getMessage());
                return;
            } catch (Throwable e) {
                listener.onLog("Auto-connect attempt failed: " + e.getMessage());
            }
            listener.onEngineState("ADB_PERMISSION_REQUIRED", false,
                    "ENABLE_ANDROID_WIRELESS_DEBUGGING", "Wireless debugging service was not discovered");
        } catch (Exception e) {
            listener.onEngineState("ADB_RECOVERING", false, "ENABLE_ANDROID_WIRELESS_DEBUGGING", e.getMessage());
        }
    }

    private boolean connectBlocking(int port) {
        try {
            listener.onEngineState("ADB_CONNECTING", false, null, null);
            AbsAdbConnectionManager manager = AdbConnectionManager.getInstance(context);
            boolean connected = manager.connect(AndroidUtils.getHostIpAddress(context), port);
            listener.onEngineState(connected ? "ADB_READY" : "ADB_CONNECTING_FAILED",
                    connected,
                    connected ? null : "ENABLE_ANDROID_WIRELESS_DEBUGGING",
                    connected ? null : "Unable to connect to local adbd on port " + port);
            return connected;
        } catch (Exception e) {
            listener.onEngineState("ADB_CONNECTING_FAILED", false,
                    "ENABLE_ANDROID_WIRELESS_DEBUGGING", e.getMessage());
            return false;
        }
    }

    private String executeShell(@NonNull String command) throws Exception {
        requireAccess();
        String sentinel = "__NBA_DONE_" + System.nanoTime() + "__";
        String wrapped = "sh -c " + shellQuote(command + "\nrc=$?\necho " + sentinel + "$rc");
        AbsAdbConnectionManager manager = AdbConnectionManager.getInstance(context);
        listener.onLog("ADB shell: " + command);
        ShellOutputBuffer output = new ShellOutputBuffer(sentinel);
        AtomicBoolean timedOut = new AtomicBoolean(false);
        AtomicReference<AdbStream> streamRef = new AtomicReference<>();
        ScheduledFuture<?> timeout = null;
        try (AdbStream stream = manager.openStream("shell:" + wrapped)) {
            if (commandGeneration.get() != null) activeRemoteStream.set(stream);
            if (commandCancellation.get() != null) commandCancellation.get().attach(stream);
            requireAccess();
            streamRef.set(stream);
            timeout = timeoutExecutor.schedule(() -> {
                timedOut.set(true);
                try {
                    AdbStream openStream = streamRef.get();
                    if (openStream != null) {
                        openStream.close();
                    }
                } catch (Exception ignored) {
                }
            }, 25, TimeUnit.SECONDS);
            InputStream input = stream.openInputStream();
            byte[] buffer = new byte[8192];
            int read;
            try {
                while ((read = input.read(buffer)) != -1) {
                    requireAccess();
                    output.append(buffer, read);
                    if (output.complete()) return output.text();
                }
            } catch (IOException e) {
                if (!timedOut.get() && !isBenignStreamClose(e)) {
                    throw e;
                }
            }
            String text = output.text();
            if (output.complete()) return text;
            if (timedOut.get()) {
                throw new IOException("ADB shell command timed out: " + command);
            }
            return text;
        } catch (IOException e) {
            String text = output.text();
            if (output.complete()) return text;
            if (!timedOut.get() && isBenignStreamClose(e)) {
                return text;
            }
            throw e;
        } finally {
            if (timeout != null) timeout.cancel(false);
            if (commandCancellation.get() != null && streamRef.get() != null)
                commandCancellation.get().detach(streamRef.get());
            streamRef.set(null);
            activeRemoteStream.set(null);
        }
    }

    private boolean typeFocusedTextViaShell(String text) throws Exception {
        requireAccess();
        if (text.length() > 4096) throw new IllegalArgumentException("Text exceeds 4096 UTF-16 units");
        String id = java.util.UUID.randomUUID().toString();
        String command = "CLASSPATH=" + shellQuote(context.getApplicationInfo().sourceDir)
                + " app_process / " + ShellTextInput.class.getName();
        AbsAdbConnectionManager manager = AdbConnectionManager.getInstance(context);
        try (AdbStream stream = manager.openStream("shell:" + command)) {
            activeRemoteStream.set(stream);
            if (commandCancellation.get() != null) commandCancellation.get().attach(stream);
            ScheduledFuture<?> timeout = timeoutExecutor.schedule(() -> {
                try { stream.close(); } catch (Exception ignored) { }
            }, 18, TimeUnit.SECONDS);
            try {
                requireAccess();
                java.io.OutputStream output = stream.openOutputStream();
                java.io.BufferedReader reader = new java.io.BufferedReader(new java.io.InputStreamReader(
                        stream.openInputStream(), java.nio.charset.StandardCharsets.UTF_8));
                writeTextFrame(output, new JSONObject().put("id", id).put("text", text));
                boolean committed = false;
                int total = 0;
                StringBuilder line = new StringBuilder();
                for (int c; (c = reader.read()) != -1;) {
                    requireAccess();
                    if (++total > 65536) throw new IOException("Text helper output exceeded its limit");
                    if (c != '\n') { line.append((char) c); continue; }
                    String frame = line.toString().trim(); line.setLength(0);
                    if (!frame.startsWith("DEVICE_AGENT_TEXT ")) continue;
                    JSONObject reply = new JSONObject(frame.substring("DEVICE_AGENT_TEXT ".length()));
                    if (!id.equals(reply.optString("id"))) throw new IOException("Text helper request mismatch");
                    String state = reply.optString("status");
                    if ("ready".equals(state) && !committed) {
                        requireAccess(); // Last consent/cancellation check immediately before the single write.
                        committed = true;
                        writeTextFrame(output, new JSONObject().put("id", id).put("action", "commit"));
                    } else if ("completed".equals(state) && committed) {
                        writeTextFrame(output, new JSONObject().put("id", id).put("action", "ack"));
                        return reply.optBoolean("verified", false);
                    } else if ("error".equals(state)) {
                        writeTextFrame(output, new JSONObject().put("id", id).put("action", "ack"));
                        throw new IOException(reply.optString("error", "Text helper failed"));
                    } else throw new IOException("Unexpected text helper state");
                }
                throw new IOException("Text helper disconnected; inspect the field before any retry");
            } finally {
                timeout.cancel(false);
                if (commandCancellation.get() != null) commandCancellation.get().detach(stream);
                activeRemoteStream.compareAndSet(stream, null);
            }
        }
    }

    private static void writeTextFrame(java.io.OutputStream output, JSONObject frame) throws IOException {
        output.write((frame.toString() + "\n").getBytes(java.nio.charset.StandardCharsets.UTF_8));
        output.flush();
    }

    private static boolean isBenignStreamClose(@NonNull IOException e) {
        String message = e.getMessage();
        return message != null && message.toLowerCase(Locale.US).contains("stream closed");
    }

    private static String toAdbInputText(@NonNull String text) {
        return text
                .replace("%", "\\%")
                .replace(" ", "%s")
                .replace("\n", "%n");
    }

    private static String shellQuote(@NonNull String value) {
        return "'" + value.replace("'", "'\\''") + "'";
    }
}
