package dev.galatea.device;

import android.content.Context;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.URI;

import java.net.URI;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.ArrayDeque;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

public final class DeviceAgentClient extends WebSocketListener implements DriverEventSink {
    public static final String PROTOCOL = "gelato.v1";

    public static String applicationVersion(@NonNull Context context) {
        try {
            String version = context.getPackageManager().getPackageInfo(context.getPackageName(), 0).versionName;
            if (version == null || version.isEmpty()) throw new IllegalStateException("Application versionName is required");
            return version;
        } catch (android.content.pm.PackageManager.NameNotFoundException error) {
            throw new IllegalStateException("Application package metadata is unavailable", error);
        }
    }

    public interface Listener {
        void onConnectionState(@NonNull String state, @Nullable String error);
        void onPairingAccepted(@NonNull String agentId, @NonNull String deviceId);
        void onPairingRejected(@NonNull String error);
        default void onReply(@NonNull String text) { }
        /** Verified 24 kHz mono PCM16 reply, delivered off the socket thread. */
        default void onReplyAudio(@NonNull byte[] pcm16, int sampleRateHz) { }
        default void onMediaStreamError(@NonNull String error) { onConnectionState("degraded", error); }
    }

    private final Context context;
    private final AgentConfig config;
    private final DeviceAgentDriver driver;
    private final Listener listener;
    private final SecureCredentialStore credentialStore;
    private final OkHttpClient http = new OkHttpClient.Builder()
            .pingInterval(15, TimeUnit.SECONDS)
            .followRedirects(false)
            .followSslRedirects(false)
            .retryOnConnectionFailure(true)
            .build();
    private final ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor();
    private final ExecutorService mediaDownloads = Executors.newSingleThreadExecutor();
    private final Map<String, CompletableFuture<DriverResult>> running = new ConcurrentHashMap<>();
    private final Map<String, PendingUpload> uploads = new ConcurrentHashMap<>();
    private final Map<String, WebSocket> uploadSockets = new ConcurrentHashMap<>();
    private final Map<String, JSONObject> terminalCache = java.util.Collections.synchronizedMap(
            new LinkedHashMap<String, JSONObject>(128, 0.75f, true) {
                @Override protected boolean removeEldestEntry(Map.Entry<String, JSONObject> eldest) {
                    return size() > 128;
                }
            });
    private final Map<String, JSONObject> eventOutbox = new ConcurrentHashMap<>();

    private volatile WebSocket socket;
    private volatile boolean desired;
    private volatile boolean authenticated;
    private volatile boolean startupCredentialProbe;
    private boolean startupProbeInitialized;
    private volatile String controllerUrl = "";
    private volatile String pairingCode = "";
    private volatile int reconnectDelaySeconds = 1;
    private volatile long revision = 0;
    private volatile long lastControllerMessageAtMs = 0;
    private volatile LiveStreamUploader liveVisualStream;
    private volatile LiveStreamUploader liveAudioStream;
    private volatile boolean controlAllowed;

    public DeviceAgentClient(
            @NonNull Context context,
            @NonNull AgentConfig config,
            @NonNull DeviceAgentDriver driver,
            @NonNull Listener listener
    ) {
        this.context = context.getApplicationContext();
        this.config = config;
        this.driver = driver;
        this.listener = listener;
        this.credentialStore = new SecureCredentialStore(this.context);
        this.controlAllowed = this.context.getSharedPreferences("device_access", Context.MODE_PRIVATE)
                .getBoolean("allowed", false);
        driver.setEventSink(this);
        scheduler.scheduleWithFixedDelay(this::maintainConnection, 3, 10, TimeUnit.SECONDS);
    }

    public synchronized void start(@NonNull String controllerUrl, @Nullable String pairingCode) {
        String nextControllerUrl = controllerUrl.trim().replaceAll("/+$", "");
        URI endpoint = URI.create(nextControllerUrl);
        String host = endpoint.getHost();
        boolean loopback = "localhost".equals(host) || "127.0.0.1".equals(host) || "[::1]".equals(host) || "::1".equals(host);
        if (host == null || endpoint.getUserInfo() != null || endpoint.getQuery() != null || endpoint.getFragment() != null
                || !("https".equals(endpoint.getScheme()) || "http".equals(endpoint.getScheme()) && loopback)
                || !(endpoint.getPath() == null || endpoint.getPath().isEmpty() || "/".equals(endpoint.getPath()))) {
            throw new IllegalArgumentException("Use an HTTPS root origin, or loopback HTTP");
        }
        credentialStore.bindOrigin(nextControllerUrl);
        String nextPairingCode = pairingCode == null ? "" : pairingCode.trim();
        boolean scheduleStartupProbe = false;
        if (!startupProbeInitialized) {
            startupProbeInitialized = true;
            startupCredentialProbe = nextPairingCode.isEmpty() && credentialStore.credentials() != null;
            scheduleStartupProbe = startupCredentialProbe;
        }
        boolean connectionChanged = !nextControllerUrl.equals(this.controllerUrl)
                || !nextPairingCode.isEmpty();
        this.controllerUrl = nextControllerUrl;
        this.pairingCode = nextPairingCode;
        desired = true;
        reconnectDelaySeconds = 1;
        if (connectionChanged) {
            authenticated = false;
            WebSocket previous = socket;
            socket = null;
            if (previous != null) previous.close(1012, "Device connection configuration changed");
        } else if (authenticated && controllerConnectionIsStale()) {
            // Some Android vendors leave the process and foreground service
            // alive while silently suspending an established network socket.
            // The service's periodic resume call must be able to replace that
            // half-open socket instead of waiting forever for OkHttp callbacks.
            authenticated = false;
            WebSocket stale = socket;
            socket = null;
            if (stale != null) stale.cancel();
        }
        reconnectNow();
        if (scheduleStartupProbe) {
            scheduler.schedule(() -> failStartupCredentialProbe(
                    "旧凭据验证超时，已清除本机凭据，请重新配对"), 12, TimeUnit.SECONDS);
        }
    }

