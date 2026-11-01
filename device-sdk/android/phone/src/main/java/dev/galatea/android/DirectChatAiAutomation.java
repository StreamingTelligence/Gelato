package dev.galatea.android;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.graphics.Rect;

import androidx.annotation.NonNull;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.function.Consumer;
import java.util.function.Predicate;

final class DirectChatAiAutomation {
    interface ShellRunner {
        String run(@NonNull String command) throws Exception;
    }

    private enum Locator {
        NONE,
        TEXT,
        DESCRIPTION,
        VIEW_ID,
        TOP_LEFT_CLICKABLE,
        TOP_RIGHT_CLICKABLE
    }

    static final class FreshConversation {
        final boolean entryCreatesFresh;
        final Locator openLocator;
        final String openValue;
        final Locator createLocator;
        final String createValue;
        final Set<String> verificationTextContains;
        final String method;

        private FreshConversation(
                boolean entryCreatesFresh,
                Locator openLocator,
                String openValue,
                Locator createLocator,
                String createValue,
                Set<String> verificationTextContains,
                String method
        ) {
            this.entryCreatesFresh = entryCreatesFresh;
            this.openLocator = openLocator;
            this.openValue = openValue;
            this.createLocator = createLocator;
            this.createValue = createValue;
            this.verificationTextContains = verificationTextContains;
            this.method = method;
        }

        static FreshConversation entry(String marker, String method) {
            return new FreshConversation(
                    true,
                    Locator.NONE,
                    "",
                    Locator.NONE,
                    "",
                    new LinkedHashSet<>(Arrays.asList(marker)),
                    method
            );
        }

        static FreshConversation controls(
                Locator openLocator,
                String openValue,
                Locator createLocator,
                String createValue,
                String marker,
                String method
        ) {
            return new FreshConversation(
                    false,
                    openLocator,
                    openValue,
                    createLocator,
                    createValue,
                    new LinkedHashSet<>(Arrays.asList(marker)),
                    method
            );
        }
    }

    static final class Profile {
        final String provider;
        final String packageName;
        final List<String> inputPrompts;
        final String inputActivatorDescription;
        final String submitDescription;
        final boolean qwenSubmitLayout;
        final String blockingLoginPrefix;
        final List<String> blockingPromptDismissals;
        final Set<String> excludedTexts;
        final String entryDescription;
        final String selectedAgentModeText;
        final String modeSelectorText;
        final String modeChoiceText;
        final Set<String> submitResourceIds;
        final boolean proximitySubmit;
        final boolean tapSubmitBounds;
        final FreshConversation freshConversation;

        private Profile(
                String provider,
                String packageName,
                List<String> inputPrompts,
                String inputActivatorDescription,
                String submitDescription,
                boolean qwenSubmitLayout,
                String blockingLoginPrefix,
                List<String> blockingPromptDismissals,
                Set<String> excludedTexts,
                FreshConversation freshConversation
        ) {
            this(
                    provider,
                    packageName,
                    inputPrompts,
                    inputActivatorDescription,
                    submitDescription,
                    qwenSubmitLayout,
                    blockingLoginPrefix,
                    blockingPromptDismissals,
                    excludedTexts,
                    "",
                    "",
                    "",
                    "",
                    setOf(),
                    false,
                    false,
                    freshConversation
            );
        }

        private Profile(
                String provider,
                String packageName,
                List<String> inputPrompts,
                String inputActivatorDescription,
                String submitDescription,
                boolean qwenSubmitLayout,
                String blockingLoginPrefix,
                List<String> blockingPromptDismissals,
                Set<String> excludedTexts,
                String entryDescription,
                String selectedAgentModeText,
                String modeSelectorText,
                String modeChoiceText,
                Set<String> submitResourceIds,
                boolean proximitySubmit,
                boolean tapSubmitBounds,
                FreshConversation freshConversation
        ) {
            this.provider = provider;
            this.packageName = packageName;
            this.inputPrompts = inputPrompts;
            this.inputActivatorDescription = inputActivatorDescription;
            this.submitDescription = submitDescription;
            this.qwenSubmitLayout = qwenSubmitLayout;
            this.blockingLoginPrefix = blockingLoginPrefix;
            this.blockingPromptDismissals = blockingPromptDismissals;
            this.excludedTexts = excludedTexts;
            this.entryDescription = entryDescription;
            this.selectedAgentModeText = selectedAgentModeText;
            this.modeSelectorText = modeSelectorText;
            this.modeChoiceText = modeChoiceText;
            this.submitResourceIds = submitResourceIds;
            this.proximitySubmit = proximitySubmit;
            this.tapSubmitBounds = tapSubmitBounds;
            this.freshConversation = freshConversation;
        }

