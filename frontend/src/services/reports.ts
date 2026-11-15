import { call, getValue } from "@/services/api";
import __ from "@/lib/translate";
import { formatWithSymbol } from "@/composables/useCurrency";
import { formatFloat, formatInt } from "@/utils/numberFormat";

export type ReportCategory = "Inventory" | "Sales" | "Purchasing" | "Operations" | "Accounting" | "Other";
export type ReportCapabilityState = "supported" | "adapter_required" | "unsupported";
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
	id: string;
	slug: string;
	aliases: string[];
	title: string;
	description: string;
	category: ReportCategory;
	ref_doctype: string;
	capability: { state: ReportCapabilityState; reasons: string[] };
	execution?: { prepared?: "none" | "unsupported" | string; summary?: string; chart?: string };
	export: { allowed: boolean };
	print: { allowed: boolean; thermal: boolean };
}

export interface ReportColumn {
	fieldname: string;
	label: string;
	fieldtype?: string;
	options?: string;
	width?: number;
	precision?: number;
	hidden?: number | boolean;
	indent?: number;
	default?: unknown;
	[key: string]: unknown;
}

export interface ReportSummaryItem {
	label?: string;
	value?: unknown;
	datatype?: string;
	currency?: string;
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

function cloneValue<T>(value: T): T {
	if (Array.isArray(value)) return [...value] as T;
	if (value && typeof value === "object") return { ...(value as Record<string, unknown>) } as T;
	return value;
}

let catalogRequest: Promise<ReportDefinition[]> | null = null;

export function fetchReportCatalog(force = false): Promise<ReportDefinition[]> {
	if (!catalogRequest || force) {
		catalogRequest = call<ReportDefinition[]>("xpos.api.reports.get_report_catalog")
			.then((rows) => (Array.isArray(rows) ? rows : []))
			.catch((error) => {
				catalogRequest = null;
				throw error;
			});
	}
	return catalogRequest;
}

export function resetReportCatalog(): void {
	catalogRequest = null;
}

/** Match a URL segment against a report's canonical id, slug or any alias. */
export function findReportDefinition(
	reports: ReportDefinition[],
	identifier: string | string[] | undefined,
): ReportDefinition | undefined {
	if (!identifier || Array.isArray(identifier)) return undefined;
	return reports.find(
		(report) =>
			report.id === identifier || report.slug === identifier || report.aliases.includes(identifier),
	);
}

export function isReportRunnable(report: ReportDefinition): boolean {
	return report.capability.state === "supported";
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

const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

function firstQueryValue(value: string | string[]): string {
	return Array.isArray(value) ? String(value[0] ?? "") : String(value);
}

/**
 * Read filter values out of the URL. Only the fields the URL actually supplies are returned, so
 * the caller's defaults (company, warehouse, saved defaults) survive for everything else. A key
 * present with an empty value is an explicit "cleared" and is returned as the empty value.
 */
export function hydrateReportFiltersFromQuery(
	filters: ReportFilterDefinition[],
	query: Record<string, string | string[] | null | undefined>,
): Record<string, unknown> {
	const hydrated: Record<string, unknown> = {};

	for (const filter of filters) {
		const queryValue = query[filter.fieldname];
		if (queryValue === undefined || queryValue === null) continue;

		const text = firstQueryValue(queryValue).trim();

		if (filter.type === "multi-link") {
			const items = Array.isArray(queryValue)
				? queryValue.map((item) => String(item).trim())
				: text.split(",").map((item) => item.trim());
			hydrated[filter.fieldname] = items.filter(Boolean);
			continue;
		}

		if (text === "") {
			hydrated[filter.fieldname] = "";
			continue;
		}

		if (filter.type === "integer") {
			const parsed = Number.parseInt(text, 10);
			if (!Number.isNaN(parsed)) hydrated[filter.fieldname] = parsed;
			continue;
		}

		if (filter.type === "float") {
			const parsed = Number.parseFloat(text);
			if (!Number.isNaN(parsed)) hydrated[filter.fieldname] = parsed;
			continue;
		}

		if (filter.type === "date") {
			if (ISO_DATE.test(text)) hydrated[filter.fieldname] = text.slice(0, 10);
			continue;
		}

		if (filter.type === "select" && filter.options?.length) {
			if (filter.options.some((option) => option.value === text)) hydrated[filter.fieldname] = text;
			continue;
		}

		hydrated[filter.fieldname] = text;
	}

	return hydrated;
}

function isEmptyFilterValue(value: unknown): boolean {
	if (Array.isArray(value)) return value.length === 0;
	return value === undefined || value === null || value === "";
}

/**
 * Write the non-empty filters to the URL. When `defaults` is given, a filter the user cleared
 * that would otherwise be re-defaulted on reload is written as an explicit empty value.
 */
export function serializeReportFiltersToQuery(
	filters: ReportFilterDefinition[],
	values: Record<string, unknown>,
	defaults: Record<string, unknown> = {},
): Record<string, string | string[]> {
	const query: Record<string, string | string[]> = {};
	const normalized = normalizeReportFilters(filters, values);

	for (const filter of filters) {
		const value = normalized[filter.fieldname];
		if (value === undefined) {
			if (!isEmptyFilterValue(defaults[filter.fieldname])) query[filter.fieldname] = "";
			continue;
		}
		query[filter.fieldname] = Array.isArray(value) ? value.map((item) => String(item)) : String(value);
	}

	return query;
}

/**
 * Filters the open shift already decides. A cashier works inside one company, POS profile and
 * warehouse, so these are not offered as choices and are always sent with the shift's values
 * (the server still enforces the same scope).
 */
const SHIFT_BOUND_FILTERS = ["company", "pos_profile", "warehouse"] as const;

export interface ShiftContext {
	company?: string;
	pos_profile?: string;
	warehouse?: string;
}

export function splitShiftBoundFilters(
	filters: ReportFilterDefinition[],
	context: ShiftContext,
): { visible: ReportFilterDefinition[]; bound: Record<string, string> } {
	const bound: Record<string, string> = {};
	const visible = filters.filter((filter) => {
		const key = filter.fieldname as (typeof SHIFT_BOUND_FILTERS)[number];
		if (!SHIFT_BOUND_FILTERS.includes(key) || !context[key]) return true;
		bound[filter.fieldname] = context[key] as string;
		return false;
	});
	return { visible, bound };
}

const DATE_RANGE_PAIRS: [string, string][] = [
	["from_date", "to_date"],
	["start_date", "end_date"],
];

/** Required filters still empty. The filter bar marks them with a red asterisk; no message is shown. */
export function missingRequiredReportFilters(
	filters: ReportFilterDefinition[],
	values: Record<string, unknown>,
): ReportFilterDefinition[] {
	return filters.filter((filter) => filter.required && isEmptyFilterValue(values[filter.fieldname]));
}

/** Static checks that need no server round trip; each message is shown next to the filter bar. */
export function validateReportFilters(
	filters: ReportFilterDefinition[],
	values: Record<string, unknown>,
): string[] {
	const errors: string[] = [];
	const known = new Set(filters.map((filter) => filter.fieldname));

	for (const filter of filters) {
		if (filter.type !== "date") continue;
		const value = values[filter.fieldname];
		if (!isEmptyFilterValue(value) && !ISO_DATE.test(String(value))) {
			errors.push(__("{0} is not a valid date.", [filter.label]));
		}
	}

	for (const [fromName, toName] of DATE_RANGE_PAIRS) {
		if (!known.has(fromName) || !known.has(toName)) continue;
		const from = String(values[fromName] ?? "");
		const to = String(values[toName] ?? "");
		if (from && to && ISO_DATE.test(from) && ISO_DATE.test(to) && from > to) {
			errors.push(__("The start date must not be after the end date."));
		}
	}

	if (
		known.has("warehouse") &&
		!isEmptyFilterValue(values.warehouse) &&
		known.has("company") &&
		isEmptyFilterValue(values.company)
	) {
		errors.push(__("Choose a company before choosing a warehouse."));
	}

	return errors;
}

const CONTEXT_LINKS: { fieldname: string; doctype: string }[] = [
	{ fieldname: "warehouse", doctype: "Warehouse" },
	{ fieldname: "pos_profile", doctype: "POS Profile" },
];
const contextCompanyCache = new Map<string, Promise<string>>();

/**
 * Confirm the warehouse / POS profile belong to the chosen company. The server enforces scope
 * regardless; this just fails fast with a clear message instead of an empty or rejected run.
 */
export async function validateReportContext(
	filters: ReportFilterDefinition[],
	values: Record<string, unknown>,
	lookup: (doctype: string, name: string) => Promise<string> = lookupCompany,
): Promise<string[]> {
	const company = String(values.company ?? "");
	if (!company) return [];
	const known = new Set(filters.map((filter) => filter.fieldname));
	const errors: string[] = [];
	for (const { fieldname, doctype } of CONTEXT_LINKS) {
		const name = String(values[fieldname] ?? "");
		if (!known.has(fieldname) || !name) continue;
		try {
			const owner = await lookup(doctype, name);
			if (owner && owner !== company) {
				errors.push(__("{0} {1} belongs to {2}, not {3}.", [doctype, name, owner, company]));
			}
		} catch {
			// an unreadable link is reported by the server run itself
		}
	}
	return errors;
}

function lookupCompany(doctype: string, name: string): Promise<string> {
	const key = `${doctype}\u0000${name}`;
	let cached = contextCompanyCache.get(key);
	if (!cached) {
		cached = getValue<{ company?: string }>(doctype, name, "company")
			.then((row) => String(row?.company ?? ""))
			.catch((error) => {
				contextCompanyCache.delete(key);
				throw error;
			});
		contextCompanyCache.set(key, cached);
	}
	return cached;
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

/**
 * Columns a user may see. `hidden` is honoured here and everywhere downstream (search, export,
 * copy, print) so a hidden column never leaks into output. This is presentation, not a security
 * boundary: the server decides which data a user can fetch at all.
 */
export function getVisibleReportColumns(columns: ReportColumn[]): ReportColumn[] {
	return columns.filter(
		(column) =>
			!reportUtilityFields.has(column.fieldname) &&
			!String(column.fieldname).startsWith("_") &&
			!Number(column.hidden),
	);
}

const NUMERIC_TYPES = ["Currency", "Float", "Int", "Percent", "Check"];
const SUMMABLE_TYPES = ["Currency", "Float", "Int"];

export function isReportNumericColumn(column: ReportColumn): boolean {
	return NUMERIC_TYPES.includes(String(column.fieldtype || ""));
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
	const markLastAsTotal = Boolean(options.addTotalRow) && !options.skipTotalRow && result.length > 1;

	return result.map((row, index) => {
		let record: Record<string, unknown>;
		if (Array.isArray(row)) {
			record = {};
			columns.forEach((column, columnIndex) => {
				record[column.fieldname] = row[columnIndex];
			});
		} else {
			record = { ...((row as Record<string, unknown>) ?? {}) };
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

	if (NUMERIC_TYPES.includes(fieldtype)) {
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

export function reportColumnPrecision(column: ReportColumn): number | null {
	const raw = column.precision as number | string | null | undefined;
	if (raw === null || raw === undefined || raw === "") return null;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

const CURRENCY_CODE = /^[A-Za-z]{3}$/;

/**
 * The currency of one cell: a literal code in `options`, else the value of the sibling column
 * `options` names (the Frappe convention), else the report-level fallback.
 */
export function columnCurrency(column: ReportColumn, row?: Record<string, unknown>, fallback = ""): string {
	const options = String(column.options || "").trim();
	if (CURRENCY_CODE.test(options) && !(row && options in row)) return options.toUpperCase();
	if (row && options && options in row) {
		const sibling = String(row[options] ?? "").trim();
		if (CURRENCY_CODE.test(sibling)) return sibling.toUpperCase();
	}
	return fallback;
}

/** A unit shown beside a quantity: the value of the sibling column a Float/Int column's options names. */
export function columnUnit(column: ReportColumn, row?: Record<string, unknown>): string {
	if (!row || !["Float", "Int"].includes(String(column.fieldtype || ""))) return "";
	const options = String(column.options || "").trim();
	if (!options || !(options in row)) return "";
	const value = row[options];
	return typeof value === "string" ? value.trim() : "";
}

function formatReportDateTime(value: unknown): string {
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

/** Display text for a cell. Empty values render as an empty string; the grid shows its own placeholder. */
export function formatReportCell(
	column: ReportColumn,
	value: unknown,
	currency = "",
	row?: Record<string, unknown>,
): string {
	if (value === null || value === undefined || value === "") return "";

	if (Array.isArray(value)) {
		return value.map((item) => String(item)).join(", ");
	}

	switch (column.fieldtype) {
		case "Currency": {
			const parsed = Number(value);
			if (Number.isNaN(parsed)) return String(value);
			return formatWithSymbol(
				columnCurrency(column, row, currency),
				parsed,
				reportColumnPrecision(column),
			);
		}
		case "Float":
		case "Percent": {
			const parsed = Number(value);
			if (Number.isNaN(parsed)) return String(value);
			const formatted = formatFloat(parsed, reportColumnPrecision(column));
			if (column.fieldtype === "Percent") return `${formatted}%`;
			const unit = columnUnit(column, row);
			return unit ? `${formatted} ${unit}` : formatted;
		}
		case "Int": {
			const parsed = Number(value);
			if (Number.isNaN(parsed)) return String(value);
			const formatted = formatInt(Math.trunc(parsed));
			const unit = columnUnit(column, row);
			return unit ? `${formatted} ${unit}` : formatted;
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

/** Summary card text, honouring the item's declared datatype and currency. */
export function formatReportSummaryValue(item: ReportSummaryItem, fallbackCurrency = ""): string {
	const value = item.value;
	if (value === null || value === undefined || value === "") return "-";
	if (Array.isArray(value)) return value.map((entry) => String(entry)).join(", ");
	const number = typeof value === "number" ? value : Number(value);
	const numeric =
		typeof value === "number" ||
		(typeof value === "string" && value.trim() !== "" && !Number.isNaN(number));
	switch (String(item.datatype || "")) {
		case "Currency":
			return numeric ? formatWithSymbol(item.currency || fallbackCurrency, number) : String(value);
		case "Int":
			return numeric ? formatInt(Math.trunc(number)) : String(value);
		case "Float":
			return numeric ? formatFloat(number) : String(value);
		case "Percent":
			return numeric ? `${formatFloat(number)}%` : String(value);
		case "Data":
		case "Text":
			return String(value);
		default:
			return typeof value === "number" ? formatFloat(value) : String(value);
	}
}

export type ReportPreparedState = "none" | "pending" | "failed";

/**
 * A prepared report answers with a status instead of rows until its background run completes.
 * That must read as "not ready", never as an empty result.
 */
export function getReportPreparedState(
	response: Partial<ReportQueryResult> | null | undefined,
): ReportPreparedState {
	if (!response) return "none";
	const status = String(response.status ?? "").toLowerCase();
	if (["error", "failed"].includes(status)) return "failed";
	if (["queued", "started", "running", "pending"].includes(status)) return "pending";
	if (response.prepared_report && !(Array.isArray(response.result) && response.result.length > 0)) {
		return status === "completed" || status === "finished" ? "none" : "pending";
	}
	return "none";
}

export const REPORT_EXPORT_ROW_LIMIT = 50_000;

export { SUMMABLE_TYPES as REPORT_SUMMABLE_TYPES };

export async function fetchReportMeta(reportId: string): Promise<ReportFilterDefinition[]> {
	const response = await call<{ filters: ReportFilterDefinition[] }>("xpos.api.reports.get_report_meta", {
		report: reportId,
	});
	return Array.isArray(response?.filters) ? response.filters : [];
}

export async function fetchReportData(
	reportId: string,
	filters: Record<string, unknown>,
	purpose: "view" | "export" | "print" = "view",
): Promise<ReportQueryResult> {
	return call<ReportQueryResult>("xpos.api.reports.run_report", {
		report: reportId,
		filters: JSON.stringify(filters),
		purpose,
	});
}
