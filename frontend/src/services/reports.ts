import { call } from "@/services/api";
import { __ } from "@/lib/utils";
import { hasPermission, type PosPermissions } from "@/services/userRights";
import { formatWithSymbol } from "@/composables/useCurrency";
import { formatFloat, formatInt } from "@/utils/numberFormat";

export type ReportCategory = "Inventory" | "Sales" | "Purchasing" | "Operations";
export type ReportFilterType = "link" | "multi-link" | "date" | "integer" | "float" | "select" | "text";

export interface ReportFilterOption {
	label: string;
	value: string;
}

export interface ReportFilterDefinition {
	fieldname: string;
	label: string;
	type: ReportFilterType;
	required?: boolean;
	doctype?: string;
	placeholder?: string;
	helpText?: string;
	defaultValue?: string | number | string[];
	options?: ReportFilterOption[];
	getQueryFilters?: Record<string, unknown>;
	clears?: string[];
}

export interface ReportDefinition {
	slug: string;
	title: string;
	reportName: string;
	description: string;
	category: ReportCategory;
	permissionKey?: keyof PosPermissions;
	thermalPrint?: boolean;
}

export interface ReportColumn {
	fieldname: string;
	label: string;
	fieldtype?: string;
	options?: string;
	width?: number;
	precision?: number;
	hidden?: number;
	default?: unknown;
	[key: string]: unknown;
}

export interface ReportSummaryItem {
	label?: string;
	value?: unknown;
	indicator?: string;
	color?: string;
	key?: string;
	[key: string]: unknown;
}

export interface ReportQueryResult {
	columns: ReportColumn[];
	result: Record<string, unknown>[];
	message?: string;
	chart?: unknown;
	report_summary?: ReportSummaryItem[];
	skip_total_row?: number | boolean;
	add_total_row?: number | boolean;
	status?: string | null;
	prepared_report?: boolean;
	[key: string]: unknown;
}

export interface ReportContextDefaults {
	company?: string;
	warehouse?: string;
}

const reportUtilityFields = new Set([
	"indent",
	"parent",
	"lft",
	"rgt",
	"is_total_row",
	"is_subtotal",
	"row_style",
	"__checked",
	"__index",
]);

const reportDefinitions: ReportDefinition[] = [
	{
		slug: "current-stock-report",
		title: __("Current Stock Report"),
		reportName: "Current Stock Report",
		description: __("Live stock valuation by item, warehouse, supplier, brand, and group."),
		category: "Inventory",
		permissionKey: "current_stock_report",
	},
	{
		slug: "current-stock-by-brand",
		title: __("Current Stock By Brand"),
		reportName: "Current Stock By Brand",
		description: __("Brand-wise stock snapshot with quantities and valuation."),
		category: "Inventory",
		permissionKey: "current_stock_by_brand",
	},
	{
		slug: "current-stock-summary",
		title: __("Current Stock Summary"),
		reportName: "Current Stock Summary",
		description: __("Compact warehouse stock overview with totals and stock movement levels."),
		category: "Inventory",
	},
	{
		slug: "current-stock-with-levels",
		title: __("Current Stock With Levels"),
		reportName: "Current Stock With Levels",
		description: __("Stock snapshot grouped with reorder and alert levels."),
		category: "Inventory",
	},
	{
		slug: "dead-stock-report",
		title: __("Dead Stock Report"),
		reportName: "Dead Stock Report",
		description: __("Stock that has been sitting too long with low value movement."),
		category: "Inventory",
	},
	{
		slug: "stock-value-by-warehouse",
		title: __("Stock Value By Warehouse"),
		reportName: "Stock Value By Warehouse",
		description: __("Warehouse value and quantity summary for quick inventory valuation."),
		category: "Inventory",
	},
	{
		slug: "stock-value-summary-by-date",
		title: __("Stock Value Summary By Date"),
		reportName: "Stock Value Summary By Date",
		description: __("Snapshot stock balance by posting date for trend review."),
		category: "Inventory",
	},
	{
		slug: "warehouse-stock-movement",
		title: __("Warehouse Stock Movement"),
		reportName: "Warehouse Stock Movement",
		description: __("Movement summary by warehouse and voucher type over time."),
		category: "Operations",
	},
	{
		slug: "branch-item-summary",
		title: __("Branch Item Summary"),
		reportName: "Branch Item Summary",
		description: __("Item movement and sales summary for a branch and warehouse window."),
		category: "Operations",
	},
	{
		slug: "branch-set-summary",
		title: __("Branch Set Summary"),
		reportName: "Branch Set Summary",
		description: __("Set-level summary for branch stock and movement tracking."),
		category: "Operations",
	},
	{
		slug: "low-qty-sales-report",
		title: __("Low Qty Sales Report"),
		reportName: "Low Qty Sales Report",
		description: "Items sold in low quantities over a selected period.",
		category: "Sales",
	},
	{
		slug: "zero-qty-sales-report",
		title: __("Zero Qty Sales Report"),
		reportName: "Zero Qty Sales Report",
		description: __("Sales lines where no quantity was fulfilled during the period."),
		category: "Sales",
	},
	{
		slug: "slow-fast-moving-items",
		title: __("Slow Fast Moving Items"),
		reportName: "Slow Fast Moving Items",
		description: __("Movement velocity overview to identify fast and slow sellers."),
		category: "Sales",
	},
	// prettier-ignore
	{
		slug: "stock-audit-report",
		title: __("Stock Audit Report"),
		reportName: "Stock Audit Report",
		description: __(
			"Thermal-printable stock audit by item with available qty. Filter by warehouse, brand, supplier, or item."
		),
		category: "Inventory",
		thermalPrint: true,
	},
	{
		slug: "purchase-order-report",
		title: __("Purchase Order Report"),
		reportName: "Purchase Order Report",
		description: __("Purchase order summary with supplier, date range, and type filters."),
		category: "Purchasing",
	},
	// prettier-ignore
	{
		slug: "pos-shift-reconciliation",
		title: __("Shift Reconciliation"),
		reportName: "POS Shift Reconciliation",
		description: __(
			"Z-report: items sold with quantities plus totals by payment mode for end-of-shift cash-up."
		),
		category: "Sales",
		permissionKey: "shift_report",
		thermalPrint: true,
	},
];

