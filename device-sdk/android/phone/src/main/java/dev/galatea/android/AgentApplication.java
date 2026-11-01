package dev.galatea.android;

import android.app.Application;

import org.conscrypt.Conscrypt;

import java.security.Security;

public class AgentApplication extends Application {
    @Override
    public void onCreate() {
        super.onCreate();
        if (Security.getProvider(Conscrypt.newProvider().getName()) == null) {
            Security.insertProviderAt(Conscrypt.newProvider(), 1);
        }
        AgentRuntime.init(this);
    }
}
