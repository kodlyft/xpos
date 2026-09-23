import { isElectron } from "./electronBridge";
import type { PendingPurchase } from "./idbService";
import { sanitizeForIdb } from "./idbSanitize";

function getDb() {
	return window.electronAPI!.db;
}

export async function getItems(opts?: { search?: string; group?: string; limit?: number; offset?: number }) {
	if (isElectron()) {
		return getDb().getItems(opts);
	}
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
	if (isElectron()) {
		return getDb().getItem(itemCode);
	}
	const { db } = await import("./idbService");
	return db.items.get(itemCode) ?? null;
}

export async function upsertItems(rows: Record<string, unknown>[]) {
	if (isElectron()) {
		return getDb().upsertItems(rows);
	}
	const { db } = await import("./idbService");
	await db.items.bulkPut(rows as never[]);
}

export async function countItems() {
	if (isElectron()) {
		return getDb().countItems();
	}
	const { db } = await import("./idbService");
	return db.items.count();
}

export async function clearItems() {
	if (isElectron()) {
		return getDb().clearItems();
	}
	const { db } = await import("./idbService");
	await db.items.clear();
}

export async function getItemGroups() {
	if (isElectron()) {
		return getDb().getItemGroups();
	}
	const { db } = await import("./idbService");
	return db.itemGroups.toArray();
}

export async function upsertItemGroups(rows: Record<string, unknown>[]) {
	if (isElectron()) {
		return getDb().upsertItemGroups(rows);
	}
	const { db } = await import("./idbService");
	await db.itemGroups.bulkPut(rows as never[]);
}

export async function getCustomers(opts?: { search?: string; limit?: number }) {
	if (isElectron()) {
		return getDb().getCustomers(opts);
	}
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
	if (isElectron()) {
		return getDb().getCustomer(name);
	}
	const { db } = await import("./idbService");
	return db.customers.get(name) ?? null;
}

export async function upsertCustomers(rows: Record<string, unknown>[]) {
	if (isElectron()) {
		return getDb().upsertCustomers(rows);
	}
	const { db } = await import("./idbService");
	await db.customers.bulkPut(rows as never[]);
}

export async function addLocalCustomer(customer: Record<string, unknown>) {
	if (isElectron()) {
		return getDb().addLocalCustomer(customer);
	}
	const { db } = await import("./idbService");
	const localId = `local_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
	await db.customers.add({ ...customer, name: localId, is_local: 1, local_id: localId } as never);
	return { name: localId, local_id: localId };
}

export async function getSuppliers(opts?: { search?: string; limit?: number }) {
	if (isElectron()) {
		return getDb().getSuppliers(opts);
	}
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
	if (isElectron()) {
		return getDb().upsertSuppliers(rows);
	}
	const { db } = await import("./idbService");
	await db.suppliers.bulkPut(rows as never[]);
}

export async function getStock(warehouse: string, itemCode?: string) {
	if (isElectron()) {
		return getDb().getStock(warehouse, itemCode);
	}
	const { db } = await import("./idbService");
	if (itemCode) {
		return db.table("stockCache").get(`${warehouse}::${itemCode}`) ?? null;
	}
	return db.table("stockCache").where("warehouse").equals(warehouse).toArray();
}

export async function upsertStock(warehouse: string, entries: { item_code: string; actual_qty: number }[]) {
	if (isElectron()) {
		return getDb().upsertStock(warehouse, entries);
	}
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
	if (isElectron()) {
		return getDb().updateStockQty(warehouse, itemCode, qty);
	}
	const { db } = await import("./idbService");
	await db.table("stockCache").put({
		cache_key: `${warehouse}::${itemCode}`,
		warehouse,
		item_code: itemCode,
		actual_qty: qty,
	});
	return true;
}

export async function addPendingInvoice(record: {
	data: unknown;
	customer_name?: string;
	grand_total?: number;
	receipt?: import("@/types/pos.types").ReceiptSnapshot;
}) {
	// The cart hands over live Vue arrays (payments, change legs); IndexedDB and IPC can only
	// store plain data and throw DataCloneError otherwise.
	record = sanitizeForIdb(record);
	if (isElectron()) {
		return getDb().addPendingInvoice(record);
	}
	const { db } = await import("./idbService");
	const localId = `inv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
	const id = await db.table("pendingInvoices").add({
		local_id: localId,
		data: record.data,
		status: "pending",
		customer_name: record.customer_name,
		grand_total: record.grand_total,
		receipt: record.receipt,
		created_at: new Date().toISOString(),
	});
	return { id: id as number, local_id: localId };
}

