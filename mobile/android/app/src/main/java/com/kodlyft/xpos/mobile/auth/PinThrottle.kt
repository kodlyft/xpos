package com.kodlyft.xpos.mobile.auth

import java.security.MessageDigest
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec

/** PIN verifier + retry throttling. Mirror of mobile/src/domain/pin.ts. The verifier is further sealed by the Keystore vault. */
object PinThrottle {
    const val PIN_LENGTH = 6
    const val MAX_FREE_FAILURES = 4
    const val BASE_LOCK_MS = 30_000L
    const val MAX_LOCK_MS = 15 * 60_000L
    private const val ITERATIONS = 150_000

    data class Record(val salt: String, val verifier: String, val failures: Int, val lockedUntilMono: Long)
    sealed class Attempt {
        data class Ok(val record: Record) : Attempt()
        data class Rejected(val locked: Boolean, val record: Record, val retryInMs: Long) : Attempt()
    }

    fun lockDurationMs(failures: Int): Long =
        if (failures <= MAX_FREE_FAILURES) 0 else minOf(MAX_LOCK_MS, BASE_LOCK_MS * (1L shl (failures - MAX_FREE_FAILURES - 1).coerceAtMost(20)))

    fun validFormat(pin: String) = pin.length == PIN_LENGTH && pin.all { it in '0'..'9' }

    fun hash(pin: String, salt: String): String {
        val spec = PBEKeySpec(pin.toCharArray(), salt.toByteArray(Charsets.UTF_8), ITERATIONS, 256)
        return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded.joinToString("") { "%02x".format(it) }
    }

    fun create(pin: String, salt: String, hasher: (String, String) -> String = ::hash): Record {
        require(validFormat(pin)) { "PIN must be 6 digits" }
        return Record(salt, hasher(pin, salt), 0, 0)
    }

    fun attempt(rec: Record, pin: String, monoNow: Long, hasher: (String, String) -> String = ::hash): Attempt {
        if (monoNow < rec.lockedUntilMono) return Attempt.Rejected(true, rec, rec.lockedUntilMono - monoNow)
        val good = MessageDigest.isEqual(hasher(pin, rec.salt).toByteArray(), rec.verifier.toByteArray())
        if (good) return Attempt.Ok(rec.copy(failures = 0, lockedUntilMono = 0))
        val failures = rec.failures + 1
        val lock = lockDurationMs(failures)
        return Attempt.Rejected(false, rec.copy(failures = failures, lockedUntilMono = if (lock > 0) monoNow + lock else 0), lock)
    }
}