        static Profile qwen() {
            return new Profile(
                    "qwen",
                    "com.aliyun.tongyi",
                    Arrays.asList("发消息或按住说话...", "发消息..."),
                    "",
                    "",
                    true,
                    "",
                    Arrays.asList("暂不更新", "稍后再说", "以后再说"),
                    setOf("欢迎回来，聊聊新话题", "内容由 Qwen-3.7 大模型生成"),
                    FreshConversation.controls(
                            Locator.TOP_LEFT_CLICKABLE,
                            "",
                            Locator.TEXT,
                            "新建对话",
                            "为你答疑 办事 创作，随时找我聊天",
                            "drawer_new_conversation"
                    )
            );
        }

        static Profile doubao() {
            return new Profile(
                    "doubao",
                    "com.larus.nova",
                    Arrays.asList("按住说话"),
                    "文本输入",
                    "发送",
                    false,
                    "立即登录",
                    Arrays.asList("暂不更新", "稍后再说", "以后再说", "我知道了"),
                    setOf("AI 生成可能有误 请核实", "按住说话"),
                    FreshConversation.controls(
                            Locator.DESCRIPTION,
                            "对话列表",
                            Locator.DESCRIPTION,
                            "创建新对话",
                            "新对话",
                            "drawer_create_conversation"
                    )
            );
        }

        static Profile deepSeek() {
            return new Profile(
                    "deepseek",
                    "com.deepseek.chat",
                    Arrays.asList("发消息或按住说话", "发消息"),
                    "",
                    "发送",
                    false,
                    "",
                    Arrays.asList("暂不更新", "稍后再说", "以后再说", "我知道了"),
                    setOf("使用快速模式开始对话", "适合日常对话，即时响应"),
                    FreshConversation.controls(
                            Locator.NONE,
                            "",
                            Locator.DESCRIPTION,
                            "开启新对话",
                            "使用快速模式开始对话",
                            "direct_new_conversation"
                    )
            );
        }

        static Profile xiaobu() {
            return new Profile(
                    "xiaobu",
                    "com.heytap.speechassist",
                    Arrays.asList("发消息或按住说话...", "发消息或按住说话…", "发消息..."),
                    "",
                    "发送消息",
                    false,
                    "登录",
                    Arrays.asList("暂不更新", "稍后再说", "以后再说", "我知道了", "取消"),
                    setOf(
                            "夜深了, 我是小布",
                            "迈出第一步，就很了不起！",
                            "深度思考",
                            "小布 P 图",
                            "AI 生图",
                            "深度研究",
                            "换一换",
                            "由 OPPO AI 生成，内容仅供参考"
                    ),
                    FreshConversation.controls(
                            Locator.DESCRIPTION,
                            "对话列表",
                            Locator.DESCRIPTION,
                            "新建对话按钮",
                            "我是小布",
                            "drawer_new_conversation"
                    )
            );
        }

        static Profile meituan() {
            return new Profile(
                    "meituan",
                    "com.sankuai.meituan",
                    Arrays.asList("发消息或按住说话", "接着问点什么"),
                    "",
                    "",
                    false,
                    "登录",
                    Arrays.asList("暂不更新", "稍后再说", "以后再说", "我知道了", "取消"),
                    setOf(
                            "我是小团，吃喝玩乐随时问我",
                            "内容由AI生成，仅供参考",
                            "已完成思考",
                            "小团"
                    ),
                    "小团",
                    "",
                    "",
                    "",
                    setOf("com.sankuai.meituan:id/aixiaotuan_iv_expanded_input_btn"),
                    false,
                    false,
                    FreshConversation.entry(
                            "我是小团，吃喝玩乐随时问我",
                            "home_agent_entry"
                    )
            );
        }

        static Profile kimi() {
            return new Profile(
                    "kimi",
                    "com.moonshot.kimichat",
                    Arrays.asList(
                            "尽管问，带图也行",
                            "尽管问，或做个任务...",
                            "尽管问，或做个任务…"
                    ),
                    "切换至文字输入",
                    "发送讯息",
                    false,
                    "登录",
                    Arrays.asList("暂不更新", "稍后再说", "以后再说", "我知道了", "取消"),
                    setOf(
                            "内容由 AI 生成",
                            "升级订阅",
                            "新建项目",
                            "PPT",
                            "集群",
                            "网站"
                    ),
                    "",
                    "K3",
                    "快速",
                    "K3",
                    setOf(),
                    false,
                    true,
                    FreshConversation.controls(
                            Locator.DESCRIPTION,
                            "导航按钮",
                            Locator.TOP_RIGHT_CLICKABLE,
                            "",
                            "今天要和 Kimi 一起做点什么",
                            "drawer_new_conversation"
                    )
            );
        }

        private static Set<String> setOf(String... values) {
            return new LinkedHashSet<>(Arrays.asList(values));
        }
    }