export async function getPendingInvoices(status?: string) {
	if (isElectron()) {
		return getDb().getPendingInvoices(status);
	}
	const idb = await import("./idbService");
	return status ? idb.getPendingInvoicesByStatus(status as any) : idb.getAllPendingInvoices();
}

export async function updatePendingInvoice(id: number, updates: Record<string, unknown>) {
	if (isElectron()) {
		return getDb().updatePendingInvoice(id, updates);
	}
	const idb = await import("./idbService");
	const existing = await idb.getAllPendingInvoices();
	const record = existing.find((entry) => entry.id === id);
	if (!record) return false;
	await idb.updatePendingInvoice({ ...record, ...updates, id });
	return true;
}

export async function deletePendingInvoice(id: number) {
	if (isElectron()) {
		return getDb().deletePendingInvoice(id);
	}
	const idb = await import("./idbService");
	await idb.deletePendingInvoice(id);
	return true;
}

export async function countPendingInvoices() {
	if (isElectron()) {
		return getDb().countPendingInvoices();
	}
	const idb = await import("./idbService");
	const records = await idb.getAllPendingInvoices();
	return records.filter((record) => record.status === "pending" || record.status === "failed").length;
}

export async function addPendingPurchase(record: {
	type: string;
	data: unknown;
	supplier_name?: string;
	grand_total?: number;
}) {
	record = sanitizeForIdb(record);
	if (isElectron()) {
		return getDb().addPendingPurchase(record);
	}
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
	if (isElectron()) {
		return getDb().getPendingPurchases(opts);
	}
	const idb = await import("./idbService");
	let results = opts?.type
		? await idb.getPendingPurchasesByType(opts.type as any)
		: await idb.getAllPendingPurchases();
	if (opts?.status) results = results.filter((r) => r.status === opts.status);
	return results;
}

export async function updatePendingPurchase(id: number, updates: Record<string, unknown>) {
	if (isElectron()) {
		return getDb().updatePendingPurchase(id, updates);
	}
	const idb = await import("./idbService");
	const existing = await idb.getAllPendingPurchases();
	const record = existing.find((entry) => entry.id === id);
	if (!record) return false;
	await idb.updatePendingPurchase({ ...record, ...updates, id });
	return true;
}

export async function deletePendingPurchase(id: number) {
	if (isElectron()) {
		return getDb().deletePendingPurchase(id);
	}
	const idb = await import("./idbService");
	await idb.deletePendingPurchase(id);
	return true;
}

export async function addSyncId(localId: string, serverName: string, doctype: string) {
	if (isElectron()) {
		return getDb().addSyncId(localId, serverName, doctype);
	}
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
	if (isElectron()) {
		return getDb().getServerName(localId);
	}
	const mod = await import("./idbService");
	return mod.getServerName(localId);
}

export async function getSyncMeta(key: string) {
	if (isElectron()) {
		return getDb().getMeta(key);
	}
	const idb = await import("./idbService");
	return idb.getMeta(key);
}

export async function setSyncMeta(key: string, value: string) {
	if (isElectron()) {
		return getDb().setMeta(key, value);
	}
	const idb = await import("./idbService");
	await idb.setMeta(key, value);
	return true;
}

export async function getSetting(key: string): Promise<string | null> {
	if (isElectron()) {
		return getDb().getSetting(key);
	}
	return localStorage.getItem(`xpos_setting_${key}`);
}

export async function setSetting(key: string, value: string, category?: string): Promise<boolean> {
	if (isElectron()) {
		return getDb().setSetting(key, value, category);
	}
	localStorage.setItem(`xpos_setting_${key}`, value);
	return true;
}

export async function getAllSettings() {
	if (isElectron()) {
		return getDb().getAllSettings();
	}
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
	if (isElectron()) {
		return getDb().cachePosData(name, data);
	}
	const idb = await import("./idbService");
	await idb.setMeta(`pos_profile_cache::${name}`, data);
	return true;
}

