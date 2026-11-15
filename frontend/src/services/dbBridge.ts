import type { PendingPurchase, PendingInvoice } from "./idbService";
import { sanitizeForIdb } from "./idbSanitize";
import { newInvoiceId } from "./saleIdentity";
import { currentOwner } from "./sessionScope";
import { StorageWriteError, classifyStorageError } from "./storageHealth";
import { tabId } from "./tabId";
import type { POSItem, ItemGroup, Customer } from "@/types/pos.types";

export async function getItems(opts?: { search?: string; group?: string; limit?: number; offset?: number }) {
	const { db } = await import("./idbService");
	let col = db.items.orderBy("item_name");
	if (opts?.group && opts.group !== "All Item Groups") {
		col = db.items.where("item_group").equals(opts.group);
	}
	let results = await col.toArray();
	if (opts?.search) {
		const s = opts.search.toLowerCase();
		results = results.filter(
			(r: Record<string, unknown>) =>
				String(r.item_code || "")
					.toLowerCase()
					.includes(s) ||
				String(r.item_name || "")
					.toLowerCase()
					.includes(s) ||
				String(r.barcode || "")
					.toLowerCase()
					.includes(s),
		);
	}
	if (opts?.offset) results = results.slice(opts.offset);
	if (opts?.limit) results = results.slice(0, opts.limit);
	return results;
}

export async function getItem(itemCode: string) {
	const { db } = await import("./idbService");
	return db.items.get(itemCode) ?? null;
}

export async function upsertItems(rows: Record<string, unknown>[]) {
	const { db } = await import("./idbService");
	await db.items.bulkPut(rows as never[]);
}

export async function countItems() {
	const { db } = await import("./idbService");
	return db.items.count();
}

export async function clearItems() {
	const { db } = await import("./idbService");
	await db.items.clear();
}

export async function getItemGroups() {
	const { db } = await import("./idbService");
	return db.itemGroups.toArray();
}

export async function upsertItemGroups(rows: Record<string, unknown>[]) {
	const { db } = await import("./idbService");
	await db.itemGroups.bulkPut(rows as never[]);
}

export async function getCustomers(opts?: { search?: string; limit?: number }) {
	const { db } = await import("./idbService");
	let results = await db.customers.toArray();
	if (opts?.search) {
		const s = opts.search.toLowerCase();
		results = results.filter(
			(r: Record<string, unknown>) =>
				String(r.customer_name || "")
					.toLowerCase()
					.includes(s) ||
				String(r.name || "")
					.toLowerCase()
					.includes(s) ||
				String(r.mobile_no || "")
					.toLowerCase()
					.includes(s),
		);
	}
	if (opts?.limit) results = results.slice(0, opts.limit);
	return results;
}

export async function getCustomer(name: string) {
	const { db } = await import("./idbService");
	return db.customers.get(name) ?? null;
}

export async function upsertCustomers(rows: Record<string, unknown>[]) {
	const { db } = await import("./idbService");
	await db.customers.bulkPut(rows as never[]);
}

