package dev.galatea.deviceapp;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.Settings;
import com.getcapacitor.BridgeActivity;
import dev.galatea.device.DeviceAgentClient;
import org.json.JSONArray;
import org.json.JSONObject;
import java.net.URI;
import java.util.Locale;

/** Only system interactions vary by device. Web assets and the account bridge are shared. */
public abstract class DeviceAppActivity extends BridgeActivity {
    public abstract DeviceAgentClient protocolClient();
    public abstract String savedControllerUrl();
    public abstract String agentKind();
    public abstract JSONObject deviceSnapshot() throws Exception;
    public abstract void connectController(String url, String code) throws Exception;
    public abstract void deviceAction(String action) throws Exception;
    public void pauseDevice() throws Exception {}

    @Override public void onCreate(Bundle state) {
        registerPlugin(DeviceAppPlugin.class);
        super.onCreate(state);
        getWindow().setNavigationBarColor(0xfff5f6fa);
    }

    public final String controllerUrl() {
        return getSharedPreferences("device_app", MODE_PRIVATE).getString("controller_url", savedControllerUrl());
    }

    public final void configure(String raw) throws Exception {
        configure(raw, false);
    }

    public final void configure(String raw, boolean confirmedMigration) throws Exception {
        String normalized = normalizeUrl(raw);
        DeviceAgentClient client = protocolClient();
        if (client != null && client.hasCredential() && !normalizeUrl(savedControllerUrl()).equals(normalized) && !confirmedMigration) {
            throw new IllegalStateException("本机已配对，不能直接更换控制服务地址");
        }
        getSharedPreferences("device_app", MODE_PRIVATE).edit().putString("controller_url", normalized)
                .remove("link_error").remove("pending_controller_url").commit();
    }