export async function getCachedPosData(name: string) {
	if (isElectron()) {
		return getDb().getCachedPosData(name);
	}
	const idb = await import("./idbService");
	return idb.getMeta(`pos_profile_cache::${name}`);
}

export async function clearAllData() {
	if (isElectron()) {
		return getDb().clearAllData();
	}
	const { db } = await import("./idbService");
	await Promise.all(db.tables.map((t) => t.clear()));
	return true;
}

export async function clearCachedData() {
	if (isElectron()) {
		return getDb().clearCachedData();
	}
	const idb = await import("./idbService");
	await idb.clearCachedData();
	return true;
}

export async function clearPendingData() {
	if (isElectron()) {
		return getDb().clearPendingData();
	}
	const idb = await import("./idbService");
	await idb.clearPendingData();
	return true;
}

export async function getCompanies() {
	if (isElectron()) return getDb().getCompanies();
	return [];
}

export async function getCountries(): Promise<string[]> {
	if (isElectron()) {
		const rows = (await getDb().getCountries()) as Record<string, unknown>[];
		return rows.map((row) => String(row.name || "")).filter(Boolean);
	}
	const idb = await import("./idbService");
	return idb.getCachedCountries();
}

export async function getCurrencies(): Promise<string[]> {
	if (isElectron()) {
		const rows = (await getDb().getCurrencies()) as Record<string, unknown>[];
		return rows.map((row) => String(row.name || row.currency_name || "")).filter(Boolean);
	}
	const idb = await import("./idbService");
	return idb.getCachedCurrencies();
}

export async function getWarehouses(opts?: { company?: string; isGroup?: boolean }) {
	if (isElectron()) return getDb().getWarehouses(opts);
	return [];
}

export async function getAccounts(opts?: { company?: string; accountType?: string; rootType?: string }) {
	if (isElectron()) return getDb().getAccounts(opts);
	return [];
}

export async function getCostCenters(company?: string) {
	if (isElectron()) return getDb().getCostCenters(company);
	return [];
}

export async function getPriceLists(selling?: boolean) {
	if (isElectron()) return getDb().getPriceLists(selling);
	return [];
}

export async function getModeOfPaymentAccounts(company: string) {
	if (isElectron()) return getDb().getModeOfPaymentAccounts(company);
	return [];
}

export async function getPosProfiles(company?: string) {
	if (isElectron()) return getDb().getPosProfiles(company);
	return [];
}

export async function getPosProfile(name: string) {
	if (isElectron()) return getDb().getPosProfile(name);
	return null;
}

export async function getPosPaymentMethods(posProfile: string) {
	if (isElectron()) return getDb().getPosPaymentMethods(posProfile);
	return [];
}

export async function getPosUsers() {
	if (isElectron()) return getDb().getPosUsers();
	return [];
}

export async function getPosUser(email: string) {
	if (isElectron()) return getDb().getPosUser(email);
	return null;
}

export async function getItemPrice(itemCode: string, priceList: string) {
	if (isElectron()) return getDb().getItemPrice(itemCode, priceList);
	return null;
}

export async function getItemPrices(opts?: { priceList?: string; selling?: boolean }) {
	if (isElectron()) return getDb().getItemPrices(opts);
	return [];
}

export async function getItemByBarcode(barcode: string) {
	if (isElectron()) return getDb().getItemByBarcode(barcode);
	return null;
}

export async function getItemTaxTemplates(company?: string) {
	if (isElectron()) return getDb().getItemTaxTemplates(company);
	return [];
}

export async function getItemTaxTemplateDetails(templateName: string) {
	if (isElectron()) return getDb().getItemTaxTemplateDetails(templateName);
	return [];
}

export async function getSalesTaxTemplates(company?: string) {
	if (isElectron()) return getDb().getSalesTaxTemplates(company);
	return [];
}

export async function getSalesTaxCharges(templateName: string) {
	if (isElectron()) return getDb().getSalesTaxCharges(templateName);
	return [];
}

export async function getPricingRules(opts?: { company?: string; itemCode?: string }) {
	if (isElectron()) return getDb().getPricingRules(opts);
	return [];
}