export async function addLocalCustomer(customer: Record<string, unknown>) {
	const { db } = await import("./idbService");
	const localId = `local_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
	await db.customers.add({ ...customer, name: localId, is_local: 1, local_id: localId } as never);
	return { name: localId, local_id: localId };
}

export async function getSuppliers(opts?: { search?: string; limit?: number }) {
	const { db } = await import("./idbService");
	let results = await db.suppliers.toArray();
	if (opts?.search) {
		const s = opts.search.toLowerCase();
		results = results.filter(
			(r) =>
				String((r as any).supplier_name || "")
					.toLowerCase()
					.includes(s) ||
				String((r as any).name || "")
					.toLowerCase()
					.includes(s),
		);
	}
	if (opts?.limit) results = results.slice(0, opts.limit);
	return results;
}

export async function upsertSuppliers(rows: Record<string, unknown>[]) {
	const { db } = await import("./idbService");
	await db.suppliers.bulkPut(rows as never[]);
}

export async function getStock(warehouse: string, itemCode?: string) {
	const { db } = await import("./idbService");
	if (itemCode) {
		return db.table("stockCache").get(`${warehouse}::${itemCode}`) ?? null;
	}
	return db.table("stockCache").where("warehouse").equals(warehouse).toArray();
}

export async function upsertStock(warehouse: string, entries: { item_code: string; actual_qty: number }[]) {
	const { db } = await import("./idbService");
	const rows = entries.map((e) => ({
		cache_key: `${warehouse}::${e.item_code}`,
		warehouse,
		item_code: e.item_code,
		actual_qty: e.actual_qty,
	}));
	await db.table("stockCache").bulkPut(rows);
}

export async function updateStockQty(warehouse: string, itemCode: string, qty: number) {
	const { db } = await import("./idbService");
	await db.table("stockCache").put({
		cache_key: `${warehouse}::${itemCode}`,
		warehouse,
		item_code: itemCode,
		actual_qty: qty,
	});
	return true;
}

export const SEND_CLAIM_MS = 2 * 60_000;

export async function addPendingInvoice(record: {
	data: unknown;
	customer_name?: string;
	grand_total?: number;
	receipt?: import("@/types/pos.types").ReceiptSnapshot;
	reservations?: { item_code: string; stock_qty: number }[];
	owner?: PendingInvoice["owner"];
	catalog_evidence?: PendingInvoice["catalog_evidence"];
	claim?: boolean;
	hold?: PendingInvoice["hold"];
}) {
	try {
		record = sanitizeForIdb(record);
		const idb = await import("./idbService");
		await idb.ensureDatabaseReady();
		const data = record.data as Record<string, unknown>;
		const localId = String(data.local_id || newInvoiceId());
		const table = idb.db.table("pendingInvoices");
		return await idb.db.transaction("rw", table, async () => {
			const existing = await table.filter((row) => row.local_id === localId).first();
			if (existing) {
				if (JSON.stringify(existing.data) !== JSON.stringify(record.data)) {
					const conflict = new Error(
						"This sale is awaiting confirmation. Retry the original sale from Pending Invoices before changing it.",
					);
					conflict.name = "SaleConflict";
					throw conflict;
				}
				if (record.hold && existing.hold !== record.hold) {
					await table.update(existing.id as number, { hold: record.hold });
				}
				return { id: existing.id as number, local_id: localId };
			}
			const id = await table.add({
				local_id: localId,
				data: record.data,
				status: "pending",
				customer_name: record.customer_name,
				grand_total: record.grand_total,
				receipt: record.receipt,
				reservations: record.reservations,
				owner: record.owner === undefined ? currentOwner() : record.owner,
				catalog_evidence: record.catalog_evidence ?? null,
				attempts: 0,
				hold: record.hold ?? null,
				claimed_by: record.claim ? tabId : null,
				claim_expires: record.claim ? new Date(Date.now() + SEND_CLAIM_MS).toISOString() : null,
				created_at: new Date().toISOString(),
			});
			const saved = await table.get(id);
			if (!saved || saved.local_id !== localId) throw new StorageWriteError("unknown");
			return { id: id as number, local_id: localId };
		});
	} catch (error) {
		if ((error as Error)?.name === "SaleConflict") throw error;
		throw error instanceof StorageWriteError
			? error
			: new StorageWriteError(classifyStorageError(error), error);
	}
}

export async function findPendingInvoiceByLocalId(localId: string): Promise<PendingInvoice | undefined> {
	const idb = await import("./idbService");
	await idb.ensureDatabaseReady();
	return idb.db.pendingInvoices.filter((row) => row.local_id === localId).first();
}

export async function claimPendingInvoice(id: number, ttlMs: number = SEND_CLAIM_MS) {
	const idb = await import("./idbService");
	return idb.claimPendingInvoice(id, tabId, ttlMs);
}

export async function recoverStaleClaims() {
	const idb = await import("./idbService");
	await idb.ensureDatabaseReady();
	return idb.recoverStaleClaims();
}

export async function exportPendingInvoices(): Promise<string> {
	const idb = await import("./idbService");
	const rows = await idb.getAllPendingInvoices();
	return JSON.stringify(
		{ exported_at: new Date().toISOString(), host: location.host, invoices: rows },
		null,
		2,
	);
}

export async function getPendingInvoices(status?: string) {
	const idb = await import("./idbService");
	return status ? idb.getPendingInvoicesByStatus(status as any) : idb.getAllPendingInvoices();
}

export async function updatePendingInvoice(id: number, updates: Record<string, unknown>) {
	const idb = await import("./idbService");
	const existing = await idb.getAllPendingInvoices();
	const record = existing.find((entry) => entry.id === id);
	if (!record) return false;
	await idb.updatePendingInvoice({ ...record, ...updates, id });
	return true;
}

export async function deletePendingInvoice(id: number) {
	const idb = await import("./idbService");
	await idb.deletePendingInvoice(id);
	return true;
}

export async function countPendingInvoices() {
	const idb = await import("./idbService");
	const records = await idb.getAllPendingInvoices();
	return records.filter(
		(record) => record.status === "pending" || record.status === "failed" || record.status === "syncing",
	).length;
}

export async function addPendingPurchase(record: {
	type: string;
	data: unknown;
	supplier_name?: string;
	grand_total?: number;
}) {
	record = sanitizeForIdb(record);
	const { db } = await import("./idbService");
	const localId = `pur_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
	const id = await db.table("pendingPurchases").add({
		local_id: localId,
		type: record.type,
		data: record.data,
		status: "pending",
		supplier_name: record.supplier_name,
		grand_total: record.grand_total,
		created_at: new Date().toISOString(),
	});
	return { id: id as number, local_id: localId };
}

