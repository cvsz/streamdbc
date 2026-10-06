package dev.zeaz.streamdbc.tv

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

data class StreamProfile(
    val id: String,
    val name: String,
    val uri: String
)

class SecureStreamStore(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun list(): List<StreamProfile> {
        val raw = prefs.getString(KEY_PROFILES, "[]") ?: "[]"
        val array = runCatching { JSONArray(raw) }.getOrElse { JSONArray() }
        val result = mutableListOf<StreamProfile>()

        for (index in 0 until array.length()) {
            val item = array.optJSONObject(index) ?: continue
            val id = item.optString("id")
            val name = item.optString("name")
            val sealedUri = item.optString("sealedUri")
            if (id.isBlank() || name.isBlank() || sealedUri.isBlank()) continue

            val uri = runCatching { decrypt(sealedUri) }.getOrNull() ?: continue
            if (RtspUriPolicy.validate(uri).isFailure) continue
            result += StreamProfile(id = id, name = name, uri = uri)
        }
        return result
    }

    fun save(name: String, uri: String): StreamProfile {
        val validUri = RtspUriPolicy.validate(uri).getOrThrow()
        val normalizedName = name.trim().ifBlank {
            runCatching { java.net.URI(validUri).host }.getOrNull() ?: "RTSP Stream"
        }.take(MAX_NAME_LENGTH)

        val existing = list().toMutableList()
        val profile = StreamProfile(
            id = UUID.randomUUID().toString(),
            name = normalizedName,
            uri = validUri
        )
        existing.add(0, profile)
        persist(existing.take(MAX_PROFILES))
        setLastUsed(profile.id)
        return profile
    }

    fun delete(id: String) {
        persist(list().filterNot { it.id == id })
        if (prefs.getString(KEY_LAST_ID, null) == id) {
            prefs.edit().remove(KEY_LAST_ID).apply()
        }
    }

    fun lastUsed(): StreamProfile? {
        val id = prefs.getString(KEY_LAST_ID, null) ?: return null
        return list().firstOrNull { it.id == id }
    }

    fun setLastUsed(id: String) {
        prefs.edit().putString(KEY_LAST_ID, id).apply()
    }

    private fun persist(profiles: List<StreamProfile>) {
        val array = JSONArray()
        profiles.forEach { profile ->
            array.put(
                JSONObject()
                    .put("id", profile.id)
                    .put("name", profile.name)
                    .put("sealedUri", encrypt(profile.uri))
            )
        }
        prefs.edit().putString(KEY_PROFILES, array.toString()).apply()
    }

    private fun encrypt(plaintext: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
        val iv = Base64.encodeToString(cipher.iv, Base64.NO_WRAP)
        val ciphertext = Base64.encodeToString(cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)
        return "v1:$iv:$ciphertext"
    }

    private fun decrypt(value: String): String {
        val parts = value.split(":", limit = 3)
        require(parts.size == 3 && parts[0] == "v1") { "Unsupported encrypted stream format" }

        val iv = Base64.decode(parts[1], Base64.NO_WRAP)
        val ciphertext = Base64.decode(parts[2], Base64.NO_WRAP)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), GCMParameterSpec(128, iv))
        return cipher.doFinal(ciphertext).toString(Charsets.UTF_8)
    }

    private fun getOrCreateKey(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return generator.generateKey()
    }

    private companion object {
        const val PREFS_NAME = "streamdbc_tv_secure"
        const val KEY_PROFILES = "profiles"
        const val KEY_LAST_ID = "last_profile_id"
        const val KEY_ALIAS = "streamdbc_tv_rtsp_profiles_v1"
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val MAX_PROFILES = 50
        const val MAX_NAME_LENGTH = 80
    }
}