    public synchronized void stop() {
        desired = false;
        authenticated = false;
        startupCredentialProbe = false;
        WebSocket active = socket;
        socket = null;
        if (active != null) active.close(1000, "Device connection stopped");
        for (CompletableFuture<DriverResult> command : running.values()) command.cancel(true);
        running.clear();
        LiveStreamUploader live = liveVisualStream;
        liveVisualStream = null;
        if (live != null) live.close();
        LiveStreamUploader audio = liveAudioStream;
        liveAudioStream = null;
        if (audio != null) audio.close();
        listener.onConnectionState("offline", null);
    }

    /** Permanently releases a client that will not be started again. */
    public synchronized void close() {
        stop();
        scheduler.shutdownNow();
        mediaDownloads.shutdownNow();
        http.dispatcher().cancelAll();
        http.connectionPool().evictAll();
    }

    public void revokeLocalCredential() {
        credentialStore.clear();
        stop();
    }

    public @Nullable String deviceId() {
        SecureCredentialStore.Credentials credentials = credentialStore.credentials();
        return credentials == null ? null : credentials.deviceId;
    }

    public boolean hasCredential() {
        return credentialStore.credentials() != null;
    }

    public @NonNull String lastReply() {
        return context.getSharedPreferences("gelato_exchange", Context.MODE_PRIVATE)
                .getString("last_reply", "");
    }

    public @NonNull String publishInput(@NonNull String kind, @NonNull JSONArray parts) throws Exception {
        if (!"instruction".equals(kind) && !"observation".equals(kind)) throw new IllegalArgumentException("Invalid input kind");
        if (parts.length() < 1 || parts.length() > 8) throw new IllegalArgumentException("Invalid content parts");
        WebSocket active = socket;
        if (!authenticated || active == null || deviceId() == null) throw new IllegalStateException("Device is not connected");
        JSONObject message = envelope("input.publish", deviceId(), null,
                new JSONObject().put("kind", kind).put("parts", parts));
        if (!active.send(message.toString())) throw new IllegalStateException("Device connection is unavailable");
        return message.getString("messageId");
    }

    public boolean isControlAllowed() { return controlAllowed; }

    /** Pausing access keeps pairing and presence, but stops execution and media. */
    public synchronized void setControlAllowed(boolean allowed) {
        controlAllowed = allowed;
        context.getSharedPreferences("device_access", Context.MODE_PRIVATE).edit()
                .putBoolean("allowed", allowed).commit();
        if (!allowed) {
            for (String commandId : running.keySet()) cancelCommand(commandId);
            uploads.clear();
            for (WebSocket uploadSocket : uploadSockets.values()) uploadSocket.cancel();
            uploadSockets.clear();
            eventOutbox.clear();
            LiveStreamUploader live = liveVisualStream;
            liveVisualStream = null;
            if (live != null) live.close();
            LiveStreamUploader audio = liveAudioStream;
            liveAudioStream = null;
            if (audio != null) audio.close();
        }
        stateChanged();
    }

    /** Native-only account ownership proof; never expose this payload to JavaScript. */
    public JSONObject accountOwnershipProof() throws Exception {
        SecureCredentialStore.Credentials value = credentialStore.credentials();
        if (value == null) throw new IllegalStateException("Device is not paired");
        return new JSONObject().put("agentId", value.agentId).put("credential", value.credential);
    }

    public synchronized void sendLiveScreenFrame(@NonNull byte[] bytes) {
        sendLiveVisualFrame(bytes, "video/h264", "screen", null);
    }

    public boolean isAuthenticated() { return authenticated; }

    public synchronized void sendLiveScreenFrame(@NonNull byte[] bytes, @Nullable Double sourceTimeS) {
        sendLiveVisualFrame(bytes, "video/h264", "screen", sourceTimeS);
    }

    /** A complete JPEG observation pushed by an active screen-sharing session. */
    public synchronized void sendLiveScreenJpegFrame(@NonNull byte[] bytes, @Nullable Double sourceTimeS) {
        sendLiveVisualFrame(bytes, "image/jpeg", "screen", sourceTimeS);
    }

