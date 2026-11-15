import type { ApiTransport, CatalogItem, CatalogRepository, CatalogScopeInfo } from "@mobile/ports";
import { crc32 } from "@mobile/domain/crc32";
import { fromRate } from "@mobile/domain/money";

/**
 * Keeps the device catalog in step with what the signed-in cashier may sell, using the existing server protocol
 * (xpos.api.catalog_sync):
 *  - full download: begin -> pages -> digest, staged in a new generation, verified (count + CRC32) and activated
 *    atomically. A failed or interrupted download leaves the active catalog untouched;
 *  - refresh: when the device holds a catalog and a delta cursor from the last run, only changed items are fetched
 *    (`catalog_delta`) and applied to the active generation page by page (each page atomic, replay-safe), then the
 *    digest is checked; any disagreement, expired cursor or scope change falls back to a full download.
 * Stock and customers are not downloaded here: a sale is validated by ERPNext at checkout.
 */

const API = "xpos.api.catalog_sync";
export const PAGE = 500;
const MAX_ATTEMPTS = 3;
const PAGE_TRIES = 4;
export const retryDelay = (n: number) => 400 * 2 ** (n - 1);

async function retried<T>(run: () => Promise<T>, wait: (ms: number) => Promise<void>): Promise<T> {
	for (let n = 1; ; n++) {
		try {
			return await run();
		} catch (e) {
			const name = e instanceof Error ? e.name : "";
			if (n >= PAGE_TRIES || (name !== "OfflineError" && name !== "ServerError")) throw e;
			await wait(retryDelay(n));
		}
	}
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class CatalogSyncError extends Error {
	constructor(
		readonly code: "resync" | "verify_failed",
		message: string,
	) {
		super(message);
		this.name = "CatalogSyncError";
	}
}

/** Small key/value store for the delta cursor (localStorage on device and in the browser; a Map in tests). */
export interface SyncMeta {
	get(key: string): string | null;
	set(key: string, value: string | null): void;
}

interface ServerBarcode {
	barcode: string;
	uom: string | null;
	conversion_factor: number | null;
}
export interface ServerItem {
	item_code: string;
	item_name?: string | null;
	item_group?: string | null;
	stock_uom?: string | null;
	brand?: string | null;
	variant_of?: string | null;
	rate?: number | null;
	price_missing?: number;
	barcodes?: ServerBarcode[];
	attributes?: Record<string, string>;
}
interface Begin {
	resync?: string;
	scope: { company: string; warehouse: string; price_list: string | null; currency: string };
	total: number;
	cursors: { items: string; delta: string };
}
interface Page {
	resync?: string;
	items: ServerItem[];
	next_cursor: string | null;
}
interface DeltaPage {
	resync?: string;
	upserts: ServerItem[];
	removed: string[];
	next_cursor: string;
	has_more: boolean;
}
interface Digest {
	count: number;
	checksum: number;
}

export interface SyncProgress {
	downloaded: number;
	total: number;
}

export interface SyncResult {
	mode: "full" | "delta";
	items: number;
	skippedBarcodes: number;
	unpriced: number | null;
	changed: number;
	removed: number;
}

/** Barcodes of the item's stock UOM are imported; a barcode for another UOM would be sold at the wrong price. */
export function toCatalogItem(row: ServerItem, minorDigits: number): { item: CatalogItem; skipped: number } {
	const stockUom = row.stock_uom || "Nos";
	const usable = (row.barcodes ?? []).filter(
		(b) => b.barcode && (!b.uom || b.uom === stockUom || b.conversion_factor === 1),
	);
	return {
		item: {
			itemCode: row.item_code,
			variantOf: row.variant_of || null,
			name: row.item_name || row.item_code,
			itemGroup: row.item_group || "",
			uom: stockUom,
			priceMinor: fromRate(Number(row.rate ?? 0), minorDigits),
			priced: row.price_missing === undefined ? Number(row.rate ?? 0) > 0 : !row.price_missing,
			brand: row.brand || null,
			attrs: row.attributes ?? {},
			barcodes: usable.map((b) => b.barcode),
		},
		skipped: (row.barcodes ?? []).length - usable.length,
	};
}

const cursorKey = (scopeId: string) => `delta:${scopeId}`;

interface SavedCursor {
	gen: number;
	cursor: string;
}

function readCursor(meta: SyncMeta, scopeId: string): SavedCursor | null {
	try {
		const v = JSON.parse(meta.get(cursorKey(scopeId)) ?? "null");
		return v && typeof v.gen === "number" && typeof v.cursor === "string" ? v : null;
	} catch {
		return null;
	}
}

function sameScope(a: CatalogScopeInfo, b: Begin["scope"]): boolean {
	return (
		a.company === b.company &&
		a.warehouse === b.warehouse &&
		a.priceList === b.price_list &&
		a.currency === b.currency
	);
}

export interface SyncOptions {
	api: ApiTransport;
	repo: CatalogRepository;
	meta?: SyncMeta;
	scopeId: string;
	site: string;
	profile: string;
	minorDigits: number;
	onProgress?: (p: SyncProgress) => void;
}

/** Delta when it is safe, otherwise a full staged download. */
export function memoryMeta(): SyncMeta {
	const m = new Map<string, string>();
	return { get: (k) => m.get(k) ?? null, set: (k, v) => void (v === null ? m.delete(k) : m.set(k, v)) };
}

export async function syncCatalog(input: SyncOptions): Promise<SyncResult> {
	const opts = { ...input, meta: input.meta ?? memoryMeta() };
	const scope = (await opts.repo.listScopes()).find((s) => s.scopeId === opts.scopeId);
	const saved = readCursor(opts.meta, opts.scopeId);
	if (scope && scope.activeGen !== null && saved && saved.gen === scope.activeGen) {
		try {
			const r = await deltaRefresh(opts, saved);
			if (r) return r;
		} catch (e) {
			if (!(e instanceof CatalogSyncError)) throw e; // network/session errors surface; protocol disagreements fall back
		}
	}
	return downloadCatalog(opts);
}

async function deltaRefresh(
	opts: SyncOptions & { meta: SyncMeta },
	saved: SavedCursor,
): Promise<SyncResult | null> {
	const { api, repo, scopeId, profile, minorDigits } = opts;
	const call = <T>(method: string, args: Record<string, unknown>) =>
		api.call<T>(`${API}.${method}`, { pos_profile: profile, ...args });
	let cursor = saved.cursor;
	let changed = 0;
	let removed = 0;
	let skipped = 0;
	for (;;) {
		const page = await retried(() => call<DeltaPage>("catalog_delta", { cursor, limit: PAGE }), sleep);
		if (page.resync) return null; // expired, scope changed or reset: a full download is required
		const mapped = page.upserts.map((r) => toCatalogItem(r, minorDigits));
		await repo.applyDelta(
			scopeId,
			mapped.map((m) => m.item),
			page.removed,
		);
		changed += page.upserts.length;
		removed += page.removed.length;
		skipped += mapped.reduce((n, m) => n + m.skipped, 0);
		cursor = page.next_cursor;
		opts.onProgress?.({ downloaded: changed + removed, total: changed + removed });
		if (!page.has_more) break;
	}
	// Check the whole set against the server before trusting the incremental result.
	const digest = await call<Digest>("catalog_digest", {});
	const stats = await repo.stats(scopeId);
	const sum = await checksumOf(repo, scopeId);
	if (digest.count !== stats.items || Number(digest.checksum) !== sum)
		throw new CatalogSyncError(
			"verify_failed",
			"The catalog does not match the server after the update.",
		);
	opts.meta.set(cursorKey(scopeId), JSON.stringify({ gen: saved.gen, cursor }));
	return { mode: "delta", items: stats.items, skippedBarcodes: skipped, unpriced: null, changed, removed };
}

/** CRC32 sum of the item codes on the device (codes only, 2000 per page), to compare with the server digest. */
async function checksumOf(repo: CatalogRepository, scopeId: string): Promise<number> {
	let sum = 0;
	let after: string | undefined;
	for (;;) {
		const codes = await repo.codePage(scopeId, after, 2000);
		for (const c of codes) sum += crc32(c);
		if (codes.length < 2000) return sum;
		after = codes[codes.length - 1];
	}
}

export async function downloadCatalog(input: SyncOptions): Promise<SyncResult> {
	const opts = { ...input, meta: input.meta ?? memoryMeta() };
	const { api, repo, scopeId, profile, minorDigits } = opts;
	const call = <T>(method: string, args: Record<string, unknown>) =>
		api.call<T>(`${API}.${method}`, { pos_profile: profile, ...args });
	let lastError: unknown;
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		const begin = await call<Begin>("catalog_begin", {});
		if (begin.resync)
			throw new CatalogSyncError("resync", `The server asked for a fresh start (${begin.resync}).`);
		const existing = (await repo.listScopes()).find((s) => s.scopeId === scopeId);
		if (existing && !sameScope(existing, begin.scope)) {
			await repo.dropScope(scopeId);
			opts.meta.set(cursorKey(scopeId), null);
		}
		if (!existing || !sameScope(existing, begin.scope))
			await repo.createScope({
				scopeId,
				site: opts.site,
				company: begin.scope.company,
				warehouse: begin.scope.warehouse,
				priceList: begin.scope.price_list,
				currency: begin.scope.currency,
				minorDigits,
			});
		const gen = await repo.beginGeneration(scopeId);
		try {
			let cursor: string | null = begin.cursors.items;
			let downloaded = 0;
			let skipped = 0;
			let unpriced = 0;
			let sum = 0;
			opts.onProgress?.({ downloaded, total: begin.total });
			while (cursor) {
				const page: Page = await retried(
					() => call<Page>("catalog_page", { cursor, limit: PAGE }),
					sleep,
				);
				if (page.resync)
					throw new CatalogSyncError(
						"resync",
						`The server asked for a fresh start (${page.resync}).`,
					);
				const mapped = page.items.map((r) => toCatalogItem(r, minorDigits));
				await repo.putBatch(
					scopeId,
					gen,
					mapped.map((m) => m.item),
				);
				for (const r of page.items) sum += crc32(r.item_code);
				skipped += mapped.reduce((n, m) => n + m.skipped, 0);
				unpriced += mapped.filter((m) => !m.item.priced).length;
				downloaded += page.items.length;
				cursor = page.next_cursor;
				opts.onProgress?.({ downloaded, total: Math.max(begin.total, downloaded) });
			}
			const digest = await call<Digest>("catalog_digest", {});
			if (digest.count !== downloaded || Number(digest.checksum) !== sum)
				throw new CatalogSyncError(
					"verify_failed",
					`The catalog changed while downloading (server ${digest.count} items, received ${downloaded}).`,
				);
			await repo.activate(scopeId, gen, downloaded);
			opts.meta.set(cursorKey(scopeId), JSON.stringify({ gen, cursor: begin.cursors.delta }));
			return {
				mode: "full",
				items: downloaded,
				skippedBarcodes: skipped,
				unpriced,
				changed: downloaded,
				removed: 0,
			};
		} catch (e) {
			await repo.discard(scopeId, gen).catch(() => undefined);
			lastError = e;
			if (!(e instanceof CatalogSyncError)) throw e;
		}
	}
	throw lastError;
}
