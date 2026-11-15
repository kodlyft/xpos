import Dexie, { type Table } from "dexie";
import type { POSItem, ItemGroup, Customer } from "@/types/pos.types";
import { sanitizeForIdb } from "./idbSanitize";
import { buildCatalogIndex, type CatalogIndex } from "./catalogIndex";
import { StorageWriteError } from "./storageHealth";

export { sanitizeForIdb };

const DB_NAME = "xpos_offline_v3";

function isRecoverableDbError(error: unknown): boolean {
	const name = error instanceof Error ? error.name : "";
	const message = error instanceof Error ? error.message : String(error || "");

	return (
		name === "DatabaseClosedError" ||
		name === "OpenFailedError" ||
		name === "UnknownError" ||
		message.includes("UnknownError") ||
		message.includes("Internal error")
	);
}

export interface PendingInvoice {
	id?: number;
	local_id?: string;
	data: unknown;
	status: "pending" | "syncing" | "failed" | "dead_letter" | "needs_review" | "fiscal_uncertain";
	created_at: string;
	error?: string;
	retry_count: number;
	customer_name?: string;
	grand_total?: number;
	/** What the till printed. Kept beside `data`, so it is never sent to the server. */
	receipt?: import("@/types/pos.types").ReceiptSnapshot;
	/** The server's new prices when it refused to post this sale at the captured ones. */
	review?: import("@/types/pos.types").RepriceResponse;
	/** The server draft whose FBR outcome is unknown and must be checked before it is finished. */
	fiscal?: { name?: string | null; doctype?: string; usin?: string; pos_profile?: string };
	owner?: { user: string; profile: string; company: string } | null;
	/** Which catalogue the prices came from. Kept beside `data`, never sent. */
	catalog_evidence?: { snapshot_id: string; activated_at: string; price_list: string } | null;
	attempts?: number;
	next_attempt_at?: string | null;
	rejection?: { code: string; message: string; at: string } | null;
	reservations?: { item_code: string; stock_qty: number }[];
	hold?: "offline_blocked" | null;
	/** A tab that is sending this sale right now, and when its claim lapses (ISO). */
	claimed_by?: string | null;
	claim_expires?: string | null;
}

export interface StockEntry {
	cache_key: string;
	warehouse: string;
	item_code: string;
	actual_qty: number;
	updated_at: string;
}

export interface MetaEntry {
	key: string;
	value: unknown;
	updated_at: string;
}

export interface ItemGroupEntry {
	name: string;
	data: ItemGroup[];
}

export interface CachedItemTax {
	item_tax_template: string | null;
	item_tax_map: Record<string, number>;
}

export interface PendingPurchase {
	id?: number;
	type: "purchase_order" | "purchase_receipt" | "purchase_invoice";
	data: unknown;
	status: "pending" | "syncing" | "failed";
	created_at: string;
	error?: string;
	retry_count: number;
	supplier_name?: string;
	grand_total?: number;
}

export interface CachedSupplier {
	name: string;
	supplier_name: string;
	supplier_group?: string;
	supplier_type?: string;
	default_currency?: string;
	mobile_no?: string;
	email_id?: string;
	[key: string]: unknown;
}

export interface SyncIdMap {
	local_id: string;
	server_name: string;
	doctype: string;
	synced_at: string;
}

class XPosDB extends Dexie {
	items!: Table<POSItem, string>;
	itemGroups!: Table<ItemGroupEntry, string>;
	customers!: Table<Customer, string>;
	suppliers!: Table<CachedSupplier, string>;
	pendingInvoices!: Table<PendingInvoice, number>;
	pendingPurchases!: Table<PendingPurchase, number>;
	stockCache!: Table<StockEntry, string>;
	meta!: Table<MetaEntry, string>;
	syncIdMap!: Table<SyncIdMap, string>;
	itemsStage!: Table<POSItem, string>;
	stockStage!: Table<StockEntry, string>;
	customersStage!: Table<Customer, string>;

