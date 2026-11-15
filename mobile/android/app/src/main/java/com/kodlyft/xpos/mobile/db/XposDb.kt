package com.kodlyft.xpos.mobile.db

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

class ReadOnlySchemaException(level: Int) : Exception("This database was updated by a newer version of the app (schema level $level). Update the app to make changes.")

/**
 * Plain SQLite (not Room): Room refuses to open a database whose tables differ from its entities unless a
 * version number is bumped, which is the opposite of "add a field and the app updates the schema". The schema
 * lives in the model classes (exported to assets/xpos-schema.json) and SchemaSync applies it on every open.
 * The framework version stays 1 forever; it is not used for schema decisions.
 *
 * Pass name = null for an in-memory database (tests).
 */
class XposDb(context: Context, name: String?, private val schema: SchemaDoc) : SQLiteOpenHelper(context.applicationContext, name, null, 1) {
    @Volatile var lastSync: SchemaSync.Report? = null
        private set

    override fun onConfigure(db: SQLiteDatabase) {
        db.setForeignKeyConstraintsEnabled(true)
        db.enableWriteAheadLogging()
    }

    override fun onCreate(db: SQLiteDatabase) = Unit
    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit
    override fun onDowngrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit // framework version is fixed at 1; the writer level in schema_state decides (SchemaSync)

    override fun onOpen(db: SQLiteDatabase) {
        // Best effort: a sale must survive power loss once the cashier sees "saved". Android may use other
        // connections of its pool; the real durability mode must be confirmed on the target device.
        runCatching { db.execSQL("PRAGMA synchronous = FULL") }
        if (!db.isReadOnly) lastSync = SchemaSync(db, schema).sync()
    }

    val db: SQLiteDatabase get() = writableDatabase

    fun catalog() = CatalogStore(db)
    fun txn() = TxnStore(db)

    /** One write transaction (IMMEDIATE in WAL): everything inside commits together or not at all. */
    fun <T> write(block: () -> T): T {
        // A newer, incompatible build changed this database: reading is fine, writing could corrupt it.
        if (lastSync?.readOnly == true) throw ReadOnlySchemaException(lastSync!!.deviceWriterLevel)
        val d = db
        d.beginTransaction()
        try { val r = block(); d.setTransactionSuccessful(); return r } finally { d.endTransaction() }
    }

    companion object {
        fun loadSchema(context: Context): SchemaDoc =
            SchemaDoc.parse(context.assets.open(SchemaDoc.ASSET).bufferedReader().use { it.readText() })

        fun open(context: Context, name: String? = "xpos-mobile.db") = XposDb(context, name, loadSchema(context))
    }
}
