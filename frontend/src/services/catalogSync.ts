import { ref } from "vue";
import type { Table } from "dexie";
import { call } from "@/services/api";
import {
	db,
	clearCatalogCache,
	getMeta,
	invalidateCatalogIndex,
	setMeta,
	type PendingInvoice,
	type StockEntry,
} from "@/services/idbService";
import { sanitizeForIdb } from "@/services/idbSanitize";
import { getSessionScope, scopeKey } from "@/services/sessionScope";
import { broadcast, runExclusive } from "@/services/tabCoordinator";
import type { Customer, ItemGroup, POSItem } from "@/types/pos.types";

const STATE_KEY = "catalog_state";
const JOB_KEY = "catalog_sync_job";
const ITEM_PAGE = 200;
const STOCK_PAGE = 1000;
const CUSTOMER_PAGE = 500;
const COPY_CHUNK = 2000;
const MAX_VERIFY_ROUNDS = 3;

export const STOCK_REFRESH_MS = 2 * 60_000;
export const CUSTOMER_REFRESH_MS = 60 * 60_000;
export const PRICES_AGING_MS = 4 * 60 * 60_000;
export const PRICES_STALE_MS = 24 * 60 * 60_000;

export type CatalogStatusKind = "none" | "partial" | "complete";
export type Freshness = "fresh" | "aging" | "stale" | "none";

export interface CatalogState {
	status: CatalogStatusKind;
	scope_key: string;
	scope_hash: string;
	snapshot_id: string;
	price_list: string;
	activated_at: string;
	confirmed_at: string;
	item_count: number;
	delta_cursor: string;
	stock_as_of: string | null;
	customers_at: string | null;
	retention_days: number;
}

export interface CatalogStatus {
	status: CatalogStatusKind;
	scopeMatches: boolean;
	snapshotId: string;
	priceList: string;
	activatedAt: string | null;
	pricesAsOf: string | null;
	ageMs: number | null;
	freshness: Freshness;
	itemCount: number;
	stockAsOf: string | null;
	downloading: boolean;
}

type Phase = "items" | "stock" | "customers" | "delta" | "verify";

interface SyncJob {
	scope_key: string;
	scope_hash: string;
	profile: string;
	snapshot_id: string;
	price_list: string;
	started_at: string;
	retention_days: number;
	phase: Phase;
	cursor: string | null;
	cursors: { items: string; stock: string; customers: string; delta: string };
	staged: { items: number; stock: number; customers: number };
	total: number;
	restarts: number;
	stock_as_of: string | null;
}

interface Resync {
	resync: string;
}

interface BeginResponse {
	snapshot_id: string;
	scope_hash: string;
	scope: { price_list: string };
	total: number;
	retention_days: number;
	cursors: SyncJob["cursors"];
}

interface PageResponse<T> {
	next_cursor: string | null;
	resync?: string;
	items?: T[];
	rows?: T[];
	customers?: T[];
	as_of?: string;
}

interface DeltaResponse {
	upserts: POSItem[];
	removed: string[];
	next_cursor: string;
	has_more: boolean;
	resync?: string;
}

interface DigestResponse {
	count: number;
	checksum: number;
	scope_hash: string;
}

export class ResyncRequired extends Error {
	reason: string;
	constructor(reason: string) {
		super(`Catalogue must be downloaded again (${reason})`);
		this.name = "ResyncRequired";
		this.reason = reason;
	}
}

export const syncProgress = ref<{ phase: Phase; done: number; total: number } | null>(null);
export const lastSyncError = ref<string | null>(null);

function unwrap<T extends { resync?: string }>(response: T | Resync): T {
	if (response && "resync" in response && response.resync) throw new ResyncRequired(response.resync);
	return response as T;
}

let crcTable: Uint32Array | null = null;