    /** Autonomous camera observations, distinct from an on-demand photo command. */
    public synchronized void sendLiveCameraJpegFrame(@NonNull byte[] bytes, @Nullable Double sourceTimeS) {
        sendLiveVisualFrame(bytes, "image/jpeg", "photo", sourceTimeS);
    }

    /** One signed little-endian PCM16 mono frame sampled at 16 kHz. */
    public synchronized void sendLiveAudioPcmFrame(@NonNull byte[] bytes, @Nullable Double sourceTimeS) {
        if (!controlAllowed || !authenticated || bytes.length < 2 || bytes.length > 32 * 1024
                || bytes.length % 2 != 0) return;
        SecureCredentialStore.Credentials credentials = credentialStore.credentials();
        if (credentials == null) return;
        LiveStreamUploader live = liveAudioStream;
        if (live == null || live.closed) {
            live = new LiveStreamUploader(credentials, "audio/pcm", "audio");
            liveAudioStream = live;
            Request request = new Request.Builder()
                    .url(websocketBase(controllerUrl) + "/agent/streams/live")
                    .header("Authorization", "Bearer " + credentials.credential)
                    .header("X-Agent-Id", credentials.agentId)
                    .header("X-Device-Id", credentials.deviceId)
                    .build();
            http.newWebSocket(request, live);
        }
        live.enqueue(bytes, sourceTimeS);
    }

    private synchronized void sendLiveVisualFrame(@NonNull byte[] bytes, @NonNull String contentType,
                                                  @NonNull String purpose, @Nullable Double sourceTimeS) {
        if (!controlAllowed || !authenticated || bytes.length == 0 || bytes.length > 2 * 1024 * 1024) return;
        SecureCredentialStore.Credentials credentials = credentialStore.credentials();
        if (credentials == null) return;
        LiveStreamUploader live = liveVisualStream;
        if (live != null && (!contentType.equals(live.contentType) || !purpose.equals(live.purpose))) {
            live.close();
            liveVisualStream = null;
            live = null;
        }
        if (live == null || live.closed) {
            live = new LiveStreamUploader(credentials, contentType, purpose);
            liveVisualStream = live;
            Request request = new Request.Builder()
                    .url(websocketBase(controllerUrl) + "/agent/streams/live")
                    .header("Authorization", "Bearer " + credentials.credential)
                    .header("X-Agent-Id", credentials.agentId)
                    .header("X-Device-Id", credentials.deviceId)
                    .build();
            http.newWebSocket(request, live);
        }
        live.enqueue(bytes, sourceTimeS);
    }

    @Override
    public void onOpen(@NonNull WebSocket webSocket, @NonNull Response response) {
        if (socket != webSocket || !desired) {
            webSocket.cancel();
            return;
        }
        reconnectDelaySeconds = 1;
        lastControllerMessageAtMs = System.currentTimeMillis();
        listener.onConnectionState("authenticating", null);
        SecureCredentialStore.Credentials credentials = credentialStore.credentials();
        JSONObject body = descriptor();
        try {
            if (!pairingCode.isEmpty()) {
                body.put("pairingCode", pairingCode);
                send(envelope("pairing.request", null, null, body));
            } else if (credentials != null) {
                body.put("agentId", credentials.agentId).put("credential", credentials.credential);
                send(envelope("session.hello", credentials.deviceId, null, body));
            } else {
                throw new IllegalStateException("Pairing code or saved credential is required");
            }
        } catch (Exception error) {
            failConnection(error.getMessage());
        }
    }

