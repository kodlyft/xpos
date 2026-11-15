import __ from "@/lib/translate";
import {
	columnCurrency,
	formatReportCell,
	isReportNumericColumn,
	isReportTotalRow,
	type ReportColumn,
	type ReportDefinition,
	type ReportFilterDefinition,
	type ReportSummaryItem,
	formatReportSummaryValue,
} from "@/services/reports";
import { hasMixedCurrency, type TotalCell } from "@/services/reportGrid";

export type ReportPrintFormat = "thermal-items" | "thermal-summary" | "a4-table";

export interface ReportPrintOptions {
	title: string;
	filters: ReportFilterDefinition[];
	values: Record<string, unknown>;
	columns: ReportColumn[];
	rows: Record<string, unknown>[];
	completeTotals?: Record<string, unknown>[];
	filteredTotals?: Record<string, TotalCell>;
	summary?: ReportSummaryItem[];
	currency: string;
	/** Search text when the printout is a filtered view; labelled on the page. */
	filteredBy?: string;
	format?: ReportPrintFormat;
	generatedAt?: Date;
}

const ESCAPES: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};

/** Every piece of dynamic text (server data, filter values, URL-supplied values) goes through here. */
export function esc(value: unknown): string {
	return String(value ?? "").replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

function isItemColumn(column: ReportColumn): boolean {
	return column.fieldname === "item_name" || column.fieldname === "item_code";
}

function isQtyColumn(column: ReportColumn): boolean {
	return (
		["Float", "Int"].includes(String(column.fieldtype || "")) &&
		(/qty|quantity/i.test(column.fieldname) || /qty|quantity/i.test(column.label))
	);
}

/**
 * Pick a layout from what the report is. The item/quantity thermal list only fits stock-style
 * reports (an item and a quantity, no money); financial reports keep their amounts and
 * currency in a label/value layout; anything else gets a full-width table.
 */
export function pickPrintFormat(
	report: Pick<ReportDefinition, "print"> | undefined,
	columns: ReportColumn[],
): ReportPrintFormat {
	const thermal = Boolean(report?.print?.thermal);
	const hasCurrency = columns.some((column) => column.fieldtype === "Currency");
	if (thermal && !hasCurrency && columns.some(isItemColumn) && columns.some(isQtyColumn)) {
		return "thermal-items";
	}
	return thermal ? "thermal-summary" : "a4-table";
}

function filterLines(filters: ReportFilterDefinition[], values: Record<string, unknown>): string {
	return filters
		.map((filter) => {
			const value = values[filter.fieldname];
			if (value === undefined || value === null || value === "") return "";
			if (Array.isArray(value) && value.length === 0) return "";
			const display = Array.isArray(value) ? value.join(", ") : String(value);
			return `<div class="filter"><span class="fl">${esc(filter.label)}:</span> <span class="fv">${esc(display)}</span></div>`;
		})
		.join("");
}

function cellText(column: ReportColumn, row: Record<string, unknown>, currency: string): string {
	return formatReportCell(column, row[column.fieldname], currency, row);
}

function currencyContext(options: ReportPrintOptions, dataRows: Record<string, unknown>[]): string {
	const money = options.columns.filter((column) => column.fieldtype === "Currency");
	if (money.length === 0 && !(options.summary ?? []).some((item) => item.datatype === "Currency"))
		return "";
	if (hasMixedCurrency(options.columns, dataRows, options.currency, columnCurrency)) {
		return __("Amounts are in the currency shown on each row.");
	}
	const first = money[0];
	const code = first ? columnCurrency(first, dataRows[0], options.currency) : options.currency;
	return code ? __("Amounts in {0}", [code]) : "";
}

function summaryHtml(options: ReportPrintOptions): string {
	const items = options.summary ?? [];
	if (items.length === 0) return "";
	return `<div class="summary">${items
		.map(
			(item) =>
				`<div class="kv"><span>${esc(item.label ?? __("Summary"))}</span><b>${esc(formatReportSummaryValue(item, options.currency))}</b></div>`,
		)
		.join("")}</div>`;
}

function totalsHtml(options: ReportPrintOptions, layout: "kv" | "table"): string {
	const { columns, currency } = options;
	if (options.filteredBy) {
		const totals = options.filteredTotals ?? {};
		const entries = columns.filter((column) => totals[column.fieldname]);
		if (entries.length === 0) return "";
		const cells = entries.map((column) => {
			const total = totals[column.fieldname];
			const value =
				total.mixed || total.value === null
					? __("Mixed currencies")
					: formatReportCell(column, total.value, total.currency || currency, {});
			return { label: column.label, value };
		});
		const heading = `<div class="sub">${esc(__("Filtered total"))}</div>`;
		return layout === "kv"
			? heading +
					cells
						.map(
							(c) => `<div class="kv"><span>${esc(c.label)}</span><b>${esc(c.value)}</b></div>`,
						)
						.join("")
			: heading +
					`<div class="totals-line">${cells.map((c) => `${esc(c.label)}: <b>${esc(c.value)}</b>`).join(" · ")}</div>`;
	}
	return (options.completeTotals ?? [])
		.map((total) => {
			const cells = columns
				.filter((column) => total[column.fieldname] !== undefined && total[column.fieldname] !== "")
				.map((column) => ({ label: column.label, value: cellText(column, total, currency) }));
			if (cells.length === 0) return "";
			return layout === "kv"
				? `<div class="rule"></div>` +
						cells
							.map(
								(c) =>
									`<div class="kv total"><span>${esc(c.label)}</span><b>${esc(c.value)}</b></div>`,
							)
							.join("")
				: `<div class="totals-line">${cells.map((c) => `${esc(c.label)}: <b>${esc(c.value)}</b>`).join(" · ")}</div>`;
		})
		.join("");
}

function thermalItemsBody(options: ReportPrintOptions, rows: Record<string, unknown>[]): string {
	const item =
		options.columns.find((c) => c.fieldname === "item_name") ?? options.columns.find(isItemColumn)!;
	const qty = options.columns.find(isQtyColumn)!;
	const hasWarehouse = rows.some((row) => row.warehouse);
	const line = (row: Record<string, unknown>) =>
		`<div class="kv"><span>${esc(row[item.fieldname] ?? row.item_code ?? "")}</span><b>${esc(cellText(qty, row, options.currency))}</b></div>`;
	if (!hasWarehouse) return rows.map(line).join("");
	const groups = new Map<string, Record<string, unknown>[]>();
	for (const row of rows) {
		const key = String(row.warehouse || "-");
		groups.set(key, [...(groups.get(key) ?? []), row]);
	}
	let html = "";
	for (const [warehouse, group] of groups) {
		html += `<div class="sub">${esc(warehouse)}</div>${group.map(line).join("")}`;
		html += `<div class="muted end">${esc(__("{0} item(s)", [String(group.length)]))}</div>`;
	}
	return html;
}

function thermalSummaryBody(options: ReportPrintOptions, rows: Record<string, unknown>[]): string {
	const [lead, ...rest] = options.columns;
	return rows
		.map((row) => {
			const heading = lead
				? `<div class="sub">${esc(cellText(lead, row, options.currency))}</div>`
				: "";
			const lines = (lead && !isReportNumericColumn(lead) ? rest : options.columns)
				.map((column) => {
					const text = cellText(column, row, options.currency);
					return text
						? `<div class="kv"><span>${esc(column.label)}</span><b>${esc(text)}</b></div>`
						: "";
				})
				.join("");
			return heading + lines;
		})
		.join("");
}

function a4Body(options: ReportPrintOptions, rows: Record<string, unknown>[]): string {
	const head = options.columns
		.map((c) => `<th class="${isReportNumericColumn(c) ? "num" : ""}">${esc(c.label)}</th>`)
		.join("");
	const body = rows
		.map(
			(row) =>
				`<tr>${options.columns
					.map(
						(c) =>
							`<td class="${isReportNumericColumn(c) ? "num" : ""}">${esc(cellText(c, row, options.currency))}</td>`,
					)
					.join("")}</tr>`,
		)
		.join("");
	return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

const BASE_CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: Arial, sans-serif; color: #000; }
.title { font-weight: bold; text-align: center; }
.muted { color: #555; }
.center { text-align: center; }
.end { text-align: end; }
.rule { border-top: 1px dashed #000; margin: 2mm 0; }
.filter { font-size: 0.85em; }
.fl { font-weight: bold; }
.kv { display: flex; justify-content: space-between; gap: 2mm; padding: 0.6mm 0; border-bottom: 1px dotted #ccc; }
.kv span { flex: 1; word-break: break-word; }
.kv b { white-space: nowrap; text-align: end; }
.kv.total { border-bottom: 0; font-weight: bold; }
.sub { font-weight: bold; margin-top: 2mm; border-bottom: 1px solid #000; }
table { width: 100%; border-collapse: collapse; font-size: 9pt; }
th, td { border-bottom: 1px solid #ccc; padding: 1.2mm 1.5mm; text-align: start; }
th { background: #eee; }
.num { text-align: end; font-variant-numeric: tabular-nums; }
.totals-line { margin-top: 2mm; font-size: 9pt; }
`;

const FORMAT_CSS: Record<ReportPrintFormat, string> = {
	"thermal-items": "@page { size: 80mm auto; margin: 4mm 3mm; } body { font-size: 9pt; width: 74mm; }",
	"thermal-summary": "@page { size: 80mm auto; margin: 4mm 3mm; } body { font-size: 9pt; width: 74mm; }",
	"a4-table": "@page { size: A4; margin: 12mm; } body { font-size: 10pt; }",
};

export function buildReportPrintHtml(options: ReportPrintOptions): string {
	const format = options.format ?? "a4-table";
	const rows = options.rows.filter((row) => !isReportTotalRow(row));
	const generated = (options.generatedAt ?? new Date()).toLocaleString();
	const dir = typeof document !== "undefined" && document.documentElement.dir === "rtl" ? "rtl" : "ltr";
	const lang = (typeof document !== "undefined" && document.documentElement.lang) || "en";
	const body =
		format === "thermal-items"
			? thermalItemsBody(options, rows)
			: format === "thermal-summary"
				? thermalSummaryBody(options, rows)
				: a4Body(options, rows);
	const currencyLine = currencyContext(options, rows);
	const scope = options.filteredBy
		? `<div class="muted center">${esc(__("Filtered view: {0}", [options.filteredBy]))}</div>`
		: "";
	const filters = filterLines(options.filters, options.values);

	return `<!DOCTYPE html>
<html lang="${esc(lang)}" dir="${dir}">
<head>
<meta charset="UTF-8" />
<title>${esc(options.title)}</title>
<style>${BASE_CSS}${FORMAT_CSS[format]}</style>
</head>
<body>
<div class="title">${esc(options.title)}</div>
<div class="muted center">${esc(generated)}</div>
${scope}
${filters ? `<div class="rule"></div>${filters}` : ""}
${currencyLine ? `<div class="muted center">${esc(currencyLine)}</div>` : ""}
<div class="rule"></div>
${summaryHtml(options)}
${body}
${totalsHtml(options, format === "a4-table" ? "table" : "kv")}
<div class="rule"></div>
<div class="muted center">${esc(__("{0} row(s)", [String(rows.length)]))} · ${esc(__("End of report"))}</div>
</body>
</html>`;
}

/**
 * Open the print window now, while the click's user gesture is still valid; the caller fills it
 * once the authorized data has arrived, or closes it if the run no longer matters.
 */
export function openReportPrintWindow(): Window | null {
	const win = window.open("", "_blank");
	if (win) {
		win.document.open();
		win.document.write(
			`<!DOCTYPE html><title>${esc(__("Preparing…"))}</title><p>${esc(__("Preparing…"))}</p>`,
		);
		win.document.close();
	}
	return win;
}

export function writeReportPrintWindow(win: Window, options: ReportPrintOptions): void {
	win.document.open();
	win.document.write(buildReportPrintHtml(options));
	win.document.close();
	win.focus();
	let printed = false;
	const printOnce = () => {
		if (printed || win.closed) return;
		printed = true;
		win.print();
	};
	win.onload = printOnce;
	setTimeout(printOnce, 800);
}
