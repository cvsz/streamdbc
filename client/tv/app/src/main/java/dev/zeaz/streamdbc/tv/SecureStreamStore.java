package dev.zeaz.streamdbc.tv;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.ArrayList;
import java.util.List;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

public final class SecureStreamStore {
    private static final String PREF = "streamdbc_tv_secure";
    private static final String KEY_ALIAS = "streamdbc_tv_channels_v1";
    private static final String CIPHERTEXT = "channels_ciphertext";
    private static final String IV = "channels_iv";
    private final SharedPreferences prefs;

    public SecureStreamStore(Context context) {
        prefs = context.getSharedPreferences(PREF, Context.MODE_PRIVATE);
    }

    public List<StreamConfig> load() throws Exception {
        String encrypted = prefs.getString(CIPHERTEXT, null);
        String iv = prefs.getString(IV, null);
        if (encrypted == null || iv == null) return new ArrayList<>();

        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)));
        byte[] clear = cipher.doFinal(Base64.decode(encrypted, Base64.NO_WRAP));

        JSONArray array = new JSONArray(new String(clear, StandardCharsets.UTF_8));
        List<StreamConfig> result = new ArrayList<>();
        for (int i = 0; i < array.length(); i++) {
            JSONObject item = array.getJSONObject(i);
            result.add(new StreamConfig(item.getString("name"), item.getString("url")));
        }
        return result;
    }

    public void save(List<StreamConfig> channels) throws Exception {
        JSONArray array = new JSONArray();
        for (StreamConfig channel : channels) {
            JSONObject item = new JSONObject();
            item.put("name", channel.name());
            item.put("url", channel.url());
            array.put(item);
        }

        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key());
        byte[] encrypted = cipher.doFinal(array.toString().getBytes(StandardCharsets.UTF_8));

        if (!prefs.edit()
                .putString(CIPHERTEXT, Base64.encodeToString(encrypted, Base64.NO_WRAP))
                .putString(IV, Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
                .commit()) {
            throw new IllegalStateException("Failed to persist encrypted channel configuration");
        }
    }

    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        KeyStore.Entry existing = store.getEntry(KEY_ALIAS, null);
        if (existing instanceof KeyStore.SecretKeyEntry entry) return entry.getSecretKey();

        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return generator.generateKey();
    }
}
