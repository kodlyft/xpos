package com.kodlyft.xpos.mobile.auth

/**
 * Offline-authorization lease. Mirror of mobile/src/domain/lease.ts, checked against the same
 * vectors (mobile/shared/lease-vectors.json) by LeaseGuardTest.
 *
 * Trust model (honest limits):
 *  - Within one boot the monotonic clock (SystemClock.elapsedRealtime) is trusted; wall-clock edits cannot move it.
 *  - Across a reboot only the wall clock exists. A persisted high-water mark of the latest wall time seen turns a
 *    clock set BACK into "rollback", which blocks new operational writes until the server re-issues the lease.
 *  - Remaining gap: a clock set back by less than the powered-off interval and still above the high-water mark can
 *    regain up to that interval. Only contacting the server closes it.
 *  - Local unlock never renews ERPNext authorization; permissions are re-checked at posting time.
 */
object LeaseGuard {
    data class Lease(val issuedAtWall: Long, val ttlMs: Long)
    data class Clock(val wallNow: Long, val monoNow: Long, val bootId: String)
    data class State(
        val consumedMs: Long,
        val highWaterWall: Long,
        val lastWall: Long,
        val lastMono: Long,
        val bootId: String,
        val rollback: Boolean,
    )
    enum class Status { VALID, EXPIRED, ROLLBACK }
    data class Evaluation(val status: Status, val remainingMs: Long, val state: State)

    fun start(lease: Lease, c: Clock) =
        State(maxOf(0, c.wallNow - lease.issuedAtWall), c.wallNow, c.wallNow, c.monoNow, c.bootId, false)

    fun evaluate(lease: Lease, prev: State, c: Clock): Evaluation {
        var consumed = prev.consumedMs
        var rollback = prev.rollback
        if (c.bootId == prev.bootId && c.monoNow >= prev.lastMono) {
            consumed += c.monoNow - prev.lastMono
            if (c.wallNow < prev.highWaterWall) rollback = true
        } else {
            if (c.wallNow < prev.highWaterWall) rollback = true else consumed += maxOf(0, c.wallNow - prev.lastWall)
        }
        val next = State(consumed, maxOf(prev.highWaterWall, c.wallNow), c.wallNow, c.monoNow, c.bootId, rollback)
        val remaining = maxOf(0, lease.ttlMs - consumed)
        val status = when {
            rollback -> Status.ROLLBACK
            remaining == 0L -> Status.EXPIRED
            else -> Status.VALID
        }
        return Evaluation(status, remaining, next)
    }

    fun writesAllowed(s: Status) = s == Status.VALID
}
