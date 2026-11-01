package dev.galatea.android;

import android.content.Context;
import android.os.Build;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import org.bouncycastle.asn1.x500.X500Name;
import org.bouncycastle.cert.X509v3CertificateBuilder;
import org.bouncycastle.cert.jcajce.JcaX509CertificateConverter;
import org.bouncycastle.cert.jcajce.JcaX509v3CertificateBuilder;
import org.bouncycastle.jce.provider.BouncyCastleProvider;
import org.bouncycastle.operator.ContentSigner;
import org.bouncycastle.operator.jcajce.JcaContentSignerBuilder;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.math.BigInteger;
import java.security.KeyFactory;
import java.security.KeyPairGenerator;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.security.cert.Certificate;
import java.security.cert.CertificateFactory;
import java.security.spec.PKCS8EncodedKeySpec;
import java.util.Date;
import java.util.concurrent.TimeUnit;

import io.github.muntashirakon.adb.AbsAdbConnectionManager;

public final class AdbConnectionManager extends AbsAdbConnectionManager {
    private static volatile AdbConnectionManager instance;

    static AdbConnectionManager getInstance(@NonNull Context context) throws Exception {
        if (instance == null) {
            synchronized (AdbConnectionManager.class) {
                if (instance == null) {
                    instance = new AdbConnectionManager(context.getApplicationContext());
                }
            }
        }
        return instance;
    }

    private final Context context;
    private final PrivateKey privateKey;
    private final Certificate certificate;

    private AdbConnectionManager(@NonNull Context context) throws Exception {
        this.context = context;
        setApi(Build.VERSION.SDK_INT);
        setTimeout(12, TimeUnit.SECONDS);
        setThrowOnUnauthorised(true);
        KeyMaterial material = loadOrCreateKeyMaterial();
        privateKey = material.privateKey;
        certificate = material.certificate;
    }

    @NonNull
    @Override
    protected PrivateKey getPrivateKey() {
        return privateKey;
    }

    @NonNull
    @Override
    protected Certificate getCertificate() {
        return certificate;
    }

    @NonNull
    @Override
    protected String getDeviceName() {
        return "NetworkBootstrapAgent-" + Build.MODEL;
    }

    private KeyMaterial loadOrCreateKeyMaterial() throws Exception {
        File privateKeyFile = new File(context.getFilesDir(), "adb_private.pk8");
        File certificateFile = new File(context.getFilesDir(), "adb_cert.der");
        PrivateKey storedPrivateKey = readPrivateKey(privateKeyFile);
        Certificate storedCertificate = readCertificate(certificateFile);
        if (storedPrivateKey != null && storedCertificate != null) {
            return new KeyMaterial(storedPrivateKey, storedCertificate);
        }

        KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA");
        generator.initialize(2048, SecureRandom.getInstance("SHA1PRNG"));
        java.security.KeyPair keyPair = generator.generateKeyPair();
        Certificate generatedCertificate = createCertificate(keyPair.getPublic(), keyPair.getPrivate());
        writeBytes(privateKeyFile, keyPair.getPrivate().getEncoded());
        writeBytes(certificateFile, generatedCertificate.getEncoded());
        return new KeyMaterial(keyPair.getPrivate(), generatedCertificate);
    }

    @Nullable
    private static PrivateKey readPrivateKey(@NonNull File file) throws Exception {
        if (!file.exists()) {
            return null;
        }
        byte[] bytes = readBytes(file);
        return KeyFactory.getInstance("RSA").generatePrivate(new PKCS8EncodedKeySpec(bytes));
    }

    @Nullable
    private static Certificate readCertificate(@NonNull File file) throws Exception {
        if (!file.exists()) {
            return null;
        }
        try (FileInputStream input = new FileInputStream(file)) {
            return CertificateFactory.getInstance("X.509").generateCertificate(input);
        }
    }

    private static Certificate createCertificate(@NonNull PublicKey publicKey, @NonNull PrivateKey privateKey)
            throws Exception {
        BouncyCastleProvider provider = new BouncyCastleProvider();
        long now = System.currentTimeMillis();
        Date notBefore = new Date(now - TimeUnit.DAYS.toMillis(1));
        Date notAfter = new Date(now + TimeUnit.DAYS.toMillis(3650));
        X500Name name = new X500Name("CN=Network Bootstrap Agent");
        BigInteger serial = new BigInteger(128, new SecureRandom()).abs();
        X509v3CertificateBuilder builder = new JcaX509v3CertificateBuilder(
                name,
                serial,
                notBefore,
                notAfter,
                name,
                publicKey
        );
        ContentSigner signer = new JcaContentSignerBuilder("SHA256withRSA")
                .setProvider(provider)
                .build(privateKey);
        return new JcaX509CertificateConverter()
                .setProvider(provider)
                .getCertificate(builder.build(signer));
    }

    private static byte[] readBytes(@NonNull File file) throws IOException {
        byte[] bytes = new byte[(int) file.length()];
        try (FileInputStream input = new FileInputStream(file)) {
            int offset = 0;
            while (offset < bytes.length) {
                int read = input.read(bytes, offset, bytes.length - offset);
                if (read < 0) {
                    break;
                }
                offset += read;
            }
        }
        return bytes;
    }

    private static void writeBytes(@NonNull File file, @NonNull byte[] bytes) throws IOException {
        try (FileOutputStream output = new FileOutputStream(file)) {
            output.write(bytes);
        }
    }

    private static final class KeyMaterial {
        final PrivateKey privateKey;
        final Certificate certificate;

        KeyMaterial(PrivateKey privateKey, Certificate certificate) {
            this.privateKey = privateKey;
            this.certificate = certificate;
        }
    }
}
