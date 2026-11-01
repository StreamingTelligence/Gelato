package dev.galatea.rokid.nativeglass;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.graphics.ImageFormat;
import android.graphics.Rect;
import android.graphics.YuvImage;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.media.Image;
import android.media.ImageReader;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.SystemClock;
import android.util.Log;
import android.util.Size;

import androidx.annotation.NonNull;

import dev.galatea.device.BinaryPayload;
import dev.galatea.device.CapabilityDescriptor;
import dev.galatea.device.CommandContext;
import dev.galatea.device.DeviceAgentDriver;
import dev.galatea.device.DriverEventSink;
import dev.galatea.device.DriverResult;

import org.json.JSONObject;
import org.json.JSONException;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;

/** Camera2 implementation that runs on the glasses, without a phone companion or still-photo shutter. */
public final class RokidNativeDriver implements DeviceAgentDriver {
    public interface FrameSink { void onFrame(byte[] jpeg, double sourceTimeS); }

    private static final String TAG = "GelatoRokidCamera";
    private final Context context;
    private final CameraManager manager;
    private final String cameraId;
    private final Size size;
    private volatile DriverEventSink eventSink;
    private HandlerThread cameraThread;
    private Handler cameraHandler;
    private ImageReader reader;
    private CameraDevice camera;
    private CameraCaptureSession session;
    private FrameSink sink;
    private boolean opening;
    private long lastFrameNs;
    private byte[] latestJpeg;
    private long latestFrameAtMs;

    public RokidNativeDriver(@NonNull Context context) {
        this.context = context.getApplicationContext();
        manager = (CameraManager) this.context.getSystemService(Context.CAMERA_SERVICE);
        String selectedId = null;
        Size selectedSize = null;
        try {
            for (String id : manager.getCameraIdList()) {
                CameraCharacteristics info = manager.getCameraCharacteristics(id);
                StreamConfigurationMap map = info.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
                Size[] sizes = map == null ? null : map.getOutputSizes(ImageFormat.YUV_420_888);
                if (sizes == null || sizes.length == 0) continue;
                Size candidate = chooseSize(sizes);
                if (selectedId == null || Integer.valueOf(CameraCharacteristics.LENS_FACING_BACK).equals(info.get(CameraCharacteristics.LENS_FACING))) {
                    selectedId = id;
                    selectedSize = candidate;
                    if (Integer.valueOf(CameraCharacteristics.LENS_FACING_BACK).equals(info.get(CameraCharacteristics.LENS_FACING))) break;
                }
            }
        } catch (CameraAccessException error) {
            Log.e(TAG, "Camera inventory failed", error);
        }
        cameraId = selectedId;
        size = selectedSize;
    }

    private static Size chooseSize(Size[] sizes) {
        Size best = null;
        for (Size value : sizes) {
            if (value.getWidth() <= 640 && value.getHeight() <= 480
                    && (best == null || value.getWidth() * value.getHeight() > best.getWidth() * best.getHeight())) {
                best = value;
            }
        }
        if (best != null) return best;
        best = sizes[0];
        for (Size value : sizes) if (value.getWidth() * value.getHeight() < best.getWidth() * best.getHeight()) best = value;
        return best;
    }

    private boolean permitted() {
        return context.checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
    }

    private static JSONObject object(Object... fields) {
        if (fields.length % 2 != 0) throw new IllegalArgumentException("JSON fields must be paired");
        JSONObject value = new JSONObject();
        try {
            for (int i = 0; i < fields.length; i += 2) value.put((String) fields[i], fields[i + 1]);
        } catch (JSONException error) { throw new IllegalStateException(error); }
        return value;
    }

    @NonNull @Override public synchronized JSONObject snapshot() {
        JSONObject hardware = object("present", cameraId != null, "connected", cameraId != null && permitted(),
                "microphonePermission", context.checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                        == PackageManager.PERMISSION_GRANTED);
        // Camera IDs such as "0" are shared across devices, not stable hardware identities.
        return object("kind", "rokid.bolon", "displayName", "Rokid BOLON",
                "os", object("family", "android", "version", Build.VERSION.RELEASE),
                "driver", object("id", "rokid.camera2", "version", "1.0.0", "location", "device",
                        "state", cameraId == null ? "unavailable" : permitted() ? "ready" : "authorization-required"),
                "hardware", hardware);
    }

