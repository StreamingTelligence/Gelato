package dev.galatea.deviceapp;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import dev.galatea.device.DeviceAgentClient;
import org.json.JSONObject;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import java.util.concurrent.Callable;
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;

@CapacitorPlugin(name = "DeviceApp")
public final class DeviceAppPlugin extends Plugin {
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final OkHttpClient http = new OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
            .callTimeout(18, TimeUnit.SECONDS).build();
    private AccountVault vault;
    @Override public void load() { vault = new AccountVault(getContext()); }
    @Override protected void handleOnDestroy() { worker.shutdownNow(); http.dispatcher().cancelAll(); }
    private DeviceAppActivity host() { return (DeviceAppActivity) getActivity(); }
    private DeviceAgentClient client() {
        DeviceAgentClient client = host().protocolClient();
        if (client == null) throw new IllegalStateException("设备服务正在启动，请稍后重试");
        return client;
    }
    @PluginMethod public void request(PluginCall call) {
        worker.execute(() -> {
            try { call.resolve(new JSObject(dispatch(call).toString())); }
            catch (Exception error) {
                Throwable cause = error.getCause() == null ? error : error.getCause();
                call.reject(cause.getMessage() == null ? "操作未完成，请重试" : cause.getMessage());
            }
        });
    }
    private JSONObject dispatch(PluginCall call) throws Exception {
        String operation = call.getString("operation", "");
        if (operation.equals("configure")) {
            String old = host().controllerUrl();
            boolean confirmed = "on".equals(call.getString("confirmMigration", ""));
            String target = DeviceAppActivity.normalizeUrl(call.getString("controllerUrl", ""));
            boolean changing = !old.equals(target);
            if (changing && client().hasCredential() && !confirmed) throw new IllegalStateException("请先确认你信任新的控制服务地址");
            if (changing && (client().hasCredential() || client().isControlAllowed())) {
                client().setControlAllowed(false);
                onMain(() -> { host().pauseDevice(); return null; });
            }
            host().configure(target, confirmed);
            if (changing) {
                vault.clear();
            }
            // Retry the native connection even if the UI URL was saved just
            // before a process death. Configuration and driver persistence may
            // otherwise disagree after an interrupted migration.
            if (client().hasCredential()) onMain(() -> { host().connectController(target, ""); return null; });
            return new JSONObject();
        }
        if (operation.equals("guest")) {
            if (session().has("user")) throw new IllegalStateException("请先退出当前账号，再确认访客连接");
            android.content.SharedPreferences pending = host().getSharedPreferences("device_app", 0);
            String code = pending.getString("pending_guest_code", "");
            if (!host().controllerUrl().equals(pending.getString("pending_guest_origin", "")) || !code.matches("[A-Za-z0-9_-]{32}"))
                throw new IllegalStateException("请从控制端重新打开匿名试用连接链接");
            JSONObject value = api("/guest/join", new JSONObject().put("code", code), false);
            client().setControlAllowed(false); onMain(() -> { host().pauseDevice(); return null; });
            value.put("origin", host().controllerUrl()); vault.save(value);
            pending.edit().remove("pending_guest_code").remove("pending_guest_origin").remove("link_error").commit();
            return new JSONObject();
        }
        if (operation.equals("login") || operation.equals("register")) {
            JSONObject input = new JSONObject().put("username", call.getString("username", ""))
                    .put("password", call.getString("password", "")).put("displayName", call.getString("displayName", ""));
            JSONObject session = api("/" + operation, input, false);
            session.put("origin", host().controllerUrl());
            client().setControlAllowed(false);
            onMain(() -> { host().pauseDevice(); return null; });
            vault.save(session);
            return new JSONObject(); // Passwords and tokens never return to the WebView.
        }
        if (operation.equals("logout")) {
            client().setControlAllowed(false);
            onMain(() -> { host().pauseDevice(); return null; });
            vault.clear(); return new JSONObject();
        }
        if (operation.equals("snapshot")) {
            JSONObject result = onMain(() -> host().deviceSnapshot());
            DeviceAgentClient current = host().protocolClient();
            long pendingAt = host().getSharedPreferences("device_app", 0).getLong("pending_pairing_at", 0);
            result.put("pendingPairing", (current == null || !current.hasCredential())
                    && pendingAt > 0 && System.currentTimeMillis() >= pendingAt
                    && System.currentTimeMillis() - pendingAt < 30 * 60_000L
                    && !host().getSharedPreferences("device_app", 0).getString("pending_pairing_code", "").isEmpty());
            result.put("pendingPairingExpired", (current == null || !current.hasCredential())
                    && pendingAt > 0 && System.currentTimeMillis() - pendingAt >= 30 * 60_000L);
            result.put("controllerUrl", host().controllerUrl());
            result.put("lastReply", current == null ? "" : current.lastReply());
            result.put("pendingControllerUrl", host().getSharedPreferences("device_app", 0).getString("pending_controller_url", ""));
            String linkError = host().getSharedPreferences("device_app", 0).getString("link_error", "");
            if (!linkError.isEmpty()) result.put("error", linkError);
            return result;
        }
        if (operation.equals("devices")) return api("/devices", null, true);
        if (operation.equals("message")) {
            String text = call.getString("text", "").trim();
            if (text.isEmpty() || text.length() > 16384) throw new IllegalArgumentException("请输入不超过 16384 字的内容");
            String messageId = client().publishInput("instruction", new org.json.JSONArray()
                    .put(new JSONObject().put("type", "text").put("text", text)));
            return new JSONObject().put("messageId", messageId);
        }
        if (operation.equals("stagePairingCode")) {
            if (client().hasCredential()) throw new IllegalStateException("本机已有配对凭据");
            DeviceAppActivity.normalizeUrl(host().controllerUrl());
            String code = call.getString("code", "").trim().toUpperCase(java.util.Locale.ROOT);
            if (!code.matches("[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}"))
                throw new IllegalArgumentException("请输入控制端生成的 8 位一次性配对码");
            host().getSharedPreferences("device_app", 0).edit()
                    .putString("pending_pairing_code", code)
                    .putLong("pending_pairing_at", System.currentTimeMillis()).commit();
            return new JSONObject();
        }
        if (operation.equals("pair")) {
            if (client().hasCredential()) return new JSONObject();
            host().requirePrePairingReady();
            android.content.SharedPreferences preferences = host().getSharedPreferences("device_app", 0);
            String code = preferences.getString("pending_pairing_code", "");
            long created = preferences.getLong("pending_pairing_at", 0);
            if (code.isEmpty() || created <= 0 || System.currentTimeMillis() - created >= 30 * 60_000L) {
                preferences.edit().remove("pending_pairing_code").remove("pending_pairing_at").apply();
                throw new IllegalStateException("配对链接已过期，请从控制端重新打开");
            }
            onMain(() -> { host().connectController(host().controllerUrl(), code); return null; });
            long end = System.currentTimeMillis() + 15_000;
            while (!client().hasCredential() && System.currentTimeMillis() < end) Thread.sleep(150);
            if (!client().hasCredential()) throw new IllegalStateException("配对仍在连接中，请检查网络后重试");
            preferences.edit().remove("pending_pairing_code").remove("pending_pairing_at").apply();
            return new JSONObject();
        }
        if (operation.equals("enroll")) {
            api("/me", null, true);
            if (!client().hasCredential()) {
                host().requirePrePairingReady();
                JSONObject pending = api("/enroll", new JSONObject().put("controllerUrl", host().controllerUrl())
                        .put("agentKind", host().agentKind()).put("displayName", host().deviceSnapshot().optString("displayName")), true);
                onMain(() -> { host().connectController(host().controllerUrl(), pending.getJSONObject("session").getString("code")); return null; });
                long end = System.currentTimeMillis() + 15_000;
                while (!client().hasCredential() && System.currentTimeMillis() < end) Thread.sleep(150);
                if (!client().hasCredential()) throw new IllegalStateException("配对仍在连接中，请检查网络后重试");
            }
            host().getSharedPreferences("device_app", 0).edit()
                    .remove("pending_pairing_code").remove("pending_pairing_at").apply();
            api("/claim", client().accountOwnershipProof(), true);
            JSONObject session = session(); session.put("linkedDeviceId", client().deviceId()); vault.save(session);
            return new JSONObject();
        }
        if (operation.equals("access")) {
            boolean allowed = Boolean.TRUE.equals(call.getBoolean("allowed", false));
            if (allowed) {
                if (!client().hasCredential() || !host().deviceSnapshot().optBoolean("online"))
                    throw new IllegalStateException("请先完成控制端配对并等待本次连接验证");
            }
            client().setControlAllowed(allowed);
            if (!allowed) onMain(() -> { host().pauseDevice(); return null; });
            return new JSONObject();
        }
        if (operation.equals("action")) {
            onMain(() -> { host().commonAction(call.getString("action", "")); return null; });
            return new JSONObject();
        }
        throw new IllegalArgumentException("不支持的操作");
    }
    private JSONObject session() throws Exception {
        JSONObject value;
        try { value = vault.read(); }
        catch (Exception unreadable) {
            // A lost/invalid Keystore entry must not strand the whole UI.
            // Remove only the account session; device pairing is independent.
            vault.clear(); value = new JSONObject();
        }
        boolean valid = value.optString("origin").equals(host().controllerUrl()) && value.has("user") && !value.optString("token").isEmpty();
        String expires = value.optString("expiresAt");
        try { valid = valid && !expires.isEmpty() && java.time.Instant.parse(expires).toEpochMilli() > System.currentTimeMillis(); }
        catch (Exception malformed) { valid = false; }
        if (!valid) {
            if (value.optJSONObject("user") != null && "guest".equals(value.optJSONObject("user").optString("mode"))) {
                host().getSharedPreferences("device_app", 0).edit().putString("link_error", "20 分钟匿名试用已结束，请注册或登录后继续").apply();
            }
            vault.clear(); return new JSONObject();
        }
        return value;
    }
    private JSONObject api(String path, JSONObject body, boolean authenticated) throws Exception {
        String origin = DeviceAppActivity.normalizeUrl(host().controllerUrl());
        Request.Builder request = new Request.Builder().url(origin + "/account" + path).header("Accept", "application/json");
        if (authenticated) {
            String token = session().optString("token");
            if (token.isEmpty()) throw new IllegalStateException("请先登录账号");
            request.header("Authorization", "Token " + token);
        }
        if (body != null) request.post(RequestBody.create(body.toString(), MediaType.get("application/json")));
        try (Response response = http.newCall(request.build()).execute()) {
            if (response.body() == null) throw new IllegalStateException("控制服务未返回数据");
            // Bound the stream before allocating the full response, including
            // chunked responses without Content-Length.
            if (response.body().source().request(1024 * 1024 + 1L)) throw new IllegalStateException("控制服务响应过大");
            String text = response.body().source().readUtf8();
            JSONObject result;
            try { result = new JSONObject(text); } catch (Exception invalid) { throw new IllegalStateException("控制服务暂时无法访问，请稍后重试"); }
            if (!response.isSuccessful()) {
                if (response.code() == 401 && authenticated) {
                    vault.clear();
                }
                throw new IllegalStateException(result.optString("error", "账号服务暂时不可用"));
            }
            return result;
        }
    }
    private <T> T onMain(Callable<T> action) throws Exception {
        FutureTask<T> task = new FutureTask<>(action); getActivity().runOnUiThread(task); return task.get(10, TimeUnit.SECONDS);
    }
}