export function crc32(text: string): number {
	if (!crcTable) {
		crcTable = new Uint32Array(256);
		for (let n = 0; n < 256; n++) {
			let c = n;
			for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
			crcTable[n] = c >>> 0;
		}
	}
	let crc = 0xffffffff;
	for (const byte of new TextEncoder().encode(text)) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

export async function getCatalogState(): Promise<CatalogState | null> {
	return ((await getMeta(STATE_KEY)) as CatalogState | undefined) ?? null;
}

async function getJob(): Promise<SyncJob | null> {
	return ((await getMeta(JOB_KEY)) as SyncJob | undefined) ?? null;
}

async function saveJob(job: SyncJob): Promise<void> {
	await setMeta(JOB_KEY, job);
}

export function freshnessOf(ageMs: number | null): Freshness {
	if (ageMs === null) return "none";
	if (ageMs >= PRICES_STALE_MS) return "stale";
	if (ageMs >= PRICES_AGING_MS) return "aging";
	return "fresh";
}

export async function getCatalogStatus(now: number = Date.now()): Promise<CatalogStatus> {
	const [state, job] = await Promise.all([getCatalogState(), getJob()]);
	const asOf = state ? state.confirmed_at || state.activated_at : null;
	const ageMs = asOf ? Math.max(now - Date.parse(asOf), 0) : null;
	return {
		status: state?.status ?? (job ? "partial" : "none"),
		scopeMatches: !!state && state.scope_key === scopeKey(),
		snapshotId: state?.snapshot_id ?? "",
		priceList: state?.price_list ?? "",
		activatedAt: state?.activated_at ?? null,
		pricesAsOf: asOf,
		ageMs,
		freshness: freshnessOf(ageMs),
		itemCount: state?.item_count ?? 0,
		stockAsOf: state?.stock_as_of ?? null,
		downloading: !!job,
	};
}

export async function currentCatalogEvidence(): Promise<PendingInvoice["catalog_evidence"]> {
	const state = await getCatalogState();
	if (!state) return null;
	return {
		snapshot_id: state.snapshot_id,
		activated_at: state.confirmed_at || state.activated_at,
		price_list: state.price_list,
	};
}

export async function ensureScope(): Promise<void> {
	const key = scopeKey();
	if (!key) throw new Error("No active session scope");
	const [state, job] = await Promise.all([getCatalogState(), getJob()]);
	if ((state && state.scope_key !== key) || (job && job.scope_key !== key)) await clearCatalogCache();
}

async function reservedByPendingSales(): Promise<Map<string, number>> {
	const reserved = new Map<string, number>();
	const rows = await db.pendingInvoices.toArray();
	for (const row of rows) {
		const lines =
			row.reservations ??
			((row.data as { items?: { item_code: string; qty: number }[] })?.items || []).map((item) => ({
				item_code: item.item_code,
				stock_qty: item.qty,
			}));
		for (const line of lines)
			reserved.set(line.item_code, (reserved.get(line.item_code) || 0) + line.stock_qty);
	}
	return reserved;
}

async function copyTable<T>(
	from: Table<T, string>,
	to: Table<T, string>,
	transform?: (row: T) => T,
): Promise<number> {
	let copied = 0;
	let last: string | undefined;
	for (;;) {
		const rows: T[] = await (last === undefined
			? from.limit(COPY_CHUNK).toArray()
			: from.where(":id").above(last).limit(COPY_CHUNK).toArray());
		if (!rows.length) return copied;
		last = from.schema.primKey.keyPath
			? String(
					(rows[rows.length - 1] as Record<string, unknown>)[from.schema.primKey.keyPath as string],
				)
			: undefined;
		await to.bulkPut(transform ? rows.map(transform) : rows);
		copied += rows.length;
	}
}

function startJob(profile: string, begun: BeginResponse, restarts: number): SyncJob {
	return {
		scope_key: scopeKey(),
		scope_hash: begun.scope_hash,
		profile,
		snapshot_id: begun.snapshot_id,
		price_list: begun.scope?.price_list || "",
		started_at: new Date().toISOString(),
		retention_days: begun.retention_days,
		phase: "items",
		cursor: begun.cursors.items,
		cursors: begun.cursors,
		staged: { items: 0, stock: 0, customers: 0 },
		total: begun.total,
		restarts,
		stock_as_of: null,
	};
}

async function clearStages(): Promise<void> {
	await db.transaction("rw", db.itemsStage, db.stockStage, db.customersStage, async () => {
		await db.itemsStage.clear();
		await db.stockStage.clear();
		await db.customersStage.clear();
	});
}

function progress(job: SyncJob): void {
	const done =
		job.staged[job.phase === "stock" ? "stock" : job.phase === "customers" ? "customers" : "items"];
	syncProgress.value = { phase: job.phase, done, total: job.total };
}

async function stageItems(job: SyncJob): Promise<void> {
	while (job.cursor) {
		const page = unwrap(
			await call<PageResponse<POSItem>>("xpos.api.catalog_sync.catalog_page", {
				pos_profile: job.profile,
				cursor: job.cursor,
				limit: ITEM_PAGE,
			}),
		);
		const rows = (page.items || []) as POSItem[];
		await db.itemsStage.bulkPut(sanitizeForIdb(rows));
		job.staged.items += rows.length;
		job.cursor = page.next_cursor;
		await saveJob(job);
		progress(job);
	}
}

async function stageStock(job: SyncJob, warehouse: string, persist = true): Promise<void> {
	while (job.cursor) {
		const page = unwrap(
			await call<PageResponse<{ item_code: string; actual_qty: number }>>(
				"xpos.api.catalog_sync.catalog_stock_page",
				{ pos_profile: job.profile, cursor: job.cursor, limit: STOCK_PAGE },
			),
		);
		const rows = page.rows || [];
		job.stock_as_of = job.stock_as_of || page.as_of || new Date().toISOString();
		await db.stockStage.bulkPut(
			rows.map((row) => ({
				cache_key: `${warehouse}::${row.item_code}`,
				warehouse,
				item_code: row.item_code,
				actual_qty: row.actual_qty,
				updated_at: job.stock_as_of as string,
			})),
		);
		job.staged.stock += rows.length;
		job.cursor = page.next_cursor;
		if (persist) await saveJob(job);
		progress(job);
	}
}

async function stageCustomers(job: SyncJob, persist = true): Promise<void> {
	while (job.cursor) {
		const page = unwrap(
			await call<PageResponse<Customer>>("xpos.api.catalog_sync.catalog_customers_page", {
				pos_profile: job.profile,
				cursor: job.cursor,
				limit: CUSTOMER_PAGE,
			}),
		);
		const rows = (page.customers || []) as Customer[];
		await db.customersStage.bulkPut(sanitizeForIdb(rows));
		job.staged.customers += rows.length;
		job.cursor = page.next_cursor;
		if (persist) await saveJob(job);
		progress(job);
	}
}

async function applyDeltaTo(
	items: Table<POSItem, string>,
	stock: Table<StockEntry, string> | null,
	warehouse: string,
	response: DeltaResponse,
): Promise<void> {
	if (response.upserts.length) await items.bulkPut(sanitizeForIdb(response.upserts));
	if (response.removed.length) {
		await items.bulkDelete(response.removed);
		if (stock) await stock.bulkDelete(response.removed.map((code) => `${warehouse}::${code}`));
	}
}

async function catchUpStage(job: SyncJob, warehouse: string): Promise<string> {
	let cursor = job.cursors.delta;
	for (;;) {
		const response = unwrap(
			await call<DeltaResponse>("xpos.api.catalog_sync.catalog_delta", {
				pos_profile: job.profile,
				cursor,
				limit: ITEM_PAGE,
			}),
		);
		await db.transaction("rw", db.itemsStage, db.stockStage, async () => {
			await applyDeltaTo(db.itemsStage, db.stockStage, warehouse, response);
		});
		cursor = response.next_cursor;
		job.cursors.delta = cursor;
		await saveJob(job);
		if (!response.has_more) return cursor;
	}
}

async function verifyStage(job: SyncJob, warehouse: string): Promise<void> {
	for (let round = 0; round < MAX_VERIFY_ROUNDS; round++) {
		await catchUpStage(job, warehouse);
		const digest = await call<DigestResponse>("xpos.api.catalog_sync.catalog_digest", {
			pos_profile: job.profile,
		});
		if (digest.scope_hash !== job.scope_hash) throw new ResyncRequired("scope_changed");
		let count = 0;
		let checksum = 0;
		await db.itemsStage.orderBy(":id").eachPrimaryKey((code) => {
			count++;
			checksum += crc32(String(code));
		});
		if (count === digest.count && checksum === digest.checksum) return;
	}
	throw new ResyncRequired("digest_mismatch");
}

async function activate(
	job: SyncJob,
	warehouse: string,
	itemGroups: { groups: ItemGroup[]; parent_groups: ItemGroup[] },
) {
	const reserved = await reservedByPendingSales();
	const now = new Date().toISOString();
	const state: CatalogState = {
		status: "complete",
		scope_key: job.scope_key,
		scope_hash: job.scope_hash,
		snapshot_id: job.snapshot_id,
		price_list: job.price_list,
		activated_at: now,
		confirmed_at: now,
		item_count: 0,
		delta_cursor: job.cursors.delta,
		stock_as_of: job.stock_as_of,
		customers_at: job.staged.customers || job.phase === "customers" ? now : null,
		retention_days: job.retention_days,
	};
	await db.transaction(
		"rw",
		[
			db.items,
			db.itemGroups,
			db.stockCache,
			db.customers,
			db.itemsStage,
			db.stockStage,
			db.customersStage,
			db.meta,
			db.pendingInvoices,
		],
		async () => {
			await db.items.clear();
			state.item_count = await copyTable(db.itemsStage, db.items);
			await db.stockCache.where("warehouse").equals(warehouse).delete();
			await copyTable(db.stockStage, db.stockCache, (row) =>
				reserved.has(row.item_code)
					? { ...row, actual_qty: row.actual_qty - (reserved.get(row.item_code) as number) }
					: row,
			);
			if (job.staged.customers) {
				await db.customers.clear();
				await copyTable(db.customersStage, db.customers);
			}
			await db.itemGroups.clear();
			await db.itemGroups.bulkAdd([
				{ name: "__groups__", data: sanitizeForIdb(itemGroups.groups || []) },
				{ name: "__parent_groups__", data: sanitizeForIdb(itemGroups.parent_groups || []) },
			]);
			await db.itemsStage.clear();
			await db.stockStage.clear();
			await db.customersStage.clear();
			await setMeta(STATE_KEY, state);
			await db.meta.delete(JOB_KEY);
		},
	);
	invalidateCatalogIndex();
	broadcast("catalog-activated");
}

async function runPhases(job: SyncJob, warehouse: string): Promise<void> {
	if (job.phase === "items") {
		await stageItems(job);
		job.phase = "stock";
		job.cursor = job.cursors.stock;
		await saveJob(job);
	}
	if (job.phase === "stock") {
		await stageStock(job, warehouse);
		job.phase = "customers";
		job.cursor = job.cursors.customers;
		await saveJob(job);
	}
	if (job.phase === "customers") {
		await stageCustomers(job);
		job.phase = "verify";
		job.cursor = null;
		await saveJob(job);
	}
	if (job.phase === "verify") {
		syncProgress.value = { phase: "verify", done: job.staged.items, total: job.total };
		await verifyStage(job, warehouse);
		const groups = await call<{ groups: ItemGroup[]; parent_groups: ItemGroup[] }>(
			"xpos.api.items.get_item_groups",
			{ pos_profile: job.profile },
		);
		await activate(job, warehouse, groups);
	}
}

function jobStillUsable(job: SyncJob, profile: string): boolean {
	const ageDays = (Date.now() - Date.parse(job.started_at)) / 86_400_000;
	return job.scope_key === scopeKey() && job.profile === profile && ageDays < job.retention_days;
}

export async function downloadCatalog(profile: string, restarts = 0): Promise<void> {
	const scope = getSessionScope();
	if (!scope) throw new Error("No active session scope");
	let job = await getJob();
	if (job && !jobStillUsable(job, profile)) {
		await clearStages();
		job = null;
	}
	if (!job) {
		await clearStages();
		const begun = await call<BeginResponse>("xpos.api.catalog_sync.catalog_begin", {
			pos_profile: profile,
		});
		job = startJob(profile, begun, restarts);
		await saveJob(job);
	}
	try {
		await runPhases(job, scope.warehouse);
	} catch (error) {
		if (error instanceof ResyncRequired && job.restarts < 2) {
			await db.meta.delete(JOB_KEY);
			await clearStages();
			return downloadCatalog(profile, job.restarts + 1);
		}
		throw error;
	} finally {
		syncProgress.value = null;
	}
}

async function runDelta(profile: string, state: CatalogState): Promise<void> {
	const scope = getSessionScope();
	if (!scope) throw new Error("No active session scope");
	let cursor = state.delta_cursor;
	for (;;) {
		const response = unwrap(
			await call<DeltaResponse>("xpos.api.catalog_sync.catalog_delta", {
				pos_profile: profile,
				cursor,
				limit: ITEM_PAGE,
			}),
		);
		await db.transaction("rw", db.items, db.stockCache, db.meta, async () => {
			await applyDeltaTo(db.items, db.stockCache, scope.warehouse, response);
			const next = (await getCatalogState()) as CatalogState;
			await setMeta(STATE_KEY, {
				...next,
				delta_cursor: response.next_cursor,
				confirmed_at: response.has_more ? next.confirmed_at : new Date().toISOString(),
			});
		});
		if (response.upserts.length || response.removed.length) invalidateCatalogIndex();
		cursor = response.next_cursor;
		if (!response.has_more) return;
	}
}

export async function refreshCatalogStock(profile: string): Promise<void> {
	const scope = getSessionScope();
	const state = await getCatalogState();
	if (!scope || !state || state.scope_key !== scopeKey()) return;
	const begun = await call<BeginResponse>("xpos.api.catalog_sync.catalog_begin", { pos_profile: profile });
	if (begun.scope_hash !== state.scope_hash) throw new ResyncRequired("scope_changed");
	const job = startJob(profile, begun, 0);
	job.phase = "stock";
	job.cursor = begun.cursors.stock;
	await db.stockStage.clear();
	await stageStock(job, scope.warehouse, false);
	syncProgress.value = null;
	const reserved = await reservedByPendingSales();
	await db.transaction("rw", [db.stockCache, db.stockStage, db.meta, db.pendingInvoices], async () => {
		await db.stockCache.where("warehouse").equals(scope.warehouse).delete();
		await copyTable(db.stockStage, db.stockCache, (row) =>
			reserved.has(row.item_code)
				? { ...row, actual_qty: row.actual_qty - (reserved.get(row.item_code) as number) }
				: row,
		);
		await db.stockStage.clear();
		await setMeta(STATE_KEY, {
			...((await getCatalogState()) as CatalogState),
			stock_as_of: job.stock_as_of,
		});
	});
}

export async function refreshCatalogCustomers(profile: string): Promise<void> {
	const state = await getCatalogState();
	if (!state || state.scope_key !== scopeKey()) return;
	const begun = await call<BeginResponse>("xpos.api.catalog_sync.catalog_begin", { pos_profile: profile });
	if (begun.scope_hash !== state.scope_hash) throw new ResyncRequired("scope_changed");
	const job = startJob(profile, begun, 0);
	job.phase = "customers";
	job.cursor = begun.cursors.customers;
	await db.customersStage.clear();
	await stageCustomers(job, false);
	syncProgress.value = null;
	await db.transaction("rw", [db.customers, db.customersStage, db.meta], async () => {
		await db.customers.clear();
		await copyTable(db.customersStage, db.customers);
		await db.customersStage.clear();
		await setMeta(STATE_KEY, {
			...((await getCatalogState()) as CatalogState),
			customers_at: new Date().toISOString(),
		});
	});
}

export type CatalogSyncOutcome = "full" | "delta" | "busy";

let inflight: Promise<CatalogSyncOutcome> | null = null;

export function syncCatalog(profile: string, options: { force?: boolean } = {}): Promise<CatalogSyncOutcome> {
	if (inflight) return inflight;
	const run = (async (): Promise<CatalogSyncOutcome> => {
		await ensureScope();
		const locked = await runExclusive(`xpos-catalog-sync:${scopeKey()}`, async () => {
			const state = await getCatalogState();
			let outcome: CatalogSyncOutcome = "delta";
			if (state && state.status === "complete" && !options.force) {
				try {
					await runDelta(profile, state);
				} catch (error) {
					if (!(error instanceof ResyncRequired)) throw error;
					outcome = "full";
					await downloadCatalog(profile);
				}
			} else {
				outcome = "full";
				await downloadCatalog(profile);
			}
			const current = await getCatalogState();
			const stockAge = current?.stock_as_of ? Date.now() - Date.parse(current.stock_as_of) : Infinity;
			if (stockAge >= STOCK_REFRESH_MS) await refreshCatalogStock(profile).catch((e) => recordError(e));
			const customerAge = current?.customers_at
				? Date.now() - Date.parse(current.customers_at)
				: Infinity;
			if (customerAge >= CUSTOMER_REFRESH_MS)
				await refreshCatalogCustomers(profile).catch((e) => recordError(e));
			return outcome;
		});
		lastSyncError.value = null;
		return locked.ran ? locked.value : "busy";
	})()
		.catch((error) => {
			recordError(error);
			throw error;
		})
		.finally(() => {
			inflight = null;
		});
	inflight = run;
	return run;
}

function recordError(error: unknown): void {
	lastSyncError.value = error instanceof Error ? error.message : String(error);
}
