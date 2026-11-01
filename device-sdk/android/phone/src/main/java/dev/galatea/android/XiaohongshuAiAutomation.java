package dev.galatea.android;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.graphics.Rect;
import android.util.Base64;
import android.util.Xml;

import androidx.annotation.NonNull;

import org.json.JSONArray;
import org.json.JSONObject;
import org.xmlpull.v1.XmlPullParser;

import java.io.ByteArrayOutputStream;
import java.io.StringReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.function.Consumer;
import java.util.function.Predicate;

final class XiaohongshuAiAutomation {
    interface ShellRunner {
        String run(@NonNull String command) throws Exception;
    }

    private static final String PACKAGE_NAME = "com.xingin.xhs";
    private static final String UI_DUMP_PATH = "/sdcard/serverized-xhs-ui.xml";
    private static final long DEFAULT_TIMEOUT_MS = 90_000L;
    private static final long MAX_TIMEOUT_MS = 180_000L;

    private final Context context;
    private final ShellRunner shell;
    private final Consumer<String> logger;

    XiaohongshuAiAutomation(
            @NonNull Context context,
            @NonNull ShellRunner shell,
            @NonNull Consumer<String> logger
    ) {
        this.context = context.getApplicationContext();
        this.shell = shell;
        this.logger = logger;
    }

    JSONObject ask(@NonNull String rawQuestion, long requestedTimeoutMs) throws Exception {
        String question = rawQuestion.trim();
        if (question.isEmpty()) {
            throw new IllegalArgumentException("question is required");
        }
        if (question.length() > 2_000) {
            throw new IllegalArgumentException("question must not exceed 2000 characters");
        }
        long timeoutMs = Math.max(30_000L, Math.min(
                requestedTimeoutMs > 0 ? requestedTimeoutMs : DEFAULT_TIMEOUT_MS,
                MAX_TIMEOUT_MS
        ));
        long startedAt = System.currentTimeMillis();
        long deadline = startedAt + timeoutMs;
        String stage = "launch";
        UiSnapshot lastSnapshot = null;
        try {
            logger.accept("Xiaohongshu AI: launching a fresh search session");
            shell.run("am force-stop " + PACKAGE_NAME
                    + "; monkey -p " + PACKAGE_NAME
                    + " -c android.intent.category.LAUNCHER 1 >/dev/null");
            sleep(3_000L);
            ensureAccessibilityReady(deadline);

            stage = "open_search";
            lastSnapshot = waitForSnapshot(
                    deadline,
                    snapshot -> snapshot.find(node -> "搜索".equals(node.contentDescription)
                            && node.clickable) != null,
                    "Xiaohongshu search button"
            );
            UiNode searchButton = requireNode(
                    lastSnapshot,
                    node -> "搜索".equals(node.contentDescription) && node.clickable,
                    "Xiaohongshu search button"
            );
            tap(searchButton);

            stage = "enter_question";
            lastSnapshot = waitForSnapshot(
                    deadline,
                    snapshot -> snapshot.find(node -> "android.widget.EditText".equals(node.className)) != null,
                    "Xiaohongshu search input"
            );
            UiNode searchInput = requireNode(
                    lastSnapshot,
                    node -> "android.widget.EditText".equals(node.className),
                    "Xiaohongshu search input"
            );
            tap(searchInput);
            if (!AgentAccessibilityService.setActiveWindowText(PACKAGE_NAME, question)) {
                setClipboard(question);
                shell.run("input keycombination KEYCODE_CTRL_LEFT KEYCODE_A; "
                        + "input keyevent KEYCODE_PASTE");
            }
            long inputDeadline = Math.min(deadline, System.currentTimeMillis() + 3_000L);
            do {
                lastSnapshot = dumpUi();
                if (lastSnapshot.find(node ->
                        "android.widget.EditText".equals(node.className)
                                && normalize(node.text).contains(normalize(question))) != null) {
                    break;
                }
                sleep(120L);
            } while (System.currentTimeMillis() < inputDeadline);
            if (dismissKnownPopup(lastSnapshot)) {
                lastSnapshot = dumpUi();
            }
            UiNode populatedInput = lastSnapshot.find(node ->
                    "android.widget.EditText".equals(node.className)
                            && normalize(node.text).contains(normalize(question))
            );
            if (populatedInput == null) {
                throw new IllegalStateException("Xiaohongshu did not accept the question text");
            }
            UiNode submit = requireNode(
                    lastSnapshot,
                    node -> "搜索".equals(node.text)
                            && "android.widget.Button".equals(node.className),
                    "Xiaohongshu search submit button"
            );
            tap(submit);

            stage = "open_ai_answer";
            lastSnapshot = waitForSnapshot(
                    deadline,
                    snapshot -> snapshot.find(node -> isAskLabel(node.text)
                            && node.bounds.top < 600) != null,
                    "Xiaohongshu Ask AI tab"
            );
            UiNode askTab = requireNode(
                    lastSnapshot,
                    node -> isAskLabel(node.text) && node.bounds.top < 600,
                    "Xiaohongshu Ask AI tab"
            );
            lastSnapshot = openAiConversation(askTab, deadline);

            stage = "wait_for_answer";
            lastSnapshot = waitForStableAnswer(question, deadline);

            stage = "collect_answer";
            LinkedHashSet<String> answerBlocks = collectAnswerBlocks(question, lastSnapshot, deadline);
            if (answerBlocks.isEmpty()) {
                throw new IllegalStateException("Xiaohongshu AI answer text was not exposed in the UI tree");
            }
            String answer = String.join("\n\n", answerBlocks);
            JSONArray blocksJson = new JSONArray();
            for (String block : answerBlocks) {
                blocksJson.put(block);
            }
            logger.accept("Xiaohongshu AI: answer collected in "
                    + (System.currentTimeMillis() - startedAt) + " ms");
            return new JSONObject()
                    .put("type", "askXiaohongshu")
                    .put("provider", "xiaohongshu-wenyiwen")
                    .put("packageName", PACKAGE_NAME)
                    .put("question", question)
                    .put("answer", answer)
                    .put("blocks", blocksJson)
                    .put("elapsedMs", System.currentTimeMillis() - startedAt)
                    .put("conversationPolicy", "fresh")
                    .put("conversationIsolated", true)
                    .put("conversationIsolationMethod", "fresh_search_query");
        } catch (Exception error) {
            JSONObject evidence = new JSONObject()
                    .put("stage", stage)
                    .put("message", error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage());
            if (lastSnapshot != null) {
                evidence.put("visibleText", lastSnapshot.visibleTextJson());
            }
            logger.accept("Xiaohongshu AI failed at " + stage + ": " + error.getMessage());
            throw new AutomationException(evidence.toString(), error);
        }
    }

