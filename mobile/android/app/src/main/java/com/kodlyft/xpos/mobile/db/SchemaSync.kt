package com.kodlyft.xpos.mobile.db

import android.database.sqlite.SQLiteDatabase
import org.json.JSONArray
import org.json.JSONObject

/** The model definition exported by the web build (mobile/scripts/export-schema.ts into assets/xpos-schema.json). */
data class SchemaDoc(val fingerprint: String, val models: List<Model>, val steps: List<Step>) {
    data class Column(val name: String, val type: String, val notNull: Boolean, val addSql: String?, val defaultSql: String? = null, val check: String? = null, val references: String? = null)
    data class Index(val name: String, val columns: List<String>, val unique: Boolean, val sql: String)
    data class Model(val table: String, val createSql: String, val primaryKey: List<String>, val columns: List<Column>, val indexes: List<Index>, val checks: List<String> = emptyList())
    data class Step(val id: String, val name: String, val statements: List<String>, val breaksOlderWriters: Boolean = false)

    /** Mirrors writerLevelOf in schemaSync.ts. */
    val writerLevel: Int get() = 1 + steps.count { it.breaksOlderWriters }

    companion object {
        const val ASSET = "xpos-schema.json"

        fun parse(json: String): SchemaDoc {
            val o = JSONObject(json)
            fun strings(a: JSONArray) = List(a.length()) { a.getString(it) }
            return SchemaDoc(
                o.getString("fingerprint"),
                o.getJSONArray("models").let { ms ->
                    List(ms.length()) { i ->
                        val m = ms.getJSONObject(i)
                        Model(
                            m.getString("table"), m.getString("createSql"), strings(m.getJSONArray("primaryKey")),
                            m.getJSONArray("columns").let { cs -> List(cs.length()) { j -> cs.getJSONObject(j).let { c -> Column(c.getString("name"), c.getString("type"), c.getBoolean("notNull"), if (c.isNull("addSql")) null else c.getString("addSql"), c.optString("defaultSql").takeIf { c.has("defaultSql") && !c.isNull("defaultSql") }, c.optString("check").takeIf { c.has("check") && !c.isNull("check") }, c.optString("references").takeIf { c.has("references") && !c.isNull("references") }) } } },
                            m.getJSONArray("indexes").let { xs -> List(xs.length()) { j -> xs.getJSONObject(j).let { x -> Index(x.getString("name"), strings(x.getJSONArray("columns")), x.getBoolean("unique"), x.getString("sql")) } } },
                            m.optJSONArray("checks")?.let { strings(it) } ?: emptyList(),
                        )
                    }
                },
                o.getJSONArray("steps").let { ss -> List(ss.length()) { i -> ss.getJSONObject(i).let { s -> Step(s.getString("id"), s.getString("name"), strings(s.getJSONArray("statements")), s.optBoolean("breaksOlderWriters", false)) } } },
            )
        }
    }
}

/** `CHECK (...)` expressions in a CREATE TABLE statement, whitespace-normalised (mirrors extractChecks in schemaSync.ts). */
fun extractChecks(createSql: String): List<String> {
    val out = mutableListOf<String>()
    for (m in Regex("""\bCHECK\s*\(""", RegexOption.IGNORE_CASE).findAll(createSql)) {
        var depth = 1
        var i = m.range.last + 1
        val start = i
        while (i < createSql.length && depth > 0) { if (createSql[i] == '(') depth++ else if (createSql[i] == ')') depth--; i++ }
        out += createSql.substring(start, i - 1).replace(Regex("\\s+"), " ").trim()
    }
    return out
}

private fun normalizeRef(table: String, from: String, to: String, onDelete: String?) = "$from->$table.$to/${(onDelete ?: "NO ACTION").uppercase()}"
private fun modelRef(column: String, ref: String): String? =
    Regex("""REFERENCES\s+(\w+)\s*\((\w+)\)(?:\s+ON DELETE\s+([A-Z ]+))?""", RegexOption.IGNORE_CASE).find(ref)?.let { normalizeRef(it.groupValues[1], column, it.groupValues[2], it.groupValues[3].ifEmpty { null }) }

class SchemaChangeBlockedException(val blocked: List<String>) :
    Exception("Schema change needs an explicit step (src/db/steps.ts); nothing was changed:\n- " + blocked.joinToString("\n- "))