    private static final long DEFAULT_TIMEOUT_MS = 90_000L;
    private static final long MAX_TIMEOUT_MS = 180_000L;

    private final Context context;
    private final ShellRunner shell;
    private final Consumer<String> logger;
    private final Profile profile;

    DirectChatAiAutomation(
            @NonNull Context context,
            @NonNull ShellRunner shell,
            @NonNull Consumer<String> logger,
            @NonNull Profile profile
    ) {
        this.context = context.getApplicationContext();
        this.shell = shell;
        this.logger = logger;
        this.profile = profile;
    }

    JSONObject ask(@NonNull String rawQuestion, long requestedTimeoutMs) throws Exception {
        String question = normalize(rawQuestion);
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
        long isolationStartedAt = 0L;
        long isolatedAt = 0L;
        long submittedAt = 0L;
        String stage = "launch";
        UiSnapshot latest = null;
        try {
            logger.accept(profile.provider + " AI: launching app");
            shell.run("am force-stop " + profile.packageName
                    + "; monkey -p " + profile.packageName
                    + " -c android.intent.category.LAUNCHER 1 >/dev/null");
            ensureAccessibilityReady(deadline);

            if (!profile.entryDescription.isEmpty()) {
                stage = "open_agent";
                latest = waitForSnapshot(
                        deadline,
                        snapshot -> snapshot.hasInputEntry(profile)
                                || snapshot.hasDescription(profile.entryDescription),
                        "agent entry"
                );
                if (!latest.hasInputEntry(profile)) {
                    if (!AgentAccessibilityService.clickActiveWindowDescription(
                            profile.packageName,
                            profile.entryDescription
                    )) {
                        throw new IllegalStateException("Agent entry was visible but not clickable");
                    }
                }
            }

            stage = "isolate_conversation";
            isolationStartedAt = System.currentTimeMillis();
            latest = createFreshConversation(deadline);
            isolatedAt = System.currentTimeMillis();

            if (!profile.selectedAgentModeText.isEmpty()) {
                stage = "select_agent_mode";
                latest = ensureAgentMode(deadline);
            }

            stage = "open_input";
            latest = waitForSnapshot(deadline, snapshot -> snapshot.hasInputEntry(profile), "chat input");
            if (dismissKnownPopup(latest)) {
                latest = waitForSnapshot(deadline, snapshot -> snapshot.hasInputEntry(profile), "chat input");
            }
            if (latest.hasBlockingLogin(profile)) {
                stage = "login_required";
                throw new IllegalStateException(profile.provider
                        + " requires the user to sign in before more questions can be sent");
            }
            UiNode input = latest.findEditText();
            for (int attempt = 0; input == null && attempt < 4; attempt += 1) {
                UiNode activator = latest.findInputActivator(profile);
                if (activator == null) {
                    throw new IllegalStateException("Chat input activator was not found");
                }
                tap(activator);
                latest = waitForEditText(
                        Math.min(deadline, System.currentTimeMillis() + 3_000L)
                );
                input = latest.findEditText();
            }
            if (input == null) {
                throw new IllegalStateException("Editable chat input was not found");
            }
            if (!input.bounds.isEmpty()) {
                tap(input);
            }

            stage = "enter_question";
            if (!AgentAccessibilityService.setActiveWindowText(profile.packageName, question)) {
                setClipboard(question);
                shell.run("input keyevent KEYCODE_MOVE_END; input keyevent KEYCODE_PASTE");
            }
            latest = waitForPopulatedInput(
                    question,
                    Math.min(deadline, System.currentTimeMillis() + 3_000L)
            );
            UiNode populatedInput = latest.find(node ->
                    "android.widget.EditText".equals(node.className)
                            && normalize(node.text).contains(question));
            if (populatedInput == null) {
                throw new IllegalStateException(profile.provider + " did not accept the question text");
            }

            stage = "submit_question";
            UiSnapshot submitted = null;
            for (int attempt = 0; attempt < 3 && submitted == null; attempt += 1) {
                latest = snapshot();
                UiNode currentInput = latest.find(node ->
                        "android.widget.EditText".equals(node.className)
                                && normalize(node.text).contains(question)
                );
                if (currentInput == null) {
                    submitted = waitForSubmittedQuestion(
                            question,
                            Math.min(deadline, System.currentTimeMillis() + 5_000L)
                    );
                    break;
                }
                UiNode submit = latest.findSubmit(profile, currentInput);
                if (submit == null) {
                    throw new IllegalStateException("Chat submit control was not found");
                }
                boolean accessibilityClick = false;
                if (!profile.submitDescription.isEmpty() && !profile.tapSubmitBounds) {
                    accessibilityClick = AgentAccessibilityService.clickActiveWindowDescription(
                            profile.packageName,
                            profile.submitDescription
                    );
                }
                if (!accessibilityClick && !submit.resourceId.isEmpty()) {
                    accessibilityClick = AgentAccessibilityService.clickActiveWindowViewId(
                            profile.packageName,
                            submit.resourceId
                    );
                }
                if (accessibilityClick) {
                    sleep(150L);
                } else {
                    tap(submit);
                }
                submitted = waitForSubmittedQuestion(
                        question,
                        Math.min(deadline, System.currentTimeMillis() + 6_000L)
                );
                if (submitted == null) {
                    logger.accept(profile.provider + " AI: submit was not accepted; retrying");
                }
            }
            if (submitted == null) {
                throw new IllegalStateException("Timed out waiting for "
                        + profile.provider + " submitted question");
            }
            latest = submitted;
            submittedAt = System.currentTimeMillis();

            stage = "wait_for_answer";
            latest = waitForStableAnswer(question, deadline);
            List<String> blocks = latest.answerBlocks(question, profile);
            if (blocks.isEmpty()) {
                throw new IllegalStateException("AI answer text was not exposed in the accessibility tree");
            }
            JSONArray blocksJson = new JSONArray();
            for (String block : blocks) {
                blocksJson.put(block);
            }
            String answer = String.join("\n\n", blocks);
            String blockedReason = providerBlockedReason(answer);
            long elapsedMs = System.currentTimeMillis() - startedAt;
            JSONObject timingsMs = new JSONObject()
                    .put("launchToIsolation", isolationStartedAt - startedAt)
                    .put("conversationIsolation", isolatedAt - isolationStartedAt)
                    .put("inputAndSubmit", submittedAt - isolatedAt)
                    .put("answerWait", System.currentTimeMillis() - submittedAt);
            logger.accept(profile.provider + " AI: answer collected in " + elapsedMs + " ms");
            return new JSONObject()
                    .put("question", question)
                    .put("answer", answer)
                    .put("blocks", blocksJson)
                    .put("status", blockedReason.isEmpty() ? "completed" : "blocked")
                    .putOpt("blockedReason", blockedReason.isEmpty() ? null : blockedReason)
                    .put("elapsedMs", elapsedMs)
                    .put("conversationPolicy", "fresh")
                    .put("conversationIsolated", true)
                    .put("conversationIsolationMethod", profile.freshConversation.method)
                    .put("timingsMs", timingsMs);
        } catch (Exception error) {
            if (error instanceof LoginRequiredException) {
                stage = "login_required";
            }
            JSONObject evidence = new JSONObject()
                    .put("provider", profile.provider)
                    .put("stage", stage)
                    .put("message", error.getMessage() == null
                            ? error.getClass().getSimpleName()
                            : error.getMessage());
            if (latest != null) {
                evidence.put("visibleText", latest.visibleTextJson());
            }
            logger.accept(profile.provider + " AI failed at " + stage + ": " + error.getMessage());
            throw new AutomationException(evidence.toString(), error);
        }
    }

