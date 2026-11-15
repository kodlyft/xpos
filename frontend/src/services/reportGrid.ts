import {
	compareReportRows,
	formatReportCell,
	isReportTotalRow,
	REPORT_SUMMABLE_TYPES,
	type ReportColumn,
} from "@/services/reports";

export interface ReportSort {
	fieldname: string;
	direction: "asc" | "desc";
}

export interface ReportLayout {
	/** Column order by fieldname; columns missing from it keep their server position after it. */
	order: string[];
	hidden: string[];
	widths: Record<string, number>;
	/** How many leading columns (after ordering) stay pinned while scrolling sideways. */
	frozen: number;
}

export const emptyLayout = (): ReportLayout => ({ order: [], hidden: [], widths: {}, frozen: 0 });

export const MIN_COLUMN_WIDTH = 72;
export const MAX_COLUMN_WIDTH = 640;

export function defaultColumnWidth(column: ReportColumn, index: number): number {
	if (column.width && Number(column.width) > 0) {
		return Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, Number(column.width)));
	}
	if (["Currency", "Float", "Int", "Percent"].includes(String(column.fieldtype || ""))) return 128;
	if (["Date", "Datetime"].includes(String(column.fieldtype || ""))) return 150;
	return index === 0 ? 220 : 160;
}

export function clampWidth(width: number): number {
	return Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, Math.round(width)));
}

/** Order, hide and size columns per a saved layout. Columns the layout has never seen stay visible. */
export function applyLayout(columns: ReportColumn[], layout: ReportLayout): ReportColumn[] {
	const byName = new Map(columns.map((column) => [column.fieldname, column]));
	const ordered: ReportColumn[] = [];
	for (const name of layout.order) {
		const column = byName.get(name);
		if (column) {
			ordered.push(column);
			byName.delete(name);
		}
	}
	for (const column of columns) {
		if (byName.has(column.fieldname)) ordered.push(column);
	}
	const hidden = new Set(layout.hidden);
	return ordered.filter((column) => !hidden.has(column.fieldname));
}

/** Drop layout entries for columns the report no longer has, so an old saved view cannot hide a new column forever. */
export function reconcileLayout(layout: ReportLayout, columns: ReportColumn[]): ReportLayout {
	const known = new Set(columns.map((column) => column.fieldname));
	return {
		order: layout.order.filter((name) => known.has(name)),
		hidden: layout.hidden.filter((name) => known.has(name)),
		widths: Object.fromEntries(Object.entries(layout.widths).filter(([name]) => known.has(name))),
		frozen: Math.max(0, Math.min(layout.frozen, columns.length)),
	};
}

export function treeIndent(row: Record<string, unknown>): number {
	const indent = Number(row.indent ?? 0);
	return Number.isFinite(indent) && indent > 0 ? Math.floor(indent) : 0;
}

export function isTreeReport(rows: Record<string, unknown>[]): boolean {
	return rows.some((row) => treeIndent(row) > 0);
}

export function rowHasChildren(rows: Record<string, unknown>[], index: number): boolean {
	const next = rows[index + 1];
	return Boolean(next) && treeIndent(next) > treeIndent(rows[index]);
}

export function rowMatchesSearch(
	columns: ReportColumn[],
	row: Record<string, unknown>,
	query: string,
	currency: string,
): boolean {
	return columns.some((column) =>
		formatReportCell(column, row[column.fieldname], currency, row).toLowerCase().includes(query),
	);
}

export interface SelectRowsOptions {
	columns: ReportColumn[];
	search?: string;
	sort?: ReportSort | null;
	currency?: string;
	/** Indices (into `rows`) of collapsed tree parents; ignored for flat reports. */
	collapsed?: ReadonlySet<number>;
}

export interface SelectedRows {
	rows: Record<string, unknown>[];
	/** index into the source rows, parallel to `rows`, so the grid can key tree state. */
	sourceIndex: number[];
	/** True when search or sort narrowed or reordered the complete result. */
	filtered: boolean;
}

/**
 * Apply search, sort and tree collapse to the data rows (never to total rows). A tree is kept
 * in document order: sorting is skipped for it, search keeps each match's ancestors, and
 * collapsing hides descendants. All of it is on the complete result, not on one page.
 */
