package dev.galatea.android;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.SystemClock;
import android.util.DisplayMetrics;
import android.view.WindowManager;
import android.view.WindowMetrics;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

public final class MediaProjectionService extends Service {
    static final String ACTION_START = "dev.galatea.android.SCREEN_START";
    static final String ACTION_STOP = "dev.galatea.android.SCREEN_STOP";
    static final String EXTRA_RESULT_CODE = "resultCode";
    static final String EXTRA_RESULT_DATA = "resultData";

    private static final String CHANNEL_ID = "screen-stream";
    private static final int NOTIFICATION_ID = 1002;
    private static final int PREVIEW_WIDTH = 960;
    private static final long FRAME_PERIOD_MS = 1_000;

    private final AtomicBoolean running = new AtomicBoolean(false);
    private final AtomicBoolean encoding = new AtomicBoolean(false);
    private final ExecutorService encoderExecutor = Executors.newSingleThreadExecutor();

    private MediaProjection mediaProjection;
    private ImageReader imageReader;
    private VirtualDisplay virtualDisplay;
    private HandlerThread projectionThread;
    private Handler projectionHandler;
    private volatile byte[] latestJpeg;
    private volatile double latestSourceTimeS;
    private volatile long lastEncodedAtMs;
    private int width;
    private int height;
    private int densityDpi;

    static Intent startIntent(Context context, int resultCode, Intent resultData) {
        Intent intent = new Intent(context, MediaProjectionService.class);
        intent.setAction(ACTION_START);
        intent.putExtra(EXTRA_RESULT_CODE, resultCode);
        intent.putExtra(EXTRA_RESULT_DATA, resultData);
        return intent;
    }

    static Intent stopIntent(Context context) {
        Intent intent = new Intent(context, MediaProjectionService.class);
        intent.setAction(ACTION_STOP);
        return intent;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
        AgentRuntime.init(this);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // A stop or process-restoration intent has no fresh MediaProjection
        // grant. Promoting it to a foreground service crashes on Android 14+.
        if (intent == null || !ACTION_START.equals(intent.getAction())) {
            stopStreaming(null);
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
            return START_NOT_STICKY;
        }
        if (intent != null && ACTION_START.equals(intent.getAction())) {
            int resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, 0);
            Intent data = intent.getParcelableExtra(EXTRA_RESULT_DATA);
            if (data != null && resultCode == android.app.Activity.RESULT_OK) {
                try {
                    startForeground(NOTIFICATION_ID, buildNotification());
                    startStreaming(resultCode, data);
                } catch (SecurityException error) {
                    stopStreaming(error.getMessage());
                    stopSelf();
                }
            } else {
                stopSelf();
            }
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        stopStreaming(null);
        encoderExecutor.shutdownNow();
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void startStreaming(int resultCode, @NonNull Intent resultData) {
        if (!running.compareAndSet(false, true)) {
            return;
        }
        try {
            configureDimensions();
            projectionThread = new HandlerThread("screen-projection");
            projectionThread.start();
            projectionHandler = new Handler(projectionThread.getLooper());

            MediaProjectionManager manager = (MediaProjectionManager) getSystemService(MEDIA_PROJECTION_SERVICE);
            mediaProjection = manager.getMediaProjection(resultCode, resultData);
            mediaProjection.registerCallback(new MediaProjection.Callback() {
                @Override
                public void onStop() {
                    stopStreaming("MediaProjection stopped by the system");
                }
            }, projectionHandler);

            // One MediaProjection session produces a continuous stream of complete
            // images. The controller can consume the newest frame without asking
            // the phone to run an individual screenshot command for each turn.
            imageReader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 3);
            imageReader.setOnImageAvailableListener(this::captureImage, projectionHandler);

            virtualDisplay = mediaProjection.createVirtualDisplay(
                    "GelatoScreen",
                    width,
                    height,
                    densityDpi,
                    DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                    imageReader.getSurface(),
                    null,
                    projectionHandler
            );

            AgentRuntime.get().setScreenActive(true, width, height, null);
            projectionHandler.postDelayed(framePump, FRAME_PERIOD_MS);
        } catch (Exception e) {
            stopStreaming(e.getMessage());
        }
    }

    private final Runnable framePump = new Runnable() {
        @Override public void run() {
            if (!running.get()) return;
            byte[] frame = latestJpeg;
            if (frame != null) AgentRuntime.get().sendScreenJpegFrame(frame, latestSourceTimeS);
            if (projectionHandler != null) projectionHandler.postDelayed(this, FRAME_PERIOD_MS);
        }
    };

