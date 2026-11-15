import { describe, expect, it } from "vitest";
import {
	columnCurrency,
	formatReportCell,
	formatReportSummaryValue,
	getReportPreparedState,
	getVisibleReportColumns,
	normalizeReportRows,
	type ReportColumn,
} from "@/services/reports";
import {
	applyLayout,
	computeFilteredTotals,
	emptyLayout,
	hasMixedCurrency,
	reconcileLayout,
	selectReportRows,
} from "@/services/reportGrid";

const col = (over: Partial<ReportColumn>): ReportColumn => ({ fieldname: "a", label: "A", ...over });

describe("column visibility", () => {
	it("drops hidden, utility and underscore columns", () => {
		const columns = [
			col({ fieldname: "name" }),
			col({ fieldname: "secret", hidden: 1 }),
			col({ fieldname: "flag", hidden: true }),
			col({ fieldname: "indent" }),
			col({ fieldname: "_x" }),
		];
		expect(getVisibleReportColumns(columns).map((c) => c.fieldname)).toEqual(["name"]);
	});

	it("applies layout order and hiding and reconciles stale entries", () => {
		const columns = [col({ fieldname: "a" }), col({ fieldname: "b" }), col({ fieldname: "c" })];
		const layout = { ...emptyLayout(), order: ["c", "gone"], hidden: ["b", "gone"] };
		expect(applyLayout(columns, layout).map((c) => c.fieldname)).toEqual(["c", "a"]);
		expect(reconcileLayout(layout, columns).order).toEqual(["c"]);
	});
});

describe("cell formatting", () => {
	it("resolves currency from a sibling column per row", () => {
		const column = col({ fieldname: "amt", fieldtype: "Currency", options: "currency" });
		expect(columnCurrency(column, { currency: "eur" }, "USD")).toBe("EUR");
		expect(columnCurrency(column, {}, "USD")).toBe("USD");
		expect(columnCurrency(col({ fieldtype: "Currency", options: "GBP" }), {}, "USD")).toBe("GBP");
	});

	it("keeps precision and appends a sibling unit", () => {
		const qty = col({ fieldname: "qty", fieldtype: "Float", options: "uom", precision: 3 });
		expect(formatReportCell(qty, 1.5, "", { uom: "Kg" })).toMatch(/1\.500.*Kg/);
		expect(formatReportCell(qty, "", "", {})).toBe("");
	});

	it("honours summary datatype and currency", () => {
		expect(formatReportSummaryValue({ value: 5, datatype: "Int" })).toBe("5");
		expect(formatReportSummaryValue({ value: "text", datatype: "Data" })).toBe("text");
		expect(formatReportSummaryValue({ value: null })).toBe("-");
	});
});

describe("rows and prepared results", () => {
	it("marks the last row as total only when there is data before it", () => {
		const columns = [col({})];
		expect(normalizeReportRows(columns, [{ a: 1 }], { addTotalRow: 1 })[0]._is_total_row).toBeUndefined();
		const rows = normalizeReportRows(columns, [{ a: 1 }, { a: 1 }], { addTotalRow: 1 });
		expect(rows[1]._is_total_row).toBe(1);
	});

	it("does not treat a queued prepared report as empty", () => {
		expect(getReportPreparedState({ status: "Queued", result: [] })).toBe("pending");
		expect(getReportPreparedState({ status: "Error", result: [] })).toBe("failed");
		expect(getReportPreparedState({ prepared_report: true, result: [] })).toBe("pending");
		expect(getReportPreparedState({ prepared_report: true, status: "Completed", result: [] })).toBe(
			"none",
		);
		expect(getReportPreparedState({ result: [] })).toBe("none");
	});
});

describe("selection and totals", () => {
	const columns = [
		col({ fieldname: "name", label: "Name" }),
		col({ fieldname: "amt", label: "Amt", fieldtype: "Currency", options: "currency" }),
	];
	const rows = [
		{ name: "b", amt: 10, currency: "USD" },
		{ name: "a", amt: 5, currency: "USD" },
		{ name: "c", amt: 7, currency: "EUR" },
	];

	it("searches and sorts the complete result", () => {
		const out = selectReportRows(rows, {
			columns,
			search: "",
			sort: { fieldname: "name", direction: "asc" },
		});
		expect(out.rows.map((r) => r.name)).toEqual(["a", "b", "c"]);
		expect(selectReportRows(rows, { columns, search: "c" }).rows).toHaveLength(1);
	});

	it("invents no totals without a server total row and refuses to add across currencies", () => {
		expect(computeFilteredTotals(columns, rows, undefined, "USD", columnCurrency)).toEqual({});
		const mixed = computeFilteredTotals(columns, rows, { amt: 22 }, "USD", columnCurrency);
		expect(mixed.amt.mixed).toBe(true);
		expect(mixed.amt.value).toBeNull();
		const same = computeFilteredTotals(columns, rows.slice(0, 2), { amt: 22 }, "USD", columnCurrency);
		expect(same.amt).toEqual({ value: 15, mixed: false, currency: "USD" });
		expect(hasMixedCurrency(columns, rows, "USD", columnCurrency)).toBe(true);
	});

	it("keeps tree order, ancestors on search, and collapses groups", () => {
		const tree = [
			{ name: "Assets", indent: 0 },
			{ name: "Cash", indent: 1 },
			{ name: "Bank", indent: 1 },
			{ name: "Liabilities", indent: 0 },
		];
		const cols = [col({ fieldname: "name" })];
		expect(selectReportRows(tree, { columns: cols, search: "bank" }).rows.map((r) => r.name)).toEqual([
			"Assets",
			"Bank",
		]);
		const folded = selectReportRows(tree, { columns: cols, collapsed: new Set([0]) });
		expect(folded.rows.map((r) => r.name)).toEqual(["Assets", "Liabilities"]);
		const sorted = selectReportRows(tree, {
			columns: cols,
			sort: { fieldname: "name", direction: "desc" },
		});
		expect(sorted.rows.map((r) => r.name)[0]).toBe("Assets");
	});
});