    @Override
    public void onMessage(@NonNull WebSocket webSocket, @NonNull String text) {
        if (socket != webSocket || !desired) return;
        lastControllerMessageAtMs = System.currentTimeMillis();
        try {
            JSONObject message = new JSONObject(text);
            if (!PROTOCOL.equals(message.optString("protocol"))) throw new IllegalArgumentException("Protocol mismatch");
            String type = message.getString("type");
            JSONObject body = message.optJSONObject("body");
            if (body == null) body = new JSONObject();
            switch (type) {
                case "pairing.accepted":
                case "session.accepted":
                    acceptSession(body);
                    break;
                case "pairing.rejected":
                    authenticated = false;
                    String rejection = body.optString("error", "Pairing rejected");
                    pairingCode = "";
                    listener.onPairingRejected(rejection);
                    if (credentialStore.credentials() == null) desired = false;
                    webSocket.close(1008, rejection);
                    break;
                case "session.rejected":
                    authenticated = false;
                    startupCredentialProbe = false;
                    String sessionRejection = body.optString("error", "Saved device credential was rejected");
                    credentialStore.clear();
                    setControlAllowed(false);
                    desired = false;
                    listener.onConnectionState("offline", sessionRejection);
                    listener.onPairingRejected("旧凭据被控制端拒绝，已清除本机凭据，请重新配对");
                    webSocket.close(1008, sessionRejection);
                    break;
                case "device.snapshot.request":
                    sendSnapshot();
                    break;
                case "lease.ack":
                case "device.snapshot.ack":
                case "device.state.patch.ack":
                    break;
                case "command.request":
                    handleCommand(message, body);
                    break;
                case "command.cancel":
                    cancelCommand(message.optString("commandId", body.optString("commandId")));
                    break;
                case "reply.deliver":
                    if (deviceId() == null || !deviceId().equals(message.optString("deviceId"))) break;
                    String replyText = body.optString("text", "");
                    if (replyText.isEmpty() || replyText.length() > 32768) break;
                    context.getSharedPreferences("gelato_exchange", Context.MODE_PRIVATE).edit()
                            .putString("last_reply", replyText).apply();
                    listener.onReply(replyText);
                    JSONObject replyAudio = body.optJSONObject("audio");
                    if (replyAudio != null && controlAllowed) downloadReplyAudio(replyAudio);
                    send(envelope("reply.ack", deviceId(), null,
                            new JSONObject().put("replyMessageId", message.getString("messageId"))));
                    break;
                case "event.ack":
                    eventOutbox.remove(message.optString("eventId"));
                    break;
                case "stream.accept":
                    beginUpload(body.getString("streamId"));
                    break;
                case "protocol.error":
                    listener.onConnectionState("degraded", body.optString("error", "Protocol error"));
                    break;
                default:
                    break;
            }
        } catch (Exception error) {
            listener.onConnectionState("degraded", "Invalid Controller message: " + error.getMessage());
        }
    }

    @Override
    public void onClosed(@NonNull WebSocket webSocket, int code, @NonNull String reason) {
        if (socket != webSocket) return;
        socket = null;
        authenticated = false;
        if (failStartupCredentialProbe("旧凭据验证失败，已清除本机凭据，请重新配对")) return;
        listener.onConnectionState("offline", reason);
        reconnectLater();
    }

    @Override
    public void onFailure(@NonNull WebSocket webSocket, @NonNull Throwable error, @Nullable Response response) {
        if (socket != webSocket) return;
        socket = null;
        authenticated = false;
        if (failStartupCredentialProbe("旧凭据验证失败，已清除本机凭据，请重新配对")) return;
        listener.onConnectionState("offline", error.getMessage());
        reconnectLater();
    }

    @Override
    public void stateChanged() {
        if (authenticated) sendSnapshot();
    }

    @Override
    public void publish(@NonNull String eventType, @NonNull JSONObject body, boolean critical) {
        if (!controlAllowed) return;
        try {
            String eventId = "evt_" + randomId();
            JSONObject event = envelope("event.publish", deviceId(), null, new JSONObject()
                    .put("eventType", eventType)
                    .put("critical", critical)
                    .put("payload", body));
            event.put("eventId", eventId);
            if (critical) {
                while (eventOutbox.size() >= 128) {
                    String oldest = eventOutbox.keySet().stream().findFirst().orElse(null);
                    if (oldest == null) break;
                    eventOutbox.remove(oldest);
                }
                eventOutbox.put(eventId, event);
            }
            // Driver callbacks can fire while the socket is still opening.
            // No state/event/command traffic may race ahead of the mandatory
            // pairing.request or session.hello first frame.
            if (!authenticated) return;
            send(event);
        } catch (Exception ignored) {
        }
    }

    private synchronized void reconnectNow() {
        if (!desired || controllerUrl.isEmpty() || socket != null) return;
        try {
            Request request = new Request.Builder().url(controlUrl(controllerUrl)).build();
            socket = http.newWebSocket(request, this);
            listener.onConnectionState("connecting", null);
        } catch (Exception error) {
            failConnection(error.getMessage());
        }
    }

    private void reconnectLater() {
        if (!desired) return;
        int delay = reconnectDelaySeconds;
        reconnectDelaySeconds = Math.min(30, reconnectDelaySeconds * 2);
        long jitterMs = Math.abs(UUID.randomUUID().getLeastSignificantBits() % 500L);
        scheduler.schedule(this::reconnectNow, delay * 1_000L + jitterMs, TimeUnit.MILLISECONDS);
    }

    private void acceptSession(JSONObject body) throws Exception {
        String agentId = body.getString("agentId");
        String assignedDeviceId = body.getString("deviceId");
        String credential = body.optString("credential", "");
        SecureCredentialStore.Credentials current = credentialStore.credentials();
        if (!credential.isEmpty()) credentialStore.save(agentId, assignedDeviceId, credential);
        else if (current == null || !current.agentId.equals(agentId) || !current.deviceId.equals(assignedDeviceId)) {
            throw new IllegalStateException("Controller omitted the credential for an unknown session");
        }
        pairingCode = "";
        authenticated = true;
        startupCredentialProbe = false;
        lastControllerMessageAtMs = System.currentTimeMillis();
        revision = 0;
        listener.onPairingAccepted(agentId, assignedDeviceId);
        listener.onConnectionState("online", null);
        sendSnapshot();
        renewLease();
        for (JSONObject event : eventOutbox.values()) {
            // Critical driver events may have been queued before first pairing,
            // when no deviceId existed yet, or while a re-pair replaced the
            // credential. Bind every replay to the accepted session.
            event.put("deviceId", assignedDeviceId);
            send(event);
        }
    }