export function selectReportRows(rows: Record<string, unknown>[], options: SelectRowsOptions): SelectedRows {
	const query = (options.search ?? "").trim().toLowerCase();
	const currency = options.currency ?? "";
	const tree = isTreeReport(rows);
	const indices = rows.map((_, index) => index);

	let keep = indices;
	if (query) {
		const matches = new Set(
			indices.filter((index) => rowMatchesSearch(options.columns, rows[index], query, currency)),
		);
		if (tree) {
			const include = new Set(matches);
			for (const index of matches) {
				let level = treeIndent(rows[index]);
				for (let i = index - 1; i >= 0 && level > 0; i--) {
					if (treeIndent(rows[i]) < level) {
						include.add(i);
						level = treeIndent(rows[i]);
					}
				}
			}
			keep = indices.filter((index) => include.has(index));
		} else {
			keep = indices.filter((index) => matches.has(index));
		}
	}

	const sortColumn = options.sort
		? options.columns.find((column) => column.fieldname === options.sort?.fieldname)
		: undefined;
	if (sortColumn && options.sort && !tree) {
		const direction = options.sort.direction === "desc" ? -1 : 1;
		keep = [...keep].sort((left, right) => {
			const comparison = compareReportRows(rows[left], rows[right], sortColumn);
			return comparison !== 0 ? comparison * direction : left - right;
		});
	}

	if (tree && options.collapsed && options.collapsed.size > 0 && !query) {
		const visible: number[] = [];
		let hideBelow: number | null = null;
		for (const index of keep) {
			const indent = treeIndent(rows[index]);
			if (hideBelow !== null && indent > hideBelow) continue;
			hideBelow = null;
			visible.push(index);
			if (options.collapsed.has(index)) hideBelow = indent;
		}
		keep = visible;
	}

	return {
		rows: keep.map((index) => rows[index]),
		sourceIndex: keep,
		filtered: Boolean(query) || Boolean(sortColumn && !tree),
	};
}

export interface TotalCell {
	value: number | null;
	/** More than one currency was present, so no single sum exists. */
	mixed: boolean;
	currency: string;
}

/**
 * Totals over a set of rows, for the columns the server's complete total row also totals.
 * Without a server total row nothing is invented. Currency columns are never added across
 * currencies.
 */
export function computeFilteredTotals(
	columns: ReportColumn[],
	rows: Record<string, unknown>[],
	completeTotal: Record<string, unknown> | undefined,
	fallbackCurrency: string,
	currencyOf: (column: ReportColumn, row: Record<string, unknown>, fallback: string) => string,
): Record<string, TotalCell> {
	const totals: Record<string, TotalCell> = {};
	if (!completeTotal) return totals;
	for (const column of columns) {
		if (!REPORT_SUMMABLE_TYPES.includes(String(column.fieldtype || ""))) continue;
		const server = completeTotal[column.fieldname];
		if (server === null || server === undefined || server === "") continue;
		let sum = 0;
		let currency = "";
		let mixed = false;
		for (const row of rows) {
			if (isReportTotalRow(row)) continue;
			const amount = Number(row[column.fieldname] ?? 0);
			if (!Number.isFinite(amount)) continue;
			if (column.fieldtype === "Currency") {
				const rowCurrency = currencyOf(column, row, fallbackCurrency);
				if (currency && rowCurrency !== currency) mixed = true;
				currency = currency || rowCurrency;
			}
			sum += amount;
		}
		totals[column.fieldname] = { value: mixed ? null : sum, mixed, currency };
	}
	return totals;
}

/** True when the data rows carry more than one currency in any Currency column. */
export function hasMixedCurrency(
	columns: ReportColumn[],
	rows: Record<string, unknown>[],
	fallbackCurrency: string,
	currencyOf: (column: ReportColumn, row: Record<string, unknown>, fallback: string) => string,
): boolean {
	const seen = new Set<string>();
	for (const column of columns) {
		if (column.fieldtype !== "Currency") continue;
		for (const row of rows) {
			if (isReportTotalRow(row)) continue;
			const value = row[column.fieldname];
			if (value === null || value === undefined || value === "") continue;
			seen.add(currencyOf(column, row, fallbackCurrency));
		}
	}
	return seen.size > 1;
}
