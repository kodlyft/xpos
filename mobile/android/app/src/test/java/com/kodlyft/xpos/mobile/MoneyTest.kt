package com.kodlyft.xpos.mobile

import com.kodlyft.xpos.mobile.catalog.Text
import com.kodlyft.xpos.mobile.txn.CanonicalJson
import com.kodlyft.xpos.mobile.txn.Money
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MoneyTest {
    @Test fun roundsHalfAwayFromZeroWithoutFloatDrift() {
        assertEquals(5997L, Money.lineTotalMinor(1999, 3000))
        assertEquals(1L, Money.lineTotalMinor(1, 500))
        assertEquals(-1L, Money.lineTotalMinor(-1, 500))
        assertEquals(500L, Money.lineTotalMinor(333, 1500))
    }

    @Test fun canonicalJsonSortsKeysAndEscapesLikeJsonStringify() {
        assertEquals("""{"a":1,"b":"x\"/\n"}""", CanonicalJson.write(mapOf("b" to "x\"/\n", "a" to 1, "skip" to null)))
        assertEquals("[1,[2],{}]", CanonicalJson.write(listOf(1, listOf(2), emptyMap<String, Any>())))
    }

    @Test fun normalizeMatchesTypeScript() {
        assertEquals("cafe creme", Text.normalize("  Café   CRÈME "))
        assertEquals("abc", Text.normalizeQuery("ABC"))
        assertTrue(Text.compareCodePoints("a", "b") < 0)
        assertTrue(Text.compareCodePoints("￿", "😀") < 0) // BMP char sorts before an astral char in UTF-8 order
    }

}
