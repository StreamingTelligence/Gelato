package dev.galatea.device;

import androidx.annotation.NonNull;

public final class CommandContext {
    public final String commandId;
    public final long deadlineEpochMs;
    public final String idempotency;

    public CommandContext(@NonNull String commandId, long deadlineEpochMs, @NonNull String idempotency) {
        this.commandId = commandId;
        this.deadlineEpochMs = deadlineEpochMs;
        this.idempotency = idempotency;
    }

    public void requireActive() {
        if (Thread.currentThread().isInterrupted()) throw new IllegalStateException("Command cancelled");
        if (System.currentTimeMillis() >= deadlineEpochMs) throw new IllegalStateException("Command deadline exceeded");
    }
}