    private UiSnapshot waitForStableAnswer(String question, long deadline) throws Exception {
        String previousSignature = "";
        long stableSince = 0L;
        UiSnapshot latest = null;
        while (System.currentTimeMillis() < deadline) {
            latest = snapshot();
            List<String> blocks = latest.answerBlocks(question, profile);
            String signature = String.join("\n\u241e\n", blocks);
            boolean completed = latest.hasAnswerCompletionEvidence(question, profile);
            if (!blocks.isEmpty()
                    && completed
                    && !latest.isGenerating()
                    && signature.equals(previousSignature)) {
                if (stableSince == 0L) {
                    stableSince = System.currentTimeMillis();
                }
                if (System.currentTimeMillis() - stableSince >= 400L) {
                    return latest;
                }
            } else {
                stableSince = 0L;
                previousSignature = signature;
            }
            sleep(400L);
        }
        throw new IllegalStateException("Timed out waiting for " + profile.provider + " to finish its answer");
    }

    private UiSnapshot waitForEditText(long deadline) throws Exception {
        UiSnapshot latest = snapshot();
        while (System.currentTimeMillis() < deadline) {
            if (latest.findEditText() != null) {
                return latest;
            }
            sleep(120L);
            latest = snapshot();
        }
        return latest;
    }

    private UiSnapshot waitForPopulatedInput(String question, long deadline) throws Exception {
        UiSnapshot latest = snapshot();
        while (System.currentTimeMillis() < deadline) {
            UiNode populated = latest.find(node ->
                    "android.widget.EditText".equals(node.className)
                            && normalize(node.text).contains(question));
            if (populated != null) {
                return latest;
            }
            sleep(120L);
            latest = snapshot();
        }
        return latest;
    }

