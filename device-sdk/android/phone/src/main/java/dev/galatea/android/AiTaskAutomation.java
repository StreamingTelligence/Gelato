package dev.galatea.android;

import android.content.Context;
import android.util.Base64;

import androidx.annotation.NonNull;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.function.Consumer;

final class AiTaskAutomation {
    interface ShellRunner {
        String run(@NonNull String command) throws Exception;
    }

    private static final long DEFAULT_TIMEOUT_MS = 120_000L;
    private static final long MAX_TIMEOUT_MS = 180_000L;
    private static final long MAX_IMAGE_BYTES = 15L * 1024L * 1024L;
    // Divisible by three so independently encoded full chunks can be safely
    // concatenated without embedded Base64 padding.
    private static final int IMAGE_TRANSFER_CHUNK_BYTES = 480 * 1024;

    private final Context context;
    private final ShellRunner shell;
    private final Consumer<String> logger;

    AiTaskAutomation(
            @NonNull Context context,
            @NonNull ShellRunner shell,
            @NonNull Consumer<String> logger
    ) {
        this.context = context.getApplicationContext();
        this.shell = shell;
        this.logger = logger;
    }

    JSONObject execute(@NonNull JSONObject command) throws Exception {
        String taskId = required(command, "taskId");
        String action = required(command, "action").toLowerCase(Locale.US);
        JSONObject arguments = command.optJSONObject("arguments");
        if (arguments == null) {
            arguments = new JSONObject();
        }
        long timeoutMs = Math.max(30_000L, Math.min(
                command.optLong("timeoutMs", DEFAULT_TIMEOUT_MS),
                MAX_TIMEOUT_MS
        ));
        long startedAt = System.currentTimeMillis();
        JSONObject result;
        switch (action) {
            case "alarm.create":
                result = createAlarm(arguments, timeoutMs);
                break;
            case "image.generate":
                result = generateImage(arguments, timeoutMs);
                break;
            case "ride.prepare":
                result = prepareRide(arguments, timeoutMs);
                break;
            default:
                throw new IllegalArgumentException("Unsupported AI task action: " + action);
        }
        return result
                .put("type", "executeAiTask")
                .put("taskId", taskId)
                .put("action", action)
                .put("elapsedMs", System.currentTimeMillis() - startedAt);
    }