const reportMap = new Map(reportDefinitions.map((report) => [report.slug, report]));

function cloneValue<T>(value: T): T {
	if (Array.isArray(value)) return [...value] as T;
	if (value && typeof value === "object") return { ...(value as Record<string, unknown>) } as T;
	return value;
}

export function getReportDefinition(slug: string | string[] | undefined): ReportDefinition | undefined {
	if (!slug || Array.isArray(slug)) return undefined;
	return reportMap.get(slug);
}

export function getReportDefinitions(): ReportDefinition[] {
	return [...reportDefinitions];
}

export function getAccessibleReports(): ReportDefinition[] {
	return reportDefinitions.filter((report) => !report.permissionKey || hasPermission(report.permissionKey));
}

export function isReportAccessible(report: ReportDefinition): boolean {
	return !report.permissionKey || hasPermission(report.permissionKey);
}

export function buildInitialReportFilters(
	filters: ReportFilterDefinition[],
	context: ReportContextDefaults = {},
): Record<string, unknown> {
	const state: Record<string, unknown> = {};

	for (const filter of filters) {
		state[filter.fieldname] = cloneValue(filter.defaultValue ?? (filter.type === "multi-link" ? [] : ""));
	}

	if (context.company && Object.prototype.hasOwnProperty.call(state, "company")) {
		state.company = context.company;
	}

	if (context.warehouse && Object.prototype.hasOwnProperty.call(state, "warehouse")) {
		state.warehouse = context.warehouse;
	}

	return state;
}

export function normalizeReportFilters(
	filters: ReportFilterDefinition[],
	values: Record<string, unknown>,
): Record<string, unknown> {
	const payload: Record<string, unknown> = {};

	for (const filter of filters) {
		const rawValue = values[filter.fieldname];

		if (rawValue === undefined || rawValue === null || rawValue === "") {
			continue;
		}

		if (Array.isArray(rawValue)) {
			const cleaned = rawValue.map((item) => String(item).trim()).filter(Boolean);
			if (cleaned.length > 0) {
				payload[filter.fieldname] = cleaned;
			}
			continue;
		}

		if (filter.type === "integer") {
			const parsed = Number.parseInt(String(rawValue), 10);
			if (!Number.isNaN(parsed)) payload[filter.fieldname] = parsed;
			continue;
		}

		if (filter.type === "float") {
			const parsed = Number.parseFloat(String(rawValue));
			if (!Number.isNaN(parsed)) payload[filter.fieldname] = parsed;
			continue;
		}

		payload[filter.fieldname] = String(rawValue).trim();
	}

	return payload;
}

