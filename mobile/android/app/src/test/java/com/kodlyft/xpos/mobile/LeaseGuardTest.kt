package com.kodlyft.xpos.mobile

import com.kodlyft.xpos.mobile.auth.LeaseGuard
import com.kodlyft.xpos.mobile.auth.LeaseGuard.Status
import org.junit.Assert.assertEquals
import org.junit.Test

class LeaseGuardTest {
    private val ttl = 86_400_000L
    private val lease = LeaseGuard.Lease(issuedAtWall = 1_000_000, ttlMs = ttl)

    private fun clock(wall: Long, mono: Long, boot: String) = LeaseGuard.Clock(wall, mono, boot)
    private fun start(wall: Long = 1_000_000, mono: Long = 0, boot: String = "A") = LeaseGuard.start(lease, clock(wall, mono, boot))

    @Test fun freshLeaseIsValid() {
        val ev = LeaseGuard.evaluate(lease, start(mono = 5000), clock(1_000_000, 5000, "A"))
        assertEquals(Status.VALID, ev.status); assertEquals(ttl, ev.remainingMs)
    }

    @Test fun sameBootWallClockForwardIsIgnoredAndMonotonicTimeIsUsed() {
        val ev = LeaseGuard.evaluate(lease, start(), clock(90_000_000, 3_600_000, "A"))
        assertEquals(Status.VALID, ev.status); assertEquals(ttl - 3_600_000, ev.remainingMs)
    }

    @Test fun sameBootWallClockMovedBackIsARollback() {
        assertEquals(Status.ROLLBACK, LeaseGuard.evaluate(lease, start(), clock(500_000, 3_600_000, "A")).status)
    }

    @Test fun expiresByMonotonicTime() {
        val ev = LeaseGuard.evaluate(lease, start(), clock(1_000_000, ttl, "A"))
        assertEquals(Status.EXPIRED, ev.status); assertEquals(0L, ev.remainingMs)
    }

    @Test fun rebootFollowsWallDeltaAndRollbackIsStickyUntilReissued() {
        var ev = LeaseGuard.evaluate(lease, start(), clock(4_600_000, 3_600_000, "A"))
        assertEquals(ttl - 3_600_000, ev.remainingMs)
        ev = LeaseGuard.evaluate(lease, ev.state, clock(11_800_000, 100, "B")) // reboot, clock moved forward normally
        assertEquals(Status.VALID, ev.status); assertEquals(ttl - 10_800_000, ev.remainingMs)
        val back = LeaseGuard.evaluate(lease, ev.state, clock(2_000_000, 50, "C")) // reboot, clock set back below the high-water mark
        assertEquals(Status.ROLLBACK, back.status)
        assertEquals(Status.ROLLBACK, LeaseGuard.evaluate(lease, back.state, clock(90_000_000, 7_000_000, "C")).status)
    }

    @Test fun longPowerOffExpiresTheLease() {
        assertEquals(Status.EXPIRED, LeaseGuard.evaluate(lease, start(), clock(100_000_000, 10, "B")).status)
    }

    @Test fun onlyAValidLeaseAllowsWrites() {
        assertEquals(true, LeaseGuard.writesAllowed(Status.VALID))
        assertEquals(false, LeaseGuard.writesAllowed(Status.EXPIRED))
        assertEquals(false, LeaseGuard.writesAllowed(Status.ROLLBACK))
    }
}
