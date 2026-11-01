package dev.galatea.android;

import java.io.IOException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/** A command can close only its own stream, including cancellation racing stream attachment. */
final class RemoteCommandCancellation {
    private final AtomicBoolean cancelled = new AtomicBoolean();
    private final AtomicReference<AutoCloseable> stream = new AtomicReference<>();

    void requireActive() throws IOException {
        if (cancelled.get()) throw new IOException("Remote command was cancelled");
    }
    void attach(AutoCloseable value) throws IOException {
        requireActive();
        if (!stream.compareAndSet(null, value)) throw new IOException("Remote command already has an active stream");
        if (cancelled.get()) { close(stream.getAndSet(null)); requireActive(); }
    }
    void detach(AutoCloseable value) { stream.compareAndSet(value, null); }
    void cancel() { cancelled.set(true); close(stream.getAndSet(null)); }
    private static void close(AutoCloseable value) {
        if (value != null) try { value.close(); } catch (Exception ignored) { }
    }
}