	constructor() {
		super(DB_NAME, { chromeTransactionDurability: "strict" });

		this.version(1).stores({
			items: "item_code, item_name, item_group, barcode",
			itemGroups: "name",
			customers: "name, customer_name, mobile_no, email_id",
			suppliers: "name, supplier_name, mobile_no, email_id",
			pendingInvoices: "++id, status, created_at",
			pendingPurchases: "++id, type, status, created_at",
			stockCache: "cache_key, warehouse, item_code",
			meta: "key",
		});

		this.version(2).stores({
			items: "item_code, item_name, item_group, barcode",
			itemGroups: "name",
			customers: "name, customer_name, mobile_no, email_id",
			suppliers: "name, supplier_name, mobile_no, email_id",
			pendingInvoices: "++id, status, created_at",
			pendingPurchases: "++id, type, status, created_at",
			stockCache: "cache_key, warehouse, item_code",
			meta: "key",
			syncIdMap: "local_id, server_name, doctype",
		});

		this.version(3)
			.stores({
				items: "item_code, item_name, item_group, barcode",
				itemGroups: "name",
				customers: "name, customer_name, mobile_no, email_id",
				suppliers: "name, supplier_name, mobile_no, email_id",
				pendingInvoices: "++id, status, created_at",
				pendingPurchases: "++id, type, status, created_at",
				stockCache: "cache_key, warehouse, item_code",
				meta: "key",
				syncIdMap: "local_id, server_name, doctype",
				itemsStage: "item_code",
				stockStage: "cache_key",
				customersStage: "name",
			})
			.upgrade((tx) =>
				tx
					.table("pendingInvoices")
					.toCollection()
					.modify((row) => {
						if (row.owner === undefined) row.owner = null;
						if (row.attempts === undefined) row.attempts = row.retry_count || 0;
					}),
			);
	}
}

const db = new XPosDB();
let dbReadyPromise: Promise<void> | null = null;

export type DbState = "ready" | "upgrading" | "needs_reload" | "storage_unavailable";

let dbState: DbState = "ready";
const dbStateListeners = new Set<(state: DbState) => void>();

export function getDbState(): DbState {
	return dbState;
}

export function setDbState(state: DbState): void {
	if (state === dbState) return;
	dbState = state;
	dbStateListeners.forEach((listener) => listener(state));
}

export function onDbStateChange(listener: (state: DbState) => void): () => void {
	dbStateListeners.add(listener);
	return () => dbStateListeners.delete(listener);
}

// Another tab is upgrading the schema (or a newer build already did): let go of the connection
db.on("versionchange", () => {
	setDbState("needs_reload");
	db.close();
	return false;
});

const BACKUP_DB = "xpos_pending_backup";

interface PendingBackup {
	invoices: PendingInvoice[];
	purchases: PendingPurchase[];
}