    @NonNull @Override public List<CapabilityDescriptor> capabilities() {
        List<CapabilityDescriptor> capabilities = new ArrayList<>();
        capabilities.add(new CapabilityDescriptor("device.describe", 1));
        if (cameraId != null) capabilities.add(new CapabilityDescriptor("camera.capture", 1,
                object("formats", new org.json.JSONArray().put("image/jpeg"),
                        "maxWidth", size.getWidth(), "maxHeight", size.getHeight()), "rokid.camera"));
        return capabilities;
    }

    @NonNull @Override public synchronized CompletableFuture<DriverResult> execute(
            @NonNull CommandContext command, @NonNull String capability, int version, @NonNull JSONObject arguments) {
        command.requireActive();
        if (version != 1) return CompletableFuture.failedFuture(new IllegalArgumentException("Unsupported capability version"));
        if ("device.describe".equals(capability)) return CompletableFuture.completedFuture(new DriverResult(snapshot()));
        if (!"camera.capture".equals(capability)) return CompletableFuture.failedFuture(new IllegalArgumentException("Unsupported capability"));
        if (!permitted()) return CompletableFuture.failedFuture(new IllegalStateException("Camera permission is missing"));
        if (latestJpeg == null || SystemClock.elapsedRealtime() - latestFrameAtMs > 3_000) {
            return CompletableFuture.failedFuture(new IllegalStateException("Camera preview has no recent frame"));
        }
        return CompletableFuture.completedFuture(new DriverResult(
                object("width", size.getWidth(), "height", size.getHeight(), "contentType", "image/jpeg"),
                new BinaryPayload("photo", "image/jpeg", latestJpeg.clone())));
    }

    @Override public boolean cancel(@NonNull String commandId) { return false; }
    @Override public void setEventSink(@NonNull DriverEventSink sink) { eventSink = sink; }

    public synchronized boolean startLiveCamera(@NonNull FrameSink frameSink) {
        if (cameraId == null || !permitted()) return false;
        sink = frameSink;
        if (camera != null || opening) return true;
        try {
            cameraThread = new HandlerThread("gelato-rokid-camera");
            cameraThread.start();
            cameraHandler = new Handler(cameraThread.getLooper());
            reader = ImageReader.newInstance(size.getWidth(), size.getHeight(), ImageFormat.YUV_420_888, 2);
            reader.setOnImageAvailableListener(this::onImageAvailable, cameraHandler);
            opening = true;
            manager.openCamera(cameraId, new CameraDevice.StateCallback() {
                @Override public void onOpened(@NonNull CameraDevice opened) {
                    synchronized (RokidNativeDriver.this) {
                        if (!opening) { opened.close(); return; }
                        camera = opened;
                        opening = false;
                        createSession(opened);
                    }
                }
                @Override public void onDisconnected(@NonNull CameraDevice opened) { cameraFailed(opened, "disconnected"); }
                @Override public void onError(@NonNull CameraDevice opened, int error) { cameraFailed(opened, "error " + error); }
            }, cameraHandler);
            return true;
        } catch (Exception error) {
            Log.e(TAG, "Camera open failed", error);
            stopLiveCamera();
            return false;
        }
    }

