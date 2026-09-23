import Dexie, { type Table } from "dexie";
import type { POSItem, ItemGroup, Customer } from "@/types/pos.types";
import { sanitizeForIdb } from "./idbSanitize";

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
	status: "pending" | "syncing" | "failed" | "dead_letter";
	created_at: string;
	error?: string;
	retry_count: number;
	customer_name?: string;
	grand_total?: number;
	/** What the till printed. Kept beside `data`, so it is never sent to the server. */
	receipt?: import("@/types/pos.types").ReceiptSnapshot;
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

	constructor() {
		super(DB_NAME);

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
	}
}

const db = new XPosDB();
let dbReadyPromise: Promise<void> | null = null;

async function resetDatabaseConnection(): Promise<void> {
	let savedInvoices: PendingInvoice[] = [];
	let savedPurchases: PendingPurchase[] = [];
	try {
		if (!db.isOpen()) await db.open();
		savedInvoices = await db.pendingInvoices.toArray();
		savedPurchases = await db.pendingPurchases.toArray();
	} catch (err) {
		console.warn("[XPOS] Could not read pending records before DB reset", err);
	}

	try {
		db.close();
	} catch {
		// Ignore close failures during recovery.
	}

	await Dexie.delete(DB_NAME);
	await db.open();

	if (savedInvoices.length || savedPurchases.length) {
		try {
			if (savedInvoices.length) await db.pendingInvoices.bulkAdd(savedInvoices);
			if (savedPurchases.length) await db.pendingPurchases.bulkAdd(savedPurchases);
			console.warn(
				`[XPOS] Restored ${savedInvoices.length} pending invoice(s) and ${savedPurchases.length} pending purchase(s) after DB reset`,
			);
		} catch (err) {
			console.error("[XPOS] Failed to restore pending records after DB reset", err);
		}
	}
}

export async function ensureDatabaseReady(forceReset = false): Promise<void> {
	if (forceReset) {
		dbReadyPromise = null;
	}

	if (!dbReadyPromise) {
		dbReadyPromise = (async () => {
			try {
				if (!db.isOpen()) {
					await db.open();
				}
			} catch (error) {
				if (!isRecoverableDbError(error)) {
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

export async function updateCachedItem(item: POSItem): Promise<void> {
	await db.items.put(sanitizeForIdb(item));
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
		[db.items, db.itemGroups, db.customers, db.suppliers, db.stockCache, db.meta, db.syncIdMap],
		async () => {
			await db.items.clear();
			await db.itemGroups.clear();
			await db.customers.clear();
			await db.suppliers.clear();
			await db.stockCache.clear();
			await db.meta.clear();
			await db.syncIdMap.clear();
		},
	);
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
