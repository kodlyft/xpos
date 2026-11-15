package com.kodlyft.xpos.mobile.db

import android.content.ContentValues
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase

private fun Cursor.str(n: String): String = getString(getColumnIndexOrThrow(n))
private fun Cursor.strOrNull(n: String): String? = getColumnIndexOrThrow(n).let { if (isNull(it)) null else getString(it) }
private fun Cursor.int(n: String): Int = getInt(getColumnIndexOrThrow(n))
private fun Cursor.long(n: String): Long = getLong(getColumnIndexOrThrow(n))
private fun Cursor.longOrNull(n: String): Long? = getColumnIndexOrThrow(n).let { if (isNull(it)) null else getLong(it) }
private fun Cursor.intOrNull(n: String): Int? = getColumnIndexOrThrow(n).let { if (isNull(it)) null else getInt(it) }
private fun <T> Cursor.list(map: Cursor.() -> T): List<T> = use { buildList { while (moveToNext()) add(map()) } }
private fun placeholders(n: Int) = List(n) { "?" }.joinToString(",")

/** Catalog queries. Same SQL as the host adapter (mobile/src/adapters/sqlite-host); API 24 safe (no row values, no RETURNING). */
class CatalogStore(private val db: SQLiteDatabase) {
    private fun q(sql: String, vararg args: Any?): Cursor = db.rawQuery(sql, args.map { it?.toString() }.toTypedArray())
    private fun scalarInt(sql: String, vararg args: Any?): Int? = q(sql, *args).use { if (it.moveToFirst() && !it.isNull(0)) it.getInt(0) else null }
    private fun scalarStr(sql: String, vararg args: Any?): String? = q(sql, *args).use { if (it.moveToFirst() && !it.isNull(0)) it.getString(0) else null }

    private fun scope(c: Cursor) = CatalogScope(c.str("scope_id"), c.str("site"), c.strOrNull("company"), c.strOrNull("warehouse"), c.strOrNull("price_list"), c.str("currency"), c.int("minor_digits"), c.intOrNull("active_gen"), c.long("created_at"))
    private fun itemRow(c: Cursor) = ItemRow(c.str("scope_id"), c.int("gen"), c.str("item_code"), c.strOrNull("variant_of"), c.str("name"), c.str("name_norm"), c.str("code_norm"), c.str("item_group"), c.str("uom"), c.long("price_minor"), c.long("priced") == 1L, c.strOrNull("brand"))

    fun insertScope(s: CatalogScope) {
        db.execSQL(
            "INSERT INTO catalog_scope (scope_id,site,company,warehouse,price_list,currency,minor_digits,active_gen,created_at) VALUES (?,?,?,?,?,?,?,NULL,?)",
            arrayOf<Any?>(s.scopeId, s.site, s.company, s.warehouse, s.priceList, s.currency, s.minorDigits, s.createdAt),
        )
    }
    fun scopes(): List<CatalogScope> = q("SELECT * FROM catalog_scope ORDER BY scope_id").list { scope(this) }
    fun scope(id: String): CatalogScope? = q("SELECT * FROM catalog_scope WHERE scope_id = ?", id).list { scope(this) }.firstOrNull()
    fun activeGen(id: String): Int? = scalarInt("SELECT active_gen FROM catalog_scope WHERE scope_id = ?", id)

    fun deleteScopeData(id: String) {
        for (t in listOf("item", "item_barcode", "item_attr", "serial_known", "batch_known")) db.execSQL("DELETE FROM $t WHERE scope_id = ?", arrayOf(id))
        db.execSQL("DELETE FROM catalog_scope WHERE scope_id = ?", arrayOf(id)) // generations cascade
    }

