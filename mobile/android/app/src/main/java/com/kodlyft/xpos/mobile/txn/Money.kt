package com.kodlyft.xpos.mobile.txn

import java.math.BigInteger

/** Integer minor-unit money (mirrors mobile/src/domain/money.ts). Quantities are integer thousandths. */
object Money {
    const val QTY_SCALE = 1000L

    fun requireDigits(d: Int) = require(d in 0..4) { "invalid minor digits: $d" }

    /** price (minor per unit) x qty (thousandths), rounded half away from zero to a minor unit. */
    fun lineTotalMinor(priceMinor: Long, qtyMilli: Long): Long {
        val p = BigInteger.valueOf(priceMinor).multiply(BigInteger.valueOf(qtyMilli))
        val s = BigInteger.valueOf(QTY_SCALE)
        val q = p.abs().multiply(BigInteger.TWO).add(s).divide(s.multiply(BigInteger.TWO))
        val r = if (p.signum() < 0) q.negate() else q
        return r.longValueExact()
    }
}

/** JSON.stringify-compatible canonical form: sorted keys, no spaces, "/" not escaped. Used for idempotency hashes. */
object CanonicalJson {
    fun write(value: Any?): String = StringBuilder().also { append(it, value) }.toString()

    private fun append(sb: StringBuilder, v: Any?) {
        when (v) {
            null -> sb.append("null")
            is Boolean -> sb.append(v)
            is Int, is Long -> sb.append(v.toString())
            is Number -> throw IllegalArgumentException("only integer numbers are allowed in money payloads")
            is String -> quote(sb, v)
            is Map<*, *> -> {
                sb.append('{')
                v.entries.filter { it.value != null }.sortedBy { it.key as String }.forEachIndexed { i, e ->
                    if (i > 0) sb.append(',')
                    quote(sb, e.key as String); sb.append(':'); append(sb, e.value)
                }
                sb.append('}')
            }
            is List<*> -> { sb.append('['); v.forEachIndexed { i, x -> if (i > 0) sb.append(','); append(sb, x) }; sb.append(']') }
            else -> throw IllegalArgumentException("unsupported type ${v::class}")
        }
    }

    private fun quote(sb: StringBuilder, s: String) {
        sb.append('"')
        for (c in s) when {
            c == '"' -> sb.append("\\\"")
            c == '\\' -> sb.append("\\\\")
            c == '\b' -> sb.append("\\b")
            c == '\u000C' -> sb.append("\\f")
            c == '\n' -> sb.append("\\n")
            c == '\r' -> sb.append("\\r")
            c == '\t' -> sb.append("\\t")
            c < ' ' -> sb.append(String.format("\\u%04x", c.code))
            else -> sb.append(c)
        }
        sb.append('"')
    }
}
