package dev.galatea.device;

import androidx.annotation.NonNull;

import org.json.JSONObject;

public interface DriverEventSink {
    void stateChanged();
    void publish(@NonNull String eventType, @NonNull JSONObject body, boolean critical);
}