export async function getPricingRuleItems(parent: string) {
	if (isElectron()) return getDb().getPricingRuleItems(parent);
	return [];
}

export async function getPricingRuleGroups(parent: string) {
	if (isElectron()) return getDb().getPricingRuleGroups(parent);
	return [];
}

export async function getPricingRuleBrands(parent: string) {
	if (isElectron()) return getDb().getPricingRuleBrands(parent);
	return [];
}

export async function getBin(itemCode: string, warehouse: string) {
	if (isElectron()) return getDb().getBin(itemCode, warehouse);
	return null;
}

export async function getBins(warehouse?: string) {
	if (isElectron()) return getDb().getBins(warehouse);
	return [];
}

export async function createPosOpeningShift(shift: Record<string, unknown>) {
	if (isElectron()) return getDb().createPosOpeningShift(shift);
	throw new Error("POS Opening Shifts require Electron mode");
}

export async function getOpenShift(user: string) {
	if (isElectron()) return getDb().getOpenShift(user);
	return null;
}

export async function closePosShift(localId: string) {
	if (isElectron()) return getDb().closePosShift(localId);
	return true;
}

export async function getPosOpeningShifts(opts?: { user?: string; status?: string }) {
	if (isElectron()) return getDb().getPosOpeningShifts(opts);
	return [];
}

export async function createPosClosingEntry(entry: Record<string, unknown>) {
	if (isElectron()) return getDb().createPosClosingEntry(entry);
	throw new Error("POS Closing Entries require Electron mode");
}

export async function getPosClosingEntries(opts?: { user?: string; status?: string }) {
	if (isElectron()) return getDb().getPosClosingEntries(opts);
	return [];
}

export async function getPosClosingEntryDetails(parentId: number) {
	if (isElectron()) return getDb().getPosClosingEntryDetails(parentId);
	return [];
}

export async function saveSalesInvoice(invoice: Record<string, unknown>) {
	if (isElectron()) return getDb().saveSalesInvoice(invoice);
	throw new Error("Sales Invoices require Electron mode");
}

export async function getSalesInvoices(opts?: {
	customer?: string;
	posProfile?: string;
	shiftLocalId?: string;
	fromDate?: string;
	toDate?: string;
	limit?: number;
}) {
	if (isElectron()) return getDb().getSalesInvoices(opts);
	return [];
}

export async function getSalesInvoice(localId: string) {
	if (isElectron()) return getDb().getSalesInvoice(localId);
	return null;
}

export async function getShiftSalesSummary(shiftLocalId: string) {
	if (isElectron()) return getDb().getShiftSalesSummary(shiftLocalId);
	return { total: 0, count: 0, qty: 0, payment_breakdown: [] };
}

export async function createExpense(expense: Record<string, unknown>) {
	if (isElectron()) return getDb().createExpense(expense);
	const { call } = await import("./api");
	return call("xpos.api.cash_movements.create_pos_expense", { payload: JSON.stringify(expense) });
}

export async function getExpenses(opts?: {
	user?: string;
	fromDate?: string;
	toDate?: string;
	shiftLocalId?: string;
	syncStatus?: string;
}) {
	if (isElectron()) return getDb().getExpenses(opts);
	const { getList } = await import("./api");
	const filters: unknown[] = [
		["movement_type", "=", "Expense"],
		["docstatus", "=", 1],
	];
	if (opts?.user) filters.push(["user", "=", opts.user]);
	if (opts?.fromDate) filters.push(["posting_date", ">=", opts.fromDate]);
	if (opts?.toDate) filters.push(["posting_date", "<=", opts.toDate]);
	const rows = await getList<Record<string, unknown>>("POS Cash Movement", {
		filters,
		fields: ["name", "amount", "remarks", "posting_date", "expense_account", "docstatus"],
		order_by: "creation desc",
	});
	return rows.map((r) => ({
		id: r.name,
		to_account: r.expense_account,
		amount: r.amount,
		remarks: r.remarks,
		posting_date: r.posting_date,
		docstatus: r.docstatus as number,
		can_delete: r.docstatus === 1,
	}));
}

