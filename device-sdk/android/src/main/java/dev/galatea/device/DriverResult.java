package dev.galatea.device;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import org.json.JSONObject;

public final class DriverResult {
    public final JSONObject body;
    @Nullable public final BinaryPayload binary;

    public DriverResult(@NonNull JSONObject body) {
        this(body, null);
    }

    public DriverResult(@NonNull JSONObject body, @Nullable BinaryPayload binary) {
        this.body = body;
        this.binary = binary;
    }
}