/**
 * Kotlin twin of mobile/src/db/schemaSync.ts, run when the database opens. It compares the exported models with
 * the real tables and applies the difference:
 *  - new table / column / index: created automatically, rows kept;
 *  - type, NOT NULL or primary-key change, or a NOT NULL column without a default: refused, database untouched;
 *  - extra tables/columns/indexes the models do not know: kept and reported (so a downgrade never fails).
 */
class SchemaSync(private val db: SQLiteDatabase, private val doc: SchemaDoc, private val now: () -> Long = System::currentTimeMillis) {
    data class Plan(
        val createTables: MutableList<SchemaDoc.Model> = mutableListOf(),
        val addColumns: MutableList<Triple<String, String, String>> = mutableListOf(), // table, column, sql
        val createIndexes: MutableList<Pair<SchemaDoc.Index, Boolean>> = mutableListOf(), // index, recreate
        val blocked: MutableList<String> = mutableListOf(),
        val unmanaged: MutableList<String> = mutableListOf(),
    )
    data class Report(val changed: Boolean, val readOnly: Boolean, val deviceWriterLevel: Int, val createdTables: List<String>, val addedColumns: List<String>, val indexes: List<String>, val stepsRun: List<String>, val unmanaged: List<String>)

    private fun rows(sql: String): List<Map<String, String?>> =
        db.rawQuery(sql, null).use { c -> val names = c.columnNames; buildList { while (c.moveToNext()) add(names.associateWith { n -> c.getString(c.getColumnIndexOrThrow(n)) }) } }

    private fun ensureState() {
        db.execSQL("CREATE TABLE IF NOT EXISTS schema_state (id INTEGER PRIMARY KEY CHECK (id = 1), fingerprint TEXT NOT NULL, updated_at INTEGER NOT NULL, writer_level INTEGER NOT NULL DEFAULT 1)")
        if (rows("PRAGMA table_info(schema_state)").none { it["name"] == "writer_level" }) db.execSQL("ALTER TABLE schema_state ADD COLUMN writer_level INTEGER NOT NULL DEFAULT 1")
        db.execSQL("CREATE TABLE IF NOT EXISTS schema_steps (id TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)")
        db.execSQL("CREATE TABLE IF NOT EXISTS schema_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, change TEXT NOT NULL)")
    }

    fun plan(): Plan {
        val plan = Plan()
        val tables = rows("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").map { it["name"]!! }.toSet()
        for (m in doc.models) {
            if (m.table !in tables) { plan.createTables += m; m.indexes.forEach { plan.createIndexes += it to false }; continue }
            val info = rows("PRAGMA table_info(${m.table})")
            val actual = info.associateBy { it["name"]!! }
            val actualPk = info.filter { (it["pk"] ?: "0").toInt() > 0 }.sortedBy { it["pk"]!!.toInt() }.map { it["name"]!! }
            if (actualPk != m.primaryKey) plan.blocked += "${m.table}: primary key changed (${actualPk.joinToString().ifEmpty { "none" }} -> ${m.primaryKey.joinToString()})"
            for (c in m.columns) {
                val a = actual[c.name]
                if (a == null) {
                    if (c.addSql != null) plan.addColumns += Triple(m.table, c.name, c.addSql)
                    else plan.blocked += "${m.table}.${c.name}: new column is NOT NULL (or a key) without a DEFAULT, so existing rows cannot be filled"
                    continue
                }
                if (a["type"]!!.uppercase() != c.type) plan.blocked += "${m.table}.${c.name}: type changed (${a["type"]} -> ${c.type})"
                if (c.name !in m.primaryKey && (a["notnull"] == "1") != c.notNull) plan.blocked += "${m.table}.${c.name}: NOT NULL changed"
            }
            for (c in m.columns) { val a = actual[c.name] ?: continue; if (a["dflt_value"] != c.defaultSql) plan.blocked += "${m.table}.${c.name}: default changed (${a["dflt_value"] ?: "none"} -> ${c.defaultSql ?: "none"})" }
            val wantRefs = m.columns.mapNotNull { c -> c.references?.let { modelRef(c.name, it) } }.sorted()
            val haveRefs = rows("PRAGMA foreign_key_list(${m.table})").map { normalizeRef(it["table"]!!, it["from"]!!, it["to"]!!, it["on_delete"]) }.sorted()
            if (wantRefs != haveRefs) plan.blocked += "${m.table}: foreign keys changed (${haveRefs.joinToString().ifEmpty { "none" }} -> ${wantRefs.joinToString().ifEmpty { "none" }})"
            val wantChecks = (m.columns.mapNotNull { it.check } + m.checks).map { it.replace(Regex("\\s+"), " ").trim() }.sorted()
            val haveSql = rows("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = '${m.table}'").firstOrNull()?.get("sql") ?: ""
            if (wantChecks != extractChecks(haveSql).sorted()) plan.blocked += "${m.table}: CHECK constraints changed"
            val modelCols = m.columns.map { it.name }.toSet()
            actual.keys.filter { it !in modelCols }.forEach { plan.unmanaged += "column ${m.table}.$it" }

            val actualIdx = rows("PRAGMA index_list(${m.table})").filter { it["origin"] == "c" }.associate { ix ->
                ix["name"]!! to Pair(rows("PRAGMA index_info(${ix["name"]})").sortedBy { it["seqno"]!!.toInt() }.map { it["name"]!! }, ix["unique"] == "1")
            }
            for (ix in m.indexes) {
                val cur = actualIdx[ix.name]
                if (cur == null) plan.createIndexes += ix to false
                else if (cur.first != ix.columns || cur.second != ix.unique) plan.createIndexes += ix to true // indexes hold no data: safe to rebuild
            }
            val modelIdx = m.indexes.map { it.name }.toSet()
            actualIdx.keys.filter { it !in modelIdx }.forEach { plan.unmanaged += "index $it" }
        }
        val known = doc.models.map { it.table }.toSet()
        tables.filter { it !in known && !it.startsWith("schema_") }.forEach { plan.unmanaged += "table $it" }
        return plan
    }

