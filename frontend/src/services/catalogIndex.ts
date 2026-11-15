/**
 * In-memory search index over the cached catalogue.
 *
 * It answers what the offline product search used to answer by reading every item from IndexedDB
 * and filtering in JavaScript, with the same results in the same order:
 *  - a term matches when it is a case-insensitive substring of any configured field (the field
 *    called "name" is the item code) or of the barcode;
 *  - rows come back in item_code order, which is IndexedDB's primary-key order;
 *  - a group filter is an exact match on item_group.
 *
 * The index holds one lower-cased string per item rather than copies of the items, scans it in
 * order and stops as soon as the requested page (plus one, to know whether more exist) is found.
 * It does not import Vue, Dexie or any store, so it can run on the main thread or in a worker.
 */

/** One barcode of an item: the UOM it sells in, how many stock units that is, and its rate. */
export interface BarcodeEntry {
	barcode: string;
	uom?: string;
	/** null: the item has no conversion for that UOM, so the scan must be refused. */
	conversion_factor?: number | null;
	rate?: number | null;
}

export type BarcodeResolution =
	| { kind: "none" }
	| { kind: "item"; code: string; entry?: BarcodeEntry }
	/** Two items claim the value (for example while a barcode moves between items mid-sync). */
	| { kind: "ambiguous"; codes: string[] };

export interface CatalogRow {
	item_code: string;
	item_group?: string;
	barcode?: string;
	barcodes?: BarcodeEntry[];
	[field: string]: unknown;
}

export interface CatalogSearch {
	term: string;
	group?: string;
	offset?: number;
	limit: number;
}

export interface CatalogPage {
	codes: string[];
	hasMore: boolean;
}

export interface CatalogIndex {
	readonly size: number;
	lookup(value: string): string | undefined;
	/** A scanned value: a barcode wins over an item code, as it does on the server. */
	resolve(value: string): BarcodeResolution;
	search(query: CatalogSearch): CatalogPage;
}

const SEPARATOR = "\u0000";
const ALL_GROUPS = "All Item Groups";

export function buildCatalogIndex(rows: readonly CatalogRow[], fields: readonly string[]): CatalogIndex {
	const columns = fields.map((field) => (field === "name" ? "item_code" : field));
	const sorted = [...rows].sort((a, b) =>
		a.item_code < b.item_code ? -1 : a.item_code > b.item_code ? 1 : 0,
	);

	const codes = new Array<string>(sorted.length);
	const groups = new Array<string | undefined>(sorted.length);
	const haystacks = new Array<string>(sorted.length);
	const exact = new Map<string, number>();
	const byBarcode = new Map<string, { at: number; entry?: BarcodeEntry }[]>();
	const addBarcode = (value: string, at: number, entry?: BarcodeEntry) => {
		const key = value.toLowerCase();
		const hits = byBarcode.get(key) ?? [];
		hits.push({ at, entry });
		byBarcode.set(key, hits);
	};

	for (let i = 0; i < sorted.length; i++) {
		const row = sorted[i];
		codes[i] = row.item_code;
		groups[i] = row.item_group;

		const parts: string[] = [];
		for (const column of columns) {
			const value = row[column];
			parts.push(typeof value === "string" ? value.toLowerCase() : "");
		}
		const entries = (row.barcodes ?? []).filter((entry) => entry && typeof entry.barcode === "string");
		const barcodes = [...entries.map((entry) => entry.barcode), ...(row.barcode ? [row.barcode] : [])];
		parts.push(barcodes.join(" ").toLowerCase());
		haystacks[i] = parts.join(SEPARATOR);
		for (const entry of entries) addBarcode(entry.barcode, i, entry);
		if (row.barcode) addBarcode(row.barcode, i);

		const code = row.item_code.toLowerCase();
		if (!exact.has(code)) exact.set(code, i);
	}
	// every barcode, in item order, is exact-matchable after the item codes
	for (const [barcode, hits] of byBarcode) if (!exact.has(barcode)) exact.set(barcode, hits[0].at);

	return {
		size: sorted.length,

		lookup(value) {
			const at = exact.get(value.toLowerCase());
			return at === undefined ? undefined : codes[at];
		},

		resolve(value) {
			const key = value.toLowerCase();
			const hits = byBarcode.get(key);
			if (hits) {
				const owners = [...new Set(hits.map((hit) => codes[hit.at]))];
				if (owners.length > 1) return { kind: "ambiguous", codes: owners };
				return { kind: "item", code: owners[0], entry: hits[0].entry };
			}
			const at = exact.get(key);
			return at === undefined ? { kind: "none" } : { kind: "item", code: codes[at] };
		},

		search({ term, group, offset = 0, limit }) {
			const needle = term.toLowerCase();
			if (needle.includes(SEPARATOR)) return { codes: [], hasMore: false };
			const byGroup = !!group && group !== ALL_GROUPS;
			const found: string[] = [];
			let skipped = 0;

			for (let i = 0; i < codes.length; i++) {
				if (byGroup && groups[i] !== group) continue;
				if (needle && !haystacks[i].includes(needle)) continue;
				if (skipped < offset) {
					skipped++;
					continue;
				}
				if (found.length === limit) return { codes: found, hasMore: true };
				found.push(codes[i]);
			}
			return { codes: found, hasMore: false };
		},
	};
}
