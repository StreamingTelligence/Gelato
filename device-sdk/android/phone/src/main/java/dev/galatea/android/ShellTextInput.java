package dev.galatea.android;

import android.app.UiAutomation;
import android.os.Bundle;
import android.os.HandlerThread;
import android.os.Looper;
import android.os.Process;
import android.view.accessibility.AccessibilityNodeInfo;
import org.json.JSONObject;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;

/**
 * One-shot device-local input helper, launched by the already-paired embedded ADB.
 * UiAutomation bootstrap adapted from openatx/android-uiautomator-server-jar's
 * InstrumentShellWrapper (MIT; see assets/licenses/uiautomator-server-jar.txt).
 * No listening port, persistent service, clipboard or IME installation.
 */
public final class ShellTextInput {
    private static final String PREFIX = "DEVICE_AGENT_TEXT ";

    public static void main(String[] args) {
        if (Process.myUid() != 2000) { System.exit(2); return; }
        Thread watchdog = new Thread(() -> {
            try { Thread.sleep(15_000); } catch (InterruptedException ignored) { return; }
            System.exit(3); // Binder death also releases UiAutomation if the host disappears.
        }, "device-text-deadline");
        watchdog.setDaemon(true); watchdog.start();
        HandlerThread thread = new HandlerThread("DeviceTextUiAutomation");
        UiAutomation automation = null;
        String requestId = "";
        BufferedReader input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        try {
            // Required by AccessibilityInteractionClient on current Android, also used
            // by upstream's bootstrap. A HandlerThread alone does not set the main Looper.
            Looper.prepareMainLooper();
            JSONObject request = new JSONObject(readLine(input));
            requestId = request.getString("id");
            String text = request.getString("text");
            if (!requestId.matches("[a-f0-9-]{36}") || text.length() > 4096)
                throw new IllegalArgumentException("Invalid input request");
            thread.start();
            Object connection = Class.forName("android.app.UiAutomationConnection").getDeclaredConstructor().newInstance();
            Class<?> connectionType = Class.forName("android.app.IUiAutomationConnection");
            automation = (UiAutomation) UiAutomation.class.getConstructor(Looper.class, connectionType)
                    .newInstance(thread.getLooper(), connection);
            // Do not suppress any accessibility services the owner already uses.
            try {
                Method connect = UiAutomation.class.getDeclaredMethod("connect", int.class, long.class);
                connect.invoke(automation, UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES, 5000L);
            } catch (NoSuchMethodException oldAndroid) {
                UiAutomation.class.getDeclaredMethod("connect", int.class)
                        .invoke(automation, UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
            }
            AccessibilityNodeInfo field = focusedField(automation);
            String before = editorText(field);
            int start = field.getTextSelectionStart(), end = field.getTextSelectionEnd();
            String value = FocusedTextEdit.insert(before, start, end, text);
            emit(requestId, "ready", null);
            JSONObject commit = new JSONObject(readLine(input));
            if (!requestId.equals(commit.optString("id")) || !"commit".equals(commit.optString("action")))
                throw new IllegalStateException("Input was cancelled before commit");
            AccessibilityNodeInfo fresh = focusedField(automation);
            String current = editorText(fresh);
            if (!field.equals(fresh) || !before.equals(current)
                    || start != fresh.getTextSelectionStart() || end != fresh.getTextSelectionEnd())
                throw new IllegalStateException("Focused field changed before input; observe again");
            Bundle arguments = new Bundle();
            arguments.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value);
            if (!fresh.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments))
                throw new IllegalStateException("Focused editor rejected text input");
            boolean verified = fresh.refresh() && value.contentEquals(fresh.getText() == null ? "" : fresh.getText());
            emit(requestId, "completed", new JSONObject().put("verified", verified));
            readLine(input); // Let the ADB peer consume the result before process/stream teardown.
        } catch (Throwable failure) {
            Throwable cause = failure instanceof java.lang.reflect.InvocationTargetException && failure.getCause() != null
                    ? failure.getCause() : failure;
            // Do not echo field contents or requested text in diagnostic errors.
            try { emit(requestId, "error", new JSONObject().put("error", cause.getClass().getSimpleName()
                    + ": " + (cause.getMessage() == null ? "UI automation unavailable" : cause.getMessage())));
                if (!requestId.isEmpty()) readLine(input);
            }
            catch (Exception ignored) { }
        } finally {
            if (automation != null) {
                try { UiAutomation.class.getDeclaredMethod("disconnect").invoke(automation); }
                catch (Exception ignored) { }
            }
            thread.quitSafely(); watchdog.interrupt();
        }
        System.exit(0);
    }

    private static AccessibilityNodeInfo focusedField(UiAutomation automation) {
        // A visible IME can be the active window while the input focus belongs
        // to the app behind it. Query global input focus, not the IME's root.
        AccessibilityNodeInfo field = automation.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        long deadline = android.os.SystemClock.uptimeMillis() + 1500;
        while (field == null && android.os.SystemClock.uptimeMillis() < deadline) {
            android.os.SystemClock.sleep(50);
            field = automation.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        }
        if (field == null || !field.isFocused() || !field.isEditable() || !field.isEnabled()
                || !field.isVisibleToUser() || field.isPassword())
            throw new IllegalStateException("No visible, non-password editable field has input focus");
        return field;
    }

    private static String editorText(AccessibilityNodeInfo field) {
        return field.isShowingHintText() || field.getText() == null ? "" : field.getText().toString();
    }

    private static String readLine(BufferedReader reader) throws Exception {
        StringBuilder value = new StringBuilder();
        for (int c; (c = reader.read()) != -1;) {
            if (c == '\n') return value.toString();
            if (value.length() >= 32768) throw new IllegalArgumentException("Input frame too large");
            value.append((char) c);
        }
        throw new java.io.EOFException("Input channel closed");
    }

    private static void emit(String id, String status, JSONObject details) throws Exception {
        JSONObject frame = details == null ? new JSONObject() : details;
        frame.put("id", id).put("status", status);
        System.out.println(PREFIX + frame); System.out.flush();
    }
}
