package dev.galatea.android;

import java.util.function.Consumer;
import java.util.function.Supplier;

/** Serializes lifecycle changes without holding the runtime state lock during driver callbacks. */
final class LifecycleTransition {
    private final Object stateLock;
    private final Object orderLock = new Object();

    LifecycleTransition(Object stateLock) { this.stateLock = stateLock; }

    <T> void run(Supplier<T> update, Consumer<T> effects) {
        // Acquiring orderLock with stateLock held would recreate the ANR lock inversion.
        if (Thread.holdsLock(stateLock)) {
            throw new IllegalStateException("Lifecycle effects must run outside the runtime state lock");
        }
        synchronized (orderLock) {
            T value;
            synchronized (stateLock) { value = update.get(); }
            effects.accept(value);
        }
    }
}