    private UiSnapshot waitForStableAnswer(@NonNull String question, long deadline) throws Exception {
        String previousSignature = "";
        int stableCount = 0;
        UiSnapshot latest = null;
        while (System.currentTimeMillis() < deadline) {
            latest = dumpUi();
            List<String> blocks = latest.answerBlocks(question, true);
            String signature = String.join("\n\u241e\n", blocks);
            if (!blocks.isEmpty() && signature.equals(previousSignature)) {
                stableCount += 1;
                if (stableCount >= 3) {
                    return latest;
                }
            } else {
                stableCount = 0;
                previousSignature = signature;
            }
            sleep(2_000L);
        }
        throw new IllegalStateException("Timed out waiting for Xiaohongshu AI to finish its answer");
    }

    private UiSnapshot openAiConversation(@NonNull UiNode initialTab, long deadline) throws Exception {
        UiNode askTab = initialTab;
        for (int attempt = 0; attempt < 3; attempt += 1) {
            tap(askTab);
            long attemptDeadline = Math.min(deadline, System.currentTimeMillis() + 8_000L);
            UiSnapshot latest = null;
            while (System.currentTimeMillis() < attemptDeadline) {
                latest = dumpUi();
                if (latest.isAiConversation()) {
                    logger.accept("Xiaohongshu AI: conversation page opened");
                    return latest;
                }
                sleep(600L);
            }
            if (latest != null) {
                UiNode retryTab = latest.find(node -> isAskLabel(node.text)
                        && node.bounds.top < 600);
                if (retryTab != null) {
                    askTab = retryTab;
                }
            }
            logger.accept("Xiaohongshu AI: Ask AI tab did not open; retrying");
        }
        throw new IllegalStateException("Xiaohongshu Ask AI conversation did not open");
    }

