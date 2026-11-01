package dev.galatea.android;

import androidx.annotation.NonNull;

import dev.galatea.device.AgentConfig;
import dev.galatea.device.BinaryPayload;
import dev.galatea.device.CapabilityDescriptor;
import dev.galatea.device.CommandContext;
import dev.galatea.device.DeviceAgentClient;
import dev.galatea.device.DeviceAgentDriver;
import dev.galatea.device.DriverEventSink;
import dev.galatea.device.DriverResult;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;

/** Gelato device-side protocol client backed by the embedded-ADB engine. */
final class ControlClient {
    private final AgentRuntime runtime;
    private final DeviceAgentClient client;

    ControlClient(@NonNull AgentRuntime runtime) {
        this.runtime = runtime;
        AndroidPhoneDriver driver = new AndroidPhoneDriver(runtime);
        this.client = new DeviceAgentClient(
                runtime.getApplicationContext(),
                new AgentConfig(
                        "android-phone",
                        "android",
                        "android.phone",
                        runtime.getDisplayName(),
                        DeviceAgentClient.applicationVersion(runtime.getApplicationContext())),
                driver,
                new DeviceAgentClient.Listener() {
                    @Override
                    public void onConnectionState(@NonNull String state, String error) {
                        if ("online".equals(state)) runtime.markControllerConnected();
                        else if ("offline".equals(state)) runtime.markControllerDisconnected(error);
                        else if (error != null && !error.isEmpty()) runtime.addLog("Device connection: " + error);
                    }

                    @Override
                    public void onPairingAccepted(@NonNull String agentId, @NonNull String deviceId) {
                        runtime.acceptDeviceAgentPairing(agentId, deviceId);
                    }

                    @Override
                    public void onPairingRejected(@NonNull String error) {
                        runtime.rejectControllerPairing(error);
                    }
                });
    }

    void start(@NonNull String controllerUrl) {
        client.start(controllerUrl, runtime.getPairingCode());
    }

    void stop() {
        client.stop();
    }

    void sendStatus() {
        client.stateChanged();
    }

    boolean hasSavedCredentials() {
        return client.hasCredential();
    }

    boolean isAuthenticated() { return client.isAuthenticated(); }

    DeviceAgentClient protocolClient() { return client; }

    void sendScreenFrame(@NonNull byte[] data) {
        client.sendLiveScreenFrame(data);
    }

    void sendScreenFrame(@NonNull byte[] data, double sourceTimeS) {
        client.sendLiveScreenFrame(data, sourceTimeS);
    }

    void sendScreenJpegFrame(@NonNull byte[] data, double sourceTimeS) {
        client.sendLiveScreenJpegFrame(data, sourceTimeS);
    }

    private static final class AndroidPhoneDriver implements DeviceAgentDriver {
        private final AgentRuntime runtime;
        private final Map<String, CompletableFuture<DriverResult>> active = new ConcurrentHashMap<>();

        AndroidPhoneDriver(AgentRuntime runtime) {
            this.runtime = runtime;
        }

        @NonNull
        @Override
        public JSONObject snapshot() throws Exception {
            AgentSnapshot status = runtime.snapshot();
            Object userAction = status.userActionCode == null || status.userActionCode.isEmpty()
                    ? JSONObject.NULL
                    : new JSONObject()
                    .put("code", status.userActionCode)
                    .put("message", "Complete Android Wireless Debugging setup");
            return new JSONObject()
                    .put("kind", "android.phone")
                    .put("displayName", status.displayName)
                    .put("os", new JSONObject()
                            .put("family", "android")
                            .put("version", android.os.Build.VERSION.RELEASE))
                    .put("driver", new JSONObject()
                            .put("id", "android.embedded-adb")
                            .put("version", "1.0.0")
                            .put("location", "device")
                            .put("state", status.engineReady ? "ready" : "authorization-required"))
                    .put("hardware", new JSONObject()
                            .put("present", true)
                            .put("connected", status.engineReady)
                            .put("stableKey", AgentRuntime.hardwareStableKey())
                            .put("userAction", userAction));
        }

        @NonNull
        @Override
        public List<CapabilityDescriptor> capabilities() {
            ArrayList<CapabilityDescriptor> values = new ArrayList<>();
            values.add(new CapabilityDescriptor("device.describe", 1));
            values.add(new CapabilityDescriptor("input.tap", 1));
            values.add(new CapabilityDescriptor("input.swipe", 1));
            values.add(new CapabilityDescriptor("text.type", 1));
            values.add(new CapabilityDescriptor("app.launch", 1));
            values.add(new CapabilityDescriptor("screen.capture", 1));
            values.add(new CapabilityDescriptor("ui.tree", 1));
            values.add(new CapabilityDescriptor("vendor.android.shell", 1));
            values.add(new CapabilityDescriptor("vendor.android.logcat", 1));
            values.add(new CapabilityDescriptor("vendor.serverized.ai.ask", 1));
            values.add(new CapabilityDescriptor("vendor.serverized.task.execute", 1));
            return values;
        }