export async function deleteExpense(id: number | string) {
	if (isElectron()) return getDb().deleteExpense(id as number);
	const { call } = await import("./api");
	return call("frappe.client.cancel", { doctype: "POS Cash Movement", name: String(id) });
}

export async function getModesOfPayment() {
	if (isElectron()) return getDb().getModesOfPayment();
	return [];
}

export async function createBankDrop(drop: Record<string, unknown>) {
	if (isElectron()) return getDb().createBankDrop(drop);
	const { call } = await import("./api");
	return call("xpos.api.cash_movements.create_cash_deposit", { payload: JSON.stringify(drop) });
}

export async function getBankDrops(opts?: {
	user?: string;
	fromDate?: string;
	toDate?: string;
	shiftLocalId?: string;
	syncStatus?: string;
}) {
	if (isElectron()) return getDb().getBankDrops(opts);
	const { getList } = await import("./api");
	const filters: unknown[] = [
		["movement_type", "=", "Deposit"],
		["docstatus", "=", 1],
	];
	if (opts?.user) filters.push(["user", "=", opts.user]);
	if (opts?.fromDate) filters.push(["posting_date", ">=", opts.fromDate]);
	if (opts?.toDate) filters.push(["posting_date", "<=", opts.toDate]);
	const rows = await getList<Record<string, unknown>>("POS Cash Movement", {
		filters,
		fields: ["name", "amount", "remarks", "posting_date", "target_account", "docstatus"],
		order_by: "creation desc",
	});
	return rows.map((r) => ({
		id: r.name,
		to_account: r.target_account,
		amount: r.amount,
		remarks: r.remarks,
		posting_date: r.posting_date,
		docstatus: r.docstatus as number,
		can_delete: r.docstatus === 0 || r.docstatus === 1,
	}));
}

export async function deleteBankDrop(id: number | string) {
	if (isElectron()) return getDb().deleteBankDrop(id as number);
	const { call } = await import("./api");
	return call("frappe.client.cancel", { doctype: "POS Cash Movement", name: String(id) });
}

export async function createStockAdjustment(adj: Record<string, unknown>) {
	if (isElectron()) return getDb().createStockAdjustment(adj);
	throw new Error("Stock Adjustments require Electron mode");
}

export async function getStockAdjustments(opts?: {
	warehouse?: string;
	syncStatus?: string;
	fromDate?: string;
	toDate?: string;
}) {
	if (isElectron()) return getDb().getStockAdjustments(opts);
	return [];
}

export async function saveQuotation(quotation: Record<string, unknown>) {
	if (isElectron()) return getDb().saveQuotation(quotation);
	throw new Error("Quotations require Electron mode");
}

export async function getQuotations(opts?: {
	customer?: string;
	fromDate?: string;
	toDate?: string;
	status?: string;
	limit?: number;
}) {
	if (isElectron()) return getDb().getQuotations(opts);
	return [];
}

export async function getBrands() {
	if (isElectron()) return getDb().getBrands();
	return [];
}

export async function getUom() {
	if (isElectron()) return getDb().getUom();
	return [];
}

export async function getUomConversions(itemCode: string) {
	if (isElectron()) return getDb().getUomConversions(itemCode);
	return [];
}

export async function upsertTable(table: string, rows: Record<string, unknown>[], keyField: string) {
	if (isElectron()) return getDb().upsertTable(table, rows, keyField);
	return 0;
}

export async function clearTable(table: string) {
	if (isElectron()) return getDb().clearTable(table);
	return true;
}

import type { POSItem, ItemGroup, Customer } from "@/types/pos.types";

export async function cacheItems(allItems: POSItem[]): Promise<void> {
	if (isElectron()) {
		await getDb().clearItems();
		if (allItems.length) await getDb().upsertItems(allItems as unknown as Record<string, unknown>[]);
		return;
	}
	const idb = await import("./idbService");
	await idb.cacheItems(allItems);
}

export async function getCachedItems(): Promise<POSItem[]> {
	if (isElectron()) {
		return (await getDb().getItems()) as unknown as POSItem[];
	}
	const idb = await import("./idbService");
	return idb.getCachedItems();
}

