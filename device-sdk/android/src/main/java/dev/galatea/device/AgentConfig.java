package dev.galatea.device;

import androidx.annotation.NonNull;

public final class AgentConfig {
    public final String agentKind;
    public final String hostPlatform;
    public final String deviceKind;
    public final String displayName;
    public final String agentVersion;

    public AgentConfig(
            @NonNull String agentKind,
            @NonNull String hostPlatform,
            @NonNull String deviceKind,
            @NonNull String displayName,
            @NonNull String agentVersion
    ) {
        this.agentKind = agentKind;
        this.hostPlatform = hostPlatform;
        this.deviceKind = deviceKind;
        this.displayName = displayName;
        this.agentVersion = agentVersion;
    }
}
