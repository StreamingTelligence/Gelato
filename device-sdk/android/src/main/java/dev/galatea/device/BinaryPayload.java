package dev.galatea.device;

import androidx.annotation.NonNull;

public final class BinaryPayload {
    public final String purpose;
    public final String contentType;
    public final byte[] bytes;

    public BinaryPayload(@NonNull String purpose, @NonNull String contentType, @NonNull byte[] bytes) {
        this.purpose = purpose;
        this.contentType = contentType;
        this.bytes = bytes;
    }
}
