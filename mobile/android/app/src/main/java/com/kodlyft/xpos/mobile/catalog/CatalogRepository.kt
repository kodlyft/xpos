package com.kodlyft.xpos.mobile.catalog

import com.kodlyft.xpos.mobile.db.CatalogStore
import com.kodlyft.xpos.mobile.db.CatalogScope
import com.kodlyft.xpos.mobile.db.ItemAttr
import com.kodlyft.xpos.mobile.db.ItemBarcode
import com.kodlyft.xpos.mobile.db.ItemRow
import com.kodlyft.xpos.mobile.db.XposDb
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

data class Item(
    val itemCode: String,
    val variantOf: String?,
    val name: String,
    val itemGroup: String,
    val uom: String,
    val priceMinor: Long,
    val priced: Boolean,
    val brand: String?,
    val attrs: Map<String, String>,
    val barcodes: List<String>,
)

data class ItemPage(val items: List<Item>, val next: String?)
data class BarcodeResult(val matches: List<Item>, val ambiguous: Boolean)
data class Stats(val items: Int, val barcodes: Int, val activeGen: Int?, val dbBytes: Long?)

/**
 * Native catalog repository: scoped, bounded, keyset-paged. Every public call is a suspend function
 * so the plugin can run it on a background dispatcher; nothing here touches the main thread.
 */
class CatalogRepository(private val db: XposDb, private val now: () -> Long = System::currentTimeMillis) {
    private val dao: CatalogStore get() = db.catalog()
    private suspend fun <T> io(block: () -> T): T = withContext(Dispatchers.IO) { block() }

    suspend fun createScope(s: CatalogScope) = io { db.write { dao.insertScope(s.copy(activeGen = null, createdAt = now())) } }
    suspend fun listScopes(): List<CatalogScope> = io { dao.scopes() }

    suspend fun dropScope(scopeId: String) = io { db.write { dao.deleteScopeData(scopeId) } }

    suspend fun beginGeneration(scopeId: String): Int = io {
        db.write {
            val gen = dao.nextGen(scopeId)
            dao.insertGeneration(scopeId, gen, now())
            gen
        }
    }

    suspend fun putBatch(scopeId: String, gen: Int, items: List<Item>) {
        require(items.size <= MAX_BATCH) { "batch too large" }
        io {
            db.write {
                check(dao.genState(scopeId, gen) == "staging") { "generation $gen is not staging" }
                dao.insertItems(items.map {
                    ItemRow(scopeId, gen, it.itemCode, it.variantOf, it.name, Text.normalize(it.name), Text.normalize(it.itemCode), it.itemGroup, it.uom, it.priceMinor, it.priced, it.brand)
                })
                dao.insertBarcodes(items.flatMap { i -> i.barcodes.toSet().map { ItemBarcode(scopeId, gen, it, i.itemCode, i.uom) } })
                dao.insertAttrs(items.flatMap { i -> i.attrs.map { (k, v) -> ItemAttr(scopeId, gen, i.itemCode, k, v) } })
                dao.addCount(scopeId, gen, items.size)
            }
        }
    }

    /** Delta for the ACTIVE generation, one transaction: changed items are replaced with their barcodes and attributes, removed ones deleted. */
    suspend fun applyDelta(scopeId: String, upserts: List<Item>, removed: List<String>) {
        require(upserts.size <= MAX_BATCH && removed.size <= MAX_BATCH) { "delta too large" }
        io {
            db.write {
                val gen = checkNotNull(activeGen(scopeId)) { "no active catalog to update" }
                (removed + upserts.map { it.itemCode }).forEach { dao.deleteItem(scopeId, gen, it) }
                dao.insertItems(upserts.map {
                    ItemRow(scopeId, gen, it.itemCode, it.variantOf, it.name, Text.normalize(it.name), Text.normalize(it.itemCode), it.itemGroup, it.uom, it.priceMinor, it.priced, it.brand)
                })
                dao.insertBarcodes(upserts.flatMap { i -> i.barcodes.toSet().map { ItemBarcode(scopeId, gen, it, i.itemCode, i.uom) } })
                dao.insertAttrs(upserts.flatMap { i -> i.attrs.map { (k, v) -> ItemAttr(scopeId, gen, i.itemCode, k, v) } })
                dao.setCount(scopeId, gen, dao.countItems(scopeId, gen))
            }
        }
    }

    suspend fun codePage(scopeId: String, after: String?, limit: Int): List<String> = io {
        val gen = activeGen(scopeId) ?: return@io emptyList()
        dao.codePage(scopeId, gen, after ?: "", limit.coerceIn(1, 2000))
    }

    /** Atomic: either the new generation becomes the only active one, or nothing changes. */
    suspend fun activate(scopeId: String, gen: Int, expectedItems: Int) {
        io {
            db.write {
                check(dao.genState(scopeId, gen) == "staging") { "generation $gen is not staging" }
                val actual = dao.countItems(scopeId, gen)
                check(actual == expectedItems) { "staged $actual items, expected $expectedItems; not activating" }
                dao.activate(scopeId, gen)
            }
            for (g in dao.retiredGens(scopeId)) db.write { dao.deleteGeneration(scopeId, g) }
        }
    }