export function hydrateReportFiltersFromQuery(
	filters: ReportFilterDefinition[],
	query: Record<string, string | string[] | null | undefined>,
): Record<string, unknown> {
	const hydrated = buildInitialReportFilters(filters);

	for (const filter of filters) {
		const queryValue = query[filter.fieldname];
		if (queryValue === undefined || queryValue === null || queryValue === "") {
			continue;
		}

		if (filter.type === "multi-link") {
			if (Array.isArray(queryValue)) {
				hydrated[filter.fieldname] = queryValue.map((item) => String(item)).filter(Boolean);
			} else {
				hydrated[filter.fieldname] = String(queryValue)
					.split(",")
					.map((item) => item.trim())
					.filter(Boolean);
			}
			continue;
		}

		if (filter.type === "integer") {
			const parsed = Number.parseInt(Array.isArray(queryValue) ? queryValue[0] : queryValue, 10);
			if (!Number.isNaN(parsed)) hydrated[filter.fieldname] = parsed;
			continue;
		}

		if (filter.type === "float") {
			const parsed = Number.parseFloat(Array.isArray(queryValue) ? queryValue[0] : queryValue);
			if (!Number.isNaN(parsed)) hydrated[filter.fieldname] = parsed;
			continue;
		}

		hydrated[filter.fieldname] = Array.isArray(queryValue) ? queryValue[0] : String(queryValue);
	}

	return hydrated;
}

export function serializeReportFiltersToQuery(
	filters: ReportFilterDefinition[],
	values: Record<string, unknown>,
): Record<string, string | string[]> {
	const query: Record<string, string | string[]> = {};
	const normalized = normalizeReportFilters(filters, values);

	for (const [fieldname, value] of Object.entries(normalized)) {
		if (Array.isArray(value)) {
			if (value.length > 0) {
				query[fieldname] = value.map((item) => String(item));
			}
			continue;
		}

		if (value === null || value === undefined || value === "") {
			continue;
		}

		query[fieldname] = String(value);
	}

	return query;
}

export function resolveReportLinkFilters(
	filter: ReportFilterDefinition,
	values: Record<string, unknown>,
): Record<string, unknown> {
	if (!filter.getQueryFilters) return {};
	const resolved: Record<string, unknown> = {};
	for (const [key, raw] of Object.entries(filter.getQueryFilters)) {
		if (typeof raw === "string" && raw.startsWith("$")) {
			resolved[key] = values[raw.slice(1)];
		} else {
			resolved[key] = raw;
		}
	}
	return resolved;
}

export function getVisibleReportColumns(columns: ReportColumn[]): ReportColumn[] {
	return columns.filter(
		(column) => !reportUtilityFields.has(column.fieldname) && !String(column.fieldname).startsWith("_"),
	);
}

export function isReportNumericColumn(column: ReportColumn): boolean {
	return ["Currency", "Float", "Int", "Percent", "Check"].includes(String(column.fieldtype || ""));
}

export function isReportTotalRow(row: Record<string, unknown>): boolean {
	return Boolean(row.is_total_row || row.is_subtotal || row._is_total_row);
}

export function normalizeReportRows(
	columns: ReportColumn[],
	result: unknown[],
	options: { addTotalRow?: boolean | number; skipTotalRow?: boolean | number } = {},
): Record<string, unknown>[] {
	const lastIndex = result.length - 1;
	const markLastAsTotal = Boolean(options.addTotalRow) && !options.skipTotalRow;

	return result.map((row, index) => {
		let record: Record<string, unknown>;
		if (Array.isArray(row)) {
			record = {};
			columns.forEach((column, columnIndex) => {
				record[column.fieldname] = row[columnIndex];
			});
		} else {
			record = (row as Record<string, unknown>) ?? {};
		}

		if (markLastAsTotal && index === lastIndex) {
			record._is_total_row = 1;
		}

		return record;
	});
}