    private LinkedHashSet<String> collectAnswerBlocks(
            @NonNull String question,
            @NonNull UiSnapshot firstSnapshot,
            long deadline
    ) throws Exception {
        LinkedHashSet<String> blocks = new LinkedHashSet<>(firstSnapshot.answerBlocks(question, true));
        int unchangedScrolls = 0;
        for (int index = 0; index < 10 && System.currentTimeMillis() < deadline; index += 1) {
            int before = blocks.size();
            shell.run("input swipe 540 1900 540 650 450");
            sleep(900L);
            UiSnapshot snapshot = dumpUi();
            blocks.addAll(snapshot.answerBlocks(question, false));
            if (blocks.size() == before) {
                unchangedScrolls += 1;
                if (unchangedScrolls >= 2) {
                    break;
                }
            } else {
                unchangedScrolls = 0;
            }
        }
        return blocks;
    }

    private UiSnapshot waitForSnapshot(
            long deadline,
            @NonNull Predicate<UiSnapshot> predicate,
            @NonNull String description
    ) throws Exception {
        UiSnapshot latest = null;
        while (System.currentTimeMillis() < deadline) {
            latest = dumpUi();
            if (dismissKnownPopup(latest)) {
                sleep(400L);
                continue;
            }
            if (predicate.test(latest)) {
                return latest;
            }
            sleep(750L);
        }
        throw new IllegalStateException("Timed out waiting for " + description);
    }

    @NonNull
    private UiSnapshot dumpUi() throws Exception {
        List<AgentAccessibilityService.NodeSnapshot> accessibleNodes =
                AgentAccessibilityService.activeWindowSnapshot();
        if (!accessibleNodes.isEmpty()) {
            return UiSnapshot.fromAccessibility(accessibleNodes);
        }
        Exception lastError = null;
        for (int attempt = 0; attempt < 4; attempt += 1) {
            try {
                return dumpUiWithUiAutomator();
            } catch (Exception error) {
                lastError = error;
                sleep(600L);
            }
        }
        throw lastError == null
                ? new IllegalStateException("Android UI hierarchy was not available")
                : lastError;
    }

    @NonNull
    private UiSnapshot dumpUiWithUiAutomator() throws Exception {
        String sizeOutput = shell.run("uiautomator dump " + UI_DUMP_PATH
                + " >/dev/null; stat -c %s " + UI_DUMP_PATH).trim();
        int newline = sizeOutput.indexOf('\n');
        String sizeText = newline >= 0 ? sizeOutput.substring(0, newline).trim() : sizeOutput;
        int size;
        try {
            size = Integer.parseInt(sizeText);
        } catch (NumberFormatException error) {
            throw new IllegalStateException("Android UI hierarchy size was not available: " + sizeText);
        }
        if (size <= 0 || size > 512_000) {
            throw new IllegalStateException("Android UI hierarchy has an invalid size: " + size);
        }
        final int chunkSize = 5_120;
        ByteArrayOutputStream bytes = new ByteArrayOutputStream(size);
        for (int chunk = 0; bytes.size() < size; chunk += 1) {
            String encoded = shell.run("dd if=" + UI_DUMP_PATH
                    + " bs=" + chunkSize
                    + " skip=" + chunk
                    + " count=1 2>/dev/null | base64");
            byte[] decoded = Base64.decode(encoded, Base64.DEFAULT);
            if (decoded.length == 0) {
                break;
            }
            bytes.write(decoded);
        }
        String xml = bytes.toString(StandardCharsets.UTF_8.name());
        int xmlStart = xml.indexOf("<?xml");
        int xmlEnd = xml.indexOf("</hierarchy>", xmlStart);
        if (xmlStart < 0 || xmlEnd < 0) {
            throw new IllegalStateException("Android UI hierarchy was not available");
        }
        return UiSnapshot.parse(xml.substring(xmlStart, xmlEnd + "</hierarchy>".length()));
    }

