/**
 * Search semantics (identical on Android and in the host SQLite test double):
 *  - input is normalised: Unicode NFKD, combining marks removed, lower-cased, whitespace collapsed;
 *  - a query matches items whose normalised NAME or normalised ITEM CODE STARTS WITH it;
 *  - it is NOT a substring or word-anywhere search ("cola" does not find "Coca Cola");
 *  - barcodes are matched exactly and only via lookupBarcode;
 *  - results are ordered by (name_norm, item_code) and paged with a keyset cursor.
 */
export const MAX_PAGE = 100;
export const DEFAULT_PAGE = 50;
export const MAX_QUERY_LEN = 64;

export function normalize(text: string): string {
	return text
		.normalize("NFKD")
		.replace(/\p{M}+/gu, "")
		.toLowerCase()
		.replace(/\s+/g, " ")
		.trim();
}

export function normalizeQuery(text: string): string {
	return normalize(text).slice(0, MAX_QUERY_LEN);
}

/** Smallest string greater than every string starting with `prefix`. */
export function prefixUpperBound(prefix: string): string {
	return prefix + "\u{10FFFF}";
}

export function clampLimit(limit: number | undefined): number {
	const n = Math.floor(limit ?? DEFAULT_PAGE);
	return Math.min(MAX_PAGE, Math.max(1, Number.isFinite(n) ? n : DEFAULT_PAGE));
}

export interface PageCursor {
	nameNorm: string;
	itemCode: string;
}
