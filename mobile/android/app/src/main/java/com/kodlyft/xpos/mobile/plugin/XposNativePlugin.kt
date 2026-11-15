package com.kodlyft.xpos.mobile.plugin

import android.os.SystemClock
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.kodlyft.xpos.mobile.auth.AuthManager
import com.kodlyft.xpos.mobile.auth.KeystoreVault
import com.kodlyft.xpos.mobile.catalog.CatalogRepository
import com.kodlyft.xpos.mobile.catalog.Item
import com.kodlyft.xpos.mobile.catalog.ItemPage
import com.kodlyft.xpos.mobile.db.CatalogScope
import com.kodlyft.xpos.mobile.db.SaleRow
import com.kodlyft.xpos.mobile.db.XposDb
import com.kodlyft.xpos.mobile.hw.Capabilities
import com.kodlyft.xpos.mobile.txn.SampleLine
import com.kodlyft.xpos.mobile.txn.SampleSale
import com.kodlyft.xpos.mobile.txn.TransactionRepository
import com.kodlyft.xpos.mobile.txn.TxnConflictException
import com.kodlyft.xpos.mobile.txn.TxnWriteException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

/**
 * Bridge between the Vue UI and the native services. Rules enforced HERE (not trusted to JS):
 *  - every data call needs an unlocked session; sales need a valid offline lease;
 *  - payloads are bounded (pages <= 100 rows, batches <= 1000 items);
 *  - all database work runs off the main thread.
 */
