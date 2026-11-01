package dev.galatea.android;

import android.accessibilityservice.AccessibilityService;
import android.graphics.Rect;
import android.os.Bundle;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import androidx.annotation.NonNull;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.io.IOException;

public final class AgentAccessibilityService extends AccessibilityService {
    private static volatile AgentAccessibilityService instance;

    static boolean isConnected() {
        return instance != null;
    }

    interface AccessCheck { void check() throws IOException; }

    /**
     * Reuses the ACTION_SET_TEXT mechanism already proven by our AI-app adapters.
     * Unlike their package-specific replacement, generic typing must target only
     * the currently focused editable field and preserve unselected text.
     * False means accepted but unverified, NEVER permission to replay the edit.
     */
    static boolean typeFocusedText(@NonNull String text, @NonNull AccessCheck access) throws IOException {
        access.check();
        AgentAccessibilityService service = instance;
        if (service == null) throw new IOException("Unicode input requires the Gelato accessibility service; enable it in Android Accessibility settings");
        AccessibilityNodeInfo field = service.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        if (field == null || !field.refresh() || !field.isFocused() || !field.isEditable()
                || !field.isEnabled() || !field.isVisibleToUser())
            throw new IOException("Tap an editable text field before typing; no focused accessible editor is available");
        if (field.isPassword()) throw new IOException("Generic accessibility typing does not replace protected password fields");
        if (!field.getActionList().contains(AccessibilityNodeInfo.AccessibilityAction.ACTION_SET_TEXT))
            throw new IOException("Focused editor does not support accessibility text input");
        String before = field.isShowingHintText() || field.getText() == null ? "" : field.getText().toString();
        String after;
        try { after = FocusedTextEdit.insert(before, field.getTextSelectionStart(), field.getTextSelectionEnd(), text); }
        catch (IllegalArgumentException error) { throw new IOException(error.getMessage()); }
        Bundle arguments = new Bundle();
        arguments.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, after);
        access.check();
        AccessibilityNodeInfo focusedNow = service.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        if (instance != service || !field.equals(focusedNow)) throw new IOException("Input focus changed before text insertion; observe again");
        if (!field.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments))
            throw new IOException("Focused editor rejected accessibility text input; no shell or keyboard fallback was attempted");
        // Some apps update accessibility asynchronously. Do not turn uncertainty
        // into a second insertion, keypress, clipboard paste or automatic submit.
        return field.refresh() && field.isFocused() && after.contentEquals(field.getText() == null ? "" : field.getText());
    }

    @NonNull
    static List<NodeSnapshot> activeWindowSnapshot() {
        AgentAccessibilityService service = instance;
        if (service == null) {
            return Collections.emptyList();
        }
        AccessibilityNodeInfo root = service.getRootInActiveWindow();
        ArrayList<NodeSnapshot> result = new ArrayList<>();
        if (root != null) {
            collect(root, result, 0);
        }
        for (AccessibilityWindowInfo window : service.getWindows()) {
            AccessibilityNodeInfo windowRoot = window.getRoot();
            if (windowRoot != null) {
                collect(windowRoot, result, 0);
            }
        }
        return result;
    }

    static boolean setActiveWindowText(@NonNull String packageName, @NonNull String text) {
        AgentAccessibilityService service = instance;
        if (service == null) {
            return false;
        }
        AccessibilityNodeInfo root = rootForPackage(service, packageName);
        if (root == null) {
            return false;
        }
        AccessibilityNodeInfo editable = findEditable(root, packageName, null, 0);
        if (editable == null) {
            return false;
        }
        Bundle arguments = new Bundle();
        arguments.putCharSequence(
                AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,
                text
        );
        return editable.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments);
    }

    static boolean clickActiveWindowDescription(
            @NonNull String packageName,
            @NonNull String description
    ) {
        AgentAccessibilityService service = instance;
        if (service == null) {
            return false;
        }
        AccessibilityNodeInfo root = rootForPackage(service, packageName);
        AccessibilityNodeInfo target = root == null
                ? null
                : findByDescription(root, packageName, description, 0);
        for (int depth = 0; target != null && depth < 5; depth += 1) {
            if (target.isClickable() && target.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
                return true;
            }
            target = target.getParent();
        }
        return false;
    }

    static boolean clickActiveWindowText(
            @NonNull String packageName,
            @NonNull String text
    ) {
        AgentAccessibilityService service = instance;
        if (service == null) {
            return false;
        }
        AccessibilityNodeInfo root = rootForPackage(service, packageName);
        AccessibilityNodeInfo target = root == null
                ? null
                : findByText(root, packageName, comparableText(text), 0);
        return clickNodeOrParent(target);
    }

    static boolean clickActiveWindowViewId(
            @NonNull String packageName,
            @NonNull String viewId
    ) {
        AgentAccessibilityService service = instance;
        if (service == null) {
            return false;
        }
        AccessibilityNodeInfo root = rootForPackage(service, packageName);
        AccessibilityNodeInfo target = root == null
                ? null
                : findByViewId(root, packageName, viewId, 0);
        return clickNodeOrParent(target);
    }

    static boolean clickActiveWindowDescriptionAfterText(
            @NonNull String packageName,
            @NonNull String markerText,
            @NonNull String description
    ) {
        AgentAccessibilityService service = instance;
        if (service == null) {
            return false;
        }
        AccessibilityNodeInfo root = rootForPackage(service, packageName);
        if (root == null) {
            return false;
        }
        boolean[] afterMarker = new boolean[]{false};
        AccessibilityNodeInfo target = findByDescriptionAfterText(
                root,
                packageName,
                comparableText(markerText),
                description,
                afterMarker,
                0
        );
        for (int depth = 0; target != null && depth < 5; depth += 1) {
            if (target.isClickable() && target.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
                return true;
            }
            target = target.getParent();
        }
        return false;
    }

    @NonNull
    private static String comparableText(String value) {
        return value == null ? "" : value.replaceAll("\\s+", "").trim();
    }

    private static AccessibilityNodeInfo findByDescriptionAfterText(
            AccessibilityNodeInfo node,
            String packageName,
            String comparableMarker,
            String description,
            boolean[] afterMarker,
            int depth
    ) {
        if (node == null || depth > 80) {
            return null;
        }
        CharSequence packageValue = node.getPackageName();
        if (packageValue != null && packageName.contentEquals(packageValue)) {
            String text = node.getText() == null ? "" : node.getText().toString();
            String contentDescription = node.getContentDescription() == null
                    ? ""
                    : node.getContentDescription().toString();
            if (comparableMarker.equals(comparableText(text))
                    || comparableMarker.equals(comparableText(contentDescription))) {
                afterMarker[0] = true;
            } else if (afterMarker[0] && description.equals(contentDescription)) {
                return node;
            }
        }
        for (int index = 0; index < node.getChildCount(); index += 1) {
            AccessibilityNodeInfo found = findByDescriptionAfterText(
                    node.getChild(index),
                    packageName,
                    comparableMarker,
                    description,
                    afterMarker,
                    depth + 1
            );
            if (found != null) {
                return found;
            }
        }
        return null;
    }

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        instance = this;
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        // Automation reads a coherent tree on demand instead of racing every event.
    }

    @Override
    public void onInterrupt() {
    }

    @Override
    public void onDestroy() {
        if (instance == this) {
            instance = null;
        }
        super.onDestroy();
    }

    private static void collect(
            @NonNull AccessibilityNodeInfo node,
            @NonNull List<NodeSnapshot> output,
            int depth
    ) {
        if (depth > 80 || output.size() >= 8_000) {
            return;
        }
        Rect bounds = new Rect();
        node.getBoundsInScreen(bounds);
        output.add(new NodeSnapshot(
                stringValue(node.getText()),
                stringValue(node.getContentDescription()),
                stringValue(node.getClassName()),
                stringValue(node.getPackageName()),
                stringValue(node.getViewIdResourceName()),
                node.isClickable(),
                bounds
        ));
        for (int index = 0; index < node.getChildCount(); index += 1) {
            AccessibilityNodeInfo child = node.getChild(index);
            if (child != null) {
                collect(child, output, depth + 1);
            }
        }
    }

    private static AccessibilityNodeInfo findEditable(
            @NonNull AccessibilityNodeInfo node,
            @NonNull String packageName,
            AccessibilityNodeInfo fallback,
            int depth
    ) {
        if (depth > 80) {
            return fallback;
        }
        boolean matchingPackage = packageName.contentEquals(
                node.getPackageName() == null ? "" : node.getPackageName()
        );
        boolean editable = node.isEditable()
                || "android.widget.EditText".contentEquals(node.getClassName());
        if (matchingPackage && editable) {
            if (node.isFocused()) {
                return node;
            }
            fallback = node;
        }
        for (int index = 0; index < node.getChildCount(); index += 1) {
            AccessibilityNodeInfo child = node.getChild(index);
            if (child == null) {
                continue;
            }
            AccessibilityNodeInfo result = findEditable(child, packageName, fallback, depth + 1);
            if (result != null && result.isFocused()) {
                return result;
            }
            if (result != null) {
                fallback = result;
            }
        }
        return fallback;
    }

    private static AccessibilityNodeInfo findByDescription(
            @NonNull AccessibilityNodeInfo node,
            @NonNull String packageName,
            @NonNull String description,
            int depth
    ) {
        if (depth > 80) {
            return null;
        }
        if (packageName.contentEquals(node.getPackageName() == null ? "" : node.getPackageName())
                && description.contentEquals(node.getContentDescription() == null
                ? ""
                : node.getContentDescription())) {
            return node;
        }
        for (int index = 0; index < node.getChildCount(); index += 1) {
            AccessibilityNodeInfo child = node.getChild(index);
            if (child == null) {
                continue;
            }
            AccessibilityNodeInfo result = findByDescription(
                    child,
                    packageName,
                    description,
                    depth + 1
            );
            if (result != null) {
                return result;
            }
        }
        return null;
    }

    private static AccessibilityNodeInfo findByText(
            @NonNull AccessibilityNodeInfo node,
            @NonNull String packageName,
            @NonNull String comparableTarget,
            int depth
    ) {
        if (depth > 80) {
            return null;
        }
        if (packageName.contentEquals(node.getPackageName() == null ? "" : node.getPackageName())
                && comparableTarget.equals(comparableText(stringValue(node.getText())))) {
            return node;
        }
        for (int index = 0; index < node.getChildCount(); index += 1) {
            AccessibilityNodeInfo child = node.getChild(index);
            if (child == null) {
                continue;
            }
            AccessibilityNodeInfo result = findByText(child, packageName, comparableTarget, depth + 1);
            if (result != null) {
                return result;
            }
        }
        return null;
    }

    private static AccessibilityNodeInfo findByViewId(
            @NonNull AccessibilityNodeInfo node,
            @NonNull String packageName,
            @NonNull String viewId,
            int depth
    ) {
        if (depth > 80) {
            return null;
        }
        if (packageName.contentEquals(node.getPackageName() == null ? "" : node.getPackageName())
                && viewId.contentEquals(node.getViewIdResourceName() == null
                ? ""
                : node.getViewIdResourceName())) {
            return node;
        }
        for (int index = 0; index < node.getChildCount(); index += 1) {
            AccessibilityNodeInfo child = node.getChild(index);
            if (child == null) {
                continue;
            }
            AccessibilityNodeInfo result = findByViewId(child, packageName, viewId, depth + 1);
            if (result != null) {
                return result;
            }
        }
        return null;
    }

    private static boolean clickNodeOrParent(AccessibilityNodeInfo target) {
        for (int depth = 0; target != null && depth < 5; depth += 1) {
            if (target.isClickable() && target.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
                return true;
            }
            target = target.getParent();
        }
        return false;
    }

    private static AccessibilityNodeInfo rootForPackage(
            @NonNull AgentAccessibilityService service,
            @NonNull String packageName
    ) {
        AccessibilityNodeInfo active = service.getRootInActiveWindow();
        if (containsPackage(active, packageName, 0)) {
            return active;
        }
        for (AccessibilityWindowInfo window : service.getWindows()) {
            AccessibilityNodeInfo root = window.getRoot();
            if (containsPackage(root, packageName, 0)) {
                return root;
            }
        }
        return active;
    }

    private static boolean containsPackage(
            AccessibilityNodeInfo node,
            @NonNull String packageName,
            int depth
    ) {
        if (node == null || depth > 80) {
            return false;
        }
        if (packageName.contentEquals(node.getPackageName() == null ? "" : node.getPackageName())) {
            return true;
        }
        for (int index = 0; index < node.getChildCount(); index += 1) {
            if (containsPackage(node.getChild(index), packageName, depth + 1)) {
                return true;
            }
        }
        return false;
    }

    @NonNull
    private static String stringValue(CharSequence value) {
        return value == null ? "" : value.toString();
    }

    static final class NodeSnapshot {
        final String text;
        final String contentDescription;
        final String className;
        final String packageName;
        final String resourceId;
        final boolean clickable;
        final Rect bounds;

        NodeSnapshot(
                String text,
                String contentDescription,
                String className,
                String packageName,
                String resourceId,
                boolean clickable,
                Rect bounds
        ) {
            this.text = text;
            this.contentDescription = contentDescription;
            this.className = className;
            this.packageName = packageName;
            this.resourceId = resourceId;
            this.clickable = clickable;
            this.bounds = new Rect(bounds);
        }
    }
}