export async function getPendingPurchases(opts?: { type?: string; status?: string }) {
	const idb = await import("./idbService");
	let results = opts?.type
		? await idb.getPendingPurchasesByType(opts.type as any)
		: await idb.getAllPendingPurchases();
	if (opts?.status) results = results.filter((r) => r.status === opts.status);
	return results;
}

export async function updatePendingPurchase(id: number, updates: Record<string, unknown>) {
	const idb = await import("./idbService");
	const existing = await idb.getAllPendingPurchases();
	const record = existing.find((entry) => entry.id === id);
	if (!record) return false;
	await idb.updatePendingPurchase({ ...record, ...updates, id });
	return true;
}

export async function deletePendingPurchase(id: number) {
	const idb = await import("./idbService");
	await idb.deletePendingPurchase(id);
	return true;
}

export async function addSyncId(localId: string, serverName: string, doctype: string) {
	const { addSyncIdMapping } = await import("./idbService");
	await addSyncIdMapping({
		local_id: localId,
		server_name: serverName,
		doctype,
		synced_at: new Date().toISOString(),
	});
	return true;
}

export async function getServerName(localId: string) {
	const mod = await import("./idbService");
	return mod.getServerName(localId);
}

export async function getSyncMeta(key: string) {
	const idb = await import("./idbService");
	return idb.getMeta(key);
}

export async function setSyncMeta(key: string, value: string) {
	const idb = await import("./idbService");
	await idb.setMeta(key, value);
	return true;
}

export async function getSetting(key: string): Promise<string | null> {
	return localStorage.getItem(`xpos_setting_${key}`);
}

export async function setSetting(key: string, value: string, category?: string): Promise<boolean> {
	localStorage.setItem(`xpos_setting_${key}`, value);
	return true;
}