export async function getCachedItemByCode(itemCode: string): Promise<POSItem | undefined> {
	if (isElectron()) {
		const row = await getDb().getItem(itemCode);
		return (row ?? undefined) as POSItem | undefined;
	}
	const idb = await import("./idbService");
	return idb.getCachedItemByCode(itemCode);
}

export async function searchCachedItems(
	term: string,
	group: string,
	searchFields?: string[],
): Promise<POSItem[]> {
	if (isElectron()) {
		return (await getDb().getItems({
			search: term || undefined,
			searchFields,
			group: group && group !== "All Item Groups" ? group : undefined,
		})) as unknown as POSItem[];
	}
	const idb = await import("./idbService");
	return idb.searchCachedItems(term, group, searchFields);
}

export async function cacheItemGroups(groups: ItemGroup[], parentGroups: ItemGroup[]): Promise<void> {
	if (isElectron()) {
		await getDb().setMeta("item_groups", JSON.stringify(groups));
		await getDb().setMeta("item_parent_groups", JSON.stringify(parentGroups));
		return;
	}
	const idb = await import("./idbService");
	await idb.cacheItemGroups(groups, parentGroups);
}

export async function getCachedItemGroups(): Promise<{ groups: ItemGroup[]; parentGroups: ItemGroup[] }> {
	if (isElectron()) {
		const g = await getDb().getMeta("item_groups");
		const pg = await getDb().getMeta("item_parent_groups");
		return {
			groups: g ? JSON.parse(g) : [],
			parentGroups: pg ? JSON.parse(pg) : [],
		};
	}
	const idb = await import("./idbService");
	return idb.getCachedItemGroups();
}

export async function cacheStockForWarehouse(
	warehouse: string,
	stockEntries: { item_code: string; actual_qty: number }[],
): Promise<void> {
	if (isElectron()) {
		await getDb().upsertStock(warehouse, stockEntries);
		return;
	}
	const idb = await import("./idbService");
	await idb.cacheStockForWarehouse(warehouse, stockEntries);
}

export async function getCachedStock(warehouse: string) {
	if (isElectron()) {
		const rows = await getDb().getStock(warehouse);
		return Array.isArray(rows)
			? (rows as Array<{
					cache_key?: string;
					warehouse: string;
					item_code: string;
					actual_qty: number;
					updated_at?: string;
				}>)
			: [];
	}
	const idb = await import("./idbService");
	return idb.getCachedStock(warehouse);
}

export async function getCachedStockForItem(warehouse: string, itemCode: string) {
	if (isElectron()) {
		const row = await getDb().getStock(warehouse, itemCode);
		if (!row || Array.isArray(row)) return undefined;
		return row as {
			cache_key?: string;
			warehouse: string;
			item_code: string;
			actual_qty: number;
			updated_at?: string;
		};
	}
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
	if (isElectron()) {
		await getDb().upsertCustomers(customers as unknown as Record<string, unknown>[]);
		return;
	}
	const idb = await import("./idbService");
	await idb.cacheCustomers(customers);
}

export async function getCachedCustomers(): Promise<Customer[]> {
	if (isElectron()) {
		return (await getDb().getCustomers()) as unknown as Customer[];
	}
	const idb = await import("./idbService");
	return idb.getCachedCustomers();
}

export async function searchCachedCustomers(term: string): Promise<Customer[]> {
	if (isElectron()) {
		return (await getDb().getCustomers({ search: term, limit: 20 })) as unknown as Customer[];
	}
	const idb = await import("./idbService");
	return idb.searchCachedCustomers(term);
}

export async function addCachedCustomer(customer: Customer): Promise<void> {
	if (isElectron()) {
		await getDb().upsertCustomers([customer as unknown as Record<string, unknown>]);
		return;
	}
	const idb = await import("./idbService");
	await idb.addCachedCustomer(customer);
}

export async function cacheSuppliers(
	suppliers: Array<Record<string, unknown> & { name: string }>,
): Promise<void> {
	if (isElectron()) {
		await getDb().upsertSuppliers(suppliers);
		return;
	}
	const idb = await import("./idbService");
	await idb.cacheSuppliers(suppliers as any);
}

