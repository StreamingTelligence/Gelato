package dev.galatea.device;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import org.json.JSONException;
import org.json.JSONObject;

public final class CapabilityDescriptor {
    public final String name;
    public final int version;
    @Nullable public final JSONObject limits;
    @Nullable public final String consent;

    public CapabilityDescriptor(@NonNull String name, int version) {
        this(name, version, null, null);
    }

    public CapabilityDescriptor(
            @NonNull String name,
            int version,
            @Nullable JSONObject limits,
            @Nullable String consent
    ) {
        if (!name.matches("^[a-z][a-z0-9-]*(\\.[a-z][a-z0-9-]*)+$")) {
            throw new IllegalArgumentException("Invalid capability name: " + name);
        }
        if (version < 1) throw new IllegalArgumentException("Capability version must be positive");
        this.name = name;
        this.version = version;
        this.limits = limits;
        this.consent = consent;
    }

    public JSONObject toJson() throws JSONException {
        JSONObject value = new JSONObject().put("name", name).put("version", version);
        if (limits != null) value.put("limits", limits);
        if (consent != null && !consent.isEmpty()) value.put("consent", consent);
        return value;
    }
}