    private void renewLease() {
        if (!authenticated) return;
        try {
            send(envelope("lease.renew", deviceId(), null, new JSONObject().put("revision", revision)));
        } catch (Exception error) {
            listener.onConnectionState("degraded", "Lease renewal failed: " + error.getMessage());
        }
    }

    private synchronized void maintainConnection() {
        if (!desired) return;
        if (authenticated && controllerConnectionIsStale()) {
            authenticated = false;
            WebSocket stale = socket;
            socket = null;
            if (stale != null) stale.cancel();
            listener.onConnectionState("offline", "Controller lease acknowledgement timed out");
            reconnectNow();
            return;
        }
        renewLease();
    }

    private boolean controllerConnectionIsStale() {
        long lastMessage = lastControllerMessageAtMs;
        return lastMessage > 0 && System.currentTimeMillis() - lastMessage > 25_000L;
    }

    private void sendSnapshot() {
        if (!authenticated) return;
        try {
            JSONObject body = driver.snapshot();
            body.getJSONObject("hardware").put("controlAllowed", controlAllowed);
            JSONArray capabilities = new JSONArray();
            for (CapabilityDescriptor capability : driver.capabilities()) capabilities.put(capability.toJson());
            body.put("capabilities", capabilities).put("revision", ++revision);
            send(envelope("device.snapshot", deviceId(), null, body));
        } catch (Exception error) {
            listener.onConnectionState("degraded", "Snapshot failed: " + error.getMessage());
        }
    }

    private void handleCommand(JSONObject message, JSONObject body) throws Exception {
        String commandId = message.optString("commandId", body.getString("commandId"));
        if (!controlAllowed && !"device.describe".equals(body.optString("capability"))) {
            sendTerminal(commandId, false, null, "Device owner has paused remote control", false);
            return;
        }
        JSONObject cached = terminalCache.get(commandId);
        if (cached != null) {
            send(new JSONObject(cached.toString()));
            return;
        }
        if (running.containsKey(commandId)) return;
        String capability = body.getString("capability");
        int version = body.optInt("capabilityVersion", 1);
        boolean advertised = driver.capabilities().stream().anyMatch(
                value -> value.name.equals(capability) && value.version == version);
        if (!advertised) {
            sendTerminal(commandId, false, null, "Capability is not advertised: " + capability, false);
            return;
        }
        long deadline = Instant.parse(body.getString("deadline")).toEpochMilli();
        CommandContext context = new CommandContext(commandId, deadline, body.optString("idempotency", "side-effecting"));
        send(envelope("command.progress", deviceId(), commandId,
                new JSONObject().put("stage", "accepted").put("progress", 0)));
        CompletableFuture<DriverResult> future = driver.execute(
                context, capability, version, body.optJSONObject("arguments") == null
                        ? new JSONObject() : body.getJSONObject("arguments"));
        running.put(commandId, future);
        future.whenComplete((result, error) -> {
            running.remove(commandId);
            if (error != null) {
                Throwable cause = error.getCause() == null ? error : error.getCause();
                sendTerminal(commandId, false, null, cause.getMessage(), future.isCancelled());
                return;
            }
            if (result.binary == null) {
                sendTerminal(commandId, true, result.body, null, false);
                return;
            }
            offerUpload(commandId, result);
        });
    }

    private void cancelCommand(String commandId) {
        driver.cancel(commandId);
        CompletableFuture<DriverResult> future = running.get(commandId);
        if (future != null) future.cancel(true);
    }

    private void offerUpload(String commandId, DriverResult result) {
        if (!controlAllowed) {
            sendTerminal(commandId, false, null, "Device owner has paused remote control", true);
            return;
        }
        try {
            String streamId = "str_" + randomId();
            PendingUpload upload = new PendingUpload(streamId, commandId, result);
            uploads.put(streamId, upload);
            JSONObject offer = new JSONObject()
                    .put("streamId", streamId)
                    .put("commandId", commandId)
                    .put("purpose", result.binary.purpose)
                    .put("direction", "agent-to-controller")
                    .put("contentType", result.binary.contentType)
                    .put("maxFrameBytes", 256 * 1024)
                    .put("maxTotalBytes", Math.max(result.binary.bytes.length, 1))
                    .put("expectedBytes", result.binary.bytes.length);
            send(envelope("stream.offer", deviceId(), commandId, offer));
        } catch (Exception error) {
            sendTerminal(commandId, false, null, error.getMessage(), false);
        }
    }

    private synchronized void beginUpload(String streamId) {
        if (!controlAllowed) return;
        PendingUpload upload = uploads.get(streamId);
        SecureCredentialStore.Credentials credentials = credentialStore.credentials();
        if (upload == null || credentials == null) return;
        String target = streamUrl(controllerUrl, streamId);
        Request request = new Request.Builder()
                .url(target)
                .header("Authorization", "Bearer " + credentials.credential)
                .header("X-Agent-Id", credentials.agentId)
                .build();
        uploadSockets.put(streamId, http.newWebSocket(request, new StreamUploader(upload, credentials.deviceId)));
    }