    public static String normalizeUrl(String raw) throws Exception {
        URI uri = new URI(raw.trim());
        if (!"https".equals(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null ||
                uri.getQuery() != null || uri.getFragment() != null ||
                !(uri.getPath() == null || uri.getPath().isEmpty() || uri.getPath().equals("/"))) {
            throw new IllegalArgumentException("请输入完整的 HTTPS 控制服务地址，不含路径或登录信息");
        }
        return "https://" + uri.getHost().toLowerCase(Locale.ROOT) + (uri.getPort() == -1 || uri.getPort() == 443 ? "" : ":" + uri.getPort());
    }

    public final void applyPairingIntent(Intent intent) {
        if (intent == null) return;
        Uri uri = intent.getData();
        if (uri != null && (!"gelato".equals(uri.getScheme()) || !"pair".equals(uri.getHost()))) return;
        try {
            if (uri != null && uri.getQueryParameter("protocol") != null
                    && !"gelato.v1".equals(uri.getQueryParameter("protocol"))) {
                throw new IllegalArgumentException("不支持的 Gelato 协议版本");
            }
            String kind = uri == null ? intent.getStringExtra("agentKind") : uri.getQueryParameter("agentKind");
            if (kind != null && !kind.equals(agentKind())) return;
            String url = intent.getStringExtra("controllerUrl");
            String code = intent.getStringExtra("pairingCode");
            if (uri != null) {
                if (uri.getQueryParameter("controllerUrl") != null) url = uri.getQueryParameter("controllerUrl");
                if (uri.getQueryParameter("pairingCode") != null) code = uri.getQueryParameter("pairingCode");
            }
            if (url == null || url.isBlank()) return;
            if (protocolClient() != null && protocolClient().hasCredential() &&
                    !normalizeUrl(savedControllerUrl()).equals(normalizeUrl(url))) {
                getSharedPreferences("device_app", MODE_PRIVATE).edit().putString("pending_controller_url", normalizeUrl(url)).commit();
                return;
            }
            configure(url);
            String guestJoin = uri == null ? null : uri.getQueryParameter("guestJoin");
            if (guestJoin != null && guestJoin.matches("[A-Za-z0-9_-]{32}")) {
                getSharedPreferences("device_app", MODE_PRIVATE).edit().putString("pending_guest_code", guestJoin)
                        .putString("pending_guest_origin", controllerUrl()).commit();
            }
            // Keep a short-lived one-use code until the user finishes local preflight
            // and explicitly starts pairing in the device app.
            if (code != null && !code.isBlank()) {
                if (!code.matches("[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}")) {
                    throw new IllegalArgumentException("配对码格式无效");
                }
                if (protocolClient() == null || !protocolClient().hasCredential()) {
                    getSharedPreferences("device_app", MODE_PRIVATE).edit()
                            .putString("pending_pairing_code", code)
                            .putLong("pending_pairing_at", System.currentTimeMillis()).commit();
                } else {
                    getSharedPreferences("device_app", MODE_PRIVATE).edit()
                            .remove("pending_pairing_code").remove("pending_pairing_at").apply();
                }
            }
        } catch (Exception error) {
            getSharedPreferences("device_app", MODE_PRIVATE).edit().putString("link_error", error.getMessage()).apply();
        }
    }

    public final void commonAction(String action) throws Exception {
        switch (action) {
            case "notifications":
                if (Build.VERSION.SDK_INT >= 33 && !notificationsAllowed()) {
                    requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 7202);
                } else openAppSettings();
                break;
            case "background":
                if (!batteryExempt()) startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                        Uri.parse("package:" + getPackageName())));
                else openAppSettings();
                break;
            case "settings": openAppSettings(); break;
            default: deviceAction(action);
        }
    }

    public final boolean notificationsAllowed() {
        return androidx.core.app.NotificationManagerCompat.from(this).areNotificationsEnabled();
    }
    public final boolean batteryExempt() {
        return getSystemService(PowerManager.class).isIgnoringBatteryOptimizations(getPackageName());
    }
    public final void openAppSettings() {
        startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName())));
    }
    public final JSONArray commonSteps(JSONArray deviceSteps) throws Exception {
        JSONArray result = new JSONArray().put(beforePairing(step("notifications", "让配对提示及时送达", "允许通知后，可在系统设置页面直接输入配对码，无需来回切换。", notificationsAllowed(), "notifications", "允许通知"), false));
        for (int index = 0; index < deviceSteps.length(); index++) result.put(deviceSteps.get(index));
        result.put(step("battery", "离开应用后，连接也能继续", "允许后台运行。系统若询问电池优化，请选择允许。", batteryExempt(), "background", "允许后台运行"));
        String vendor = Build.MANUFACTURER.toLowerCase(Locale.ROOT);
        boolean colorOs = vendor.contains("oneplus") || vendor.contains("oppo") || vendor.contains("realme");
        result.put(step("background", "最后检查一下后台设置", colorOs
                ? "在“我的 → 系统权限与后台运行”打开应用详情，进入耗电管理，选择“完全允许后台行为”。\n系统未提供可靠的读取接口，此项保持未验证，不会阻止流程。"
                : "在“我的 → 系统权限与后台运行”中确认允许应用不受限制地后台运行。系统无法可靠读取此设置，不会阻止流程。",
                false, "settings", "打开应用设置")
                .put("check", new JSONObject().put("state", "unknown").put("basis", "none")));
        return result;
    }
    public static JSONObject step(String id, String title, String detail, boolean done, String action, String button) throws Exception {
        return step(id, title, detail, done, "system", action, button);
    }
    public static JSONObject step(String id, String title, String detail, boolean done, String basis, String action, String button) throws Exception {
        return new JSONObject().put("id", id).put("title", title).put("detail", detail).put("done", done)
                .put("check", new JSONObject().put("state", done ? "passed" : "failed").put("basis", basis))
                .put("phase", "before-control").put("required", true)
                .put("action", action).put("button", button);
    }
    public static JSONObject unknown(JSONObject step) throws Exception {
        return step.put("done", false)
                .put("check", new JSONObject().put("state", "unknown").put("basis", "none"));
    }
    public static JSONObject checkedStep(String id, String title, String detail, Boolean observed,
                                         String basis, String action, String button) throws Exception {
        JSONObject result = step(id, title, detail, Boolean.TRUE.equals(observed), basis, action, button);
        return observed == null ? unknown(result) : result;
    }
    public static JSONObject beforePairing(JSONObject step, boolean required) throws Exception {
        return step.put("phase", "before-pairing").put("required", required);
    }
    public final void requirePrePairingReady() throws Exception {
        JSONArray steps = deviceSnapshot().optJSONArray("steps");
        if (steps == null) throw new IllegalStateException("无法读取本机配对准备状态");
        for (int index = 0; index < steps.length(); index++) {
            JSONObject step = steps.getJSONObject(index);
            if ("before-pairing".equals(step.optString("phase")) && step.optBoolean("required")
                    && "failed".equals(step.optJSONObject("check") == null ? "unknown" : step.getJSONObject("check").optString("state"))) {
                throw new IllegalStateException("请先完成配对前准备：" + step.optString("title"));
            }
        }
    }
}
