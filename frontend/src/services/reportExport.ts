import __ from "@/lib/translate";
import {
	columnCurrency,
	isReportTotalRow,
	REPORT_EXPORT_ROW_LIMIT,
	type ReportColumn,
} from "@/services/reports";
import { hasMixedCurrency, type TotalCell } from "@/services/reportGrid";

export class ReportExportLimitError extends Error {
	constructor(
		public rows: number,
		public limit: number,
	) {
		super(
			__(
				"This report has {0} rows, more than the {1} that can be exported. Narrow the filters and try again.",
				[String(rows), String(limit)],
			),
		);
	}
}

/** Cells a spreadsheet would evaluate as a formula (OWASP CSV injection). */
const FORMULA_START = /^[=+\-@\t\r\n]/;

export function guardFormula(value: string): string {
	return FORMULA_START.test(value) ? `'${value}` : value;
}

function quote(value: string, delimiter: string): string {
	const needsQuotes = value.includes(delimiter) || /[\n\r"]/.test(value);
	return needsQuotes ? `"${value.replace(/"/g, '""')}"` : value;
}

const NUMERIC = ["Currency", "Float", "Int", "Percent"];

function rawCell(column: ReportColumn, value: unknown): { text: string; numeric: boolean } {
	if (value === null || value === undefined || value === "") return { text: "", numeric: false };
	if (Array.isArray(value)) return { text: value.map((item) => String(item)).join(", "), numeric: false };
	if (NUMERIC.includes(String(column.fieldtype || ""))) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return { text: String(parsed), numeric: true };
	}
	if (column.fieldtype === "Check") return { text: value ? __("Yes") : __("No"), numeric: false };
	return { text: String(value), numeric: false };
}

export interface ReportExportInput {
	columns: ReportColumn[];
	rows: Record<string, unknown>[];
	/** Server total rows; only included when the export is the complete, unfiltered result. */
	completeTotals?: Record<string, unknown>[];
	/** Totals over the filtered rows; used instead of complete totals for a filtered view. */
	filteredTotals?: Record<string, TotalCell>;
	filtered: boolean;
	currency: string;
	delimiter: "," | "\t";
	limit?: number;
}

/**
 * Delimited text with raw numbers (no symbols or grouping, so a spreadsheet parses them),
 * formula-injection protection on text, and the currency of each Currency column preserved: a
 * `(CUR)` suffix when there is one, a companion column when rows carry several.
 */
export function buildReportExport(input: ReportExportInput): string {
	const { columns, rows, delimiter } = input;
	const limit = input.limit ?? REPORT_EXPORT_ROW_LIMIT;
	const dataRows = rows.filter((row) => !isReportTotalRow(row));
	if (dataRows.length > limit) throw new ReportExportLimitError(dataRows.length, limit);

	const mixed = hasMixedCurrency(columns, dataRows, input.currency, columnCurrency);
	const firstCurrencyColumn = columns.find((column) => column.fieldtype === "Currency");
	const singleCurrency =
		!mixed && firstCurrencyColumn ? columnCurrency(firstCurrencyColumn, dataRows[0], input.currency) : "";

	const headers: string[] = [];
	const extract: ((row: Record<string, unknown>) => { text: string; numeric: boolean })[] = [];
	for (const column of columns) {
		const isCurrency = column.fieldtype === "Currency";
		const suffix = isCurrency && !mixed && singleCurrency ? ` (${singleCurrency})` : "";
		headers.push(`${column.label}${suffix}`);
		extract.push((row) => rawCell(column, row[column.fieldname]));
		if (isCurrency && mixed) {
			headers.push(`${column.label} ${__("currency")}`);
			extract.push((row) => ({
				text:
					row[column.fieldname] === null || row[column.fieldname] === undefined
						? ""
						: columnCurrency(column, row, input.currency),
				numeric: false,
			}));
		}
	}

	const render = (cells: { text: string; numeric: boolean }[]) =>
		cells
			.map((cell) => quote(cell.numeric ? cell.text : guardFormula(cell.text), delimiter))
			.join(delimiter);

	const lines = [headers.map((label) => quote(guardFormula(label), delimiter)).join(delimiter)];
	for (const row of dataRows) lines.push(render(extract.map((read) => read(row))));

	if (input.filtered) {
		const totals = input.filteredTotals ?? {};
		if (Object.keys(totals).length > 0) {
			let labelled = false;
			const cells = columns.flatMap((column) => {
				const total = totals[column.fieldname];
				const cell = total
					? { text: total.mixed || total.value === null ? "" : String(total.value), numeric: true }
					: { text: !labelled ? (labelled = true) && __("Filtered total") : "", numeric: false };
				const pair = [cell];
				if (column.fieldtype === "Currency" && mixed) {
					pair.push({ text: total && !total.mixed ? total.currency : "", numeric: false });
				}
				return pair;
			});
			lines.push(render(cells));
		}
	} else {
		for (const total of input.completeTotals ?? []) {
			lines.push(render(extract.map((read) => read(total))));
		}
	}

	return lines.join("\n");
}

/** UTF-8 BOM so Excel opens non-Latin and RTL text correctly. */
export const CSV_BOM = "﻿";

export function reportFileName(title: string, date = new Date()): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return `${slug || "report"}-${date.toISOString().slice(0, 10)}.csv`;
}
