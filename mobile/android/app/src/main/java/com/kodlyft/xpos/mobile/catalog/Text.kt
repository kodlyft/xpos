package com.kodlyft.xpos.mobile.catalog

import android.util.Base64
import org.json.JSONArray
import java.text.Normalizer
import java.util.Locale

/** Search semantics, identical to mobile/src/domain/search.ts (PREFIX on normalised name or code; barcodes exact). */
object Text {
    const val MAX_PAGE = 100
    const val DEFAULT_PAGE = 50
    const val MAX_QUERY_LEN = 64
    private val MARKS = Regex("\\p{M}+")
    private val SPACES = Regex("\\s+")

    /** U+10FFFF as a UTF-16 pair: sorts after every valid code point in SQLite's BINARY (UTF-8) collation. */
    const val PREFIX_END = "􏿿"

    fun normalize(text: String): String =
        Normalizer.normalize(text, Normalizer.Form.NFKD).replace(MARKS, "").lowercase(Locale.ROOT).replace(SPACES, " ").trim()

    fun normalizeQuery(text: String): String = normalize(text).let { if (it.length > MAX_QUERY_LEN) it.substring(0, MAX_QUERY_LEN) else it }

    fun clampLimit(limit: Int?): Int = (limit ?: DEFAULT_PAGE).coerceIn(1, MAX_PAGE)

    /** UTF-8 byte order == code point order; Kotlin's String.compareTo is UTF-16 order and differs for astral characters. */
    fun compareCodePoints(a: String, b: String): Int {
        var i = 0
        var j = 0
        while (i < a.length && j < b.length) {
            val x = a.codePointAt(i)
            val y = b.codePointAt(j)
            if (x != y) return if (x < y) -1 else 1
            i += Character.charCount(x)
            j += Character.charCount(y)
        }
        return (a.length - i).compareTo(b.length - j)
    }

    data class Cursor(val nameNorm: String, val itemCode: String)

    fun encodeCursor(c: Cursor): String =
        Base64.encodeToString(JSONArray().put(c.nameNorm).put(c.itemCode).toString().toByteArray(Charsets.UTF_8), Base64.NO_WRAP)

    fun decodeCursor(s: String?): Cursor? {
        if (s.isNullOrEmpty()) return null
        return try {
            val a = JSONArray(String(Base64.decode(s, Base64.NO_WRAP), Charsets.UTF_8))
            Cursor(a.getString(0), a.getString(1))
        } catch (e: Exception) {
            throw IllegalArgumentException("invalid page cursor")
        }
    }
}
