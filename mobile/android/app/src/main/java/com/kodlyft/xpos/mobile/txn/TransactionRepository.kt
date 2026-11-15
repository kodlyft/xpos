package com.kodlyft.xpos.mobile.txn

import com.kodlyft.xpos.mobile.db.Outbox
import com.kodlyft.xpos.mobile.db.SampleTxn
import com.kodlyft.xpos.mobile.db.SaleRow
import com.kodlyft.xpos.mobile.db.XposDb
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.security.MessageDigest

data class SampleLine(val itemCode: String, val name: String, val priceMinor: Long, val qtyMilli: Long)
data class SampleSale(val clientTxnId: String, val scopeId: String, val currency: String, val minorDigits: Int, val lines: List<SampleLine>)
data class CommitResult(val status: String, val receiptJson: String)

class TxnConflictException(id: String) : Exception("transaction id $id already exists with different contents")
class TxnWriteException(cause: Throwable) : Exception("sample transaction was not saved", cause)

/**
 * Sample-only transactions. Sale + receipt snapshot + outbox command are written in ONE SQLite
 * transaction; the caller is told "saved" only after it commits. Never posts to ERPNext.
 */
class TransactionRepository(
    private val db: XposDb,
    private val now: () -> Long = System::currentTimeMillis,
    /** Test hook (instrumented tests): throw at a stage to prove full rollback. */
    var faultHook: ((String) -> Unit)? = null,
) {
    suspend fun commitSample(sale: SampleSale): CommitResult {
        validate(sale)
        val canonical = CanonicalJson.write(saleMap(sale))
        val hash = MessageDigest.getInstance("SHA-256").digest(canonical.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
        val capturedAt = now()
        val lines = sale.lines.map { it to Money.lineTotalMinor(it.priceMinor, it.qtyMilli) }
        val total = lines.sumOf { it.second }
        val receipt = CanonicalJson.write(
            mapOf(
                "clientTxnId" to sale.clientTxnId, "sample" to true, "notice" to NOTICE, "currency" to sale.currency, "minorDigits" to sale.minorDigits,
                "lines" to lines.map { (l, t) -> mapOf("itemCode" to l.itemCode, "name" to l.name, "priceMinor" to l.priceMinor, "qtyMilli" to l.qtyMilli, "totalMinor" to t) },
                "totalMinor" to total, "capturedAt" to capturedAt,
            ),
        )
        try {
            return withContext(Dispatchers.IO) { db.write {
                val dao = db.txn()
                val ex = dao.txn(sale.clientTxnId)
                if (ex != null) {
                    if (ex.contentHash != hash) throw TxnConflictException(sale.clientTxnId)
                    return@write CommitResult("duplicate", ex.receiptJson)
                }
                dao.insertTxn(SampleTxn(sale.clientTxnId, hash, sale.scopeId, sale.currency, sale.minorDigits, total, canonical, "{}", capturedAt))
                faultHook?.invoke("after-sale")
                dao.setReceipt(sale.clientTxnId, receipt)
                faultHook?.invoke("after-receipt")
                dao.insertOutbox(Outbox("cmd-${sale.clientTxnId}", sale.clientTxnId, "SAMPLE", "blocked", null, null, 0, "sample transaction: never posted to ERPNext", capturedAt))
                faultHook?.invoke("after-outbox")
                CommitResult("created", receipt)
            } }
        } catch (e: TxnConflictException) {
            throw e
        } catch (e: Exception) {
            throw TxnWriteException(e)
        }
    }

    /** Real sales. JSON bodies and the hash arrive from the web layer as strings and are stored verbatim. */
    class SaleConflictException(id: String) : Exception("sale id $id already exists with different contents")

    suspend fun saveSale(n: SaleRow): Pair<Boolean, SaleRow> = withContext(Dispatchers.IO) {
        db.write {
            val dao = db.txn()
            val ex = dao.sale(n.txnId)
            if (ex != null) {
                if (ex.contentHash != n.contentHash) throw SaleConflictException(n.txnId)
                return@write false to ex
            }
            val row = n.copy(status = "captured", serverJson = null, invoice = null, message = "", attempts = 0, createdAt = now(), updatedAt = now())
            dao.insertSale(row)
            true to row
        }
    }

    suspend fun getSale(id: String): SaleRow? = withContext(Dispatchers.IO) { db.txn().sale(id) }

    suspend fun updateSale(id: String, status: String?, serverJson: String?, setServer: Boolean, invoice: String?, setInvoice: Boolean, message: String?, bodyJson: String?, evidenceJson: String?, payableMinor: Long?, attempt: Boolean): SaleRow =
        withContext(Dispatchers.IO) {
            db.write {
                val dao = db.txn()
                val cur = requireNotNull(dao.sale(id)) { "unknown sale $id" }
                val next = cur.copy(
                    status = status ?: cur.status,
                    serverJson = if (setServer) serverJson else cur.serverJson,
                    invoice = if (setInvoice) invoice else cur.invoice,
                    message = message ?: cur.message,
                    bodyJson = bodyJson ?: cur.bodyJson,
                    evidenceJson = evidenceJson ?: cur.evidenceJson,
                    payableMinor = payableMinor ?: cur.payableMinor,
                    attempts = cur.attempts + if (attempt) 1 else 0,
                    updatedAt = now(),
                )
                dao.updateSale(next)
                next
            }
        }

    suspend fun listSales(statuses: List<String>, limit: Int): List<SaleRow> = withContext(Dispatchers.IO) { db.txn().sales(statuses, limit.coerceIn(1, 200)) }

    suspend fun receipt(id: String): String? = withContext(Dispatchers.IO) { db.txn().txn(id)?.receiptJson?.takeIf { it != "{}" } }
    suspend fun outboxCounts(): Map<String, Int> = withContext(Dispatchers.IO) { db.txn().outboxCounts().associate { it.state to it.n } }

    private fun validate(s: SampleSale) {
        require(s.clientTxnId.isNotEmpty()) { "clientTxnId required" }
        Money.requireDigits(s.minorDigits)
        require(s.lines.isNotEmpty()) { "a sale needs at least one line" }
        s.lines.forEach { require(it.qtyMilli != 0L) { "line ${it.itemCode}: qty must be non-zero" } }
    }

    private fun saleMap(s: SampleSale) = mapOf(
        "clientTxnId" to s.clientTxnId, "scopeId" to s.scopeId, "currency" to s.currency, "minorDigits" to s.minorDigits,
        "lines" to s.lines.map { mapOf("itemCode" to it.itemCode, "name" to it.name, "priceMinor" to it.priceMinor, "qtyMilli" to it.qtyMilli) },
    )

    companion object { const val NOTICE = "SAMPLE ONLY: not an invoice, not posted to ERPNext, no payment taken." }
}