    fun nextGen(id: String): Int = scalarInt("SELECT COALESCE(MAX(gen), 0) + 1 FROM catalog_generation WHERE scope_id = ?", id) ?: 1
    fun insertGeneration(id: String, gen: Int, now: Long) =
        db.execSQL("INSERT INTO catalog_generation (scope_id,gen,state,item_count,created_at) VALUES (?,?, 'staging', 0, ?)", arrayOf<Any>(id, gen, now))
    fun genState(id: String, gen: Int): String? = scalarStr("SELECT state FROM catalog_generation WHERE scope_id = ? AND gen = ?", id, gen)
    fun addCount(id: String, gen: Int, n: Int) = db.execSQL("UPDATE catalog_generation SET item_count = item_count + ? WHERE scope_id = ? AND gen = ?", arrayOf<Any>(n, id, gen))
    fun activate(id: String, gen: Int) {
        db.execSQL("UPDATE catalog_generation SET state = 'retired' WHERE scope_id = ? AND state = 'active'", arrayOf<Any>(id))
        db.execSQL("UPDATE catalog_generation SET state = 'active' WHERE scope_id = ? AND gen = ?", arrayOf<Any>(id, gen))
        db.execSQL("UPDATE catalog_scope SET active_gen = ? WHERE scope_id = ?", arrayOf<Any>(gen, id))
    }
    fun retiredGens(id: String): List<Int> = q("SELECT gen FROM catalog_generation WHERE scope_id = ? AND state = 'retired'", id).list { getInt(0) }
    fun deleteGeneration(id: String, gen: Int) {
        for (t in listOf("item", "item_barcode", "item_attr")) db.execSQL("DELETE FROM $t WHERE scope_id = ? AND gen = ?", arrayOf<Any>(id, gen))
        db.execSQL("DELETE FROM catalog_generation WHERE scope_id = ? AND gen = ?", arrayOf<Any>(id, gen))
    }

    fun insertItems(rows: List<ItemRow>) = rows.forEach { r ->
        db.execSQL(
            "INSERT INTO item (scope_id,gen,item_code,variant_of,name,name_norm,code_norm,item_group,uom,price_minor,priced,brand) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            arrayOf<Any?>(r.scopeId, r.gen, r.itemCode, r.variantOf, r.name, r.nameNorm, r.codeNorm, r.itemGroup, r.uom, r.priceMinor, if (r.priced) 1 else 0, r.brand),
        )
    }
    fun insertBarcodes(rows: List<ItemBarcode>) = rows.forEach {
        val cv = ContentValues().apply { put("scope_id", it.scopeId); put("gen", it.gen); put("barcode", it.barcode); put("item_code", it.itemCode); put("uom", it.uom) }
        db.insertWithOnConflict("item_barcode", null, cv, SQLiteDatabase.CONFLICT_IGNORE)
    }
    fun insertAttrs(rows: List<ItemAttr>) = rows.forEach {
        db.execSQL("INSERT INTO item_attr (scope_id,gen,item_code,attr,value) VALUES (?,?,?,?,?)", arrayOf<Any>(it.scopeId, it.gen, it.itemCode, it.attr, it.value))
    }
    fun deleteItem(id: String, gen: Int, code: String) {
        for (t in listOf("item", "item_barcode", "item_attr")) db.execSQL("DELETE FROM $t WHERE scope_id = ? AND gen = ? AND item_code = ?", arrayOf<Any>(id, gen, code))
    }
    fun setCount(id: String, gen: Int, n: Int) = db.execSQL("UPDATE catalog_generation SET item_count = ? WHERE scope_id = ? AND gen = ?", arrayOf<Any>(n, id, gen))
    fun codePage(id: String, gen: Int, after: String, limit: Int): List<String> =
        q("SELECT item_code FROM item WHERE scope_id = ? AND gen = ? AND item_code > ? ORDER BY item_code LIMIT ?", id, gen, after, limit).list { getString(0) }
    fun countItems(id: String, gen: Int): Int = scalarInt("SELECT COUNT(*) FROM item WHERE scope_id = ? AND gen = ?", id, gen) ?: 0
    fun countBarcodes(id: String, gen: Int): Int = scalarInt("SELECT COUNT(*) FROM item_barcode WHERE scope_id = ? AND gen = ?", id, gen) ?: 0