export function compareReportRows(
	left: Record<string, unknown>,
	right: Record<string, unknown>,
	column: ReportColumn,
): number {
	const leftValue = left[column.fieldname];
	const rightValue = right[column.fieldname];
	const fieldtype = String(column.fieldtype || "");

	if (["Currency", "Float", "Int", "Percent", "Check"].includes(fieldtype)) {
		const leftNumber = Number(leftValue ?? 0);
		const rightNumber = Number(rightValue ?? 0);
		if (Number.isNaN(leftNumber) && Number.isNaN(rightNumber)) return 0;
		if (Number.isNaN(leftNumber)) return 1;
		if (Number.isNaN(rightNumber)) return -1;
		return leftNumber - rightNumber;
	}

	if (["Date", "Datetime"].includes(fieldtype)) {
		const leftTime = new Date(String(leftValue || "")).getTime();
		const rightTime = new Date(String(rightValue || "")).getTime();
		if (Number.isNaN(leftTime) && Number.isNaN(rightTime)) return 0;
		if (Number.isNaN(leftTime)) return 1;
		if (Number.isNaN(rightTime)) return -1;
		return leftTime - rightTime;
	}

	return String(leftValue ?? "").localeCompare(String(rightValue ?? ""), undefined, {
		numeric: true,
		sensitivity: "base",
	});
}

function escapeDelimited(value: string, delimiter: string): string {
	const needsQuotes = value.includes(delimiter) || value.includes("\n") || value.includes('"');
	const escaped = value.replace(/"/g, '""');
	return needsQuotes ? `"${escaped}"` : escaped;
}

export function buildReportDelimitedRows(
	columns: ReportColumn[],
	rows: Record<string, unknown>[],
	currency: string,
	delimiter: "," | "\t",
): string {
	const header = columns.map((column) => escapeDelimited(column.label, delimiter)).join(delimiter);
	const body = rows.map((row) =>
		columns
			.map((column) =>
				escapeDelimited(formatReportCell(column, row[column.fieldname], currency), delimiter),
			)
			.join(delimiter),
	);
	return [header, ...body].join("\n");
}

function optionalPrecision(column: ReportColumn): number | null {
	const raw = column.precision as number | string | null | undefined;
	if (raw === null || raw === undefined || raw === "") return null;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function columnCurrency(column: ReportColumn): string {
	const options = String(column.options || "").trim();
	return /^[A-Za-z]{3}$/.test(options) ? options.toUpperCase() : "";
}

function formatReportDateTime(value: unknown): string {
	if (!value) return "-";
	const date = new Date(String(value));
	if (Number.isNaN(date.getTime())) return String(value);
	return new Intl.DateTimeFormat(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	}).format(date);
}

export function formatReportCell(column: ReportColumn, value: unknown, currency = ""): string {
	if (value === null || value === undefined || value === "") return "-";

	if (Array.isArray(value)) {
		return value.map((item) => String(item)).join(", ");
	}

	switch (column.fieldtype) {
		case "Currency": {
			const parsed = Number(value ?? 0);
			if (Number.isNaN(parsed)) return String(value);
			const cellCurrency = columnCurrency(column) || currency;
			const precision = optionalPrecision(column);
			return formatWithSymbol(cellCurrency, parsed, precision);
		}
		case "Float":
		case "Percent": {
			const parsed = Number(value ?? 0);
			if (Number.isNaN(parsed)) return String(value);
			const formatted = formatFloat(parsed, optionalPrecision(column));
			return column.fieldtype === "Percent" ? `${formatted}%` : formatted;
		}
		case "Int": {
			const parsed = Number(value ?? 0);
			if (Number.isNaN(parsed)) return String(value);
			return formatInt(Math.trunc(parsed));
		}
		case "Check":
			return value ? __("Yes") : __("No");
		case "Date": {
			const date = new Date(String(value));
			if (Number.isNaN(date.getTime())) return String(value);
			return new Intl.DateTimeFormat(undefined, {
				year: "numeric",
				month: "short",
				day: "numeric",
			}).format(date);
		}
		case "Datetime":
			return formatReportDateTime(value);
		default:
			return String(value);
	}
}

export async function fetchReportMeta(reportName: string): Promise<ReportFilterDefinition[]> {
	const response = await call<{ filters: ReportFilterDefinition[] }>("xpos.api.reports.get_report_meta", {
		report: reportName,
	});
	return Array.isArray(response?.filters) ? response.filters : [];
}

export async function fetchReportData(
	reportName: string,
	filters: Record<string, unknown>,
): Promise<ReportQueryResult> {
	return call<ReportQueryResult>("frappe.desk.query_report.run", {
		report_name: reportName,
		filters: JSON.stringify(filters),
	});
}