    private void sendTerminal(
            String commandId,
            boolean ok,
            @Nullable JSONObject result,
            @Nullable String error,
            boolean cancelled
    ) {
        try {
            JSONObject body = new JSONObject();
            if (ok) body.put("result", result == null ? new JSONObject() : result);
            else body.put("error", error == null ? "Command failed" : error).put("cancelled", cancelled);
            JSONObject terminal = envelope(ok ? "command.result" : "command.error", deviceId(), commandId, body);
            terminalCache.put(commandId, terminal);
            send(terminal);
        } catch (Exception ignored) {
        }
    }

    private JSONObject descriptor() {
        try {
            return new JSONObject()
                    .put("installationId", credentialStore.installationId())
                    .put("agentKind", config.agentKind)
                    .put("hostPlatform", config.hostPlatform)
                    .put("deviceKind", config.deviceKind)
                    .put("displayName", config.displayName)
                    .put("agentVersion", config.agentVersion);
        } catch (Exception error) {
            throw new IllegalStateException(error);
        }
    }

    private void send(JSONObject message) {
        WebSocket active = socket;
        if (active != null) active.send(message.toString());
    }

    private void failConnection(@Nullable String error) {
        if (failStartupCredentialProbe("旧凭据验证失败，已清除本机凭据，请重新配对")) return;
        listener.onConnectionState("offline", error);
        reconnectLater();
    }

    private synchronized boolean failStartupCredentialProbe(String reason) {
        if (!startupCredentialProbe || authenticated || !desired) return false;
        startupCredentialProbe = false;
        credentialStore.clear();
        setControlAllowed(false);
        desired = false;
        WebSocket active = socket;
        socket = null;
        if (active != null) active.cancel();
        listener.onConnectionState("offline", reason);
        listener.onPairingRejected(reason);
        return true;
    }

    private static JSONObject envelope(String type, @Nullable String deviceId, @Nullable String commandId, JSONObject body) {
        try {
            JSONObject value = new JSONObject()
                    .put("protocol", PROTOCOL)
                    .put("type", type)
                    .put("messageId", "msg_" + randomId())
                    .put("sentAt", Instant.now().toString())
                    .put("body", body);
            if (deviceId != null && !deviceId.isEmpty()) value.put("deviceId", deviceId);
            if (commandId != null && !commandId.isEmpty()) value.put("commandId", commandId);
            return value;
        } catch (Exception error) {
            throw new IllegalStateException(error);
        }
    }

    private static String randomId() {
        return UUID.randomUUID().toString().replace("-", "");
    }

    private static String controlUrl(String controllerUrl) {
        return websocketBase(controllerUrl) + "/agent/control";
    }

    private static String streamUrl(String controllerUrl, String streamId) {
        return websocketBase(controllerUrl) + "/agent/streams/" + streamId;
    }

    private static String websocketBase(String raw) {
        String value = raw.trim().replaceAll("/+$", "");
        if (value.startsWith("https://")) return "wss://" + value.substring(8);
        if (value.startsWith("http://")) return "ws://" + value.substring(7);
        if (value.startsWith("ws://") || value.startsWith("wss://")) return value;
        return "ws://" + value;
    }

    private void downloadReplyAudio(JSONObject audio) throws Exception {
        String streamId = audio.getString("streamId");
        String sha = audio.getString("sha256");
        int expected = audio.getInt("sizeBytes");
        if (!streamId.matches("str_[A-Za-z0-9_-]{10,80}")
                || !"audio/pcm".equals(audio.getString("mimeType"))
                || audio.getInt("sampleRateHz") != 24000 || audio.getInt("channels") != 1
                || expected < 2 || expected > 8 * 1024 * 1024 || expected % 2 != 0
                || !sha.matches("[a-f0-9]{64}")) throw new IllegalArgumentException("Invalid reply audio");
        SecureCredentialStore.Credentials credentials = credentialStore.credentials();
        if (credentials == null) return;
        final String origin = controllerUrl;
        mediaDownloads.execute(() -> {
            if (!authenticated || !controlAllowed || !origin.equals(controllerUrl)) return;
            Request request = new Request.Builder()
                    .url(origin + "/agent/streams/" + streamId + "/content")
                    .header("Authorization", "Bearer " + credentials.credential)
                    .header("X-Agent-Id", credentials.agentId)
                    .header("X-Device-Id", credentials.deviceId)
                    .build();
            try (Response response = http.newCall(request).execute()) {
                if (!response.isSuccessful() || response.body() == null
                        || !response.header("content-type", "").split(";", 2)[0].trim().equalsIgnoreCase("audio/pcm")
                        || response.body().contentLength() > expected) throw new IllegalStateException("Audio download failed");
                InputStream source = response.body().byteStream();
                ByteArrayOutputStream output = new ByteArrayOutputStream(expected);
                byte[] buffer = new byte[8192];
                int read;
                while ((read = source.read(buffer, 0,
                        Math.min(buffer.length, expected + 1 - output.size()))) != -1) {
                    if (read == 0) break;
                    output.write(buffer, 0, read);
                    if (output.size() > expected) break;
                }
                byte[] bytes = output.toByteArray();
                if (bytes.length != expected || !sha.equals(sha256(bytes))) {
                    throw new IllegalStateException("Audio reply checksum mismatch");
                }
                if (authenticated && controlAllowed && origin.equals(controllerUrl)) {
                    listener.onReplyAudio(bytes, 24000);
                }
            } catch (Exception error) {
                listener.onMediaStreamError("Reply audio unavailable: " + error.getMessage());
            }
        });
    }