    private UiSnapshot createFreshConversation(long deadline) throws Exception {
        FreshConversation fresh = profile.freshConversation;
        if (fresh == null) {
            throw new IllegalStateException(profile.provider
                    + " does not have a verified fresh-conversation flow for this app version");
        }
        if (!fresh.entryCreatesFresh && fresh.openLocator != Locator.NONE) {
            UiSnapshot openSnapshot = waitForSnapshot(
                    deadline,
                    snapshot -> snapshot.locate(fresh.openLocator, fresh.openValue) != null,
                    "conversation navigation"
            );
            clickLocated(openSnapshot, fresh.openLocator, fresh.openValue);
        }
        if (!fresh.entryCreatesFresh) {
            Predicate<UiSnapshot> createVisible = snapshot ->
                    snapshot.locate(fresh.createLocator, fresh.createValue) != null;
            UiSnapshot createSnapshot = waitForSnapshotOrNull(
                    Math.min(deadline, System.currentTimeMillis() + 2_000L),
                    createVisible
            );
            if (createSnapshot == null && fresh.openLocator != Locator.NONE) {
                UiSnapshot retryOpenSnapshot = snapshot();
                if (retryOpenSnapshot.locate(fresh.openLocator, fresh.openValue) != null) {
                    logger.accept(profile.provider
                            + " AI: conversation-navigation click was not accepted; retrying once");
                    clickLocated(retryOpenSnapshot, fresh.openLocator, fresh.openValue);
                }
            }
            if (createSnapshot == null) {
                createSnapshot = waitForSnapshot(
                        Math.min(deadline, System.currentTimeMillis() + 10_000L),
                        snapshot -> snapshot.locate(fresh.createLocator, fresh.createValue) != null,
                        "new conversation control"
                );
            }
            clickLocated(createSnapshot, fresh.createLocator, fresh.createValue);
        }
        Predicate<UiSnapshot> freshReady = snapshot ->
                snapshot.hasAnyTextContaining(fresh.verificationTextContains)
                        && snapshot.hasInputEntry(profile);
        UiSnapshot verified = waitForSnapshotOrNull(
                Math.min(deadline, System.currentTimeMillis() + 2_000L),
                freshReady
        );
        if (verified == null && !fresh.entryCreatesFresh) {
            UiSnapshot retrySnapshot = snapshot();
            if (retrySnapshot.locate(fresh.createLocator, fresh.createValue) != null) {
                logger.accept(profile.provider
                        + " AI: new-conversation click was not accepted; retrying once");
                clickLocated(retrySnapshot, fresh.createLocator, fresh.createValue);
            }
        }
        if (verified == null) {
            verified = waitForSnapshot(
                    Math.min(deadline, System.currentTimeMillis() + 12_000L),
                    freshReady,
                    "fresh conversation verification"
            );
        }
        logger.accept(profile.provider + " AI: fresh conversation verified via " + fresh.method);
        return verified;
    }

    private void clickLocated(UiSnapshot snapshot, Locator locator, String value) throws Exception {
        UiNode target = snapshot.locate(locator, value);
        if (target == null) {
            throw new IllegalStateException("Conversation control was not found");
        }
        boolean clicked = false;
        if (locator == Locator.TEXT) {
            clicked = AgentAccessibilityService.clickActiveWindowText(profile.packageName, value);
        } else if (locator == Locator.DESCRIPTION) {
            clicked = AgentAccessibilityService.clickActiveWindowDescription(profile.packageName, value);
        } else if (locator == Locator.VIEW_ID) {
            clicked = AgentAccessibilityService.clickActiveWindowViewId(profile.packageName, value);
        }
        if (clicked) {
            sleep(150L);
        } else {
            tap(target);
        }
    }

    private UiSnapshot ensureAgentMode(long deadline) throws Exception {
        UiSnapshot latest = waitForSnapshot(
                deadline,
                snapshot -> snapshot.hasInputEntry(profile)
                        || snapshot.hasText(profile.selectedAgentModeText),
                "agent mode selector"
        );
        if (latest.hasText(profile.selectedAgentModeText)) {
            return latest;
        }
        if (!AgentAccessibilityService.clickActiveWindowText(
                profile.packageName,
                profile.modeSelectorText
        )) {
            throw new IllegalStateException("Agent mode selector was not clickable");
        }
        latest = waitForSnapshot(
                deadline,
                snapshot -> snapshot.hasText(profile.modeChoiceText),
                "agent mode choice"
        );
        if (!AgentAccessibilityService.clickActiveWindowText(
                profile.packageName,
                profile.modeChoiceText
        )) {
            throw new IllegalStateException("Agent mode choice was not clickable");
        }
        return waitForSnapshot(
                deadline,
                snapshot -> snapshot.hasText(profile.selectedAgentModeText)
                        && snapshot.hasInputEntry(profile),
                "selected agent mode"
        );
    }