export async function searchCachedSuppliers(term: string) {
	if (isElectron()) {
		const rows = await getDb().getSuppliers({ search: term, limit: 20 });
		return rows as Array<{
			name: string;
			supplier_name: string;
			supplier_group?: string;
			supplier_type?: string;
			default_currency?: string;
			mobile_no?: string;
			email_id?: string;
		}>;
	}
	const idb = await import("./idbService");
	return idb.searchCachedSuppliers(term);
}

export async function addCachedSupplier(supplier: Record<string, unknown>): Promise<void> {
	if (isElectron()) {
		await getDb().upsertSuppliers([supplier]);
		return;
	}
	const idb = await import("./idbService");
	await idb.addCachedSupplier(supplier as any);
}

export async function cachePOSData(data: unknown): Promise<void> {
	if (isElectron()) {
		await getDb().setMeta("pos_complete_data", JSON.stringify(data));
		return;
	}
	const idb = await import("./idbService");
	await idb.cachePOSData(data as any);
}

export async function getCachedPOSData(): Promise<unknown | null> {
	if (isElectron()) {
		const val = await getDb().getMeta("pos_complete_data");
		return val ? JSON.parse(val) : null;
	}
	const idb = await import("./idbService");
	return idb.getCachedPOSData();
}

export async function cacheOffers(posProfile: string, offers: unknown[]): Promise<void> {
	if (isElectron()) {
		await getDb().setMeta(`offers::${posProfile}`, JSON.stringify(offers));
		return;
	}
	const idb = await import("./idbService");
	await idb.cacheOffers(posProfile, offers);
}

export async function getCachedOffers(posProfile: string): Promise<unknown[] | null> {
	if (isElectron()) {
		const val = await getDb().getMeta(`offers::${posProfile}`);
		return val ? JSON.parse(val) : null;
	}
	const idb = await import("./idbService");
	return idb.getCachedOffers(posProfile);
}

export async function cachePricingRules(posProfile: string, rules: unknown[]): Promise<void> {
	if (isElectron()) {
		await getDb().setMeta(`pricing_rules::${posProfile}`, JSON.stringify(rules));
		return;
	}
	const idb = await import("./idbService");
	await idb.cachePricingRules(posProfile, rules);
}

export async function getCachedPricingRules(posProfile: string): Promise<unknown[] | null> {
	if (isElectron()) {
		const val = await getDb().getMeta(`pricing_rules::${posProfile}`);
		return val ? JSON.parse(val) : null;
	}
	const idb = await import("./idbService");
	return idb.getCachedPricingRules(posProfile);
}

export async function cacheReceiptContext(
	posProfile: string,
	context: import("@/types/pos.types").ReceiptContext,
): Promise<void> {
	if (isElectron()) {
		await getDb().setMeta(`receipt_context::${posProfile}`, JSON.stringify(context));
		return;
	}
	const idb = await import("./idbService");
	await idb.cacheReceiptContext(posProfile, context);
}

export async function getCachedReceiptContext(
	posProfile: string,
): Promise<import("@/types/pos.types").ReceiptContext | null> {
	if (isElectron()) {
		const val = await getDb().getMeta(`receipt_context::${posProfile}`);
		return val ? JSON.parse(val) : null;
	}
	const idb = await import("./idbService");
	return idb.getCachedReceiptContext(posProfile);
}

export async function cacheItemTax(
	itemCode: string,
	company: string,
	data: { item_tax_template: string | null; item_tax_map: Record<string, number> },
): Promise<void> {
	if (isElectron()) {
		await getDb().setMeta(`item_tax::${company}::${itemCode}`, JSON.stringify(data));
		return;
	}
	const idb = await import("./idbService");
	await idb.cacheItemTax(itemCode, company, data);
}

export async function getCachedItemTax(
	itemCode: string,
	company: string,
): Promise<{ item_tax_template: string | null; item_tax_map: Record<string, number> } | null> {
	if (isElectron()) {
		const val = await getDb().getMeta(`item_tax::${company}::${itemCode}`);
		return val ? JSON.parse(val) : null;
	}
	const idb = await import("./idbService");
	return idb.getCachedItemTax(itemCode, company);
}

export async function cacheCustomerGroups(groups: string[]): Promise<void> {
	if (isElectron()) {
		await getDb().setMeta("customer_groups", JSON.stringify(groups));
		return;
	}
	const idb = await import("./idbService");
	await idb.cacheCustomerGroups(groups);
}