    private void ensureAccessibilityReady(long deadline) throws Exception {
        if (AgentAccessibilityService.isConnected()) {
            return;
        }
        String component = context.getPackageName()
                + "/dev.galatea.android.AgentAccessibilityService";
        String enabled = shell.run("settings get secure enabled_accessibility_services").trim();
        if ("null".equals(enabled)) {
            enabled = "";
        }
        boolean alreadyListed = false;
        for (String item : enabled.split(":")) {
            if (component.equals(item)) {
                alreadyListed = true;
                break;
            }
        }
        String updated = alreadyListed || enabled.isEmpty()
                ? (alreadyListed ? enabled : component)
                : enabled + ":" + component;
        shell.run("settings put secure enabled_accessibility_services " + shellQuote(updated)
                + "; settings put secure accessibility_enabled 1");
        long accessibilityDeadline = Math.min(deadline, System.currentTimeMillis() + 8_000L);
        while (!AgentAccessibilityService.isConnected()
                && System.currentTimeMillis() < accessibilityDeadline) {
            sleep(250L);
        }
        if (AgentAccessibilityService.isConnected()) {
            logger.accept("Xiaohongshu AI: accessibility window reader ready");
        } else {
            logger.accept("Xiaohongshu AI: accessibility reader unavailable; using UIAutomator fallback");
        }
    }

    private void setClipboard(@NonNull String value) {
        ClipboardManager clipboard = (ClipboardManager) context.getSystemService(Context.CLIPBOARD_SERVICE);
        if (clipboard == null) {
            throw new IllegalStateException("Android clipboard service is unavailable");
        }
        clipboard.setPrimaryClip(ClipData.newPlainText("Serverized question", value));
    }

    private boolean dismissKnownPopup(@NonNull UiSnapshot snapshot) throws Exception {
        UiNode dismiss = snapshot.find(node ->
                "稍后再说".equals(node.text)
                        || "暂不更新".equals(node.text)
                        || "以后再说".equals(node.text)
        );
        if (dismiss == null || dismiss.bounds.isEmpty()) {
            return false;
        }
        logger.accept("Xiaohongshu AI: dismissed blocking prompt “" + dismiss.text + "”");
        tap(dismiss);
        return true;
    }

    private void tap(@NonNull UiNode node) throws Exception {
        if (node.bounds.isEmpty()) {
            throw new IllegalStateException("Target UI element has no bounds");
        }
        shell.run("input tap " + node.bounds.centerX() + " " + node.bounds.centerY());
        sleep(500L);
    }

    @NonNull
    private static UiNode requireNode(
            @NonNull UiSnapshot snapshot,
            @NonNull Predicate<UiNode> predicate,
            @NonNull String description
    ) {
        UiNode node = snapshot.find(predicate);
        if (node == null) {
            throw new IllegalStateException(description + " was not found");
        }
        return node;
    }

    private static void sleep(long durationMs) throws InterruptedException {
        Thread.sleep(durationMs);
    }

    @NonNull
    private static String normalize(String value) {
        return value == null ? "" : value
                .replace("\u200B", "")
                .replace("\uFFFC", "")
                .trim();
    }

    @NonNull
    private static String shellQuote(@NonNull String value) {
        return "'" + value.replace("'", "'\\''") + "'";
    }

    private static boolean isAskLabel(@NonNull String value) {
        String text = normalize(value);
        return "问一问".equals(text) || "问点点".equals(text);
    }

    private static final class UiSnapshot {
        final List<UiNode> nodes;

        UiSnapshot(List<UiNode> nodes) {
            this.nodes = nodes;
        }

        static UiSnapshot parse(@NonNull String xml) throws Exception {
            ArrayList<UiNode> nodes = new ArrayList<>();
            XmlPullParser parser = Xml.newPullParser();
            parser.setInput(new StringReader(xml));
            int event;
            while ((event = parser.next()) != XmlPullParser.END_DOCUMENT) {
                if (event != XmlPullParser.START_TAG || !"node".equals(parser.getName())) {
                    continue;
                }
                nodes.add(new UiNode(
                        normalize(parser.getAttributeValue(null, "text")),
                        normalize(parser.getAttributeValue(null, "content-desc")),
                        normalize(parser.getAttributeValue(null, "class")),
                        "true".equals(parser.getAttributeValue(null, "clickable")),
                        parseBounds(parser.getAttributeValue(null, "bounds"))
                ));
            }
            return new UiSnapshot(nodes);
        }

