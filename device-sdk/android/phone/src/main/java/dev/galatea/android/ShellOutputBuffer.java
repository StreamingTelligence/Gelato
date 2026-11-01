package dev.galatea.android;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;

/** Preserve the existing shell sentinel framing without repeatedly decoding all output. */
final class ShellOutputBuffer extends ByteArrayOutputStream {
    private final byte[] sentinel;
    private int sentinelIndex = -1;

    ShellOutputBuffer(String sentinel) {
        this.sentinel = sentinel.getBytes(StandardCharsets.US_ASCII);
        if (this.sentinel.length == 0) throw new IllegalArgumentException("Sentinel must not be empty");
    }

    void append(byte[] bytes, int length) {
        int previousSize = count;
        super.write(bytes, 0, length);
        if (sentinelIndex >= 0) return;
        // Recheck only the boundary and newly received bytes. A sentinel may
        // span any number of reads, including one-byte reads.
        for (int start = Math.max(0, previousSize - sentinel.length + 1);
             start <= count - sentinel.length; start++) {
            int matched = 0;
            while (matched < sentinel.length && buf[start + matched] == sentinel[matched]) matched++;
            if (matched == sentinel.length) {
                sentinelIndex = start;
                return;
            }
        }
    }

    boolean complete() { return sentinelIndex >= 0; }

    String text() {
        return new String(buf, 0, sentinelIndex >= 0 ? sentinelIndex : count, StandardCharsets.UTF_8);
    }
}