    private void captureImage(ImageReader reader) {
        Image image = reader.acquireLatestImage();
        if (image == null) return;
        long now = SystemClock.elapsedRealtime();
        if (!running.get() || now - lastEncodedAtMs < FRAME_PERIOD_MS - 100 || !encoding.compareAndSet(false, true)) {
            image.close();
            return;
        }
        lastEncodedAtMs = now;
        encoderExecutor.execute(() -> {
            try {
                byte[] jpeg = encodeJpeg(image);
                if (running.get()) {
                    latestSourceTimeS = image.getTimestamp() > 0
                            ? image.getTimestamp() / 1_000_000_000.0
                            : SystemClock.elapsedRealtimeNanos() / 1_000_000_000.0;
                    latestJpeg = jpeg;
                }
            } catch (Exception error) {
                if (running.get()) stopStreaming(error.getMessage());
            } finally {
                image.close();
                encoding.set(false);
            }
        });
    }

    private static byte[] encodeJpeg(Image image) {
        Image.Plane plane = image.getPlanes()[0];
        int pixelStride = plane.getPixelStride();
        int rowStride = plane.getRowStride();
        int width = image.getWidth();
        int height = image.getHeight();
        if (pixelStride != 4 || rowStride < width * pixelStride)
            throw new IllegalStateException("Unsupported screen image layout");
        ByteBuffer buffer = plane.getBuffer();
        byte[] row = new byte[width * pixelStride];
        int[] pixels = new int[width * height];
        for (int y = 0; y < height; y++) {
            buffer.position(y * rowStride);
            buffer.get(row);
            for (int x = 0; x < width; x++) {
                int offset = x * pixelStride;
                pixels[y * width + x] = 0xff000000
                        | (row[offset] & 0xff) << 16
                        | (row[offset + 1] & 0xff) << 8
                        | (row[offset + 2] & 0xff);
            }
        }
        Bitmap source = Bitmap.createBitmap(pixels, width, height, Bitmap.Config.ARGB_8888);
        int previewWidth = Math.min(width, PREVIEW_WIDTH);
        int previewHeight = Math.max(1, Math.round((float) height * previewWidth / width));
        Bitmap preview = previewWidth == width ? source
                : Bitmap.createScaledBitmap(source, previewWidth, previewHeight, true);
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        try {
            if (!preview.compress(Bitmap.CompressFormat.JPEG, 75, output))
                throw new IllegalStateException("JPEG screen encoding failed");
            return output.toByteArray();
        } finally {
            if (preview != source) preview.recycle();
            source.recycle();
        }
    }

    private synchronized void stopStreaming(@Nullable String error) {
        if (!running.getAndSet(false)) {
            return;
        }
        if (projectionHandler != null) projectionHandler.removeCallbacks(framePump);
        try {
            if (virtualDisplay != null) {
                virtualDisplay.release();
            }
        } catch (Exception ignored) {
        }
        try {
            if (imageReader != null) {
                imageReader.setOnImageAvailableListener(null, null);
                imageReader.close();
            }
        } catch (Exception ignored) {
        }
        try {
            if (mediaProjection != null) {
                mediaProjection.stop();
            }
        } catch (Exception ignored) {
        }
        if (projectionThread != null) {
            projectionThread.quitSafely();
        }
        virtualDisplay = null;
        imageReader = null;
        mediaProjection = null;
        projectionThread = null;
        projectionHandler = null;
        latestJpeg = null;
        AgentRuntime.get().setScreenActive(false, 0, 0, error);
    }

    private void configureDimensions() {
        DisplayMetrics metrics = getResources().getDisplayMetrics();
        densityDpi = metrics.densityDpi;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowManager windowManager = getSystemService(WindowManager.class);
            WindowMetrics windowMetrics = windowManager.getMaximumWindowMetrics();
            Rect bounds = windowMetrics.getBounds();
            width = bounds.width();
            height = bounds.height();
        } else {
            width = metrics.widthPixels;
            height = metrics.heightPixels;
        }
        if (width % 2 != 0) {
            width -= 1;
        }
        if (height % 2 != 0) {
            height -= 1;
        }
    }

    private Notification buildNotification() {
        Intent activityIntent = new Intent(this, MainActivity.class);
        PendingIntent pendingIntent = PendingIntent.getActivity(
                this,
                1,
                activityIntent,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );
        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_agent)
                .setContentTitle(getString(R.string.app_name))
                .setContentText("Screen stream is active")
                .setOngoing(true)
                .setContentIntent(pendingIntent)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build();
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                getString(R.string.screen_channel_name),
                NotificationManager.IMPORTANCE_LOW
        );
        manager.createNotificationChannel(channel);
    }
}
