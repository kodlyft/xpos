import { describe, expect, it } from "vitest";
import { buildReportExport, guardFormula, ReportExportLimitError } from "@/services/reportExport";
import type { ReportColumn } from "@/services/reports";

const columns: ReportColumn[] = [
	{ fieldname: "name", label: "Name" },
	{ fieldname: "amt", label: "Amount", fieldtype: "Currency", options: "currency" },
];

const base = { columns, filtered: false, currency: "USD", delimiter: "," as const };

describe("export", () => {
	it("neutralises formulas in text and headers but keeps real numbers raw", () => {
		const csv = buildReportExport({
			...base,
			columns: [{ fieldname: "name", label: "=HYPERLINK()" }, columns[1]],
			rows: [
				{ name: "=1+1", amt: -1234.5, currency: "USD" },
				{ name: "@x", amt: 3, currency: "USD" },
			],
		});
		const lines = csv.split("\n");
		expect(lines[0]).toBe("'=HYPERLINK(),Amount (USD)");
		expect(lines[1]).toBe("'=1+1,-1234.5");
		expect(lines[2]).toBe("'@x,3");
		expect(guardFormula("ok")).toBe("ok");
		expect(guardFormula("\tcmd")).toBe("'\tcmd");
	});

	it("leaves empty cells empty and quotes delimiters", () => {
		const csv = buildReportExport({ ...base, rows: [{ name: 'a,"b"', amt: null, currency: "USD" }] });
		expect(csv.split("\n")[1]).toBe('"a,""b""",');
	});

	it("adds a currency column when rows mix currencies", () => {
		const csv = buildReportExport({
			...base,
			rows: [
				{ name: "a", amt: 1, currency: "USD" },
				{ name: "b", amt: 2, currency: "EUR" },
			],
		});
		const lines = csv.split("\n");
		expect(lines[0]).toBe("Name,Amount,Amount currency");
		expect(lines[2]).toBe("b,2,EUR");
	});

	it("complete export carries server totals; filtered export carries filtered totals only", () => {
		const rows = [{ name: "a", amt: 1, currency: "USD" }];
		const complete = buildReportExport({ ...base, rows, completeTotals: [{ name: "Total", amt: 99 }] });
		expect(complete.split("\n")[2]).toBe("Total,99");
		const filtered = buildReportExport({
			...base,
			rows,
			filtered: true,
			completeTotals: [{ name: "Total", amt: 99 }],
			filteredTotals: { amt: { value: 1, mixed: false, currency: "USD" } },
		});
		expect(filtered).not.toContain("99");
		expect(filtered.split("\n")[2]).toBe("Filtered total,1");
	});

	it("refuses to silently truncate past the row limit", () => {
		const rows = Array.from({ length: 4 }, (_, i) => ({ name: String(i), amt: i, currency: "USD" }));
		expect(() => buildReportExport({ ...base, rows, limit: 3 })).toThrow(ReportExportLimitError);
	});
});
