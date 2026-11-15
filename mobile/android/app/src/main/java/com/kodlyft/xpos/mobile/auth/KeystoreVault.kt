package com.kodlyft.xpos.mobile.auth

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Seals the enrollment (cashier, site, lease state, PIN verifier + throttle state) with an AES-256-GCM key
 * that lives in the Android Keystore (hardware-backed where the device has it; the key never leaves it).
 * The file sits in noBackupFilesDir, so it is excluded from backup and device transfer.
 *
 * Not stored here: the ERPNext password (never persisted) and the session cookie (held by the platform
 * cookie jar, in app-private storage, NOT additionally encrypted in this milestone).
 * androidx.security:security-crypto is deprecated, so the Keystore is used directly.
 */
class KeystoreVault(context: Context, private val alias: String = "xpos_vault_v1", fileName: String = "vault.bin") {
    private val file = File(context.noBackupFilesDir, fileName)

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(alias, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    fun write(plain: ByteArray) {
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        val sealed = c.iv + c.doFinal(plain) // 12-byte IV prefix
        val tmp = File(file.parentFile, file.name + ".tmp")
        tmp.writeBytes(sealed)
        check(tmp.renameTo(file)) { "could not replace vault file" } // atomic replace: never a half-written vault
    }

    fun read(): ByteArray? {
        if (!file.exists()) return null
        val all = file.readBytes()
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, all, 0, 12)) }
        return c.doFinal(all, 12, all.size - 12)
    }

    fun clear() {
        file.delete()
    }
}
