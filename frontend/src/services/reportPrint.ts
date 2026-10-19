import type { ReportColumn, ReportFilterDefinition } from "@/services/reports";
import { formatQty as formatNumberQty } from "@/utils/numberFormat";

export interface ThermalReportOptions {
	title: string;
	filters: ReportFilterDefinition[];
	values: Record<string, unknown>;
	columns: ReportColumn[];
	rows: Record<string, unknown>[];
}

function isNumericColumn(column: ReportColumn): boolean {
	return ["Float", "Int"].includes(String(column.fieldtype || ""));
}

function pickItemColumn(columns: ReportColumn[]): ReportColumn | undefined {
	return (
		columns.find((column) => column.fieldname === "item_name") ||
		columns.find((column) => /name/i.test(column.fieldname) || /name/i.test(column.label)) ||
		columns.find((column) => !isNumericColumn(column)) ||
		columns[0]
	);
}

function pickQtyColumn(columns: ReportColumn[]): ReportColumn | undefined {
	const numeric = columns.filter(isNumericColumn);
	return (
		numeric.find(
			(column) => /qty|quantity/i.test(column.fieldname) || /qty|quantity/i.test(column.label),
		) || numeric[0]
	);
}

function formatQty(value: unknown): string {
	const qty = Number(value ?? 0);
	if (Number.isNaN(qty)) return String(value ?? "0");
	return formatNumberQty(qty);
}

function buildFilterLines(filters: ReportFilterDefinition[], values: Record<string, unknown>): string {
	return filters
		.map((filter) => {
			const value = values[filter.fieldname];
			if (!value || (Array.isArray(value) && value.length === 0)) return null;
			const display = Array.isArray(value) ? value.join(", ") : String(value);
			return `<div><span class="fl">${filter.label}:</span> <span class="fv">${display}</span></div>`;
		})
		.filter(Boolean)
		.join("");
}

function itemLine(row: Record<string, unknown>, itemColumn?: ReportColumn, qtyColumn?: ReportColumn): string {
	const name = String((itemColumn && row[itemColumn.fieldname]) || row.item_name || row.item_code || "-");
	const qty = qtyColumn ? formatQty(row[qtyColumn.fieldname]) : "";
	return `<div class="item-row"><span class="item-name">${name}</span><span class="item-qty">${qty}</span></div>`;
}

function buildBody(columns: ReportColumn[], rows: Record<string, unknown>[]): string {
	const itemColumn = pickItemColumn(columns);
	const qtyColumn = pickQtyColumn(columns);
	const hasWarehouse = rows.some((row) => row.warehouse);

	if (!hasWarehouse) {
		return rows.map((row) => itemLine(row, itemColumn, qtyColumn)).join("");
	}

	const warehouseMap = new Map<string, Record<string, unknown>[]>();
	for (const row of rows) {
		const warehouse = String(row.warehouse || "-");
		if (!warehouseMap.has(warehouse)) warehouseMap.set(warehouse, []);
		warehouseMap.get(warehouse)!.push(row);
	}

	let body = "";
	for (const [warehouse, warehouseRows] of warehouseMap) {
		body += `<div class="wh-header">${warehouse}</div>`;
		for (const row of warehouseRows) {
			body += itemLine(row, itemColumn, qtyColumn);
		}
		body += `<div class="wh-subtotal">Subtotal: ${warehouseRows.length} item(s)</div>`;
	}
	return body;
}

export function buildThermalHtml(options: ThermalReportOptions): string {
	const { title, filters, values, columns, rows } = options;
	const now = new Date().toLocaleString();
	const filterLines = buildFilterLines(filters, values);
	const bodyHtml = buildBody(columns, rows);
	const itemHeader = pickItemColumn(columns)?.label || "Item";
	const qtyHeader = pickQtyColumn(columns)?.label || "Qty";

	return `<!DOCTYPE html>
	<html lang="en">
	<head>
		<meta charset="UTF-8" />
		<title>${title}</title>
		<style>
			@page { size: 80mm auto; margin: 4mm 3mm; }
			* { box-sizing: border-box; margin: 0; padding: 0; }
			body { font-family: Arial, sans-serif; font-size: 9pt; width: 74mm; color: #000; }
			.center { text-align: center; }
			.title { font-size: 11pt; font-weight: bold; margin-bottom: 2mm; }
			.divider { border-top: 1px dashed #000; margin: 2mm 0; }
			.filters { font-size: 7.5pt; color: #333; margin-bottom: 1mm; }
			.fl { font-weight: bold; }
			.fv { font-style: italic; }
			.wh-header { font-weight: bold; font-size: 8.5pt; margin-top: 2mm; padding-bottom: 0.5mm; border-bottom: 1px solid #000; text-transform: uppercase; }
			.item-row { display: flex; justify-content: space-between; align-items: baseline; padding: 0.6mm 0; border-bottom: 1px dotted #ccc; gap: 2mm; }
			.item-name { flex: 1; word-break: break-word; line-height: 1.3; }
			.item-qty { white-space: nowrap; font-weight: bold; text-align: right; min-width: 10mm; }
			.wh-subtotal { text-align: right; font-size: 7.5pt; color: #555; margin-top: 0.5mm; margin-bottom: 1mm; }
			.footer { margin-top: 2mm; text-align: center; font-size: 7.5pt; color: #555; }
			.total-row { font-weight: bold; margin-top: 1.5mm; padding-top: 1mm; border-top: 2px solid #000; display: flex; justify-content: space-between; }
		</style>
	</head>
	<body>
		<div class="center title">${title}</div>
		<div class="center" style="font-size:7.5pt; color:#555;">${now}</div>
		${filterLines ? `<div class="divider"></div><div class="filters">${filterLines}</div>` : ""}
		<div class="divider"></div>
		<div style="display:flex; justify-content:space-between; font-weight:bold; font-size:8pt; padding-bottom:1mm; border-bottom:1px solid #000;">
			<span>${itemHeader}</span><span>${qtyHeader}</span>
		</div>
		${bodyHtml}
		<div class="divider"></div>
		<div class="total-row"><span>Total Items</span><span>${rows.length}</span></div>
		<div class="footer">*** End of Report ***</div>
	</body>
	</html>`;
}

export function printThermalReport(options: ThermalReportOptions): boolean {
	const html = buildThermalHtml(options);
	const printWindow = window.open("", "_blank");
	if (!printWindow) return false;

	printWindow.document.open();
	printWindow.document.write(html);
	printWindow.document.close();
	printWindow.focus();
	printWindow.onload = () => printWindow.print();
	setTimeout(() => {
		if (printWindow && !printWindow.closed) printWindow.print();
	}, 800);
	return true;
}