    fun barcodeCodes(id: String, gen: Int, barcode: String): List<String> =
        q("SELECT item_code FROM item_barcode WHERE scope_id = ? AND gen = ? AND barcode = ? ORDER BY item_code LIMIT 5", id, gen, barcode).list { getString(0) }
    fun itemsByCodes(id: String, gen: Int, codes: List<String>): List<ItemRow> =
        if (codes.isEmpty()) emptyList() else q("SELECT * FROM item WHERE scope_id = ? AND gen = ? AND item_code IN (${placeholders(codes.size)})", id, gen, *codes.toTypedArray()).list { itemRow(this) }
    fun item(id: String, gen: Int, code: String): ItemRow? = q("SELECT * FROM item WHERE scope_id = ? AND gen = ? AND item_code = ?", id, gen, code).list { itemRow(this) }.firstOrNull()
    fun barcodesFor(id: String, gen: Int, codes: List<String>): List<BarcodeOf> =
        q("SELECT item_code, barcode FROM item_barcode WHERE scope_id = ? AND gen = ? AND item_code IN (${placeholders(codes.size)}) ORDER BY barcode", id, gen, *codes.toTypedArray()).list { BarcodeOf(str("item_code"), str("barcode")) }
    fun attrsFor(id: String, gen: Int, codes: List<String>): List<AttrOf> =
        q("SELECT item_code, attr, value FROM item_attr WHERE scope_id = ? AND gen = ? AND item_code IN (${placeholders(codes.size)})", id, gen, *codes.toTypedArray()).list { AttrOf(str("item_code"), str("attr"), str("value")) }

    private val keyset = "AND name_norm >= ? AND (name_norm > ? OR item_code > ?)"
    private fun variantsClause(on: Boolean) = if (on) "AND variant_of IS NOT NULL" else ""

    // Keystroke search: prefix on name_norm OR code_norm, keyset-paged on (name_norm, item_code); merged in the repository.
    fun searchByName(id: String, gen: Int, lo: String, hi: String, afterName: String, afterCode: String, limit: Int, variantsOnly: Boolean = false): List<ItemRow> =
        q("SELECT * FROM item WHERE scope_id = ? AND gen = ? AND name_norm >= ? AND name_norm < ? $keyset ${variantsClause(variantsOnly)} ORDER BY name_norm, item_code LIMIT ?", id, gen, lo, hi, afterName, afterName, afterCode, limit).list { itemRow(this) }
    fun searchByCode(id: String, gen: Int, lo: String, hi: String, afterName: String, afterCode: String, limit: Int, variantsOnly: Boolean = false): List<ItemRow> =
        q("SELECT * FROM item WHERE scope_id = ? AND gen = ? AND code_norm >= ? AND code_norm < ? $keyset ${variantsClause(variantsOnly)} ORDER BY name_norm, item_code LIMIT ?", id, gen, lo, hi, afterName, afterName, afterCode, limit).list { itemRow(this) }
    fun page(id: String, gen: Int, afterName: String, afterCode: String, limit: Int, variantsOnly: Boolean = false): List<ItemRow> =
        q("SELECT * FROM item WHERE scope_id = ? AND gen = ? $keyset ${variantsClause(variantsOnly)} ORDER BY name_norm, item_code LIMIT ?", id, gen, afterName, afterName, afterCode, limit).list { itemRow(this) }
    fun variants(id: String, gen: Int, tpl: String): List<ItemRow> =
        q("SELECT * FROM item WHERE scope_id = ? AND gen = ? AND variant_of = ? ORDER BY name_norm, item_code LIMIT 500", id, gen, tpl).list { itemRow(this) }
}

data class StateCount(val state: String, val n: Int)

class TxnStore(private val db: SQLiteDatabase) {
    private fun q(sql: String, vararg args: Any?): Cursor = db.rawQuery(sql, args.map { it?.toString() }.toTypedArray())
    private fun outbox(c: Cursor) = Outbox(c.str("command_id"), c.str("txn_id"), c.str("kind"), c.str("state"), c.strOrNull("claim_token"), c.longOrNull("claim_until"), c.int("attempts"), c.strOrNull("blocked_reason"), c.long("created_at"))