    private UiSnapshot waitForSubmittedQuestion(String question, long deadline) throws Exception {
        while (System.currentTimeMillis() < deadline) {
            UiSnapshot latest = snapshot();
            if (latest.hasBlockingLogin(profile)) {
                throw new LoginRequiredException(profile.provider
                        + " requires the user to sign in before more questions can be sent");
            }
            if (latest.hasSubmittedQuestion(question)) {
                return latest;
            }
            sleep(200L);
        }
        return null;
    }

    private UiSnapshot waitForSnapshot(
            long deadline,
            Predicate<UiSnapshot> predicate,
            String description
    ) throws Exception {
        UiSnapshot latest = null;
        while (System.currentTimeMillis() < deadline) {
            latest = snapshot();
            if (dismissKnownPopup(latest)) {
                sleep(500L);
                continue;
            }
            if (predicate.test(latest)) {
                return latest;
            }
            sleep(200L);
        }
        throw new IllegalStateException("Timed out waiting for " + profile.provider + " " + description);
    }

    private UiSnapshot waitForSnapshotOrNull(
            long deadline,
            Predicate<UiSnapshot> predicate
    ) throws Exception {
        while (System.currentTimeMillis() < deadline) {
            UiSnapshot latest = snapshot();
            if (dismissKnownPopup(latest)) {
                sleep(500L);
                continue;
            }
            if (predicate.test(latest)) {
                return latest;
            }
            sleep(200L);
        }
        return null;
    }

    private UiSnapshot snapshot() {
        List<AgentAccessibilityService.NodeSnapshot> source =
                AgentAccessibilityService.activeWindowSnapshot();
        ArrayList<UiNode> nodes = new ArrayList<>();
        for (AgentAccessibilityService.NodeSnapshot node : source) {
            if (!profile.packageName.equals(node.packageName)) {
                continue;
            }
            nodes.add(new UiNode(
                    normalize(node.text),
                    normalize(node.contentDescription),
                    normalize(node.className),
                    normalize(node.resourceId),
                    node.clickable,
                    new Rect(node.bounds)
            ));
        }
        return new UiSnapshot(nodes);
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
        boolean listed = Arrays.asList(enabled.split(":")).contains(component);
        String updated = listed || enabled.isEmpty()
                ? (listed ? enabled : component)
                : enabled + ":" + component;
        shell.run("settings put secure enabled_accessibility_services " + shellQuote(updated)
                + "; settings put secure accessibility_enabled 1");
        long serviceDeadline = Math.min(deadline, System.currentTimeMillis() + 8_000L);
        while (!AgentAccessibilityService.isConnected() && System.currentTimeMillis() < serviceDeadline) {
            sleep(250L);
        }
        if (!AgentAccessibilityService.isConnected()) {
            throw new IllegalStateException("Gelato accessibility reader did not start");
        }
    }

    private boolean dismissKnownPopup(UiSnapshot snapshot) throws Exception {
        UiNode dismiss = snapshot.find(node -> profile.blockingPromptDismissals.contains(node.text));
        if (dismiss == null || dismiss.bounds.isEmpty()) {
            return false;
        }
        logger.accept(profile.provider + " AI: dismissed blocking prompt “" + dismiss.text + "”");
        tap(dismiss);
        return true;
    }

    private void tap(UiNode node) throws Exception {
        if (node.bounds.isEmpty()) {
            throw new IllegalStateException("Target UI element has no bounds");
        }
        shell.run("input tap " + node.bounds.centerX() + " " + node.bounds.centerY());
        sleep(150L);
    }

    private void setClipboard(String value) {
        ClipboardManager clipboard = (ClipboardManager) context.getSystemService(Context.CLIPBOARD_SERVICE);
        if (clipboard == null) {
            throw new IllegalStateException("Android clipboard service is unavailable");
        }
        clipboard.setPrimaryClip(ClipData.newPlainText("Serverized AI question", value));
    }

    private static String normalize(String value) {
        return value == null ? "" : value
                .replace("\u200B", "")
                .replace("\uFFFC", "")
                .replace('\u00A0', ' ')
                .trim();
    }

    private String providerBlockedReason(String answer) {
        if (profile.provider.equals("kimi")
                && (answer.contains("聊天的人太多")
                || answer.contains("会员可优先")
                || answer.contains("优先队列"))) {
            return "provider_queue_or_subscription_limit";
        }
        return "";
    }

    private static String shellQuote(String value) {
        return "'" + value.replace("'", "'\\''") + "'";
    }

    private static void sleep(long durationMs) throws InterruptedException {
        Thread.sleep(durationMs);
    }

    private static final class UiSnapshot {
        final List<UiNode> nodes;

        UiSnapshot(List<UiNode> nodes) {
            this.nodes = nodes;
        }

