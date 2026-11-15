package com.kodlyft.xpos.mobile

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.kodlyft.xpos.mobile.auth.AuthManager
import com.kodlyft.xpos.mobile.auth.AuthManager.UnlockResult
import com.kodlyft.xpos.mobile.auth.KeystoreVault
import com.kodlyft.xpos.mobile.auth.LeaseGuard
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.security.KeyStore

/** Real Android Keystore, real vault file, real SystemClock. A fresh AuthManager over the same vault stands in for a process restart. */
@RunWith(AndroidJUnit4::class)
class AuthInstrumentedTest {
    private lateinit var ctx: Context
    private val alias = "xpos_vault_test"
    private val fileName = "vault-test.bin"

    private fun vault() = KeystoreVault(ctx, alias, fileName)
    private fun auth() = AuthManager(ctx, vault())
    private fun enroll(a: AuthManager, issuedAt: Long = System.currentTimeMillis(), ttl: Long = 24 * 3600L, pin: String = "123456") =
        a.enroll("cashier@shop.test", "https://shop.test", "Main", "PKR", 2, issuedAt, ttl, pin)

    @Before fun setUp() { ctx = ApplicationProvider.getApplicationContext(); cleanup() }
    @After fun cleanup() {
        File(ctx.noBackupFilesDir, fileName).delete()
        KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.let { if (it.containsAlias(alias)) it.deleteEntry(alias) }
    }

    @Test fun enrollmentIsSealedWithAKeystoreKeyAndNothingIsReadableOnDisk() {
        val a = auth(); enroll(a)
        assertTrue(a.unlocked)
        val raw = File(ctx.noBackupFilesDir, fileName).readBytes()
        assertFalse(String(raw, Charsets.ISO_8859_1).contains("cashier@shop.test"))
        assertFalse(String(raw, Charsets.ISO_8859_1).contains("123456"))
        assertTrue(KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.containsAlias(alias))
        assertEquals("cashier@shop.test", vault().read()!!.let { auth().enrolled()!!.user })
    }

    @Test fun processRestartStartsLockedAndOnlyTheRightPinUnlocks() {
        enroll(auth())
        val restarted = auth()
        assertFalse(restarted.unlocked)
        try { restarted.requireUnlocked(); fail("must be locked after a restart") } catch (e: IllegalStateException) { /* expected */ }
        assertTrue(restarted.unlock("000000") is UnlockResult.WrongPin)
        assertFalse(restarted.unlocked)
        assertEquals(UnlockResult.Ok, restarted.unlock("123456"))
        assertTrue(restarted.unlocked)
        restarted.lock() // what backgrounding calls
        assertFalse(restarted.unlocked)
    }

    @Test fun repeatedWrongPinsLockTheDeviceAndSurviveARestart() {
        enroll(auth())
        var a = auth()
        var last: UnlockResult = UnlockResult.Ok
        repeat(8) { last = a.unlock("999999") }
        assertTrue("expected a throttle lock, got $last", last is UnlockResult.Locked)
        a = auth() // restart: the throttle lives in the sealed vault, not memory
        assertTrue(a.unlock("123456") is UnlockResult.Locked)
        assertFalse(a.unlocked)
    }

    @Test fun oneCashierPerDeviceAndSignOutClearsTheVault() {
        val a = auth(); enroll(a)
        try { a.enroll("other@shop.test", "https://shop.test", "Main", "PKR", 2, System.currentTimeMillis(), 3600, "111111"); fail("second cashier must be refused") } catch (e: IllegalArgumentException) { /* expected */ }
        a.signOut()
        assertNull(auth().enrolled())
        assertFalse(File(ctx.noBackupFilesDir, fileName).exists())
    }

    @Test fun leaseIsCappedAt24HoursAndAnExpiredLeaseStillUnlocksButRefusesWrites() {
        val a = auth()
        enroll(a, issuedAt = System.currentTimeMillis() - 30 * 3600_000L, ttl = 72 * 3600L) // ttl is capped to 24 h, issued 30 h ago
        val ev = a.lease()!!
        assertEquals(LeaseGuard.Status.EXPIRED, ev.status)
        val restarted = auth()
        assertEquals(UnlockResult.Ok, restarted.unlock("123456")) // reading and queue review still possible
        try { restarted.requireWritable(); fail("writes must be refused after expiry") } catch (e: IllegalStateException) { assertEquals("lease_invalid", e.message) }
    }

    @Test fun aFreshLeaseAllowsWrites() {
        val a = auth(); enroll(a)
        a.requireWritable()
        assertNotNull(a.lease())
        assertEquals(LeaseGuard.Status.VALID, a.lease()!!.status)
    }
}
