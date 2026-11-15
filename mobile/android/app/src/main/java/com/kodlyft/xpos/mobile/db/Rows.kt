package com.kodlyft.xpos.mobile.db

/** Plain rows. Their fields mirror the model classes in mobile/src/db/models. */
data class CatalogScope(
    val scopeId: String,
    val site: String,
    val company: String?,
    val warehouse: String?,
    val priceList: String?,
    val currency: String,
    val minorDigits: Int,
    val activeGen: Int?,
    val createdAt: Long,
)

data class ItemRow(
    val scopeId: String,
    val gen: Int,
    val itemCode: String,
    val variantOf: String?,
    val name: String,
    val nameNorm: String,
    val codeNorm: String,
    val itemGroup: String,
    val uom: String,
    val priceMinor: Long,
    val priced: Boolean,
    val brand: String?,
)

data class ItemBarcode(val scopeId: String, val gen: Int, val barcode: String, val itemCode: String, val uom: String?)
data class ItemAttr(val scopeId: String, val gen: Int, val itemCode: String, val attr: String, val value: String)
data class BarcodeOf(val itemCode: String, val barcode: String)
data class AttrOf(val itemCode: String, val attr: String, val value: String)

data class SampleTxn(
    val txnId: String,
    val contentHash: String,
    val scopeId: String,
    val currency: String,
    val minorDigits: Int,
    val totalMinor: Long,
    val saleJson: String,
    val receiptJson: String,
    val createdAt: Long,
)

data class Outbox(
    val commandId: String,
    val txnId: String,
    val kind: String,
    val state: String,
    val claimToken: String?,
    val claimUntil: Long?,
    val attempts: Int,
    val blockedReason: String?,
    val createdAt: Long,
)

data class SaleRow(
    val txnId: String,
    val scopeId: String,
    val status: String,
    val bodyJson: String,
    val contentHash: String,
    val currency: String,
    val minorDigits: Int,
    val payableMinor: Long,
    val evidenceJson: String,
    val serverJson: String?,
    val invoice: String?,
    val message: String,
    val attempts: Int,
    val createdAt: Long,
    val updatedAt: Long,
)
