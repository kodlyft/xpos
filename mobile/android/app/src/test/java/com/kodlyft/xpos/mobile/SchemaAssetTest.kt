package com.kodlyft.xpos.mobile

import com.kodlyft.xpos.mobile.db.SchemaDoc
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** The exported model JSON (from `yarn build`) must exist, parse, and describe every table with usable SQL. */
class SchemaAssetTest {
    private val doc = SchemaDoc.parse(File("src/main/assets/xpos-schema.json").readText())

    @Test fun everyModelHasCreateSqlAndAKey() {
        assertTrue(doc.fingerprint.isNotEmpty())
        assertTrue(doc.models.isNotEmpty())
        doc.models.forEach {
            assertTrue(it.table, it.createSql.startsWith("CREATE TABLE ${it.table} "))
            assertTrue("${it.table} needs a primary key", it.primaryKey.isNotEmpty())
            it.indexes.forEach { ix -> assertTrue(ix.sql.contains("INDEX ${ix.name} ON ${it.table}")) }
        }
    }

    @Test fun outboxForbidsPendingSampleRowsAtTheDatabaseLevel() {
        val outbox = doc.models.first { it.table == "outbox" }
        assertTrue(outbox.createSql.contains("kind <> 'SAMPLE' OR (state = 'blocked'"))
    }

    @Test fun newColumnsAreAddableOnlyWhenNullableOrDefaulted() {
        val item = doc.models.first { it.table == "item" }
        assertEquals("ALTER TABLE item ADD COLUMN brand TEXT", item.columns.first { it.name == "brand" }.addSql)
        assertEquals(null, item.columns.first { it.name == "price_minor" }.addSql) // NOT NULL without default: needs an explicit step
    }
}