    suspend fun discard(scopeId: String, gen: Int) = io {
        check(dao.genState(scopeId, gen) != "active") { "cannot discard the active generation" }
        db.write { dao.deleteGeneration(scopeId, gen) }
    }

    private fun activeGen(scopeId: String): Int? {
        requireNotNull(dao.scope(scopeId)) { "unknown scope $scopeId" }
        return dao.activeGen(scopeId)
    }

    private fun hydrate(scopeId: String, gen: Int, rows: List<ItemRow>): List<Item> {
        if (rows.isEmpty()) return emptyList()
        val codes = rows.map { it.itemCode } // <= 100, well under SQLite's variable limit
        val barcodes = dao.barcodesFor(scopeId, gen, codes).groupBy({ it.itemCode }, { it.barcode })
        val attrs = dao.attrsFor(scopeId, gen, codes).groupBy { it.itemCode }
        return rows.map { r ->
            Item(r.itemCode, r.variantOf, r.name, r.itemGroup, r.uom, r.priceMinor, r.priced, r.brand,
                attrs[r.itemCode].orEmpty().associate { it.attr to it.value }, barcodes[r.itemCode].orEmpty())
        }
    }

    suspend fun lookupBarcode(scopeId: String, barcode: String): BarcodeResult = io {
        val gen = activeGen(scopeId) ?: return@io BarcodeResult(emptyList(), false)
        val codes = dao.barcodeCodes(scopeId, gen, barcode)
        val rows = dao.itemsByCodes(scopeId, gen, codes).sortedBy { it.itemCode }
        val items = hydrate(scopeId, gen, rows)
        return@io BarcodeResult(items, items.size > 1)
    }

    suspend fun getItem(scopeId: String, itemCode: String): Item? = io {
        val gen = activeGen(scopeId) ?: return@io null
        return@io dao.item(scopeId, gen, itemCode)?.let { hydrate(scopeId, gen, listOf(it)).first() }
    }

    private fun finish(scopeId: String, gen: Int, rows: List<ItemRow>, limit: Int): ItemPage {
        val more = rows.size > limit
        val slice = if (more) rows.subList(0, limit) else rows
        val last = slice.lastOrNull()
        return ItemPage(hydrate(scopeId, gen, slice), if (more && last != null) Text.encodeCursor(Text.Cursor(last.nameNorm, last.itemCode)) else null)
    }

    suspend fun search(scopeId: String, query: String, after: String?, limit: Int?, variantsOnly: Boolean = false): ItemPage = io {
        val gen = activeGen(scopeId)
        val q = Text.normalizeQuery(query)
        if (gen == null || q.isEmpty()) return@io ItemPage(emptyList(), null)
        val n = Text.clampLimit(limit)
        val cur = Text.decodeCursor(after)
        val hi = q + Text.PREFIX_END
        val byName = dao.searchByName(scopeId, gen, q, hi, cur?.nameNorm ?: "", cur?.itemCode ?: "", n + 1, variantsOnly)
        val byCode = dao.searchByCode(scopeId, gen, q, hi, cur?.nameNorm ?: "", cur?.itemCode ?: "", n + 1, variantsOnly)
        val merged = (byName + byCode).distinctBy { it.itemCode }
            .sortedWith { a, b -> Text.compareCodePoints(a.nameNorm, b.nameNorm).takeIf { it != 0 } ?: Text.compareCodePoints(a.itemCode, b.itemCode) }
            .take(n + 1)
        return@io finish(scopeId, gen, merged, n)
    }

    suspend fun page(scopeId: String, after: String?, limit: Int?, variantsOnly: Boolean = false): ItemPage = io {
        val gen = activeGen(scopeId) ?: return@io ItemPage(emptyList(), null)
        val n = Text.clampLimit(limit)
        val cur = Text.decodeCursor(after)
        val rows = dao.page(scopeId, gen, cur?.nameNorm ?: "", cur?.itemCode ?: "", n + 1, variantsOnly)
        return@io finish(scopeId, gen, rows, n)
    }

    suspend fun variantsOf(scopeId: String, templateCode: String): List<Item> = io {
        val gen = activeGen(scopeId) ?: return@io emptyList()
        return@io hydrate(scopeId, gen, dao.variants(scopeId, gen, templateCode))
    }

    suspend fun stats(scopeId: String, dbBytes: Long?): Stats = io {
        val gen = activeGen(scopeId)
        return@io Stats(gen?.let { dao.countItems(scopeId, it) } ?: 0, gen?.let { dao.countBarcodes(scopeId, it) } ?: 0, gen, dbBytes)
    }

    companion object { const val MAX_BATCH = 1000 }
}