    private JSONObject createAlarm(JSONObject arguments, long timeoutMs) throws Exception {
        String provider = provider(arguments, "xiaobu");
        if (!"xiaobu".equals(provider)) {
            throw new IllegalArgumentException("alarm.create currently requires provider xiaobu");
        }
        String dateText = required(arguments, "date");
        String timeText = required(arguments, "time");
        LocalDate date;
        LocalTime time;
        try {
            date = LocalDate.parse(dateText, DateTimeFormatter.ISO_LOCAL_DATE);
            time = LocalTime.parse(timeText, DateTimeFormatter.ofPattern("HH:mm", Locale.US));
        } catch (DateTimeParseException error) {
            throw new IllegalArgumentException("alarm.create expects date YYYY-MM-DD and time HH:mm", error);
        }
        ZonedDateTime requested = ZonedDateTime.of(date, time, ZoneId.systemDefault());
        ZonedDateTime now = ZonedDateTime.now(ZoneId.systemDefault());
        if (!requested.isAfter(now.plusMinutes(1))) {
            throw new IllegalArgumentException("alarm.create time must be at least two minutes in the future");
        }
        if (requested.isAfter(now.plusDays(366))) {
            throw new IllegalArgumentException("alarm.create time must be within 366 days");
        }
        ZonedDateTime nextOccurrence = ZonedDateTime.of(now.toLocalDate(), time, ZoneId.systemDefault());
        if (!nextOccurrence.isAfter(now.plusMinutes(1))) {
            nextOccurrence = nextOccurrence.plusDays(1);
        }
        if (!requested.toLocalDate().equals(nextOccurrence.toLocalDate())) {
            throw new IllegalArgumentException(
                    "alarm.create can set only the next occurrence of a clock time; expected date "
                            + nextOccurrence.toLocalDate()
            );
        }
        long requestedEpochMs = requested.toInstant().toEpochMilli();
        String before = shell.run("dumpsys alarm");
        if (alarmExists(before, requestedEpochMs)) {
            return completed(provider, new JSONObject()
                    .put("verified", true)
                    .put("alreadyExisted", true)
                    .put("requestedEpochMs", requestedEpochMs)
                    .put("date", dateText)
                    .put("time", timeText)
                    .put("timeZone", ZoneId.systemDefault().getId()));
        }

        String prompt = "帮我设置一个"
                + time.format(DateTimeFormatter.ofPattern("HH点mm分", Locale.CHINA))
                + "的一次性闹钟";
        JSONObject assistantResponse = null;
        String assistantError = "";
        try {
            // System actions should be verified promptly even if the assistant
            // leaves a card open or never exposes a stable prose response.
            assistantResponse = ask(provider, prompt, Math.min(timeoutMs, 45_000L));
        } catch (Exception error) {
            assistantError = message(error);
            logger.accept("alarm.create assistant response was incomplete; verifying system state");
        }

        String after = "";
        boolean verified = false;
        long verificationDeadline = System.currentTimeMillis() + 12_000L;
        while (System.currentTimeMillis() < verificationDeadline) {
            after = shell.run("dumpsys alarm");
            if (alarmExists(after, requestedEpochMs)) {
                verified = true;
                break;
            }
            sleep(1_000L);
        }
        JSONObject evidence = new JSONObject()
                .put("verified", verified)
                .put("alreadyExisted", false)
                .put("requestedEpochMs", requestedEpochMs)
                .put("date", dateText)
                .put("time", timeText)
                .put("timeZone", ZoneId.systemDefault().getId())
                .put("nextAlarmClock", nextAlarmSummary(after));
        if (assistantResponse != null) {
            evidence.put("assistantAnswer", assistantResponse.optString("answer"));
        }
        if (!assistantError.isEmpty()) {
            evidence.put("assistantError", assistantError);
        }
        if (!verified) {
            return failed(provider, "The system AlarmManager did not contain the requested alarm", evidence);
        }
        return completed(provider, evidence);
    }

