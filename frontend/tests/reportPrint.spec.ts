import { describe, expect, it } from "vitest";
import { buildReportPrintHtml, esc, pickPrintFormat } from "@/services/reportPrint";
import type { ReportColumn } from "@/services/reports";

const stock: ReportColumn[] = [
	{ fieldname: "item_name", label: "Item" },
	{ fieldname: "qty", label: "Qty", fieldtype: "Float" },
];
const money: ReportColumn[] = [
	{ fieldname: "mode", label: "Mode" },
	{ fieldname: "amt", label: "Amount", fieldtype: "Currency", options: "currency" },
];
const thermal = { print: { allowed: true, thermal: true } };

describe("print", () => {
	it("escapes every dynamic value", () => {
		expect(esc(`<img src=x onerror="a()">&'`)).toBe(
			"&lt;img src=x onerror=&quot;a()&quot;&gt;&amp;&#39;",
		);
		const html = buildReportPrintHtml({
			title: "<script>alert(1)</script>",
			filters: [{ fieldname: "c", label: "<b>C</b>", type: "text" }],
			values: { c: "<i>x</i>" },
			columns: stock,
			rows: [{ item_name: "<svg onload=1>", qty: 2 }],
			currency: "USD",
			format: "thermal-items",
		});
		expect(html).not.toContain("<script>alert");
		expect(html).not.toContain("<svg onload");
		expect(html).not.toContain("<i>x</i>");
		expect(html).toContain("&lt;svg onload=1&gt;");
	});

	it("chooses a format from what the report is", () => {
		expect(pickPrintFormat(thermal, stock)).toBe("thermal-items");
		expect(pickPrintFormat(thermal, money)).toBe("thermal-summary");
		expect(pickPrintFormat({ print: { allowed: true, thermal: false } }, stock)).toBe("a4-table");
	});

	it("keeps amounts, currency context and totals on a financial report", () => {
		const html = buildReportPrintHtml({
			title: "Shift",
			filters: [],
			values: {},
			columns: money,
			rows: [{ mode: "Cash", amt: 1250.5, currency: "EUR" }],
			completeTotals: [{ mode: "Total", amt: 1250.5, currency: "EUR" }],
			summary: [{ label: "Net", value: 10, datatype: "Currency", currency: "EUR" }],
			currency: "USD",
			format: "thermal-summary",
		});
		expect(html).toContain("Cash");
		expect(html).toContain("1,250.50");
		expect(html).toContain("EUR");
		expect(html).toContain("Total");
		expect(html).not.toContain("Total Items");
	});

	it("labels a filtered printout and uses the document direction", () => {
		document.documentElement.dir = "rtl";
		const html = buildReportPrintHtml({
			title: "T",
			filters: [],
			values: {},
			columns: money,
			rows: [{ mode: "Cash", amt: 1, currency: "USD" }],
			filteredBy: "ca",
			filteredTotals: { amt: { value: 1, mixed: false, currency: "USD" } },
			currency: "USD",
		});
		document.documentElement.dir = "";
		expect(html).toContain('dir="rtl"');
		expect(html).toContain("Filtered view");
		expect(html).toContain("Filtered total");
	});
});
