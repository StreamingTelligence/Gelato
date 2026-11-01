package dev.galatea.android;

import android.content.Intent;
import android.media.projection.MediaProjectionManager;
import android.os.Bundle;
import android.provider.Settings;
import android.view.View;
import android.view.WindowInsets;
import dev.galatea.deviceapp.DeviceAppActivity;
import dev.galatea.device.DeviceAgentClient;
import org.json.JSONArray;
import org.json.JSONObject;

/** Android-specific onboarding and lifecycle; presentation lives in examples/device/shared-ui. */
public final class MainActivity extends DeviceAppActivity {
    private AgentRuntime runtime;
    @Override public void onCreate(Bundle state) {
        AgentRuntime.init(this);
        runtime = AgentRuntime.get();
        super.onCreate(state);
        applyPairingIntent(getIntent());
        if (runtime.canResumeSavedConfiguration()) startForegroundService(AgentForegroundService.restoreIntent(this));
    }
    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent); setIntent(intent); applyPairingIntent(intent);
    }
    @Override public DeviceAgentClient protocolClient() { return runtime.protocolClient(); }
    @Override public String savedControllerUrl() { return runtime.getControllerUrl(); }
    @Override public String agentKind() { return "android-phone"; }
    @Override public void connectController(String url, String code) {
        startForegroundService(AgentForegroundService.startIntent(this, url, runtime.getDisplayName(), code));
    }
    @Override public void pauseDevice() {
        runtime.pauseRemoteWork();
        // Do not create a media-projection FGS just to stop it: Android 14+
        // rejects that without a fresh screen-capture consent token.
        stopService(new Intent(this, MediaProjectionService.class));
    }
    @Override public JSONObject deviceSnapshot() throws Exception {
        AgentSnapshot value = runtime.snapshot();
        boolean developer = Settings.Global.getInt(getContentResolver(), Settings.Global.DEVELOPMENT_SETTINGS_ENABLED, 0) != 0;
        JSONArray steps = new JSONArray()
                .put(beforePairing(step("developer", "开启开发者选项", "打开“关于本机 → 版本信息”，连续点击版本号，按系统提示开启开发者选项。已开启的设备会自动跳过。", developer, "developer", "打开关于本机"), true))
                .put(step("adb", "完成一次系统配对", "在开发者选项中开启“无线调试”，点“使用配对码配对设备”。\n保持六位码弹窗打开，下拉通知栏，在设备助手通知中输入该码；不需要填写端口。", runtime.isAdbReady(), "probe", "wireless", "打开无线调试"));
        return new JSONObject().put("platform", "android").put("displayName", value.displayName)
                .put("deviceId", protocolClient().deviceId()).put("paired", protocolClient().hasCredential())
                .put("online", value.appOnline).put("ready", value.engineReady)
                .put("controlAllowed", protocolClient().isControlAllowed()).put("steps", commonSteps(steps))
                .put("topInsetDp", webContentTopInsetDp())
                .put("screenSharing", value.screenActive)
                .put("error", value.lastError == null ? "" : value.lastError).put("version", DeviceAgentClient.applicationVersion(this));
    }
    private int webContentTopInsetDp() {
        View webView = getBridge() == null ? null : getBridge().getWebView();
        WindowInsets insets = getWindow().getDecorView().getRootWindowInsets();
        if (webView == null || insets == null) return 0;
        int[] location = new int[2];
        webView.getLocationOnScreen(location);
        int statusBarBottom = insets.getInsets(WindowInsets.Type.statusBars()).top;
        return Math.round(Math.max(0, statusBarBottom - location[1])
                / getResources().getDisplayMetrics().density);
    }
    @Override public void deviceAction(String action) {
        switch (action) {
            case "developer": startActivity(new Intent(Settings.ACTION_DEVICE_INFO_SETTINGS)); break;
            case "wireless":
                // Keep the tested notification entry path so the system pairing dialog stays alive.
                startForegroundService(AgentForegroundService.restoreIntent(this));
                Intent direct = new Intent("android.settings.WIRELESS_DEBUGGING_SETTINGS");
                if (direct.resolveActivity(getPackageManager()) != null) startActivity(direct);
                else startActivity(new Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS));
                break;
            case "reconnect": startForegroundService(AgentForegroundService.restoreIntent(this)); break;
            case "screen-start":
                if (!protocolClient().isControlAllowed()) throw new IllegalStateException("请先开启允许接入控制");
                startActivityForResult(getSystemService(MediaProjectionManager.class).createScreenCaptureIntent(), 7301);
                break;
            case "screen-stop": stopService(new Intent(this, MediaProjectionService.class)); break;
            default: throw new IllegalArgumentException("不支持的系统操作");
        }
    }
    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == 7301 && resultCode == RESULT_OK && data != null && protocolClient().isControlAllowed()) {
            startForegroundService(MediaProjectionService.startIntent(this, resultCode, data));
        }
    }
}