    private final class StreamUploader extends WebSocketListener {
        private final PendingUpload upload;
        private final String assignedDeviceId;

        StreamUploader(PendingUpload upload, String assignedDeviceId) {
            this.upload = upload;
            this.assignedDeviceId = assignedDeviceId;
        }

        @Override public void onMessage(@NonNull WebSocket webSocket, @NonNull String text) {
            if (!controlAllowed || !uploads.containsKey(upload.streamId)) { webSocket.cancel(); return; }
            try {
                JSONObject message = new JSONObject(text);
                if ("stream.ready".equals(message.optString("type"))) {
                    byte[] bytes = upload.result.binary.bytes;
                    int sequence = 0;
                    int offset = 0;
                    while (offset < bytes.length) {
                        if (!controlAllowed) { webSocket.cancel(); return; }
                        int length = Math.min(256 * 1024, bytes.length - offset);
                        java.nio.ByteBuffer frame = java.nio.ByteBuffer.allocate(length + 4);
                        frame.putInt(sequence++).put(bytes, offset, length);
                        webSocket.send(ByteString.of(frame.array()));
                        offset += length;
                    }
                    webSocket.send(new JSONObject()
                            .put("type", "stream.end")
                            .put("totalBytes", bytes.length)
                            .put("sha256", sha256(bytes)).toString());
                } else if ("stream.complete".equals(message.optString("type"))) {
                    uploads.remove(upload.streamId);
                    uploadSockets.remove(upload.streamId, webSocket);
                    JSONObject result = new JSONObject(upload.result.body.toString()).put("stream", new JSONObject()
                            .put("streamId", upload.streamId)
                            .put("purpose", upload.result.binary.purpose)
                            .put("contentType", upload.result.binary.contentType)
                            .put("sizeBytes", upload.result.binary.bytes.length)
                            .put("sha256", message.optString("sha256")));
                    sendTerminal(upload.commandId, true, result, null, false);
                    webSocket.close(1000, "Upload complete");
                }
            } catch (Exception error) {
                uploads.remove(upload.streamId);
                uploadSockets.remove(upload.streamId, webSocket);
                sendTerminal(upload.commandId, false, null, error.getMessage(), false);
                webSocket.cancel();
            }
        }

        @Override public void onFailure(@NonNull WebSocket webSocket, @NonNull Throwable error, @Nullable Response response) {
            uploadSockets.remove(upload.streamId, webSocket);
            if (uploads.remove(upload.streamId) != null) {
                sendTerminal(upload.commandId, false, null, "Stream upload failed: " + error.getMessage(), false);
            }
        }
    }

    private final class LiveStreamUploader extends WebSocketListener {
        private static final long ROTATE_BYTES = 120L * 1024 * 1024;
        private static final long MAX_QUEUE_BYTES = 8L * 1024 * 1024;
        private final SecureCredentialStore.Credentials credentials;
        private final String contentType;
        private final String purpose;
        private final String streamId = "str_" + randomId();
        private final ArrayDeque<LiveFrame> queue = new ArrayDeque<>();
        private boolean timed;
        private MessageDigest digest;
        private WebSocket webSocket;
        private boolean ready;
        private boolean closed;
        private long queuedBytes;
        private long sentBytes;
        private int sequence;

        LiveStreamUploader(SecureCredentialStore.Credentials credentials, String contentType, String purpose) {
            this.credentials = credentials;
            this.contentType = contentType;
            this.purpose = purpose;
            try {
                digest = MessageDigest.getInstance("SHA-256");
            } catch (Exception error) {
                throw new IllegalStateException(error);
            }
        }

        synchronized void enqueue(byte[] bytes, @Nullable Double sourceTimeS) {
            if (closed || queuedBytes + bytes.length > MAX_QUEUE_BYTES) return;
            queue.addLast(new LiveFrame(bytes.clone(), sourceTimeS));
            queuedBytes += bytes.length;
            flush();
        }

