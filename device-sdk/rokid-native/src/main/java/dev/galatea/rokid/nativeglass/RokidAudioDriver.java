package dev.galatea.rokid.nativeglass;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.AudioTrack;
import android.media.MediaRecorder;
import android.os.SystemClock;
import android.util.Log;

import androidx.annotation.NonNull;

import java.util.Arrays;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Local microphone and speaker adapter. Transport, pairing and model choice stay outside this driver. */
public final class RokidAudioDriver implements AutoCloseable {
    public interface AudioSink { void onPcm16(byte[] frame, double sourceTimeS); }

    private static final String TAG = "GelatoRokidAudio";
    private static final int INPUT_RATE = 16000;
    private static final int OUTPUT_RATE = 24000;
    private static final int FRAME_BYTES = 3200; // 100 ms of 16 kHz mono PCM16

    private final Context context;
    private final ExecutorService captureWorker = Executors.newSingleThreadExecutor();
    private final ExecutorService playbackWorker = Executors.newSingleThreadExecutor();
    private volatile boolean capturing;
    private volatile long captureGeneration;
    private volatile boolean closed;
    private volatile boolean playing;
    private volatile long suppressInputUntilMs;
    private volatile AudioRecord recorder;
    private volatile AudioTrack track;

    public RokidAudioDriver(@NonNull Context context) { this.context = context.getApplicationContext(); }

    public boolean permitted() {
        return context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
    }

    public synchronized boolean startCapture(@NonNull AudioSink sink) {
        if (closed || !permitted()) return false;
        if (capturing) return true;
        capturing = true;
        long generation = ++captureGeneration;
        captureWorker.execute(() -> capture(sink, generation));
        return true;
    }

    private void capture(AudioSink sink, long generation) {
        AudioRecord input = null;
        try {
            if (!capturing || generation != captureGeneration || closed) return;
            int minimum = AudioRecord.getMinBufferSize(INPUT_RATE, AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT);
            if (minimum <= 0) throw new IllegalStateException("16 kHz microphone unavailable");
            input = new AudioRecord(MediaRecorder.AudioSource.VOICE_COMMUNICATION, INPUT_RATE,
                    AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
                    Math.max(minimum, FRAME_BYTES * 4));
            if (input.getState() != AudioRecord.STATE_INITIALIZED) throw new IllegalStateException("Microphone not initialized");
            if (!capturing || generation != captureGeneration || closed) return;
            recorder = input;
            input.startRecording();
            byte[] frame = new byte[FRAME_BYTES];
            while (capturing && generation == captureGeneration && !closed) {
                int count = input.read(frame, 0, frame.length, AudioRecord.READ_BLOCKING);
                if (count < 0) throw new IllegalStateException("Microphone read failed: " + count);
                if (count < 2 || playing || SystemClock.elapsedRealtime() < suppressInputUntilMs) continue;
                sink.onPcm16(Arrays.copyOf(frame, count & ~1), SystemClock.elapsedRealtimeNanos() / 1_000_000_000.0);
            }
        } catch (Exception error) {
            if (capturing && !closed) Log.w(TAG, "Microphone capture stopped", error);
        } finally {
            if (generation == captureGeneration) recorder = null;
            if (input != null) {
                try { input.stop(); } catch (Exception ignored) { }
                input.release();
            }
            if (generation == captureGeneration) capturing = false;
        }
    }

    public synchronized void stopCapture() {
        capturing = false;
        captureGeneration++;
        AudioRecord input = recorder;
        if (input != null) try { input.stop(); } catch (Exception ignored) { }
    }

    /** Play a verified model reply on the glasses' current audio output route. */
    public void playPcm16(@NonNull byte[] bytes, int sampleRateHz) {
        if (closed || bytes.length < 2 || bytes.length > 8 * 1024 * 1024 || bytes.length % 2 != 0
                || sampleRateHz != OUTPUT_RATE) return;
        playbackWorker.execute(() -> {
            if (closed) return;
            playing = true;
            AudioTrack output = null;
            try {
                int minimum = AudioTrack.getMinBufferSize(OUTPUT_RATE, AudioFormat.CHANNEL_OUT_MONO,
                        AudioFormat.ENCODING_PCM_16BIT);
                if (minimum <= 0) throw new IllegalStateException("24 kHz speaker unavailable");
                output = new AudioTrack.Builder()
                        .setAudioAttributes(new AudioAttributes.Builder()
                                .setUsage(AudioAttributes.USAGE_ASSISTANT)
                                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                        .setAudioFormat(new AudioFormat.Builder()
                                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                                .setSampleRate(OUTPUT_RATE)
                                .setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
                        .setTransferMode(AudioTrack.MODE_STREAM)
                        .setBufferSizeInBytes(Math.max(minimum, OUTPUT_RATE * 2)).build();
                if (output.getState() != AudioTrack.STATE_INITIALIZED) throw new IllegalStateException("Speaker not initialized");
                track = output;
                output.play();
                int position = 0;
                while (position < bytes.length && !closed && playing) {
                    int written = output.write(bytes, position, Math.min(8192, bytes.length - position),
                            AudioTrack.WRITE_BLOCKING);
                    if (written <= 0) throw new IllegalStateException("Speaker write failed: " + written);
                    position += written;
                }
                if (!closed && playing) {
                    long drainMs = Math.min(3000, bytes.length * 1000L / (OUTPUT_RATE * 2));
                    SystemClock.sleep(drainMs);
                }
            } catch (Exception error) {
                Log.w(TAG, "Reply playback failed", error);
            } finally {
                track = null;
                if (output != null) {
                    try { output.stop(); } catch (Exception ignored) { }
                    output.release();
                }
                suppressInputUntilMs = SystemClock.elapsedRealtime() + 400;
                playing = false;
            }
        });
    }

    public void stopPlayback() {
        playing = false;
        AudioTrack output = track;
        if (output != null) try { output.pause(); output.flush(); } catch (Exception ignored) { }
    }

    @Override public synchronized void close() {
        closed = true;
        stopCapture();
        stopPlayback();
        captureWorker.shutdownNow();
        playbackWorker.shutdownNow();
    }
}