    fun txn(id: String): SampleTxn? = q("SELECT * FROM sample_txn WHERE txn_id = ?", id).list {
        SampleTxn(str("txn_id"), str("content_hash"), str("scope_id"), str("currency"), int("minor_digits"), long("total_minor"), str("sale_json"), str("receipt_json"), long("created_at"))
    }.firstOrNull()
    fun insertTxn(t: SampleTxn) = db.execSQL(
        "INSERT INTO sample_txn (txn_id,content_hash,scope_id,currency,minor_digits,total_minor,sale_json,receipt_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        arrayOf<Any>(t.txnId, t.contentHash, t.scopeId, t.currency, t.minorDigits, t.totalMinor, t.saleJson, t.receiptJson, t.createdAt),
    )
    fun setReceipt(id: String, receipt: String) = db.execSQL("UPDATE sample_txn SET receipt_json = ? WHERE txn_id = ?", arrayOf<Any>(receipt, id))
    fun insertOutbox(o: Outbox) = db.execSQL(
        "INSERT INTO outbox (command_id,txn_id,kind,state,claim_token,claim_until,attempts,blocked_reason,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        arrayOf<Any?>(o.commandId, o.txnId, o.kind, o.state, o.claimToken, o.claimUntil, o.attempts, o.blockedReason, o.createdAt),
    )
    private fun sale(c: Cursor) = SaleRow(c.str("txn_id"), c.str("scope_id"), c.str("status"), c.str("body_json"), c.str("content_hash"), c.str("currency"), c.int("minor_digits"), c.long("payable_minor"), c.str("evidence_json"), c.strOrNull("server_json"), c.strOrNull("invoice"), c.str("message"), c.int("attempts"), c.long("created_at"), c.long("updated_at"))
    fun sale(id: String): SaleRow? = q("SELECT * FROM sale WHERE txn_id = ?", id).list { sale(this) }.firstOrNull()
    fun insertSale(r: SaleRow) = db.execSQL(
        "INSERT INTO sale (txn_id,scope_id,status,body_json,content_hash,currency,minor_digits,payable_minor,evidence_json,server_json,invoice,message,attempts,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        arrayOf<Any?>(r.txnId, r.scopeId, r.status, r.bodyJson, r.contentHash, r.currency, r.minorDigits, r.payableMinor, r.evidenceJson, r.serverJson, r.invoice, r.message, r.attempts, r.createdAt, r.updatedAt),
    )
    fun updateSale(r: SaleRow) = db.execSQL(
        "UPDATE sale SET status = ?, server_json = ?, invoice = ?, message = ?, body_json = ?, evidence_json = ?, payable_minor = ?, attempts = ?, updated_at = ? WHERE txn_id = ?",
        arrayOf<Any?>(r.status, r.serverJson, r.invoice, r.message, r.bodyJson, r.evidenceJson, r.payableMinor, r.attempts, r.updatedAt, r.txnId),
    )
    fun sales(statuses: List<String>, limit: Int): List<SaleRow> =
        if (statuses.isEmpty()) emptyList() else q("SELECT * FROM sale WHERE status IN (${statuses.joinToString(",") { "?" }}) ORDER BY created_at DESC LIMIT ?", *statuses.toTypedArray(), limit).list { sale(this) }
    fun outboxCounts(): List<StateCount> = q("SELECT state, COUNT(*) AS n FROM outbox GROUP BY state").list { StateCount(str("state"), int("n")) }
    fun nextClaimable(now: Long): Outbox? =
        q("SELECT * FROM outbox WHERE kind <> 'SAMPLE' AND (state = 'pending' OR (state = 'claimed' AND claim_until < ?)) ORDER BY created_at LIMIT 1", now).list { outbox(this) }.firstOrNull()

    /** Compare-and-set: only one processor (foreground or WorkManager) can win a given row. Returns rows changed (1 = won). */
    fun claim(id: String, token: String, until: Long, expectedState: String): Int {
        val st = db.compileStatement("UPDATE outbox SET state = 'claimed', claim_token = ?, claim_until = ?, attempts = attempts + 1 WHERE command_id = ? AND state = ?")
        st.bindString(1, token); st.bindLong(2, until); st.bindString(3, id); st.bindString(4, expectedState)
        return try { st.executeUpdateDelete() } finally { st.close() }
    }
}