    private fun log(change: String) = db.execSQL("INSERT INTO schema_log (at, change) VALUES (?, ?)", arrayOf<Any?>(now(), change))

    private inline fun <T> tx(block: () -> T): T {
        db.beginTransaction() // IMMEDIATE in WAL mode, like BEGIN IMMEDIATE on the host
        try { val r = block(); db.setTransactionSuccessful(); return r } finally { db.endTransaction() }
    }

    fun sync(): Report {
        ensureState()
        val ownLevel = doc.writerLevel
        val deviceLevel = rows("SELECT writer_level FROM schema_state WHERE id = 1").firstOrNull()?.get("writer_level")?.toInt() ?: 0
        if (deviceLevel > ownLevel) return Report(false, true, deviceLevel, emptyList(), emptyList(), emptyList(), emptyList(), emptyList())
        val applied = rows("SELECT id FROM schema_steps").map { it["id"]!! }.toSet()
        val pending = doc.steps.filter { it.id !in applied }
        val stored = rows("SELECT fingerprint FROM schema_state WHERE id = 1").firstOrNull()?.get("fingerprint")
        if (stored == doc.fingerprint && pending.isEmpty()) return Report(false, false, deviceLevel, emptyList(), emptyList(), emptyList(), emptyList(), emptyList())

        val stepsRun = mutableListOf<String>()
        for (s in pending) {
            tx {
                s.statements.forEach(db::execSQL)
                db.execSQL("INSERT INTO schema_steps (id, name, applied_at) VALUES (?, ?, ?)", arrayOf<Any?>(s.id, s.name, now()))
                log("step ${s.id}: ${s.name}")
            }
            stepsRun += s.id
        }
        val plan = plan()
        if (plan.blocked.isNotEmpty()) throw SchemaChangeBlockedException(plan.blocked)
        tx {
            plan.createTables.forEach { db.execSQL(it.createSql); log("create table ${it.table}") }
            plan.addColumns.forEach { (t, c, sql) -> db.execSQL(sql); log("add column $t.$c") }
            plan.createIndexes.forEach { (ix, recreate) -> if (recreate) db.execSQL("DROP INDEX IF EXISTS ${ix.name}"); db.execSQL(ix.sql) }
            db.execSQL("INSERT OR REPLACE INTO schema_state (id, fingerprint, updated_at, writer_level) VALUES (1, ?, ?, ?)", arrayOf<Any?>(doc.fingerprint, now(), maxOf(ownLevel, deviceLevel)))
        }
        return Report(
            plan.createTables.isNotEmpty() || plan.addColumns.isNotEmpty() || plan.createIndexes.isNotEmpty() || stepsRun.isNotEmpty(), false, maxOf(ownLevel, deviceLevel),
            plan.createTables.map { it.table }, plan.addColumns.map { "${it.first}.${it.second}" }, plan.createIndexes.map { it.first.name }, stepsRun, plan.unmanaged,
        )
    }
}
