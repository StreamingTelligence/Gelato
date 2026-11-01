package dev.galatea.device;

import androidx.annotation.NonNull;

import org.json.JSONObject;

import java.util.List;
import java.util.concurrent.CompletableFuture;

public interface DeviceAgentDriver extends AutoCloseable {
    @NonNull JSONObject snapshot() throws Exception;
    @NonNull List<CapabilityDescriptor> capabilities();
    @NonNull CompletableFuture<DriverResult> execute(
            @NonNull CommandContext context,
            @NonNull String capability,
            int version,
            @NonNull JSONObject arguments
    );
    boolean cancel(@NonNull String commandId);
    void setEventSink(@NonNull DriverEventSink sink);
    @Override void close();
}
