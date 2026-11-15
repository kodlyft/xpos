package com.kodlyft.xpos.mobile.hw

import org.json.JSONArray
import org.json.JSONObject

/**
 * Honest hardware capability report. Nothing is claimed as supported or tested: every adapter is a stub
 * until the exact model/configuration has been tested. Candidates: Samsung Galaxy A26 5G, Epson TM-P20II
 * (Bluetooth), Zebra DS2278, SUNMI V3 PLUS (Google Play availability varies by configuration). An integrated
 * printer is not a card-payment terminal.
 */
object Capabilities {
    private fun cap(kind: String, supported: Boolean, note: String) =
        JSONObject().put("kind", kind).put("supported", supported).put("tested", false).put("note", note)

    fun scanners(): JSONArray = JSONArray()
        .put(cap("keyboard-wedge", true, "Handheld scanners that type like a keyboard work through the scan field; no model has been tested."))
        .put(cap("camera", false, "Camera scanning is not implemented in this milestone."))
        .put(cap("vendor-sdk", false, "Zebra DS2278 / SUNMI scanner SDK adapters are stubs."))

    fun printers(): JSONArray = JSONArray()
        .put(cap("bluetooth-escpos", false, "Epson TM-P20II Bluetooth printing is not implemented; ESC/POS behaviour differs per model and must be tested."))
        .put(cap("integrated", false, "SUNMI V3 PLUS integrated printer SDK adapter is a stub. An integrated printer is not a card-payment terminal."))
        .put(cap("system-print", false, "Android print service is not wired in this milestone."))
}