        UiNode find(Predicate<UiNode> predicate) {
            for (UiNode node : nodes) {
                if (predicate.test(node)) {
                    return node;
                }
            }
            return null;
        }

        UiNode findEditText() {
            return find(node -> "android.widget.EditText".equals(node.className)
                    && !node.bounds.isEmpty());
        }

        boolean hasInputEntry(Profile profile) {
            return findEditText() != null || findInputActivator(profile) != null;
        }

        boolean hasDescription(String description) {
            return find(node -> description.equals(node.contentDescription)) != null;
        }

        boolean hasText(String text) {
            String expected = comparableText(text);
            return find(node -> expected.equals(comparableText(node.text))) != null;
        }

        boolean hasAnyTextContaining(Set<String> fragments) {
            return find(node -> {
                String comparable = comparableText(node.text);
                for (String fragment : fragments) {
                    if (comparable.contains(comparableText(fragment))) {
                        return true;
                    }
                }
                return false;
            }) != null;
        }

        UiNode locate(Locator locator, String value) {
            if (locator == Locator.TEXT) {
                String expected = comparableText(value);
                return find(node -> expected.equals(comparableText(node.text)));
            }
            if (locator == Locator.DESCRIPTION) {
                return find(node -> value.equals(node.contentDescription));
            }
            if (locator == Locator.VIEW_ID) {
                return find(node -> value.equals(node.resourceId));
            }
            if (locator == Locator.TOP_LEFT_CLICKABLE) {
                return positionalClickable(false);
            }
            if (locator == Locator.TOP_RIGHT_CLICKABLE) {
                return positionalClickable(true);
            }
            return null;
        }

        private UiNode positionalClickable(boolean rightSide) {
            int rightEdge = 0;
            for (UiNode node : nodes) {
                rightEdge = Math.max(rightEdge, node.bounds.right);
            }
            final int screenRight = rightEdge;
            return find(node -> node.clickable
                    && !node.bounds.isEmpty()
                    && node.bounds.top >= 80
                    && node.bounds.bottom <= 420
                    && node.bounds.width() <= 300
                    && node.bounds.height() <= 300
                    && (rightSide
                    ? node.bounds.centerX() >= screenRight * 2 / 3
                    : node.bounds.centerX() <= screenRight / 3));
        }

        boolean hasBlockingLogin(Profile profile) {
            return !profile.blockingLoginPrefix.isEmpty()
                    && find(node -> node.text.startsWith(profile.blockingLoginPrefix)) != null;
        }

        UiNode findInputActivator(Profile profile) {
            return find(node -> (!profile.inputActivatorDescription.isEmpty()
                    && profile.inputActivatorDescription.equals(node.contentDescription))
                    || profile.inputPrompts.contains(node.text));
        }

        UiNode findSubmit(Profile profile, UiNode input) {
            UiNode identified = find(node -> profile.submitResourceIds.contains(node.resourceId));
            if (identified != null) {
                return identified;
            }
            if (!profile.submitDescription.isEmpty()) {
                UiNode described = find(node -> profile.submitDescription.equals(node.contentDescription));
                if (described != null) {
                    return described;
                }
            }
            if (profile.qwenSubmitLayout) {
                return find(node -> node.clickable
                        && "android.widget.FrameLayout".equals(node.className)
                        && node.bounds.left >= 900
                        && node.bounds.top >= input.bounds.bottom
                        && node.bounds.top <= input.bounds.bottom + 250);
            }
            if (profile.proximitySubmit) {
                return find(node -> node.clickable
                        && !node.bounds.isEmpty()
                        && node.bounds.centerX() >= input.bounds.centerX()
                        && node.bounds.left >= input.bounds.right - 260
                        && node.bounds.top <= input.bounds.bottom + 180
                        && node.bounds.bottom >= input.bounds.top - 40);
            }
            return null;
        }

        boolean hasSubmittedQuestion(String question) {
            String expected = comparableText(question);
            return find(node -> expected.equals(comparableText(node.text))
                    && !"android.widget.EditText".equals(node.className)) != null;
        }

        boolean isGenerating() {
            return find(node -> node.contentDescription.contains("停止生成")
                    || node.text.equals("停止生成")
                    || node.text.equals("思考中")
                    || node.text.equals("正在思考")) != null;
        }

