package dev.galatea.android;

import java.util.List;

interface RuntimeListener {
    void onRuntimeChanged(AgentSnapshot snapshot, List<String> logs);
}