@CapacitorPlugin(name = "XposNative")
class XposNativePlugin : Plugin() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private lateinit var db: XposDb
    private lateinit var catalog: CatalogRepository
    private lateinit var txns: TransactionRepository
    private lateinit var auth: AuthManager
    private var pausedAt = 0L

    override fun load() {
        db = XposDb.open(context)
        catalog = CatalogRepository(db)
        txns = TransactionRepository(db)
        auth = AuthManager(context, KeystoreVault(context))
    }

    override fun handleOnPause() {
        pausedAt = SystemClock.elapsedRealtime()
    }

    /** Lock natively when the app was in the background for at least AUTO_LOCK_MS (the process may also just die: that locks too). */
    override fun handleOnResume() {
        if (pausedAt != 0L && SystemClock.elapsedRealtime() - pausedAt >= AUTO_LOCK_MS) auth.lock()
        pausedAt = 0
    }

    override fun handleOnDestroy() {
        scope.cancel()
    }

    private fun launch(call: PluginCall, needsUnlock: Boolean = true, block: suspend () -> JSObject?) {
        scope.launch {
            try {
                if (needsUnlock) auth.requireUnlocked()
                call.resolve(block() ?: JSObject())
            } catch (e: com.kodlyft.xpos.mobile.txn.TransactionRepository.SaleConflictException) {
                call.reject(e.message, "SALE_CONFLICT")
            } catch (e: com.kodlyft.xpos.mobile.db.ReadOnlySchemaException) {
                call.reject(e.message, "SCHEMA_READ_ONLY")
            } catch (e: TxnConflictException) {
                call.reject(e.message, "TXN_CONFLICT")
            } catch (e: TxnWriteException) {
                call.reject(e.message, "TXN_WRITE_FAILED")
            } catch (e: IllegalStateException) {
                call.reject(e.message, if (e.message == "locked") "LOCKED" else if (e.message == "lease_invalid") "LEASE_INVALID" else "STATE")
            } catch (e: IllegalArgumentException) {
                call.reject(e.message, "BAD_REQUEST")
            } catch (e: Exception) {
                call.reject(e.message ?: e.javaClass.simpleName, "NATIVE_ERROR")
            }
        }
    }

    // ---- JSON helpers -----------------------------------------------------------------------------
    private fun JSObject.str(k: String): String = getString(k) ?: throw IllegalArgumentException("missing $k")
    private fun itemJson(i: Item) = JSObject()
        .put("itemCode", i.itemCode).put("variantOf", i.variantOf ?: JSONObject.NULL).put("name", i.name).put("itemGroup", i.itemGroup)
        .put("uom", i.uom).put("priceMinor", i.priceMinor).put("priced", i.priced).put("brand", i.brand ?: JSONObject.NULL)
        .put("attrs", JSONObject(i.attrs)).put("barcodes", JSONArray(i.barcodes))
    private fun pageJson(p: ItemPage) = JSObject().put("items", JSArray().also { a -> p.items.forEach { a.put(itemJson(it)) } }).also { if (p.next != null) it.put("next", p.next) }
    private fun parseItem(o: JSONObject) = Item(
        o.getString("itemCode"), o.optString("variantOf").takeIf { it.isNotEmpty() && it != "null" }, o.getString("name"), o.getString("itemGroup"),
        o.getString("uom"), o.getLong("priceMinor"), o.getBoolean("priced"), o.optString("brand").takeIf { it.isNotEmpty() && it != "null" },
        o.optJSONObject("attrs")?.let { a -> a.keys().asSequence().associateWith { a.getString(it) } } ?: emptyMap(),
        o.optJSONArray("barcodes")?.let { a -> List(a.length()) { a.getString(it) } } ?: emptyList(),
    )
    private fun scopeJson(s: CatalogScope) = JSObject()
        .put("scopeId", s.scopeId).put("site", s.site).put("company", s.company ?: JSONObject.NULL).put("warehouse", s.warehouse ?: JSONObject.NULL)
        .put("priceList", s.priceList ?: JSONObject.NULL).put("currency", s.currency).put("minorDigits", s.minorDigits).put("activeGen", s.activeGen ?: JSONObject.NULL)

    // ---- catalog ----------------------------------------------------------------------------------
    @PluginMethod fun createScope(call: PluginCall) = launch(call) {
        catalog.createScope(CatalogScope(call.data.str("scopeId"), call.data.str("site"), call.data.optString("company").ifEmpty { null }, call.data.optString("warehouse").ifEmpty { null }, call.data.optString("priceList").ifEmpty { null }, call.data.str("currency"), call.data.getInt("minorDigits"), null, 0))
        null
    }
    @PluginMethod fun listScopes(call: PluginCall) = launch(call) { JSObject().put("scopes", JSArray().also { a -> catalog.listScopes().forEach { a.put(scopeJson(it)) } }) }
    @PluginMethod fun dropScope(call: PluginCall) = launch(call) { catalog.dropScope(call.data.str("scopeId")); null }
    @PluginMethod fun beginGeneration(call: PluginCall) = launch(call) { JSObject().put("gen", catalog.beginGeneration(call.data.str("scopeId"))) }
    @PluginMethod fun putBatch(call: PluginCall) = launch(call) {
        val arr = call.data.getJSONArray("items")
        require(arr.length() <= CatalogRepository.MAX_BATCH) { "batch too large" }
        catalog.putBatch(call.data.str("scopeId"), call.data.getInt("gen"), List(arr.length()) { parseItem(arr.getJSONObject(it)) })
        null
    }
    @PluginMethod fun activate(call: PluginCall) = launch(call) { catalog.activate(call.data.str("scopeId"), call.data.getInt("gen"), call.data.getInt("expectedItems")); null }
    @PluginMethod fun discard(call: PluginCall) = launch(call) { catalog.discard(call.data.str("scopeId"), call.data.getInt("gen")); null }
    @PluginMethod fun lookupBarcode(call: PluginCall) = launch(call) {
        val r = catalog.lookupBarcode(call.data.str("scopeId"), call.data.str("barcode"))
        JSObject().put("matches", JSArray().also { a -> r.matches.forEach { a.put(itemJson(it)) } }).put("ambiguous", r.ambiguous)
    }
    @PluginMethod fun getItem(call: PluginCall) = launch(call) { JSObject().put("item", catalog.getItem(call.data.str("scopeId"), call.data.str("itemCode"))?.let(::itemJson) ?: JSONObject.NULL) }
    @PluginMethod fun search(call: PluginCall) = launch(call) {
        pageJson(catalog.search(call.data.str("scopeId"), call.data.str("query"), call.data.optString("after").ifEmpty { null }, if (call.data.has("limit")) call.data.getInt("limit") else null, call.data.optBoolean("variantsOnly", false)))
    }
    @PluginMethod fun page(call: PluginCall) = launch(call) {
        pageJson(catalog.page(call.data.str("scopeId"), call.data.optString("after").ifEmpty { null }, if (call.data.has("limit")) call.data.getInt("limit") else null, call.data.optBoolean("variantsOnly", false)))
    }
    @PluginMethod fun variantsOf(call: PluginCall) = launch(call) { JSObject().put("items", JSArray().also { a -> catalog.variantsOf(call.data.str("scopeId"), call.data.str("templateCode")).forEach { a.put(itemJson(it)) } }) }
    @PluginMethod fun stats(call: PluginCall) = launch(call) {
        val s = catalog.stats(call.data.str("scopeId"), context.getDatabasePath("xpos-mobile.db").length())
        JSObject().put("items", s.items).put("barcodes", s.barcodes).put("activeGen", s.activeGen ?: JSONObject.NULL).put("dbBytes", s.dbBytes ?: JSONObject.NULL)
    }

    // ---- sample transaction -----------------------------------------------------------------------
    @PluginMethod fun commitSample(call: PluginCall) = launch(call) {
        auth.requireWritable() // native enforcement of the offline lease: no new writes once expired/rolled back
        val d = call.data
        val lines = d.getJSONArray("lines")
        val sale = SampleSale(d.str("clientTxnId"), d.str("scopeId"), d.str("currency"), d.getInt("minorDigits"),
            List(lines.length()) { lines.getJSONObject(it).let { l -> SampleLine(l.getString("itemCode"), l.getString("name"), l.getLong("priceMinor"), l.getLong("qtyMilli")) } })
        val r = txns.commitSample(sale)
        JSObject().put("status", r.status).put("receipt", JSONObject(r.receiptJson))
    }
    private fun saleJson(r: SaleRow) = JSObject()
        .put("txnId", r.txnId).put("scopeId", r.scopeId).put("status", r.status).put("bodyJson", r.bodyJson).put("contentHash", r.contentHash)
        .put("currency", r.currency).put("minorDigits", r.minorDigits).put("payableMinor", r.payableMinor).put("evidenceJson", r.evidenceJson)
        .put("serverJson", r.serverJson ?: JSONObject.NULL).put("invoice", r.invoice ?: JSONObject.NULL).put("message", r.message)
        .put("attempts", r.attempts).put("createdAt", r.createdAt).put("updatedAt", r.updatedAt)
    @PluginMethod fun saveSale(call: PluginCall) = launch(call) {
        auth.requireWritable() // same offline-lease rule as any new sale
        val d = call.data
        val r = txns.saveSale(SaleRow(d.str("txnId"), d.str("scopeId"), "captured", d.str("bodyJson"), d.str("contentHash"), d.str("currency"), d.getInt("minorDigits"), d.getLong("payableMinor"), d.str("evidenceJson"), null, null, "", 0, 0, 0))
        JSObject().put("created", r.first).put("sale", saleJson(r.second))
    }
    @PluginMethod fun getSale(call: PluginCall) = launch(call) { JSObject().put("sale", txns.getSale(call.data.str("txnId"))?.let(::saleJson) ?: JSONObject.NULL) }
    @PluginMethod fun updateSale(call: PluginCall) = launch(call) {
        val d = call.data
        fun optStr(k: String) = if (d.has(k) && !d.isNull(k)) d.getString(k) else null
        val r = txns.updateSale(
            d.str("txnId"), optStr("status"), optStr("serverJson"), d.has("serverJson"), optStr("invoice"), d.has("invoice"),
            optStr("message"), optStr("bodyJson"), optStr("evidenceJson"), if (d.has("payableMinor")) d.getLong("payableMinor") else null, d.optBoolean("attempt", false),
        )
        JSObject().put("sale", saleJson(r))
    }
    @PluginMethod fun listSales(call: PluginCall) = launch(call) {
        val st = call.data.getJSONArray("statuses")
        val rows = txns.listSales(List(st.length()) { st.getString(it) }, call.data.optInt("limit", 100))
        JSObject().put("sales", JSArray().also { a -> rows.forEach { a.put(saleJson(it)) } })
    }
    @PluginMethod fun applyDelta(call: PluginCall) = launch(call) {
        auth.requireWritable()
        val up = call.data.getJSONArray("upserts")
        val rm = call.data.getJSONArray("removed")
        catalog.applyDelta(call.data.str("scopeId"), List(up.length()) { parseItem(up.getJSONObject(it)) }, List(rm.length()) { rm.getString(it) })
        null
    }
    @PluginMethod fun codePage(call: PluginCall) = launch(call) {
        val codes = catalog.codePage(call.data.str("scopeId"), call.data.getString("after"), call.data.optInt("limit", 2000))
        JSObject().put("codes", JSArray().also { a -> codes.forEach { a.put(it) } })
    }
    @PluginMethod fun getReceipt(call: PluginCall) = launch(call) { JSObject().put("receipt", txns.receipt(call.data.str("clientTxnId"))?.let { JSONObject(it) } ?: JSONObject.NULL) }
    @PluginMethod fun outboxCounts(call: PluginCall) = launch(call) { JSObject().put("counts", JSONObject(txns.outboxCounts() as Map<*, *>)) }

    // ---- auth / lease (the enforcement point) -----------------------------------------------------
    @PluginMethod fun enroll(call: PluginCall) = launch(call, needsUnlock = false) {
        val d = call.data
        auth.enroll(d.str("user"), d.str("site"), d.str("profile"), d.str("currency"), d.getInt("minorDigits"), d.getLong("issuedAt"), d.getLong("leaseTtlSeconds"), d.str("pin"))
        null
    }
    @PluginMethod fun enrolled(call: PluginCall) = launch(call, needsUnlock = false) {
        JSObject().put("enrolled", auth.enrolled()?.let { JSObject().put("user", it.user).put("site", it.site).put("profile", it.profile).put("currency", it.currency).put("minorDigits", it.minorDigits) } ?: JSONObject.NULL)
    }
    @PluginMethod fun unlock(call: PluginCall) = launch(call, needsUnlock = false) {
        when (val r = auth.unlock(call.data.str("pin"))) {
            is AuthManager.UnlockResult.Ok -> JSObject().put("ok", true)
            is AuthManager.UnlockResult.NotEnrolled -> JSObject().put("ok", false).put("reason", "not_enrolled")
            is AuthManager.UnlockResult.WrongPin -> JSObject().put("ok", false).put("reason", "wrong_pin").put("retryInMs", r.retryInMs)
            is AuthManager.UnlockResult.Locked -> JSObject().put("ok", false).put("reason", "locked").put("retryInMs", r.retryInMs)
        }
    }
    @PluginMethod fun lock(call: PluginCall) = launch(call, needsUnlock = false) { auth.lock(); null }
    @PluginMethod fun leaseStatus(call: PluginCall) = launch(call, needsUnlock = false) {
        JSObject().put("lease", auth.lease()?.let { JSObject().put("status", it.status.name.lowercase()).put("remainingMs", it.remainingMs) } ?: JSONObject.NULL)
    }
    @PluginMethod fun signOut(call: PluginCall) = launch(call, needsUnlock = false) { auth.signOut(); null }

    // ---- diagnostics ------------------------------------------------------------------------------
    @PluginMethod fun schemaInfo(call: PluginCall) = launch(call, needsUnlock = false) {
        val doc = XposDb.loadSchema(context)
        val sync = db.lastSync
        JSObject().put("fingerprint", doc.fingerprint).put("tables", doc.models.size)
            .put("changedAtLastOpen", sync?.changed ?: JSONObject.NULL)
            .put("addedColumns", JSArray(sync?.addedColumns ?: emptyList<String>()))
            .put("unmanaged", JSArray(sync?.unmanaged ?: emptyList<String>()))
    }
    @PluginMethod fun scannerCapabilities(call: PluginCall) = launch(call, needsUnlock = false) { JSObject().put("capabilities", JSArray(Capabilities.scanners().toString())) }
    @PluginMethod fun printerCapabilities(call: PluginCall) = launch(call, needsUnlock = false) { JSObject().put("capabilities", JSArray(Capabilities.printers().toString())) }

    companion object { const val AUTO_LOCK_MS = 30_000L }
}