        @NonNull
        @Override
        public CompletableFuture<DriverResult> execute(
                @NonNull CommandContext context,
                @NonNull String capability,
                int version,
                @NonNull JSONObject arguments
        ) {
            context.requireActive();
            try {
                if ("device.describe".equals(capability)) {
                    return CompletableFuture.completedFuture(new DriverResult(snapshot()));
                }
                JSONObject command = mapCommand(capability, arguments);
                CompletableFuture<JSONObject> execution = runtime.handleControlCommand(command);
                CompletableFuture<DriverResult> future = execution
                        .thenApply(result -> {
                            context.requireActive();
                            if ("screen.capture".equals(capability)) {
                                String base64 = result.optString("base64", "");
                                if (!base64.isEmpty()) {
                                    try {
                                        JSONObject metadata = new JSONObject(result.toString());
                                        metadata.remove("base64");
                                        return new DriverResult(metadata, new BinaryPayload(
                                                "photo",
                                                result.optString("mimeType", "image/png"),
                                                android.util.Base64.decode(base64, android.util.Base64.DEFAULT)));
                                    } catch (Exception error) {
                                        throw new IllegalStateException(error);
                                    }
                                }
                            }
                            return new DriverResult(result);
                        });
                active.put(context.commandId, future);
                future.whenComplete((ignored, error) -> {
                    if (future.isCancelled()) execution.cancel(true);
                    active.remove(context.commandId, future);
                });
                return future;
            } catch (Exception error) {
                CompletableFuture<DriverResult> failed = new CompletableFuture<>();
                failed.completeExceptionally(error);
                return failed;
            }
        }

        @Override
        public boolean cancel(@NonNull String commandId) {
            CompletableFuture<DriverResult> future = active.remove(commandId);
            return future != null && future.cancel(true);
        }

        @Override
        public void setEventSink(@NonNull DriverEventSink sink) {
        }

        @Override
        public void close() {
            for (CompletableFuture<DriverResult> future : active.values()) future.cancel(true);
            active.clear();
        }

        private static JSONObject mapCommand(String capability, JSONObject arguments) throws Exception {
            switch (capability) {
                case "input.tap":
                    return new JSONObject().put("type", "tap")
                            .put("x", arguments.getInt("x")).put("y", arguments.getInt("y"));
                case "input.swipe":
                    return new JSONObject().put("type", "swipe")
                            .put("fromX", arguments.getInt("fromX"))
                            .put("fromY", arguments.getInt("fromY"))
                            .put("toX", arguments.getInt("toX"))
                            .put("toY", arguments.getInt("toY"))
                            .put("durationMs", arguments.optInt("durationMs", 450));
                case "text.type":
                    return new JSONObject().put("type", "typeText").put("text", arguments.getString("text"));
                case "app.launch":
                    return new JSONObject().put("type", "launchApp")
                            .put("packageName", arguments.getString("appId"))
                            .put("activity", arguments.optString("activity", ""));
                case "screen.capture": return new JSONObject().put("type", "getScreenshot");
                case "ui.tree": return new JSONObject().put("type", "getUiTree");
                case "vendor.android.shell":
                    return new JSONObject().put("type", "shell").put("command", arguments.getString("command"));
                case "vendor.android.logcat":
                    return new JSONObject().put("type", "logcat").put("lines", arguments.optInt("lines", 200));
                case "vendor.serverized.ai.ask":
                    return new JSONObject().put("type", "askAiApp")
                            .put("provider", arguments.getString("provider"))
                            .put("question", arguments.getString("question"))
                            .put("timeoutMs", arguments.optInt("timeoutMs", 90_000));
                case "vendor.serverized.task.execute":
                    return new JSONObject().put("type", "executeAiTask")
                            .put("taskId", arguments.optString("taskId", ""))
                            .put("action", arguments.getString("action"))
                            .put("arguments", arguments.getJSONObject("arguments"))
                            .put("timeoutMs", arguments.optInt("timeoutMs", 120_000));
                default: throw new IllegalArgumentException("Unsupported capability " + capability);
            }
        }
    }
}