        static UiSnapshot fromAccessibility(
                @NonNull List<AgentAccessibilityService.NodeSnapshot> source
        ) {
            ArrayList<UiNode> nodes = new ArrayList<>();
            for (AgentAccessibilityService.NodeSnapshot node : source) {
                if (!PACKAGE_NAME.equals(node.packageName)) {
                    continue;
                }
                nodes.add(new UiNode(
                        normalize(node.text),
                        normalize(node.contentDescription),
                        normalize(node.className),
                        node.clickable,
                        new Rect(node.bounds)
                ));
            }
            return new UiSnapshot(nodes);
        }

        UiNode find(@NonNull Predicate<UiNode> predicate) {
            for (UiNode node : nodes) {
                if (predicate.test(node)) {
                    return node;
                }
            }
            return null;
        }

        boolean isAiConversation() {
            return find(node -> "点点".equals(node.text) && node.bounds.top < 350) != null
                    || find(node -> isAskLabel(node.text) && node.bounds.top < 260) != null;
        }

        List<String> answerBlocks(@NonNull String question, boolean requireSourceMarker) {
            ArrayList<String> blocks = new ArrayList<>();
            boolean afterSource = !requireSourceMarker;
            for (UiNode node : nodes) {
                String text = normalize(node.text);
                if (text.equals(normalize(question))) {
                    // Long answers can scroll the source badge out of the active
                    // accessibility window. The unique submitted question is an
                    // equally strong marker for the current fresh conversation.
                    afterSource = true;
                    blocks.clear();
                    continue;
                }
                if (isSourceMarker(text)) {
                    afterSource = true;
                    continue;
                }
                if (!afterSource || !"android.widget.TextView".equals(node.className)) {
                    continue;
                }
                // Everything after the answer action bar belongs to 点点's chrome
                // (history and suggested follow-up questions), not to the answer.
                if (isAnswerTerminator(text)) {
                    break;
                }
                if (!isAnswerText(text, question) || blocks.contains(text)) {
                    continue;
                }
                blocks.add(text);
            }
            return blocks;
        }

        JSONArray visibleTextJson() {
            JSONArray result = new JSONArray();
            Set<String> unique = new LinkedHashSet<>();
            for (UiNode node : nodes) {
                String text = !node.text.isEmpty() ? node.text : node.contentDescription;
                if (!text.isEmpty() && unique.add(text)) {
                    result.put(text.length() > 500 ? text.substring(0, 500) : text);
                }
                if (result.length() >= 30) {
                    break;
                }
            }
            return result;
        }

        private static boolean isAnswerText(@NonNull String text, @NonNull String question) {
            if (text.length() < 8 || text.equals(normalize(question))) {
                return false;
            }
            if (isAskLabel(text)
                    || text.equals("搜索")
                    || isSourceMarker(text)
                    || text.contains("接着问点什么")
                    || text.contains("发消息或按住说话")
                    || text.equals("下拉查看历史对话")
                    || text.equals("内容由AI生成")) {
                return false;
            }
            return true;
        }

        private static boolean isAnswerTerminator(@NonNull String text) {
            return text.equals("复制")
                    || text.equals("分享")
                    || text.equals("不喜欢")
                    || text.equals("重新生成")
                    || text.equals("下拉查看历史对话");
        }

        private static boolean isSourceMarker(@NonNull String text) {
            return text.startsWith("ai参考小红书")
                    || (text.startsWith("参考")
                    && text.contains("篇")
                    && (text.contains("笔记") || text.contains("内容")));
        }

        private static Rect parseBounds(String value) {
            if (value == null) {
                return new Rect();
            }
            String[] parts = value.replace("][", ",")
                    .replace("[", "")
                    .replace("]", "")
                    .split(",");
            if (parts.length != 4) {
                return new Rect();
            }
            try {
                return new Rect(
                        Integer.parseInt(parts[0]),
                        Integer.parseInt(parts[1]),
                        Integer.parseInt(parts[2]),
                        Integer.parseInt(parts[3])
                );
            } catch (NumberFormatException ignored) {
                return new Rect();
            }
        }
    }

    private static final class UiNode {
        final String text;
        final String contentDescription;
        final String className;
        final boolean clickable;
        final Rect bounds;

        UiNode(String text, String contentDescription, String className, boolean clickable, Rect bounds) {
            this.text = text;
            this.contentDescription = contentDescription;
            this.className = className;
            this.clickable = clickable;
            this.bounds = bounds;
        }
    }

    static final class AutomationException extends Exception {
        AutomationException(String message, Throwable cause) {
            super(message, cause);
        }
    }
}
