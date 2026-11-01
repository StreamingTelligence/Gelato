package dev.galatea.android;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;

import androidx.annotation.NonNull;

import org.json.JSONObject;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.Consumer;

final class AiAppAutomation {
    interface ShellRunner {
        String run(@NonNull String command) throws Exception;
    }

    private enum Flow {
        XIAOHONGSHU_SEARCH,
        DIRECT_CHAT
    }

    static final class AdapterSpec {
        final String provider;
        final String packageName;
        final long minVersionCode;
        final long maxVersionCode;
        final String revision;
        final Flow flow;
        final DirectChatAiAutomation.Profile directChatProfile;

        AdapterSpec(
                String provider,
                String packageName,
                long minVersionCode,
                long maxVersionCode,
                String revision,
                Flow flow,
                DirectChatAiAutomation.Profile directChatProfile
        ) {
            this.provider = provider;
            this.packageName = packageName;
            this.minVersionCode = minVersionCode;
            this.maxVersionCode = maxVersionCode;
            this.revision = revision;
            this.flow = flow;
            this.directChatProfile = directChatProfile;
        }

        boolean supports(long versionCode) {
            return versionCode >= minVersionCode && versionCode <= maxVersionCode;
        }
    }

    private static final Map<String, AdapterSpec> ADAPTERS = buildAdapters();

    private final Context context;
    private final ShellRunner shell;
    private final Consumer<String> logger;

    AiAppAutomation(
            @NonNull Context context,
            @NonNull ShellRunner shell,
            @NonNull Consumer<String> logger
    ) {
        this.context = context.getApplicationContext();
        this.shell = shell;
        this.logger = logger;
    }

    JSONObject ask(
            @NonNull String rawProvider,
            @NonNull String question,
            long timeoutMs
    ) throws Exception {
        String provider = normalizeProvider(rawProvider);
        AdapterSpec spec = ADAPTERS.get(provider);
        if (spec == null) {
            throw new IllegalArgumentException(
                    "Unsupported AI app provider: " + rawProvider
                            + ". Supported providers: " + String.join(", ", ADAPTERS.keySet())
            );
        }
        PackageInfo packageInfo;
        try {
            packageInfo = context.getPackageManager().getPackageInfo(spec.packageName, 0);
        } catch (PackageManager.NameNotFoundException error) {
            throw new IllegalStateException(
                    "The " + provider + " app is not installed (" + spec.packageName + ")",
                    error
            );
        }
        long versionCode = packageInfo.getLongVersionCode();
        if (!spec.supports(versionCode)) {
            throw new IllegalStateException(
                    "No tested " + provider + " adapter for versionCode " + versionCode
                            + " (installed version " + packageInfo.versionName + "). "
                            + "Current adapter " + spec.revision + " supports "
                            + spec.minVersionCode + ".." + spec.maxVersionCode
            );
        }

        JSONObject result;
        if (spec.flow == Flow.XIAOHONGSHU_SEARCH) {
            result = new XiaohongshuAiAutomation(
                    context,
                    shell::run,
                    logger
            ).ask(question, timeoutMs);
        } else {
            result = new DirectChatAiAutomation(
                    context,
                    shell::run,
                    logger,
                    spec.directChatProfile
            ).ask(question, timeoutMs);
        }
        return result
                .put("type", "askAiApp")
                .put("provider", provider)
                .put("adapterRevision", spec.revision)
                .put("packageName", spec.packageName)
                .put("packageVersionName", packageInfo.versionName)
                .put("packageVersionCode", versionCode);
    }

    private static Map<String, AdapterSpec> buildAdapters() {
        LinkedHashMap<String, AdapterSpec> adapters = new LinkedHashMap<>();
        register(adapters, new AdapterSpec(
                "xiaohongshu",
                "com.xingin.xhs",
                9_351_803L,
                9_351_803L,
                "xiaohongshu-9.35-v1",
                Flow.XIAOHONGSHU_SEARCH,
                null
        ));
        register(adapters, new AdapterSpec(
                "qwen",
                "com.aliyun.tongyi",
                61_205L,
                61_205L,
                "qwen-6.12-v2",
                Flow.DIRECT_CHAT,
                DirectChatAiAutomation.Profile.qwen()
        ));
        register(adapters, new AdapterSpec(
                "doubao",
                "com.larus.nova",
                14_000_001L,
                14_000_001L,
                "doubao-14.0-v2",
                Flow.DIRECT_CHAT,
                DirectChatAiAutomation.Profile.doubao()
        ));
        register(adapters, new AdapterSpec(
                "deepseek",
                "com.deepseek.chat",
                229L,
                229L,
                "deepseek-2.2-v2",
                Flow.DIRECT_CHAT,
                DirectChatAiAutomation.Profile.deepSeek()
        ));
        register(adapters, new AdapterSpec(
                "xiaobu",
                "com.heytap.speechassist",
                120_906L,
                120_906L,
                "xiaobu-12.9-v2",
                Flow.DIRECT_CHAT,
                DirectChatAiAutomation.Profile.xiaobu()
        ));
        register(adapters, new AdapterSpec(
                "meituan",
                "com.sankuai.meituan",
                1_200_630_202L,
                1_200_630_202L,
                "meituan-xiaotuan-12.63-v2",
                Flow.DIRECT_CHAT,
                DirectChatAiAutomation.Profile.meituan()
        ));
        register(adapters, new AdapterSpec(
                "kimi",
                "com.moonshot.kimichat",
                361L,
                361L,
                "kimi-k3-3.0-v2",
                Flow.DIRECT_CHAT,
                DirectChatAiAutomation.Profile.kimi()
        ));
        return adapters;
    }

    private static void register(Map<String, AdapterSpec> adapters, AdapterSpec spec) {
        adapters.put(spec.provider, spec);
    }

    private static String normalizeProvider(String value) {
        String provider = value == null ? "" : value.trim().toLowerCase();
        if ("千问".equals(provider) || "tongyi".equals(provider)) {
            return "qwen";
        }
        if ("豆包".equals(provider)) {
            return "doubao";
        }
        if ("小红书".equals(provider) || "xhs".equals(provider)) {
            return "xiaohongshu";
        }
        if ("小布".equals(provider)
                || "手机助手".equals(provider)
                || "assistant".equals(provider)) {
            return "xiaobu";
        }
        if ("美团".equals(provider) || "小团".equals(provider) || "xiaotuan".equals(provider)) {
            return "meituan";
        }
        if ("月之暗面".equals(provider)) {
            return "kimi";
        }
        return provider;
    }
}