function readRawStore(database: IDBDatabase, store: string): Promise<unknown[]> {
	if (!database.objectStoreNames.contains(store)) return Promise.resolve([]);
	return new Promise((resolve, reject) => {
		const request = database.transaction(store, "readonly").objectStore(store).getAll();
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

async function readPendingRaw(): Promise<PendingBackup | null> {
	if (typeof indexedDB === "undefined") return null;
	try {
		const database = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open(DB_NAME);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
			request.onblocked = () => reject(new Error("blocked"));
		});
		try {
			return {
				invoices: (await readRawStore(database, "pendingInvoices")) as PendingInvoice[],
				purchases: (await readRawStore(database, "pendingPurchases")) as PendingPurchase[],
			};
		} finally {
			database.close();
		}
	} catch {
		return null;
	}
}

class BackupDB extends Dexie {
	invoices!: Table<PendingInvoice, number>;
	purchases!: Table<PendingPurchase, number>;
	constructor() {
		super(BACKUP_DB);
		this.version(1).stores({ invoices: "id", purchases: "id" });
	}
}

async function writeBackup(rows: PendingBackup): Promise<boolean> {
	const backup = new BackupDB();
	try {
		await backup.transaction("rw", backup.invoices, backup.purchases, async () => {
			await backup.invoices.clear();
			await backup.purchases.clear();
			await backup.invoices.bulkPut(rows.invoices);
			await backup.purchases.bulkPut(rows.purchases);
		});
		const [invoices, purchases] = await Promise.all([backup.invoices.count(), backup.purchases.count()]);
		return invoices === rows.invoices.length && purchases === rows.purchases.length;
	} catch {
		return false;
	} finally {
		backup.close();
	}
}

async function readBackup(): Promise<PendingBackup | null> {
	const backup = new BackupDB();
	try {
		return { invoices: await backup.invoices.toArray(), purchases: await backup.purchases.toArray() };
	} catch {
		return null;
	} finally {
		backup.close();
	}
}

async function resetDatabaseConnection(): Promise<void> {
	db.close();
	const rows = await readPendingRaw();
	if (!rows || !(await writeBackup(rows))) {
		setDbState("storage_unavailable");
		throw new StorageWriteError("unavailable");
	}

	await Dexie.delete(DB_NAME);
	await db.open();

	if (rows.invoices.length || rows.purchases.length) {
		await db.transaction("rw", db.pendingInvoices, db.pendingPurchases, async () => {
			await db.pendingInvoices.bulkPut(rows.invoices);
			await db.pendingPurchases.bulkPut(rows.purchases);
		});
		const [invoices, purchases] = await Promise.all([
			db.pendingInvoices.count(),
			db.pendingPurchases.count(),
		]);
		if (invoices !== rows.invoices.length || purchases !== rows.purchases.length) {
			setDbState("storage_unavailable");
			throw new StorageWriteError("unavailable");
		}
		console.warn(
			`[XPOS] Restored ${rows.invoices.length} pending invoice(s) and ${rows.purchases.length} pending purchase(s) after DB reset`,
		);
	}
}

/** Queued sales kept in the backup database; non-empty only after a recovery that has not been restored. */
export async function getBackedUpPending(): Promise<PendingBackup | null> {
	const rows = await readBackup();
	return rows && (rows.invoices.length || rows.purchases.length) ? rows : null;
}

/** Put backed-up sales back into the live queue (skipping any already there), then drop the backup. */
export async function restoreBackedUpPending(): Promise<number> {
	const rows = await readBackup();
	if (!rows) return 0;
	await ensureDatabaseReady();
	const existing = new Set((await db.pendingInvoices.toArray()).map((row) => row.local_id).filter(Boolean));
	const missing = rows.invoices
		.filter((row) => !row.local_id || !existing.has(row.local_id))
		.map(({ id, ...rest }) => rest);
	await db.pendingInvoices.bulkAdd(missing as PendingInvoice[]);
	const backup = new BackupDB();
	try {
		await backup.invoices.clear();
		await backup.purchases.clear();
	} finally {
		backup.close();
	}
	return missing.length;
}

export async function ensureDatabaseReady(forceReset = false): Promise<void> {
	if (forceReset) {
		dbReadyPromise = null;
	}

	if (!dbReadyPromise) {
		dbReadyPromise = (async () => {
			try {
				if (!db.isOpen()) {
					if (dbState === "needs_reload") throw new StorageWriteError("unavailable");
					await db.open();
				}
				if (dbState === "upgrading") setDbState("ready");
			} catch (error) {
				if (error instanceof StorageWriteError) throw error;
				const name = (error as { name?: string })?.name;
				// A newer build already upgraded the schema: never reset, ask for a reload.
				if (name === "VersionError") {
					setDbState("needs_reload");
					throw error;
				}
				if (!isRecoverableDbError(error)) {
					setDbState("storage_unavailable");
					throw error;
				}

				console.warn("[XPOS] IndexedDB open failed, resetting local browser cache", error);
				await resetDatabaseConnection();
			}
		})().catch((error) => {
			dbReadyPromise = null;
			throw error;
		});
	}

	await dbReadyPromise;
}

export async function cacheItems(allItems: POSItem[]): Promise<void> {
	const safeItems = sanitizeForIdb(allItems);
	await db.transaction("rw", db.items, async () => {
		await db.items.clear();
		await db.items.bulkAdd(safeItems);
	});
	invalidateCatalogIndex();
	await setMeta("items_cached_at", new Date().toISOString());
}

export async function getCachedItems(): Promise<POSItem[]> {
	return db.items.toArray();
}

export async function getCachedItemByCode(itemCode: string): Promise<POSItem | undefined> {
	return db.items.get(itemCode);
}

const DEFAULT_CACHED_SEARCH_FIELDS = ["item_code", "item_name", "local_item_name", "description"];

export async function searchCachedItems(
	term: string,
	group: string,
	searchFields?: string[],
): Promise<POSItem[]> {
	let results: POSItem[];

	if (group && group !== "All Item Groups") {
		results = await db.items.where("item_group").equals(group).toArray();
	} else {
		results = await db.items.toArray();
	}

	if (term) {
		const lower = term.toLowerCase();
		const fields = (searchFields?.length ? searchFields : DEFAULT_CACHED_SEARCH_FIELDS).map((f) =>
			f === "name" ? "item_code" : f,
		);
		results = results.filter((item) => {
			const record = item as unknown as Record<string, unknown>;
			const matchesField = fields.some((field) => {
				const value = record[field];
				return typeof value === "string" && value.toLowerCase().includes(lower);
			});
			return matchesField || (!!item.barcode && item.barcode.toLowerCase().includes(lower));
		});
	}

	return results;
}

interface CatalogIndexSlot {
	fields: string;
	ready: Promise<CatalogIndex>;
}

let catalogIndex: CatalogIndexSlot | null = null;

/** Forget the index; the next search rebuilds it from what is stored. Call after writing `items`. */
export function invalidateCatalogIndex(): void {
	catalogIndex = null;
}

/** The index for these search fields; without fields, whichever index exists (lookups ignore fields). */
function ensureCatalogIndex(searchFields?: string[]): Promise<CatalogIndex> {
	const fields = searchFields?.length ? searchFields : DEFAULT_CACHED_SEARCH_FIELDS;
	const key = fields.join("\u0000");
	if (catalogIndex && (!searchFields || catalogIndex.fields === key)) return catalogIndex.ready;

	const slot: CatalogIndexSlot = {
		fields: key,
		ready: db.items.toArray().then((rows) => buildCatalogIndex(rows, fields)),
	};
	catalogIndex = slot;
	slot.ready.catch(() => {
		if (catalogIndex === slot) catalogIndex = null;
	});
	return slot.ready;
}

/** Build the index ahead of the first search so that search does not pay for it. */
export async function warmCatalogIndex(searchFields?: string[]): Promise<void> {
	await ensureCatalogIndex(searchFields);
}

/** One page of cached items, found through the index and read by key instead of scanning the table. */
export async function searchCachedItemsPage(
	term: string,
	group: string,
	searchFields: string[] | undefined,
	offset: number,
	limit: number,
): Promise<{ items: POSItem[]; hasMore: boolean; total: number }> {
	const index = await ensureCatalogIndex(searchFields);
	const { codes, hasMore } = index.search({ term, group, offset, limit });
	const rows = await db.items.bulkGet(codes);
	return { items: rows.filter((row): row is POSItem => !!row), hasMore, total: index.size };
}

/** The item whose code or barcode is exactly `value`, ignoring case. */
export async function findCachedItem(value: string): Promise<POSItem | undefined> {
	const index = await ensureCatalogIndex();
	const code = index.lookup(value);
	return code === undefined ? undefined : db.items.get(code);
}

export type CachedScan =
	| {
			kind: "item";
			item: POSItem;
			barcode: string;
			uom: string;
			conversion_factor: number | null;
			rate: number;
	  }
	| { kind: "ambiguous"; codes: string[] };

/**
 * What an offline scan of ``value`` sells: the item with the UOM, factor and rate its barcode carries.
 * A plain item-code scan sells one stock unit at the item's rate. ``conversion_factor`` is null when
 * the barcode's UOM cannot be converted, and the caller must refuse the scan.
 */
export async function findCachedScan(value: string): Promise<CachedScan | undefined> {
	const index = await ensureCatalogIndex();
	const hit = index.resolve(value);
	if (hit.kind === "none") return undefined;
	if (hit.kind === "ambiguous") return { kind: "ambiguous", codes: hit.codes };
	const item = await db.items.get(hit.code);
	if (!item) return undefined;
	const entry = hit.entry;
	const stockRate = Number((item as { rate?: number }).rate) || 0;
	return {
		kind: "item",
		item,
		barcode: entry?.barcode ?? value,
		uom: entry?.uom || (item as { stock_uom?: string }).stock_uom || "",
		conversion_factor: entry ? (entry.conversion_factor ?? null) : 1,
		rate: entry?.rate ?? stockRate,
	};
}

export async function updateCachedItem(item: POSItem): Promise<void> {
	await db.items.put(sanitizeForIdb(item));
	invalidateCatalogIndex();
}

export async function cacheItemGroups(groups: ItemGroup[], parentGroups: ItemGroup[]): Promise<void> {
	const safeGroups = sanitizeForIdb(groups);
	const safeParentGroups = sanitizeForIdb(parentGroups);
	await db.transaction("rw", db.itemGroups, async () => {
		await db.itemGroups.clear();
		await db.itemGroups.bulkAdd([
			{ name: "__groups__", data: safeGroups },
			{ name: "__parent_groups__", data: safeParentGroups },
		]);
	});
}

export async function getCachedItemGroups(): Promise<{
	groups: ItemGroup[];
	parentGroups: ItemGroup[];
}> {
	const [g, pg] = await Promise.all([
		db.itemGroups.get("__groups__"),
		db.itemGroups.get("__parent_groups__"),
	]);
	return {
		groups: g?.data || [],
		parentGroups: pg?.data || [],
	};
}

export async function cacheCustomers(customers: Customer[]): Promise<void> {
	const safeCustomers = sanitizeForIdb(customers);
	await db.transaction("rw", db.customers, async () => {
		await db.customers.clear();
		await db.customers.bulkAdd(safeCustomers);
	});
	await setMeta("customers_cached_at", new Date().toISOString());
}

export async function mergeCachedCustomers(customers: Customer[]): Promise<void> {
	await db.customers.bulkPut(sanitizeForIdb(customers));
}

export async function getCachedCustomers(): Promise<Customer[]> {
	return db.customers.toArray();
}

export async function getCachedCustomerByName(name: string): Promise<Customer | undefined> {
	return db.customers.get(name);
}

export async function searchCachedCustomers(term: string): Promise<Customer[]> {
	const all = await db.customers.toArray();
	if (!term) return all.slice(0, 20);

	const lower = term.toLowerCase();
	return all
		.filter(
			(c) =>
				c.customer_name.toLowerCase().includes(lower) ||
				(c.mobile_no && c.mobile_no.toLowerCase().includes(lower)) ||
				(c.email_id && c.email_id.toLowerCase().includes(lower)) ||
				c.name.toLowerCase().includes(lower),
		)
		.slice(0, 20);
}

export async function addCachedCustomer(customer: Customer): Promise<void> {
	await db.customers.put(sanitizeForIdb(customer));
}

export async function cacheSuppliers(suppliers: CachedSupplier[]): Promise<void> {
	const safeSuppliers = sanitizeForIdb(suppliers);
	await db.transaction("rw", db.suppliers, async () => {
		await db.suppliers.clear();
		await db.suppliers.bulkAdd(safeSuppliers);
	});
	await setMeta("suppliers_cached_at", new Date().toISOString());
}

export async function getCachedSuppliers(): Promise<CachedSupplier[]> {
	return db.suppliers.toArray();
}

export async function searchCachedSuppliers(term: string): Promise<CachedSupplier[]> {
	const all = await db.suppliers.toArray();
	if (!term) return all.slice(0, 20);

	const lower = term.toLowerCase();
	return all
		.filter(
			(s) =>
				s.supplier_name.toLowerCase().includes(lower) ||
				(s.mobile_no && s.mobile_no.toLowerCase().includes(lower)) ||
				s.name.toLowerCase().includes(lower),
		)
		.slice(0, 20);
}

export async function addCachedSupplier(supplier: CachedSupplier): Promise<void> {
	await db.suppliers.put(sanitizeForIdb(supplier));
}

export async function cacheStockForWarehouse(
	warehouse: string,
	stockEntries: { item_code: string; actual_qty: number }[],
): Promise<void> {
	const now = new Date().toISOString();

	await db.transaction("rw", db.stockCache, async () => {
		await db.stockCache.where("warehouse").equals(warehouse).delete();

		const entries: StockEntry[] = stockEntries.map((entry) => ({
			cache_key: `${warehouse}::${entry.item_code}`,
			warehouse,
			item_code: entry.item_code,
			actual_qty: entry.actual_qty,
			updated_at: now,
		}));

		await db.stockCache.bulkAdd(entries);
	});

	await setMeta(`stock_cached_at_${warehouse}`, now);
}

export async function getCachedStock(warehouse: string): Promise<StockEntry[]> {
	return db.stockCache.where("warehouse").equals(warehouse).toArray();
}

/** Cached quantities for just these items in one warehouse. */
export async function getCachedStockForItems(
	warehouse: string,
	itemCodes: string[],
): Promise<Map<string, number>> {
	const rows = await db.stockCache.bulkGet(itemCodes.map((code) => `${warehouse}::${code}`));
	const quantities = new Map<string, number>();
	for (const row of rows) if (row) quantities.set(row.item_code, row.actual_qty);
	return quantities;
}

export async function getCachedStockForItem(
	warehouse: string,
	itemCode: string,
): Promise<StockEntry | undefined> {
	return db.stockCache.get(`${warehouse}::${itemCode}`);
}

export async function updateStockForItem(
	warehouse: string,
	itemCode: string,
	actualQty: number,
): Promise<void> {
	const cacheKey = `${warehouse}::${itemCode}`;
	await db.stockCache.put({
		cache_key: cacheKey,
		warehouse,
		item_code: itemCode,
		actual_qty: actualQty,
		updated_at: new Date().toISOString(),
	});
}

export async function addPendingInvoice(record: Omit<PendingInvoice, "id">): Promise<number> {
	return db.pendingInvoices.add(sanitizeForIdb(record) as PendingInvoice);
}

export async function getAllPendingInvoices(): Promise<PendingInvoice[]> {
	return db.pendingInvoices.toArray();
}

export async function getPendingInvoicesByStatus(
	status: PendingInvoice["status"],
): Promise<PendingInvoice[]> {
	return db.pendingInvoices.where("status").equals(status).toArray();
}

export async function updatePendingInvoice(record: PendingInvoice): Promise<void> {
	if (record.id !== undefined) {
		await db.pendingInvoices.put(sanitizeForIdb(record));
	}
}

export async function deletePendingInvoice(id: number): Promise<void> {
	await db.pendingInvoices.delete(id);
}

export async function countPendingInvoices(): Promise<number> {
	return db.pendingInvoices.count();
}

export async function addPendingPurchase(record: Omit<PendingPurchase, "id">): Promise<number> {
	return db.pendingPurchases.add(sanitizeForIdb(record) as PendingPurchase);
}

export async function getAllPendingPurchases(): Promise<PendingPurchase[]> {
	return db.pendingPurchases.toArray();
}

export async function getPendingPurchasesByType(type: PendingPurchase["type"]): Promise<PendingPurchase[]> {
	return db.pendingPurchases.where("type").equals(type).toArray();
}

export async function updatePendingPurchase(record: PendingPurchase): Promise<void> {
	if (record.id !== undefined) {
		await db.pendingPurchases.put(sanitizeForIdb(record));
	}
}

export async function deletePendingPurchase(id: number): Promise<void> {
	await db.pendingPurchases.delete(id);
}

export async function countPendingPurchases(): Promise<number> {
	return db.pendingPurchases.count();
}

export async function setMeta(key: string, value: unknown): Promise<void> {
	await db.meta.put({
		key,
		value: sanitizeForIdb(value),
		updated_at: new Date().toISOString(),
	});
}

export async function getMeta(key: string): Promise<unknown> {
	const entry = await db.meta.get(key);
	return entry?.value;
}

export async function deleteMeta(key: string): Promise<void> {
	await db.meta.delete(key);
}

export async function cachePOSProfile(profileData: unknown): Promise<void> {
	await setMeta("pos_profile", profileData);
}

export async function getCachedPOSProfile(): Promise<unknown | null> {
	return await getMeta("pos_profile");
}

export async function cachePOSData(data: {
	pos_opening_shift?: unknown;
	pos_profile?: unknown;
	company?: unknown;
	stock_settings?: unknown;
	taxes?: unknown;
	tax_inclusive?: boolean | number;
	disable_rounded_total?: boolean | number;
	print_settings?: unknown;
}): Promise<void> {
	await setMeta("pos_complete_data", data);
}

export async function getCachedPOSData(): Promise<unknown | null> {
	return await getMeta("pos_complete_data");
}

export async function cacheCustomerGroups(groups: string[]): Promise<void> {
	await setMeta("customer_groups", groups);
}

export async function getCachedCustomerGroups(): Promise<string[]> {
	const val = await getMeta("customer_groups");
	return val ? (val as string[]) : [];
}

export async function cacheTerritories(territories: string[]): Promise<void> {
	await setMeta("territories", territories);
}

export async function getCachedTerritories(): Promise<string[]> {
	const val = await getMeta("territories");
	return val ? (val as string[]) : [];
}

export async function cacheCountries(countries: string[]): Promise<void> {
	await setMeta("countries", countries);
}

export async function getCachedCountries(): Promise<string[]> {
	const val = await getMeta("countries");
	return val ? (val as string[]) : [];
}

export async function cacheCurrencies(currencies: string[]): Promise<void> {
	await setMeta("currencies", currencies);
}

export async function getCachedCurrencies(): Promise<string[]> {
	const val = await getMeta("currencies");
	return val ? (val as string[]) : [];
}

export async function cacheLanguages(languages: string[]): Promise<void> {
	await setMeta("languages", languages);
}

export async function getCachedLanguages(): Promise<string[]> {
	const val = await getMeta("languages");
	return val ? (val as string[]) : [];
}

export async function cacheItemTax(itemCode: string, company: string, data: CachedItemTax): Promise<void> {
	await setMeta(`item_tax::${company}::${itemCode}`, data);
}

export async function getCachedItemTax(itemCode: string, company: string): Promise<CachedItemTax | null> {
	const val = await getMeta(`item_tax::${company}::${itemCode}`);
	return val ? (val as CachedItemTax) : null;
}

export async function cacheOffers(posProfile: string, offers: unknown[]): Promise<void> {
	await setMeta(`offers::${posProfile}`, offers);
}

export async function getCachedOffers(posProfile: string): Promise<unknown[] | null> {
	const val = await getMeta(`offers::${posProfile}`);
	return val ? (val as unknown[]) : null;
}

export async function cachePricingRules(posProfile: string, rules: unknown[]): Promise<void> {
	await setMeta(`pricing_rules::${posProfile}`, rules);
}

export async function getCachedPricingRules(posProfile: string): Promise<unknown[] | null> {
	const val = await getMeta(`pricing_rules::${posProfile}`);
	return val ? (val as unknown[]) : null;
}

export async function cacheReceiptContext(
	posProfile: string,
	context: import("@/types/pos.types").ReceiptContext,
): Promise<void> {
	await setMeta(`receipt_context::${posProfile}`, context);
}

export async function getCachedReceiptContext(
	posProfile: string,
): Promise<import("@/types/pos.types").ReceiptContext | null> {
	const val = await getMeta(`receipt_context::${posProfile}`);
	return val ? (val as import("@/types/pos.types").ReceiptContext) : null;
}

export async function clearAllData(): Promise<void> {
	await db.transaction(
		"rw",
		[
			db.items,
			db.itemGroups,
			db.customers,
			db.suppliers,
			db.stockCache,
			db.meta,
			db.syncIdMap,
			db.itemsStage,
			db.stockStage,
			db.customersStage,
		],
		async () => {
			await db.items.clear();
			invalidateCatalogIndex();
			await db.itemGroups.clear();
			await db.customers.clear();
			await db.suppliers.clear();
			await db.stockCache.clear();
			await db.meta.clear();
			await db.syncIdMap.clear();
			await db.itemsStage.clear();
			await db.stockStage.clear();
			await db.customersStage.clear();
		},
	);
}

const CATALOG_META_KEYS = [
	"catalog_state",
	"catalog_sync_job",
	"items_cached_at",
	"items_cache_scope",
	"customers_cached_at",
];

export async function clearCatalogCache(): Promise<void> {
	await db.transaction(
		"rw",
		[
			db.items,
			db.itemGroups,
			db.customers,
			db.stockCache,
			db.meta,
			db.itemsStage,
			db.stockStage,
			db.customersStage,
		],
		async () => {
			await db.items.clear();
			await db.itemGroups.clear();
			await db.customers.clear();
			await db.stockCache.clear();
			await db.itemsStage.clear();
			await db.stockStage.clear();
			await db.customersStage.clear();
			await db.meta.bulkDelete(CATALOG_META_KEYS);
		},
	);
	invalidateCatalogIndex();
}

export async function claimPendingInvoice(
	id: number,
	owner: string,
	ttlMs: number,
): Promise<PendingInvoice | null> {
	return db.transaction("rw", db.pendingInvoices, async () => {
		const row = await db.pendingInvoices.get(id);
		if (!row) return null;
		if (row.claimed_by && row.claim_expires && Date.parse(row.claim_expires) > Date.now()) return null;
		const claimed: PendingInvoice = {
			...row,
			claimed_by: owner,
			claim_expires: new Date(Date.now() + ttlMs).toISOString(),
			status: "syncing",
		};
		await db.pendingInvoices.put(claimed);
		return claimed;
	});
}

export async function recoverStaleClaims(): Promise<number> {
	return db.transaction("rw", db.pendingInvoices, async () => {
		const rows = await db.pendingInvoices.where("status").equals("syncing").toArray();
		let recovered = 0;
		for (const row of rows) {
			if (row.claim_expires && Date.parse(row.claim_expires) > Date.now()) continue;
			await db.pendingInvoices.put({
				...row,
				status: "pending",
				claimed_by: null,
				claim_expires: null,
			});
			recovered++;
		}
		return recovered;
	});
}

export async function clearCachedData(): Promise<void> {
	await clearAllData();
}

export async function cacheERPSettings(settings: unknown): Promise<void> {
	await setMeta("erp_settings", settings);
	await setMeta("erp_settings_cached_at", new Date().toISOString());
}

export async function getCachedERPSettings(): Promise<unknown | null> {
	return await getMeta("erp_settings");
}

export async function clearPendingData(): Promise<void> {
	await db.transaction("rw", [db.pendingInvoices, db.pendingPurchases], async () => {
		await db.pendingInvoices.clear();
		await db.pendingPurchases.clear();
	});
}

export async function addSyncIdMapping(entry: SyncIdMap): Promise<void> {
	await db.syncIdMap.put(sanitizeForIdb(entry));
}

export async function getServerName(localId: string): Promise<string | null> {
	const entry = await db.syncIdMap.get(localId);
	return entry?.server_name || null;
}

export async function getLocalId(serverName: string): Promise<string | null> {
	const entry = await db.syncIdMap.where("server_name").equals(serverName).first();
	return entry?.local_id || null;
}

export async function getSyncIdMapByDoctype(doctype: string): Promise<SyncIdMap[]> {
	return db.syncIdMap.where("doctype").equals(doctype).toArray();
}

export async function upsertPullBatch(
	store: string,
	records: Record<string, unknown>[],
	isIncremental: boolean,
): Promise<void> {
	const safeRecords = sanitizeForIdb(records);

	if (store === "items") {
		if (!isIncremental) await db.items.clear();
		await db.items.bulkPut(safeRecords as unknown as POSItem[]);
		invalidateCatalogIndex();
	} else if (store === "customers") {
		if (!isIncremental) await db.customers.clear();
		await db.customers.bulkPut(safeRecords as unknown as Customer[]);
	} else if (store === "suppliers") {
		if (!isIncremental) await db.suppliers.clear();
		await db.suppliers.bulkPut(safeRecords as unknown as CachedSupplier[]);
	} else if (store === "itemGroups") {
		await db.itemGroups.clear();
		await db.itemGroups.bulkPut(safeRecords as unknown as ItemGroupEntry[]);
	}
}

export { db };