    private synchronized void createSession(CameraDevice opened) {
        if (reader == null || cameraHandler == null) return;
        try {
            opened.createCaptureSession(List.of(reader.getSurface()), new CameraCaptureSession.StateCallback() {
                @Override public void onConfigured(@NonNull CameraCaptureSession configured) {
                    synchronized (RokidNativeDriver.this) {
                        if (camera != opened || reader == null) { configured.close(); return; }
                        session = configured;
                        try {
                            CaptureRequest.Builder request = opened.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);
                            request.addTarget(reader.getSurface());
                            request.set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_ON);
                            configured.setRepeatingRequest(request.build(), null, cameraHandler);
                            Log.i(TAG, "Native preview started " + size);
                            if (eventSink != null) eventSink.stateChanged();
                        } catch (CameraAccessException error) { cameraFailed(opened, error.getMessage()); }
                    }
                }
                @Override public void onConfigureFailed(@NonNull CameraCaptureSession failed) {
                    cameraFailed(opened, "preview configuration failed");
                }
            }, cameraHandler);
        } catch (CameraAccessException error) { cameraFailed(opened, error.getMessage()); }
    }

    private void onImageAvailable(ImageReader source) {
        try (Image image = source.acquireLatestImage()) {
            if (image == null) return;
            long timestampNs = image.getTimestamp();
            FrameSink current;
            synchronized (this) {
                current = sink;
                if (current == null || timestampNs - lastFrameNs < 1_000_000_000L) return;
                lastFrameNs = timestampNs;
            }
            byte[] jpeg = encodeJpeg(image);
            synchronized (this) {
                latestJpeg = jpeg;
                latestFrameAtMs = SystemClock.elapsedRealtime();
            }
            current.onFrame(jpeg, timestampNs / 1_000_000_000.0);
        } catch (Exception error) { Log.e(TAG, "Frame encoding failed", error); }
    }

    private static byte[] encodeJpeg(Image image) {
        int width = image.getWidth(), height = image.getHeight();
        byte[] nv21 = new byte[width * height * 3 / 2];
        Image.Plane[] planes = image.getPlanes();
        copyLuma(planes[0], nv21, width, height);
        ByteBuffer u = planes[1].getBuffer(), v = planes[2].getBuffer();
        for (int row = 0; row < height / 2; row++) {
            for (int col = 0; col < width / 2; col++) {
                int offset = width * height + row * width + col * 2;
                nv21[offset] = v.get(row * planes[2].getRowStride() + col * planes[2].getPixelStride());
                nv21[offset + 1] = u.get(row * planes[1].getRowStride() + col * planes[1].getPixelStride());
            }
        }
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        if (!new YuvImage(nv21, ImageFormat.NV21, width, height, null)
                .compressToJpeg(new Rect(0, 0, width, height), 70, output)) {
            throw new IllegalStateException("JPEG encoding failed");
        }
        return output.toByteArray();
    }

    private static void copyLuma(Image.Plane plane, byte[] destination, int width, int height) {
        ByteBuffer data = plane.getBuffer();
        for (int row = 0; row < height; row++) {
            for (int col = 0; col < width; col++) {
                destination[row * width + col] = data.get(row * plane.getRowStride() + col * plane.getPixelStride());
            }
        }
    }

    private synchronized void cameraFailed(CameraDevice failed, String reason) {
        Log.w(TAG, "Camera preview stopped: " + reason);
        if (camera == failed || opening) {
            if (camera == null) try { failed.close(); } catch (RuntimeException ignored) { }
            stopLiveCamera();
        }
    }

    public synchronized void stopLiveCamera() {
        if (sink == null && !opening && session == null && camera == null && reader == null) return;
        sink = null;
        opening = false;
        latestJpeg = null;
        lastFrameNs = 0;
        if (session != null) {
            try { session.close(); } catch (RuntimeException error) { Log.w(TAG, "Camera session close failed", error); }
            session = null;
        }
        if (camera != null) {
            try { camera.close(); } catch (RuntimeException error) { Log.w(TAG, "Camera close failed", error); }
            camera = null;
        }
        if (reader != null) {
            try { reader.close(); } catch (RuntimeException error) { Log.w(TAG, "Camera reader close failed", error); }
            reader = null;
        }
        if (cameraThread != null) { cameraThread.quitSafely(); cameraThread = null; cameraHandler = null; }
        if (eventSink != null) eventSink.stateChanged();
    }

    @Override public void close() { stopLiveCamera(); }
}