export async function getAllSettings() {
	const settings: { key: string; value: string; category: string }[] = [];
	for (let i = 0; i < localStorage.length; i++) {
		const k = localStorage.key(i);
		if (k?.startsWith("xpos_setting_")) {
			settings.push({
				key: k.replace("xpos_setting_", ""),
				value: localStorage.getItem(k) || "",
				category: "general",
			});
		}
	}
	return settings;
}

export async function cachePosData(name: string, data: unknown) {
	const idb = await import("./idbService");
	await idb.setMeta(`pos_profile_cache::${name}`, data);
	return true;
}

export async function getCachedPosData(name: string) {
	const idb = await import("./idbService");
	return idb.getMeta(`pos_profile_cache::${name}`);
}

export async function clearAllData() {
	const { db } = await import("./idbService");
	await Promise.all(db.tables.map((t) => t.clear()));
	return true;
}

export async function clearCachedData() {
	const idb = await import("./idbService");
	await idb.clearCachedData();
	return true;
}

export async function clearPendingData() {
	const idb = await import("./idbService");
	await idb.clearPendingData();
	return true;
}

export async function getCountries(): Promise<string[]> {
	const idb = await import("./idbService");
	return idb.getCachedCountries();
}

export async function getCurrencies(): Promise<string[]> {
	const idb = await import("./idbService");
	return idb.getCachedCurrencies();
}

export async function cacheItems(allItems: POSItem[]): Promise<void> {
	const idb = await import("./idbService");
	await idb.cacheItems(allItems);
}

export async function getCachedItems(): Promise<POSItem[]> {
	const idb = await import("./idbService");
	return idb.getCachedItems();
}

export async function getCachedItemByCode(itemCode: string): Promise<POSItem | undefined> {
	const idb = await import("./idbService");
	return idb.getCachedItemByCode(itemCode);
}

export async function searchCachedItems(
	term: string,
	group: string,
	searchFields?: string[],
): Promise<POSItem[]> {
	const idb = await import("./idbService");
	return idb.searchCachedItems(term, group, searchFields);
}

export async function searchCachedItemsPage(
	term: string,
	group: string,
	searchFields: string[] | undefined,
	offset: number,
	limit: number,
): Promise<{ items: POSItem[]; hasMore: boolean; total: number }> {
	const idb = await import("./idbService");
	return idb.searchCachedItemsPage(term, group, searchFields, offset, limit);
}

export async function findCachedItem(value: string): Promise<POSItem | undefined> {
	const idb = await import("./idbService");
	return idb.findCachedItem(value);
}

export async function findCachedScan(value: string) {
	const idb = await import("./idbService");
	return idb.findCachedScan(value);
}

export async function warmCatalogIndex(searchFields?: string[]): Promise<void> {
	const idb = await import("./idbService");
	await idb.warmCatalogIndex(searchFields);
}

export async function getCachedStockForItems(
	warehouse: string,
	itemCodes: string[],
): Promise<Map<string, number>> {
	const idb = await import("./idbService");
	return idb.getCachedStockForItems(warehouse, itemCodes);
}

export async function cacheItemGroups(groups: ItemGroup[], parentGroups: ItemGroup[]): Promise<void> {
	const idb = await import("./idbService");
	await idb.cacheItemGroups(groups, parentGroups);
}

export async function getCachedItemGroups(): Promise<{ groups: ItemGroup[]; parentGroups: ItemGroup[] }> {
	const idb = await import("./idbService");
	return idb.getCachedItemGroups();
}

export async function cacheStockForWarehouse(
	warehouse: string,
	stockEntries: { item_code: string; actual_qty: number }[],
): Promise<void> {
	const idb = await import("./idbService");
	await idb.cacheStockForWarehouse(warehouse, stockEntries);
}

export async function getCachedStock(warehouse: string) {
	const idb = await import("./idbService");
	return idb.getCachedStock(warehouse);
}

export async function getCachedStockForItem(warehouse: string, itemCode: string) {
	const idb = await import("./idbService");
	return idb.getCachedStockForItem(warehouse, itemCode);
}