        boolean hasAnswerCompletionEvidence(String question, Profile profile) {
            boolean afterQuestion = false;
            String comparableQuestion = comparableText(question);
            for (UiNode node : nodes) {
                if (comparableQuestion.equals(comparableText(node.text))
                        && !"android.widget.EditText".equals(node.className)) {
                    afterQuestion = true;
                    continue;
                }
                if (!afterQuestion) {
                    continue;
                }
                if (isAnswerAction(node.contentDescription)
                        || isAnswerAction(node.text)
                        || node.resourceId.endsWith("/msg_action_copy")
                        || node.resourceId.endsWith("/msg_action_regenerate")) {
                    return true;
                }
                if (profile.provider.equals("qwen")
                        && node.resourceId.endsWith("/query_onscreen_answer_bottom_anchor")) {
                    return true;
                }
                if (profile.provider.equals("meituan") && node.text.contains("已完成思考")) {
                    return true;
                }
                if (profile.provider.equals("kimi")
                        && (node.text.contains("聊天的人太多")
                        || node.text.contains("会员可优先"))) {
                    return true;
                }
            }
            return false;
        }

        List<String> answerBlocks(String question, Profile profile) {
            ArrayList<String> blocks = new ArrayList<>();
            boolean afterQuestion = false;
            String comparableQuestion = comparableText(question);
            for (UiNode node : nodes) {
                String text = normalize(node.text);
                if (comparableQuestion.equals(comparableText(text))
                        && !"android.widget.EditText".equals(node.className)) {
                    afterQuestion = true;
                    blocks.clear();
                    continue;
                }
                if (!afterQuestion || !"android.widget.TextView".equals(node.className)) {
                    if (afterQuestion && isAnswerAction(node.contentDescription)) {
                        break;
                    }
                    continue;
                }
                if (profile.provider.equals("deepseek") && text.equals("复制")) {
                    // DeepSeek renders a Copy label inside a code-block header,
                    // before the code TextView itself. The semantic action node
                    // after the complete answer remains the real terminator.
                    continue;
                }
                if (isAnswerTerminator(text, profile)) {
                    break;
                }
                if (!isAnswerText(text, profile) || blocks.contains(text)) {
                    continue;
                }
                if (profile.provider.equals("qwen")) {
                    text = stripQwenQuickReply(text);
                    if (text.isEmpty()) {
                        continue;
                    }
                }
                blocks.add(text);
            }
            return blocks;
        }

        JSONArray visibleTextJson() {
            JSONArray result = new JSONArray();
            LinkedHashSet<String> unique = new LinkedHashSet<>();
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

        private static boolean isAnswerText(String text, Profile profile) {
            return text.length() >= 2
                    && !profile.excludedTexts.contains(text)
                    && !(text.startsWith("参考了") && text.contains("篇"))
                    && !(text.startsWith("搜索 ") && text.contains("参考") && text.contains("篇"))
                    && !(text.startsWith("引用 ") && text.contains("篇联网资料"))
                    && !profile.inputPrompts.contains(text)
                    && !text.contains("按住说话")
                    && !text.equals("深度思考")
                    && !text.equals("智能搜索")
                    && !text.equals("AI 创作")
                    && !text.equals("拍题答疑")
                    && !text.equals("买前问豆包")
                    && !text.equals("内容由AI生成");
        }

        private static boolean isAnswerTerminator(String text, Profile profile) {
            return profile.inputPrompts.contains(text)
                    || (profile.provider.equals("qwen") && (
                    text.equals("任务")
                            || text.equals("思考")
                            || text.equals("生活帮手")
                            || text.equals("AI生图")))
                    || text.equals("复制")
                    || text.equals("分享")
                    || text.equals("重新生成")
                    || text.equals("赞")
                    || text.equals("踩");
        }

        private static boolean isAnswerAction(String description) {
            return description.equals("复制")
                    || description.equals("喜欢")
                    || description.equals("不喜欢")
                    || description.equals("分享")
                    || description.equals("重新生成");
        }

        private static String stripQwenQuickReply(String text) {
            int lastLine = text.lastIndexOf('\n');
            if (lastLine < 0) {
                return text;
            }
            String suffix = normalize(text.substring(lastLine + 1))
                    .replace("\u2060", "")
                    .replace("\uFEFF", "")
                    .trim();
            String prefix = text.substring(0, lastLine).trim();
            if (prefix.contains("需要我") && suffix.startsWith("好的，帮我")) {
                return prefix;
            }
            return text;
        }

        private static String comparableText(String value) {
            return normalize(value).replaceAll("\\s+", "");
        }
    }

    private static final class UiNode {
        final String text;
        final String contentDescription;
        final String className;
        final String resourceId;
        final boolean clickable;
        final Rect bounds;

        UiNode(
                String text,
                String contentDescription,
                String className,
                String resourceId,
                boolean clickable,
                Rect bounds
        ) {
            this.text = text;
            this.contentDescription = contentDescription;
            this.className = className;
            this.resourceId = resourceId;
            this.clickable = clickable;
            this.bounds = bounds;
        }
    }

    static final class AutomationException extends Exception {
        AutomationException(String message, Throwable cause) {
            super(message, cause);
        }
    }

    private static final class LoginRequiredException extends Exception {
        LoginRequiredException(String message) {
            super(message);
        }
    }
}