export async function getCachedCustomerGroups(): Promise<string[]> {
	if (isElectron()) {
		const val = await getDb().getMeta("customer_groups");
		return val ? JSON.parse(val) : [];
	}
	const idb = await import("./idbService");
	return idb.getCachedCustomerGroups();
}

export async function cacheTerritories(territories: string[]): Promise<void> {
	if (isElectron()) {
		await getDb().setMeta("territories", JSON.stringify(territories));
		return;
	}
	const idb = await import("./idbService");
	await idb.cacheTerritories(territories);
}

export async function getCachedTerritories(): Promise<string[]> {
	if (isElectron()) {
		const val = await getDb().getMeta("territories");
		return val ? JSON.parse(val) : [];
	}
	const idb = await import("./idbService");
	return idb.getCachedTerritories();
}

export async function cacheCountries(countries: string[]): Promise<void> {
	if (isElectron()) {
		await getDb().setMeta("countries", JSON.stringify(countries));
		return;
	}
	const idb = await import("./idbService");
	await idb.cacheCountries(countries);
}

export async function getCachedCountries(): Promise<string[]> {
	if (isElectron()) {
		const val = await getDb().getMeta("countries");
		return val ? JSON.parse(val) : [];
	}
	const idb = await import("./idbService");
	return idb.getCachedCountries();
}

export async function cacheCurrencies(currencies: string[]): Promise<void> {
	if (isElectron()) {
		await getDb().setMeta("currencies", JSON.stringify(currencies));
		return;
	}
	const idb = await import("./idbService");
	await idb.cacheCurrencies(currencies);
}

export async function getCachedCurrencies(): Promise<string[]> {
	if (isElectron()) {
		const val = await getDb().getMeta("currencies");
		return val ? JSON.parse(val) : [];
	}
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
	if (isElectron()) {
		await getDb().setMeta("currency_meta", JSON.stringify(currencies));
		return;
	}
	const idb = await import("./idbService");
	await idb.setMeta("currency_meta", currencies);
}

export async function getCachedCurrencyMeta(): Promise<CachedCurrencyMeta[]> {
	if (isElectron()) {
		const rows = (await getDb().getCurrencies()) as unknown as CachedCurrencyMeta[] | undefined;
		if (rows?.length) return rows;
		const val = await getDb().getMeta("currency_meta");
		return val ? JSON.parse(val) : [];
	}
	const idb = await import("./idbService");
	return ((await idb.getMeta("currency_meta")) as CachedCurrencyMeta[]) || [];
}

export async function cacheLanguages(languages: string[]): Promise<void> {
	if (isElectron()) {
		await getDb().setMeta("languages", JSON.stringify(languages));
		return;
	}
	const idb = await import("./idbService");
	await idb.cacheLanguages(languages);
}

export async function getCachedLanguages(): Promise<string[]> {
	if (isElectron()) {
		const val = await getDb().getMeta("languages");
		return val ? JSON.parse(val) : [];
	}
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
	if (isElectron()) {
		return getDb().getDeadLetters();
	}
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
	if (isElectron()) {
		return getDb().countDeadLetters();
	}
	const { invoices, purchases } = await getDeadLetters();
	return invoices.length + purchases.length;
}

export async function retryDeadLetter(table: string, id: number): Promise<boolean> {
	if (isElectron()) {
		return getDb().retryDeadLetter(table, id);
	}
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
	if (isElectron()) {
		return getDb().countPendingPurchases();
	}
	const idb = await import("./idbService");
	const records = await idb.getAllPendingPurchases();
	return records.filter((record) => record.status === "pending" || record.status === "failed").length;
}

export async function cacheERPSettings(settings: unknown): Promise<void> {
	if (isElectron()) {
		await getDb().setMeta("erp_settings", JSON.stringify(settings));
		return;
	}
	const idb = await import("./idbService");
	await idb.cacheERPSettings(settings);
}

export async function getCachedERPSettings(): Promise<unknown | null> {
	if (isElectron()) {
		const val = await getDb().getMeta("erp_settings");
		return val ? JSON.parse(val) : null;
	}
	const idb = await import("./idbService");
	return idb.getCachedERPSettings();
}