export async function adjustCachedStock(
	warehouse: string,
	deltas: { item_code: string; delta: number }[],
): Promise<void> {
	if (!warehouse || deltas.length === 0) return;

	for (const { item_code, delta } of deltas) {
		if (!delta) continue;
		try {
			const current = await getCachedStockForItem(warehouse, item_code);
			if (!current) continue;

			await updateStockQty(warehouse, item_code, (current.actual_qty || 0) + delta);
		} catch (error) {
			console.warn("[XPOS Offline] Failed to adjust cached stock for", item_code, error);
		}
	}
}

export async function cacheCustomers(customers: Customer[]): Promise<void> {
	const idb = await import("./idbService");
	await idb.cacheCustomers(customers);
}

export async function mergeCachedCustomers(customers: Customer[]): Promise<void> {
	const idb = await import("./idbService");
	await idb.mergeCachedCustomers(customers);
}

export async function getCachedCustomers(): Promise<Customer[]> {
	const idb = await import("./idbService");
	return idb.getCachedCustomers();
}

export async function searchCachedCustomers(term: string): Promise<Customer[]> {
	const idb = await import("./idbService");
	return idb.searchCachedCustomers(term);
}

export async function addCachedCustomer(customer: Customer): Promise<void> {
	const idb = await import("./idbService");
	await idb.addCachedCustomer(customer);
}

export async function cacheSuppliers(
	suppliers: Array<Record<string, unknown> & { name: string }>,
): Promise<void> {
	const idb = await import("./idbService");
	await idb.cacheSuppliers(suppliers as any);
}

export async function searchCachedSuppliers(term: string) {
	const idb = await import("./idbService");
	return idb.searchCachedSuppliers(term);
}

export async function addCachedSupplier(supplier: Record<string, unknown>): Promise<void> {
	const idb = await import("./idbService");
	await idb.addCachedSupplier(supplier as any);
}

export async function cachePOSData(data: unknown): Promise<void> {
	const idb = await import("./idbService");
	await idb.cachePOSData(data as any);
}

export async function getCachedPOSData(): Promise<unknown | null> {
	const idb = await import("./idbService");
	return idb.getCachedPOSData();
}

export async function cacheOffers(posProfile: string, offers: unknown[]): Promise<void> {
	const idb = await import("./idbService");
	await idb.cacheOffers(posProfile, offers);
}

export async function getCachedOffers(posProfile: string): Promise<unknown[] | null> {
	const idb = await import("./idbService");
	return idb.getCachedOffers(posProfile);
}

export async function cachePricingRules(posProfile: string, rules: unknown[]): Promise<void> {
	const idb = await import("./idbService");
	await idb.cachePricingRules(posProfile, rules);
}

export async function getCachedPricingRules(posProfile: string): Promise<unknown[] | null> {
	const idb = await import("./idbService");
	return idb.getCachedPricingRules(posProfile);
}

export async function cacheReceiptContext(
	posProfile: string,
	context: import("@/types/pos.types").ReceiptContext,
): Promise<void> {
	const idb = await import("./idbService");
	await idb.cacheReceiptContext(posProfile, context);
}

export async function getCachedReceiptContext(
	posProfile: string,
): Promise<import("@/types/pos.types").ReceiptContext | null> {
	const idb = await import("./idbService");
	return idb.getCachedReceiptContext(posProfile);
}

export async function cacheItemTax(
	itemCode: string,
	company: string,
	data: { item_tax_template: string | null; item_tax_map: Record<string, number> },
): Promise<void> {
	const idb = await import("./idbService");
	await idb.cacheItemTax(itemCode, company, data);
}

export async function getCachedItemTax(
	itemCode: string,
	company: string,
): Promise<{ item_tax_template: string | null; item_tax_map: Record<string, number> } | null> {
	const idb = await import("./idbService");
	return idb.getCachedItemTax(itemCode, company);
}