    private JSONObject generateImage(JSONObject arguments, long timeoutMs) throws Exception {
        String provider = provider(arguments, "doubao");
        if (!"doubao".equals(provider)) {
            throw new IllegalArgumentException("image.generate currently requires provider doubao");
        }
        String prompt = required(arguments, "prompt");
        if (prompt.length() > 2_000) {
            throw new IllegalArgumentException("image prompt must not exceed 2000 characters");
        }
        shell.run("monkey -p com.larus.nova -c android.intent.category.LAUNCHER 1");
        sleep(2_000L);
        Set<String> baselineText = doubaoVisibleText();
        String beforePath = latestPicturePath();
        String taskPrompt = "请生成图片：" + prompt;
        JSONObject assistantResponse = null;
        String assistantError = "";
        try {
            // Doubao can finish rendering image cards without exposing a text
            // answer that remains stable long enough for the chat adapter.
            assistantResponse = ask(provider, taskPrompt, Math.min(timeoutMs, 75_000L));
        } catch (Exception error) {
            assistantError = message(error);
            logger.accept("image.generate chat response was incomplete; checking generated cards");
        }
        ImageCardSnapshot imageSnapshot = null;
        long imageDeadline = System.currentTimeMillis() + 60_000L;
        while (System.currentTimeMillis() < imageDeadline) {
            imageSnapshot = imageCardSnapshot(taskPrompt, baselineText);
            if (imageSnapshot.imageCount > 0) {
                break;
            }
            sleep(750L);
        }
        int visibleImageCount = imageSnapshot == null ? 0 : imageSnapshot.imageCount;
        JSONObject evidence = new JSONObject()
                .put("visibleImageCount", visibleImageCount);
        if (assistantResponse != null) {
            evidence.put("assistantAnswer", assistantResponse.optString("answer"));
        }
        if (!assistantError.isEmpty()) {
            evidence.put("assistantError", assistantError);
        }
        boolean promptSubmitted = assistantResponse != null
                || (imageSnapshot != null
                && (imageSnapshot.promptVisible || imageSnapshot.responseChanged));
        evidence.put("promptSubmitted", promptSubmitted);
        if (!promptSubmitted) {
            return failed(provider, "Doubao did not show the submitted image prompt", evidence);
        }
        if (visibleImageCount < 1) {
            return failed(provider, "Doubao did not expose a generated image card", evidence);
        }
        if (imageSnapshot == null || imageSnapshot.markerText.isEmpty()) {
            return failed(provider, "Doubao image cards could not be correlated to this task", evidence);
        }
        if (!AgentAccessibilityService.clickActiveWindowDescriptionAfterText(
                "com.larus.nova",
                imageSnapshot.markerText,
                "保存"
        )) {
            return failed(provider, "Doubao generated images but the Save control was unavailable", evidence);
        }
        String savedPath = beforePath;
        long saveDeadline = System.currentTimeMillis() + 12_000L;
        while (System.currentTimeMillis() < saveDeadline) {
            sleep(750L);
            savedPath = latestPicturePath();
            if (!savedPath.isEmpty() && !savedPath.equals(beforePath)) {
                break;
            }
        }
        if (savedPath.isEmpty() || savedPath.equals(beforePath)
                || !savedPath.startsWith("/sdcard/Pictures/")
                || savedPath.contains("\n") || savedPath.contains("\r")) {
            return failed(provider, "Doubao image was not saved to a new Pictures file", evidence);
        }
        long sizeBytes;
        try {
            sizeBytes = Long.parseLong(shell.run("stat -c %s " + shellQuote(savedPath)).trim());
        } catch (NumberFormatException error) {
            throw new IllegalStateException("Saved image size was unavailable", error);
        }
        if (sizeBytes <= 0 || sizeBytes > MAX_IMAGE_BYTES) {
            throw new IllegalStateException("Saved image size is outside the supported range: " + sizeBytes);
        }
        String encoded = readFileBase64(savedPath, sizeBytes);
        byte[] decoded = Base64.decode(encoded, Base64.DEFAULT);
        if (decoded.length != sizeBytes) {
            throw new IllegalStateException("Saved image transfer was incomplete");
        }
        String fileName = new File(savedPath).getName();
        String mimeType = fileName.toLowerCase(Locale.US).endsWith(".png")
                ? "image/png"
                : "image/jpeg";
        JSONObject artifact = new JSONObject()
                .put("fileName", fileName)
                .put("mimeType", mimeType)
                .put("sizeBytes", sizeBytes)
                .put("base64", encoded);
        evidence.put("devicePath", savedPath);
        return completed(provider, evidence)
                .put("artifact", artifact);
    }

    private JSONObject prepareRide(JSONObject arguments, long timeoutMs) throws Exception {
        String provider = provider(arguments, "qwen");
        if (!"qwen".equals(provider)) {
            throw new IllegalArgumentException("ride.prepare currently requires provider qwen");
        }
        String origin = required(arguments, "origin");
        String destination = required(arguments, "destination");
        if (origin.length() > 200 || destination.length() > 200) {
            throw new IllegalArgumentException("ride origin and destination must not exceed 200 characters");
        }
        String prompt = "帮我准备从" + origin + "到" + destination
                + "的打车行程。只显示上车点选择或订单确认页面，不要替我确认、不要下单、不要支付。";
        JSONObject assistantResponse = null;
        String assistantError = "";
        try {
            assistantResponse = ask(provider, prompt, Math.min(timeoutMs, 35_000L));
        } catch (Exception error) {
            assistantError = message(error);
            logger.accept("ride.prepare left the answer flow; checking the task card");
        }

        RideSnapshot snapshot = null;
        long markerDeadline = System.currentTimeMillis() + 15_000L;
        while (System.currentTimeMillis() < markerDeadline) {
            snapshot = rideSnapshot(origin);
            if (snapshot.confirmationReady) {
                break;
            }
            sleep(750L);
        }
        JSONObject evidence = new JSONObject()
                .put("origin", origin)
                .put("destination", destination)
                .put("orderSubmitted", false)
                .put("paymentAttempted", false);
        if (assistantResponse != null) {
            evidence.put("assistantAnswer", assistantResponse.optString("answer"));
        }
        if (!assistantError.isEmpty()) {
            evidence.put("assistantError", assistantError);
        }
        if (snapshot != null) {
            evidence.put("visibleText", snapshot.visibleText)
                    .put("pickupOptions", snapshot.pickupOptions);
        }
        if (snapshot == null || !snapshot.confirmationReady) {
            return blocked(provider, "Qwen did not reach a verifiable pickup confirmation card", evidence);
        }
        return new JSONObject()
                .put("status", "awaiting_confirmation")
                .put("provider", provider)
                .put("confirmation", new JSONObject()
                        .put("kind", "pickup_location")
                        .put("prompt", "Choose a pickup location before continuing")
                        .put("options", snapshot.pickupOptions))
                .put("evidence", evidence);
    }

