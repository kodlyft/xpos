package com.kodlyft.xpos.mobile

import com.kodlyft.xpos.mobile.auth.PinThrottle
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PinThrottleTest {
    private val fakeHash = { pin: String, salt: String -> "h($salt:$pin)" }

    @Test fun locksWithBackoffAndResetsOnSuccess() {
        var rec = PinThrottle.create("123456", "s", fakeHash)
        repeat(4) {
            val r = PinThrottle.attempt(rec, "000000", 1000, fakeHash) as PinThrottle.Attempt.Rejected
            assertTrue(!r.locked); rec = r.record
        }
        val fifth = PinThrottle.attempt(rec, "000000", 1000, fakeHash) as PinThrottle.Attempt.Rejected
        assertEquals(30_000L, fifth.retryInMs); rec = fifth.record
        assertTrue((PinThrottle.attempt(rec, "123456", 2000, fakeHash) as PinThrottle.Attempt.Rejected).locked) // right PIN refused while locked
        val ok = PinThrottle.attempt(rec, "123456", 40_000, fakeHash) as PinThrottle.Attempt.Ok
        assertEquals(0, ok.record.failures)
        assertEquals(15 * 60_000L, PinThrottle.lockDurationMs(100))
    }

    @Test fun rejectsBadFormat() {
        assertTrue(!PinThrottle.validFormat("12345")); assertTrue(!PinThrottle.validFormat("12345a")); assertTrue(PinThrottle.validFormat("012345"))
    }
}
