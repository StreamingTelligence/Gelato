package dev.galatea.device;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import androidx.annotation.NonNull;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.UUID;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class SecureCredentialStore {
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String KEY_ALIAS = "galatea_device_credential_v1";
    private static final String LEGACY_KEY_ALIAS = "serverized_device_agent_credential_v1";
    private static final String PREFS = "device_agent_protocol_v1";
    private static final String INSTALLATION_ID = "installation_id";
    private static final String AGENT_ID = "agent_id";
    private static final String DEVICE_ID = "device_id";
    private static final String CREDENTIAL = "credential";
    private final SharedPreferences preferences;

    SecureCredentialStore(@NonNull Context context) {
        preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    synchronized String installationId() {
        String existing = preferences.getString(INSTALLATION_ID, "");
        if (existing != null && existing.matches("^inst_[A-Za-z0-9_-]{12,80}$")) return existing;
        String created = "inst_" + UUID.randomUUID().toString().replace("-", "");
        preferences.edit().putString(INSTALLATION_ID, created).commit();
        return created;
    }

    synchronized Credentials credentials() {
        String agentId = preferences.getString(AGENT_ID, "");
        String deviceId = preferences.getString(DEVICE_ID, "");
        String encrypted = preferences.getString(CREDENTIAL, "");
        if (agentId == null || deviceId == null || encrypted == null
                || agentId.isEmpty() || deviceId.isEmpty() || encrypted.isEmpty()) return null;
        try {
            return new Credentials(agentId, deviceId, decrypt(encrypted));
        } catch (Exception error) {
            clear();
            return null;
        }
    }

    synchronized void bindOrigin(@NonNull String origin) {
        String previous = preferences.getString("controller_origin", "");
        if (previous != null && !previous.isEmpty() && !previous.equals(origin) && credentials() != null) {
            throw new IllegalArgumentException("Saved identity belongs to another server; unpair first");
        }
        preferences.edit().putString("controller_origin", origin).commit();
    }

    synchronized void save(@NonNull String agentId, @NonNull String deviceId, @NonNull String credential)
            throws Exception {
        preferences.edit()
                .putString(AGENT_ID, agentId)
                .putString(DEVICE_ID, deviceId)
                .putString(CREDENTIAL, encrypt(credential))
                .commit();
    }

    synchronized void clear() {
        preferences.edit().remove(AGENT_ID).remove(DEVICE_ID).remove(CREDENTIAL).remove("controller_origin").commit();
    }

    private String encrypt(String value) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key());
        byte[] ciphertext = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
        return Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP)
                + "." + Base64.encodeToString(ciphertext, Base64.NO_WRAP);
    }

    private String decrypt(String value) throws Exception {
        String[] parts = value.split("\\.", 2);
        if (parts.length != 2) throw new IllegalArgumentException("Invalid encrypted credential");
        KeyStore store = KeyStore.getInstance(KEYSTORE);
        store.load(null);
        java.security.GeneralSecurityException failure = null;
        for (String alias : new String[]{KEY_ALIAS, LEGACY_KEY_ALIAS}) {
            java.security.Key saved = store.getKey(alias, null);
            if (!(saved instanceof SecretKey)) continue;
            try {
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.DECRYPT_MODE, saved, new GCMParameterSpec(
                        128, Base64.decode(parts[0], Base64.NO_WRAP)));
                return new String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), StandardCharsets.UTF_8);
            } catch (java.security.GeneralSecurityException error) { failure = error; }
        }
        if (failure != null) throw failure;
        throw new java.security.KeyStoreException("Saved credential key is unavailable");
    }

    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance(KEYSTORE);
        store.load(null);
        java.security.Key existing = store.getKey(KEY_ALIAS, null);
        if (existing instanceof SecretKey) return (SecretKey) existing;
        java.security.Key legacy = store.getKey(LEGACY_KEY_ALIAS, null);
        if (legacy instanceof SecretKey) return (SecretKey) legacy;
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        generator.init(new KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build());
        return generator.generateKey();
    }

    static final class Credentials {
        final String agentId;
        final String deviceId;
        final String credential;

        Credentials(String agentId, String deviceId, String credential) {
            this.agentId = agentId;
            this.deviceId = deviceId;
            this.credential = credential;
        }
    }
}