    private RideSnapshot rideSnapshot(String origin) {
        List<AgentAccessibilityService.NodeSnapshot> nodes =
                AgentAccessibilityService.activeWindowSnapshot();
        Set<String> visible = new LinkedHashSet<>();
        Set<String> options = new LinkedHashSet<>();
        boolean confirmationReady = false;
        boolean hasMatchingOrigin = false;
        for (AgentAccessibilityService.NodeSnapshot node : nodes) {
            if (!"com.aliyun.tongyi".equals(node.packageName)) {
                continue;
            }
            String text = clean(node.text);
            String description = clean(node.contentDescription);
            if ("在这上车".equals(text) || "在这上车".equals(description)) {
                confirmationReady = true;
            }
            if (!text.isEmpty() && visible.size() < 40) {
                visible.add(truncate(text));
            }
            if (!description.isEmpty() && visible.size() < 40) {
                visible.add(truncate(description));
            }
            if (!description.isEmpty()
                    && (description.contains(origin) || description.contains("-"))
                    && description.length() <= 160) {
                options.add(description);
                if (description.contains(origin)) {
                    hasMatchingOrigin = true;
                }
            }
        }
        return new RideSnapshot(
                confirmationReady && hasMatchingOrigin,
                new JSONArray(visible),
                new JSONArray(options)
        );
    }

    private JSONObject ask(String provider, String question, long timeoutMs) throws Exception {
        return new AiAppAutomation(context, shell::run, logger).ask(provider, question, timeoutMs);
    }

    private String latestPicturePath() throws Exception {
        String output = shell.run("ls -1t /sdcard/Pictures/*.png /sdcard/Pictures/*.jpg "
                + "/sdcard/Pictures/*.jpeg 2>/dev/null | head -n 1").trim();
        int newline = output.indexOf('\n');
        return newline >= 0 ? output.substring(0, newline).trim() : output;
    }

    private Set<String> doubaoVisibleText() {
        Set<String> values = new LinkedHashSet<>();
        for (AgentAccessibilityService.NodeSnapshot node
                : AgentAccessibilityService.activeWindowSnapshot()) {
            if (!"com.larus.nova".equals(node.packageName)) {
                continue;
            }
            String text = comparableText(node.text);
            String description = comparableText(node.contentDescription);
            if (!text.isEmpty()) values.add(text);
            if (!description.isEmpty()) values.add(description);
        }
        return values;
    }

    private ImageCardSnapshot imageCardSnapshot(String taskPrompt, Set<String> baselineText) {
        String comparablePrompt = comparableText(taskPrompt);
        String markerText = "";
        boolean promptVisible = false;
        boolean responseChanged = false;
        int imageCount = 0;
        for (AgentAccessibilityService.NodeSnapshot node
                : AgentAccessibilityService.activeWindowSnapshot()) {
            if (!"com.larus.nova".equals(node.packageName)) {
                continue;
            }
            String text = clean(node.text);
            String description = clean(node.contentDescription);
            if (markerText.isEmpty()
                    && (comparablePrompt.equals(comparableText(text))
                    || comparablePrompt.equals(comparableText(description)))) {
                promptVisible = true;
                markerText = text.isEmpty() ? description : text;
                continue;
            }
            if (markerText.isEmpty()
                    && "android.widget.TextView".equals(node.className)
                    && text.length() >= 12
                    && !baselineText.contains(comparableText(text))) {
                responseChanged = true;
                markerText = text;
                continue;
            }
            if (!markerText.isEmpty() && "图片".equals(description)) {
                imageCount += 1;
            }
        }
        return new ImageCardSnapshot(
                markerText,
                promptVisible,
                responseChanged,
                imageCount
        );
    }

