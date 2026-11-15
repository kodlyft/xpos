package com.kodlyft.xpos.mobile.auth

import android.content.Context
import android.os.SystemClock
import android.provider.Settings
import org.json.JSONObject
import java.security.SecureRandom

/**
 * Native owner of the access boundary. The "unlocked" flag lives only in memory, so a process restart or
 * device reboot always starts locked; the plugin refuses data calls while locked and refuses writes unless
 * the lease is valid. The JS layer is a convenience; this class is the enforcement point.
 */
class AuthManager(private val context: Context, private val vault: KeystoreVault) {
    @Volatile var unlocked = false
        private set

    data class Enrollment(val user: String, val site: String, val profile: String, val currency: String, val minorDigits: Int, val lease: LeaseGuard.Lease, val leaseState: LeaseGuard.State, val pin: PinThrottle.Record)

    private fun clock() = LeaseGuard.Clock(
        System.currentTimeMillis(),
        SystemClock.elapsedRealtime(),
        // Settings.Global.BOOT_COUNT is public since API 24 and changes on every reboot.
        Settings.Global.getInt(context.contentResolver, "boot_count", 0).toString(),
    )

    private fun load(): Enrollment? = vault.read()?.let { b ->
        val o = JSONObject(String(b, Charsets.UTF_8))
        val l = o.getJSONObject("lease"); val s = o.getJSONObject("leaseState"); val p = o.getJSONObject("pin")
        Enrollment(
            o.getString("user"), o.getString("site"), o.getString("profile"), o.getString("currency"), o.getInt("minorDigits"),
            LeaseGuard.Lease(l.getLong("issuedAtWall"), l.getLong("ttlMs")),
            LeaseGuard.State(s.getLong("consumedMs"), s.getLong("highWaterWall"), s.getLong("lastWall"), s.getLong("lastMono"), s.getString("bootId"), s.getBoolean("rollback")),
            PinThrottle.Record(p.getString("salt"), p.getString("verifier"), p.getInt("failures"), p.getLong("lockedUntilMono")),
        )
    }

    private fun save(e: Enrollment) = vault.write(
        JSONObject()
            .put("user", e.user).put("site", e.site).put("profile", e.profile).put("currency", e.currency).put("minorDigits", e.minorDigits)
            .put("lease", JSONObject().put("issuedAtWall", e.lease.issuedAtWall).put("ttlMs", e.lease.ttlMs))
            .put("leaseState", JSONObject().put("consumedMs", e.leaseState.consumedMs).put("highWaterWall", e.leaseState.highWaterWall).put("lastWall", e.leaseState.lastWall).put("lastMono", e.leaseState.lastMono).put("bootId", e.leaseState.bootId).put("rollback", e.leaseState.rollback))
            .put("pin", JSONObject().put("salt", e.pin.salt).put("verifier", e.pin.verifier).put("failures", e.pin.failures).put("lockedUntilMono", e.pin.lockedUntilMono))
            .toString().toByteArray(Charsets.UTF_8),
    )

    data class Who(val user: String, val site: String, val profile: String, val currency: String, val minorDigits: Int)

    fun enrolled(): Who? = load()?.let { Who(it.user, it.site, it.profile, it.currency, it.minorDigits) }

    fun enroll(user: String, site: String, profile: String, currency: String, minorDigits: Int, issuedAt: Long, ttlSeconds: Long, pin: String) {
        val prev = load()
        // One cashier per device: nobody can take over the device offline.
        require(prev == null || (prev.user == user && prev.site == site)) { "This device is enrolled to another cashier; sign out first." }
        val lease = LeaseGuard.Lease(issuedAt, minOf(ttlSeconds, 24 * 3600L) * 1000)
        val salt = ByteArray(16).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
        save(Enrollment(user, site, profile, currency, minorDigits, lease, LeaseGuard.start(lease, clock()), PinThrottle.create(pin, salt)))
        unlocked = true
    }

    sealed class UnlockResult {
        object Ok : UnlockResult()
        object NotEnrolled : UnlockResult()
        data class WrongPin(val retryInMs: Long) : UnlockResult()
        data class Locked(val retryInMs: Long) : UnlockResult()
    }

    @Synchronized
    fun unlock(pin: String): UnlockResult {
        val e = load() ?: return UnlockResult.NotEnrolled
        val c = clock()
        return when (val a = PinThrottle.attempt(e.pin, pin, c.monoNow)) {
            is PinThrottle.Attempt.Rejected -> {
                save(e.copy(pin = a.record))
                if (a.locked) UnlockResult.Locked(a.retryInMs) else UnlockResult.WrongPin(a.retryInMs)
            }
            is PinThrottle.Attempt.Ok -> {
                // The PIN proves who holds the device. An expired/rolled-back lease still opens the app for
                // reading and queue review (nothing is deleted); writes are refused by requireWritable().
                save(e.copy(pin = a.record, leaseState = LeaseGuard.evaluate(e.lease, e.leaseState, c).state))
                unlocked = true
                UnlockResult.Ok
            }
        }
    }

    fun lock() {
        unlocked = false
    }

    @Synchronized
    fun lease(): LeaseGuard.Evaluation? {
        val e = load() ?: return null
        val ev = LeaseGuard.evaluate(e.lease, e.leaseState, clock())
        save(e.copy(leaseState = ev.state))
        return ev
    }

    fun requireUnlocked() = check(unlocked) { "locked" }

    fun requireWritable() {
        requireUnlocked()
        check(lease()?.status?.let(LeaseGuard::writesAllowed) == true) { "lease_invalid" }
    }

    fun signOut() {
        unlocked = false
        vault.clear()
    }
}