export async function cacheCustomerGroups(groups: string[]): Promise<void> {
	const idb = await import("./idbService");
	await idb.cacheCustomerGroups(groups);
}

export async function getCachedCustomerGroups(): Promise<string[]> {
	const idb = await import("./idbService");
	return idb.getCachedCustomerGroups();
}

export async function cacheTerritories(territories: string[]): Promise<void> {
	const idb = await import("./idbService");
	await idb.cacheTerritories(territories);
}

export async function getCachedTerritories(): Promise<string[]> {
	const idb = await import("./idbService");
	return idb.getCachedTerritories();
}

export async function cacheCountries(countries: string[]): Promise<void> {
	const idb = await import("./idbService");
	await idb.cacheCountries(countries);
}

export async function getCachedCountries(): Promise<string[]> {
	const idb = await import("./idbService");
	return idb.getCachedCountries();
}

export async function cacheCurrencies(currencies: string[]): Promise<void> {
	const idb = await import("./idbService");
	await idb.cacheCurrencies(currencies);
}

export async function getCachedCurrencies(): Promise<string[]> {
	const idb = await import("./idbService");
	return idb.getCachedCurrencies();
}

export interface CachedCurrencyMeta {
	name: string;
	symbol?: string;
	number_format?: string;
	smallest_currency_fraction_value?: number;
	symbol_on_right?: number;
}

export async function cacheCurrencyMeta(currencies: CachedCurrencyMeta[]): Promise<void> {
	const idb = await import("./idbService");
	await idb.setMeta("currency_meta", currencies);
}

export async function getCachedCurrencyMeta(): Promise<CachedCurrencyMeta[]> {
	const idb = await import("./idbService");
	return ((await idb.getMeta("currency_meta")) as CachedCurrencyMeta[]) || [];
}

export async function cacheLanguages(languages: string[]): Promise<void> {
	const idb = await import("./idbService");
	await idb.cacheLanguages(languages);
}

export async function getCachedLanguages(): Promise<string[]> {
	const idb = await import("./idbService");
	return idb.getCachedLanguages();
}

export async function getAllPendingInvoices() {
	return getPendingInvoices();
}

export async function getDeadLetters(): Promise<{
	invoices: Record<string, unknown>[];
	purchases: Record<string, unknown>[];
}> {
	const idb = await import("./idbService");
	const invoices = await idb.getPendingInvoicesByStatus("dead_letter" as never);
	const purchases = (await idb.getAllPendingPurchases()).filter(
		(p) => (p as { status?: string }).status === "dead_letter",
	);
	return {
		invoices: invoices as unknown as Record<string, unknown>[],
		purchases: purchases as unknown as Record<string, unknown>[],
	};
}

export async function countDeadLetters(): Promise<number> {
	const { invoices, purchases } = await getDeadLetters();
	return invoices.length + purchases.length;
}

export async function retryDeadLetter(table: string, id: number): Promise<boolean> {
	const idb = await import("./idbService");
	if (table === "pending_invoices") {
		const all = await idb.getAllPendingInvoices();
		const rec = all.find((r) => r.id === id);
		if (!rec) return false;
		await idb.updatePendingInvoice({ ...rec, status: "pending", retry_count: 0, error: undefined, id });
		return true;
	}
	return false;
}

export async function getAllPendingPurchases(): Promise<PendingPurchase[]> {
	return getPendingPurchases() as Promise<PendingPurchase[]>;
}

export async function countPendingPurchases(): Promise<number> {
	const idb = await import("./idbService");
	const records = await idb.getAllPendingPurchases();
	return records.filter((record) => record.status === "pending" || record.status === "failed").length;
}

export async function cacheERPSettings(settings: unknown): Promise<void> {
	const idb = await import("./idbService");
	await idb.cacheERPSettings(settings);
}

export async function getCachedERPSettings(): Promise<unknown | null> {
	const idb = await import("./idbService");
	return idb.getCachedERPSettings();
}