    private String readFileBase64(String path, long sizeBytes) throws Exception {
        StringBuilder encoded = new StringBuilder((int) Math.min(
                Integer.MAX_VALUE,
                ((sizeBytes + 2L) / 3L) * 4L
        ));
        long chunkCount = (sizeBytes + IMAGE_TRANSFER_CHUNK_BYTES - 1L)
                / IMAGE_TRANSFER_CHUNK_BYTES;
        for (long index = 0; index < chunkCount; index += 1) {
            String chunk = shell.run("dd if=" + shellQuote(path)
                    + " bs=" + IMAGE_TRANSFER_CHUNK_BYTES
                    + " skip=" + index
                    + " count=1 2>/dev/null | base64").replaceAll("\\s+", "");
            if (chunk.isEmpty()) {
                throw new IllegalStateException("Saved image transfer stopped at chunk " + index);
            }
            encoded.append(chunk);
        }
        return encoded.toString();
    }

    private static boolean alarmExists(String dump, long epochMs) {
        String epoch = Long.toString(epochMs);
        if (dump.contains("time:" + epoch)) {
            return true;
        }
        int offset = -1;
        while ((offset = dump.indexOf(epoch, offset + 1)) >= 0) {
            int start = Math.max(0, offset - 500);
            int end = Math.min(dump.length(), offset + epoch.length() + 700);
            if (dump.substring(start, end).contains("com.coloros.alarmclock")) {
                return true;
            }
        }
        return false;
    }

    private static String nextAlarmSummary(String dump) {
        String marker = "Next alarm clock information:";
        int start = dump.indexOf(marker);
        if (start < 0) {
            return "unavailable";
        }
        int end = dump.indexOf("pending alarms:", start);
        String summary = dump.substring(start, end < 0 ? Math.min(dump.length(), start + 500) : end);
        return summary.replaceAll("\\s+", " ").trim();
    }

    private static JSONObject completed(String provider, JSONObject evidence) throws Exception {
        return new JSONObject()
                .put("status", "completed")
                .put("provider", provider)
                .put("evidence", evidence);
    }

    private static JSONObject failed(String provider, String message, JSONObject evidence) throws Exception {
        return new JSONObject()
                .put("status", "failed")
                .put("provider", provider)
                .put("message", message)
                .put("evidence", evidence);
    }

    private static JSONObject blocked(String provider, String message, JSONObject evidence) throws Exception {
        return new JSONObject()
                .put("status", "blocked")
                .put("provider", provider)
                .put("message", message)
                .put("evidence", evidence);
    }

    private static String provider(JSONObject arguments, String fallback) {
        String value = arguments.optString("provider", fallback).trim().toLowerCase(Locale.US);
        return value.isEmpty() ? fallback : value;
    }

    private static String required(JSONObject object, String key) {
        String value = object.optString(key, "").trim();
        if (value.isEmpty()) {
            throw new IllegalArgumentException(key + " is required");
        }
        return value;
    }

    private static String message(Exception error) {
        return error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage();
    }

    private static String clean(String value) {
        return value == null ? "" : value.replace("\u200B", "").trim();
    }

    private static String comparableText(String value) {
        return clean(value).replaceAll("\\s+", "");
    }

    private static String truncate(String value) {
        return value.length() > 500 ? value.substring(0, 500) : value;
    }

    private static String shellQuote(String value) {
        return "'" + value.replace("'", "'\\''") + "'";
    }

    private static void sleep(long durationMs) throws InterruptedException {
        Thread.sleep(durationMs);
    }

    private static final class RideSnapshot {
        final boolean confirmationReady;
        final JSONArray visibleText;
        final JSONArray pickupOptions;

        RideSnapshot(boolean confirmationReady, JSONArray visibleText, JSONArray pickupOptions) {
            this.confirmationReady = confirmationReady;
            this.visibleText = visibleText;
            this.pickupOptions = pickupOptions;
        }
    }

    private static final class ImageCardSnapshot {
        final String markerText;
        final boolean promptVisible;
        final boolean responseChanged;
        final int imageCount;

        ImageCardSnapshot(
                String markerText,
                boolean promptVisible,
                boolean responseChanged,
                int imageCount
        ) {
            this.markerText = markerText;
            this.promptVisible = promptVisible;
            this.responseChanged = responseChanged;
            this.imageCount = imageCount;
        }
    }
}