        @Override public synchronized void onOpen(@NonNull WebSocket socket, @NonNull Response response) {
            webSocket = socket;
            try {
                JSONObject offer = new JSONObject()
                        .put("streamId", streamId)
                        .put("purpose", purpose)
                        .put("direction", "agent-to-controller")
                        .put("contentType", contentType)
                        .put("maxFrameBytes", 2 * 1024 * 1024)
                        .put("maxTotalBytes", 128 * 1024 * 1024)
                        .put("metadata", "audio/pcm".equals(contentType)
                                ? new JSONObject().put("sampleRateHz", 16000).put("channels", 1)
                                        .put("sampleFormat", "s16le").put("transient", true)
                                : "image/jpeg".equals(contentType)
                                ? new JSONObject().put("observationFraming", "image-per-message.v1")
                                        .put("frameTiming", "source-time.v1").put("transient", true)
                                : new JSONObject().put("codec", "h264-annexb").put("frameTiming", "source-time.v1"));
                socket.send(envelope("stream.offer", credentials.deviceId, null, offer).toString());
            } catch (Exception error) {
                fail(socket, error.getMessage());
            }
        }

        @Override public synchronized void onMessage(@NonNull WebSocket socket, @NonNull String text) {
            try {
                JSONObject message = new JSONObject(text);
                if ("stream.ready".equals(message.optString("type"))) {
                    timed = "source-time.v1".equals(message.optString("frameTiming"));
                    ready = true;
                    flush();
                } else if ("stream.complete".equals(message.optString("type"))) {
                    closed = true;
                    clearLiveSlot();
                    socket.close(1000, "Screen stream rotated");
                }
            } catch (Exception error) {
                fail(socket, error.getMessage());
            }
        }

        private void flush() {
            if (!ready || closed || webSocket == null) return;
            while (!queue.isEmpty()) {
                LiveFrame item = queue.removeFirst();
                byte[] bytes = item.bytes;
                queuedBytes -= bytes.length;
                if (sentBytes + bytes.length > ROTATE_BYTES) {
                    finish();
                    return;
                }
                java.nio.ByteBuffer frame = java.nio.ByteBuffer.allocate(bytes.length + 4);
                if (timed) {
                    try {
                        if (!webSocket.send(new JSONObject().put("type", "stream.frame").put("sequence", sequence)
                                .put("sourceTimeS", item.sourceTimeS == null ? JSONObject.NULL : item.sourceTimeS)
                                .put("capturedAtS", JSONObject.NULL).toString())) {
                            fail(webSocket, "Timing queue rejected"); return;
                        }
                    } catch (Exception error) { fail(webSocket, "Invalid timing"); return; }
                }
                frame.putInt(sequence++).put(bytes);
                if (!webSocket.send(ByteString.of(frame.array()))) {
                    fail(webSocket, "Screen stream send queue rejected a frame");
                    return;
                }
                digest.update(bytes);
                sentBytes += bytes.length;
            }
        }

        private void finish() {
            if (closed || webSocket == null) return;
            closed = true;
            try {
                webSocket.send(new JSONObject()
                        .put("type", "stream.end")
                        .put("totalBytes", sentBytes)
                        .put("sha256", hex(digest.digest()))
                        .toString());
            } catch (Exception error) {
                fail(webSocket, error.getMessage());
            }
        }

        synchronized void close() {
            if (!closed && ready) finish();
            else if (webSocket != null) webSocket.close(1000, "Device connection stopped");
            closed = true;
        }

        @Override public synchronized void onClosed(@NonNull WebSocket socket, int code, @NonNull String reason) {
            boolean unexpected = !closed;
            closed = true;
            queue.clear();
            queuedBytes = 0;
            clearLiveSlot();
            if (unexpected) listener.onMediaStreamError("Live media stream closed: " + code);
        }

        @Override public synchronized void onFailure(@NonNull WebSocket socket, @NonNull Throwable error, @Nullable Response response) {
            fail(socket, error.getMessage());
        }

        private void fail(WebSocket socket, String error) {
            closed = true;
            queue.clear();
            queuedBytes = 0;
            clearLiveSlot();
            socket.cancel();
            listener.onMediaStreamError("Live media stream failed: " + error);
        }

        private void clearLiveSlot() {
            if (liveVisualStream == this) liveVisualStream = null;
            if (liveAudioStream == this) liveAudioStream = null;
        }
    }

    private static final class LiveFrame {
        final byte[] bytes;
        final Double sourceTimeS;
        LiveFrame(byte[] bytes, Double sourceTimeS) { this.bytes = bytes; this.sourceTimeS = sourceTimeS; }
    }

    private static String sha256(byte[] bytes) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
        StringBuilder value = new StringBuilder();
        for (byte item : digest) value.append(String.format(java.util.Locale.US, "%02x", item));
        return value.toString();
    }

    private static String hex(byte[] bytes) {
        StringBuilder value = new StringBuilder();
        for (byte item : bytes) value.append(String.format(java.util.Locale.US, "%02x", item));
        return value.toString();
    }

    private static final class PendingUpload {
        final String streamId;
        final String commandId;
        final DriverResult result;

        PendingUpload(String streamId, String commandId, DriverResult result) {
            this.streamId = streamId;
            this.commandId = commandId;
            this.result = result;
        }
    }
}
