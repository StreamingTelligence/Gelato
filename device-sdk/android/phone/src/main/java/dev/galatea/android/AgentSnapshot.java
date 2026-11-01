package dev.galatea.android;

final class AgentSnapshot {
    final String deviceId;
    final String displayName;
    final String controllerUrl;
    final String appState;
    final String engineState;
    final String screenState;
    final String userActionCode;
    final boolean appOnline;
    final boolean engineReady;
    final boolean screenActive;
    final int screenWidth;
    final int screenHeight;
    final long lastHeartbeatAt;
    final String lastError;

    AgentSnapshot(
            String deviceId,
            String displayName,
            String controllerUrl,
            String appState,
            String engineState,
            String screenState,
            String userActionCode,
            boolean appOnline,
            boolean engineReady,
            boolean screenActive,
            int screenWidth,
            int screenHeight,
            long lastHeartbeatAt,
            String lastError
    ) {
        this.deviceId = deviceId;
        this.displayName = displayName;
        this.controllerUrl = controllerUrl;
        this.appState = appState;
        this.engineState = engineState;
        this.screenState = screenState;
        this.userActionCode = userActionCode;
        this.appOnline = appOnline;
        this.engineReady = engineReady;
        this.screenActive = screenActive;
        this.screenWidth = screenWidth;
        this.screenHeight = screenHeight;
        this.lastHeartbeatAt = lastHeartbeatAt;
        this.lastError = lastError;
    }

}
