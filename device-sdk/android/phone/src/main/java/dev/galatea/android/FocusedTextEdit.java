package dev.galatea.android;

/** Plans insertion using Android's UTF-16 selection offsets, without shell quoting or IME changes. */
final class FocusedTextEdit {
    private FocusedTextEdit() {}

    static boolean needsUnicodeInput(String text) {
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (c < 32 || c > 126) return true;
        }
        return false;
    }

    static String insert(String before, int start, int end, String text) {
        // An empty EditText may expose no selection until the first edit.
        if (before.isEmpty() && start == -1 && end == -1) start = end = 0;
        if (start < 0 || end < 0 || start > before.length() || end > before.length())
            throw new IllegalArgumentException("Focused field did not expose a valid text selection");
        int left = Math.min(start, end), right = Math.max(start, end);
        if (splitsSurrogate(before, left) || splitsSurrogate(before, right))
            throw new IllegalArgumentException("Focused field selection splits a Unicode character");
        return before.substring(0, left) + text + before.substring(right);
    }

    private static boolean splitsSurrogate(String value, int offset) {
        return offset > 0 && offset < value.length()
                && Character.isHighSurrogate(value.charAt(offset - 1))
                && Character.isLowSurrogate(value.charAt(offset));
    }
}
