/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isProxy, reactive, ref } from "vue";

// ── Mock electronBridge ──────────────────────────────────────
// In Electron mode, isElectron() returns true and functions go through IPC.
// In browser mode, isElectron() returns false and functions fall back to idbService.

let electronMode = false;

vi.mock("@/services/electronBridge", () => ({
	isElectron: () => electronMode,
}));

// ── Mock idbService (browser fallback) ───────────────────────
const mockDb = {
	items: {
		orderBy: vi.fn(() => ({ toArray: vi.fn().mockResolvedValue([]) })),
		where: vi.fn(() => ({ equals: vi.fn(() => ({ toArray: vi.fn().mockResolvedValue([]) })) })),
		get: vi.fn().mockResolvedValue(undefined),
		bulkPut: vi.fn().mockResolvedValue(undefined),
		count: vi.fn().mockResolvedValue(0),
		clear: vi.fn().mockResolvedValue(undefined),
	},
	itemGroups: {
		toArray: vi.fn().mockResolvedValue([]),
		bulkPut: vi.fn().mockResolvedValue(undefined),
	},
	customers: {
		toArray: vi.fn().mockResolvedValue([]),
		get: vi.fn().mockResolvedValue(undefined),
		bulkPut: vi.fn().mockResolvedValue(undefined),
		add: vi.fn().mockResolvedValue(1),
	},
	suppliers: {
		toArray: vi.fn().mockResolvedValue([]),
		bulkPut: vi.fn().mockResolvedValue(undefined),
	},
	table: vi.fn().mockReturnValue({
		get: vi.fn().mockResolvedValue(undefined),
		put: vi.fn().mockResolvedValue(undefined),
		bulkPut: vi.fn().mockResolvedValue(undefined),
		where: vi.fn(() => ({
			equals: vi.fn(() => ({ toArray: vi.fn().mockResolvedValue([]) })),
			anyOf: vi.fn(() => ({ count: vi.fn().mockResolvedValue(0) })),
		})),
		toCollection: vi.fn(() => ({ toArray: vi.fn().mockResolvedValue([]) })),
		add: vi.fn().mockResolvedValue(1),
		update: vi.fn().mockResolvedValue(1),
		delete: vi.fn().mockResolvedValue(undefined),
		clear: vi.fn().mockResolvedValue(undefined),
	}),
	tables: [],
};

vi.mock("@/services/idbService", () => ({
	db: mockDb,
	cacheItems: vi.fn(),
	getCachedItems: vi.fn().mockResolvedValue([]),
	getCachedItemByCode: vi.fn().mockResolvedValue(undefined),
	searchCachedItems: vi.fn().mockResolvedValue([]),
	cacheItemGroups: vi.fn(),
	getCachedItemGroups: vi.fn().mockResolvedValue({ groups: [], parentGroups: [] }),
	cacheStockForWarehouse: vi.fn(),
	getCachedStock: vi.fn().mockResolvedValue([]),
	getCachedStockForItem: vi.fn().mockResolvedValue(undefined),
	cacheCustomers: vi.fn(),
	getCachedCustomers: vi.fn().mockResolvedValue([]),
	searchCachedCustomers: vi.fn().mockResolvedValue([]),
	addCachedCustomer: vi.fn(),
	cacheSuppliers: vi.fn(),
	searchCachedSuppliers: vi.fn().mockResolvedValue([]),
	addCachedSupplier: vi.fn(),
	cachePOSData: vi.fn(),
	getCachedPOSData: vi.fn().mockResolvedValue(null),
	cacheOffers: vi.fn(),
	getCachedOffers: vi.fn().mockResolvedValue(null),
	cacheItemTax: vi.fn(),
	getCachedItemTax: vi.fn().mockResolvedValue(null),
	cacheCustomerGroups: vi.fn(),
	getCachedCustomerGroups: vi.fn().mockResolvedValue([]),
	cacheTerritories: vi.fn(),
	getCachedTerritories: vi.fn().mockResolvedValue([]),
	cacheCountries: vi.fn(),
	getCachedCountries: vi.fn().mockResolvedValue([]),
	addSyncIdMapping: vi.fn(),
	getServerName: vi.fn().mockResolvedValue(null),
}));

// ── Mock window.electronAPI for Electron mode ────────────────
const mockElectronDb = {
	getItems: vi.fn().mockResolvedValue([]),
	getItem: vi.fn().mockResolvedValue(null),
	upsertItems: vi.fn().mockResolvedValue(0),
	countItems: vi.fn().mockResolvedValue(0),
	clearItems: vi.fn().mockResolvedValue(true),
	getItemGroups: vi.fn().mockResolvedValue([]),
	upsertItemGroups: vi.fn().mockResolvedValue(0),
	getCustomers: vi.fn().mockResolvedValue([]),
	getCustomer: vi.fn().mockResolvedValue(null),
	upsertCustomers: vi.fn().mockResolvedValue(0),
	addLocalCustomer: vi.fn().mockResolvedValue({ name: "local_1", local_id: "local_1" }),
	getSuppliers: vi.fn().mockResolvedValue([]),
	upsertSuppliers: vi.fn().mockResolvedValue(0),
	getStock: vi.fn().mockResolvedValue([]),
	upsertStock: vi.fn().mockResolvedValue(0),
	updateStockQty: vi.fn().mockResolvedValue(true),
	addPendingInvoice: vi.fn().mockResolvedValue({ id: 1, local_id: "inv_123" }),
	getPendingInvoices: vi.fn().mockResolvedValue([]),
	updatePendingInvoice: vi.fn().mockResolvedValue(true),
	deletePendingInvoice: vi.fn().mockResolvedValue(true),
	countPendingInvoices: vi.fn().mockResolvedValue(0),
	addPendingPurchase: vi.fn().mockResolvedValue({ id: 2, local_id: "pur_456" }),
	getPendingPurchases: vi.fn().mockResolvedValue([]),
	updatePendingPurchase: vi.fn().mockResolvedValue(true),
	deletePendingPurchase: vi.fn().mockResolvedValue(true),
	countPendingPurchases: vi.fn().mockResolvedValue(5),
	addSyncId: vi.fn().mockResolvedValue(true),
	getServerName: vi.fn().mockResolvedValue("INV-001"),
	getMeta: vi.fn().mockResolvedValue(null),
	setMeta: vi.fn().mockResolvedValue(true),
	getSetting: vi.fn().mockResolvedValue(null),
	setSetting: vi.fn().mockResolvedValue(true),
	getAllSettings: vi.fn().mockResolvedValue([]),
	cachePosData: vi.fn().mockResolvedValue(true),
	getCachedPosData: vi.fn().mockResolvedValue(null),
	clearAllData: vi.fn().mockResolvedValue(true),
	clearPendingData: vi.fn().mockResolvedValue(true),
	getCompanies: vi.fn().mockResolvedValue([]),
	getWarehouses: vi.fn().mockResolvedValue([]),
	getAccounts: vi.fn().mockResolvedValue([]),
	getCostCenters: vi.fn().mockResolvedValue([]),
	getPriceLists: vi.fn().mockResolvedValue([]),
	getModesOfPayment: vi.fn().mockResolvedValue([]),
	getModeOfPaymentAccounts: vi.fn().mockResolvedValue([]),
	getPosProfiles: vi.fn().mockResolvedValue([]),
	getPosProfile: vi.fn().mockResolvedValue(null),
	getPosPaymentMethods: vi.fn().mockResolvedValue([]),
	getPosUsers: vi.fn().mockResolvedValue([]),
	getPosUser: vi.fn().mockResolvedValue(null),
	getItemPrice: vi.fn().mockResolvedValue(null),
	getItemPrices: vi.fn().mockResolvedValue([]),
	getItemByBarcode: vi.fn().mockResolvedValue(null),
	getItemTaxTemplates: vi.fn().mockResolvedValue([]),
	getItemTaxTemplateDetails: vi.fn().mockResolvedValue([]),
	getSalesTaxTemplates: vi.fn().mockResolvedValue([]),
	getSalesTaxCharges: vi.fn().mockResolvedValue([]),
	getPricingRules: vi.fn().mockResolvedValue([]),
	getPricingRuleItems: vi.fn().mockResolvedValue([]),
	getPricingRuleGroups: vi.fn().mockResolvedValue([]),
	getPricingRuleBrands: vi.fn().mockResolvedValue([]),
	getBin: vi.fn().mockResolvedValue(null),
	getBins: vi.fn().mockResolvedValue([]),
	upsertTable: vi.fn().mockResolvedValue(0),
	clearTable: vi.fn().mockResolvedValue(true),
	createPosOpeningShift: vi.fn().mockResolvedValue({ id: 1, local_id: "shift_1" }),
	getOpenShift: vi.fn().mockResolvedValue(null),
	closePosShift: vi.fn().mockResolvedValue(true),
	getPosOpeningShifts: vi.fn().mockResolvedValue([]),
	createPosClosingEntry: vi.fn().mockResolvedValue({ id: 1 }),
	getPosClosingEntries: vi.fn().mockResolvedValue([]),
	getPosClosingEntryDetails: vi.fn().mockResolvedValue([]),
	saveSalesInvoice: vi.fn().mockResolvedValue({ id: 1 }),
	getSalesInvoices: vi.fn().mockResolvedValue([]),
	getSalesInvoice: vi.fn().mockResolvedValue(null),
	getShiftSalesSummary: vi.fn().mockResolvedValue({ total: 0, count: 0, qty: 0, payment_breakdown: [] }),
	createExpense: vi.fn().mockResolvedValue({ id: 1 }),
	getExpenses: vi.fn().mockResolvedValue([]),
	deleteExpense: vi.fn().mockResolvedValue(true),
	createBankDrop: vi.fn().mockResolvedValue({ id: 1 }),
	getBankDrops: vi.fn().mockResolvedValue([]),
	deleteBankDrop: vi.fn().mockResolvedValue(true),
	createStockAdjustment: vi.fn().mockResolvedValue({ id: 1 }),
	getStockAdjustments: vi.fn().mockResolvedValue([]),
	saveQuotation: vi.fn().mockResolvedValue({ id: 1 }),
	getQuotations: vi.fn().mockResolvedValue([]),
	getBrands: vi.fn().mockResolvedValue([]),
	getUom: vi.fn().mockResolvedValue([]),
	getUomConversions: vi.fn().mockResolvedValue([]),
};

// ── Import after mocks ──────────────────────────────────────
import * as bridge from "@/services/dbBridge";

describe("dbBridge", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// ══════════════════════════════════════════════════════════════
	// Electron Mode Tests
	// ══════════════════════════════════════════════════════════════

	describe("Electron mode (IPC)", () => {
		beforeEach(() => {
			electronMode = true;
			(window as any).electronAPI = { db: mockElectronDb };
		});

		afterEach(() => {
			delete (window as any).electronAPI;
		});

		// ── Items ──────────────────────────────────────────────

		it("getItems delegates to electronAPI.db.getItems", async () => {
			const mockItems = [{ item_code: "ITEM-1", item_name: "Widget" }];
			mockElectronDb.getItems.mockResolvedValueOnce(mockItems);

			const result = await bridge.getItems({ search: "widget", limit: 10 });

			expect(mockElectronDb.getItems).toHaveBeenCalledWith({ search: "widget", limit: 10 });
			expect(result).toEqual(mockItems);
		});

		it("getItem delegates to electronAPI.db.getItem", async () => {
			mockElectronDb.getItem.mockResolvedValueOnce({ item_code: "ITEM-1" });

			const result = await bridge.getItem("ITEM-1");

			expect(mockElectronDb.getItem).toHaveBeenCalledWith("ITEM-1");
			expect(result).toEqual({ item_code: "ITEM-1" });
		});

		it("upsertItems delegates to electronAPI.db.upsertItems", async () => {
			const rows = [{ item_code: "A" }, { item_code: "B" }];
			await bridge.upsertItems(rows);
			expect(mockElectronDb.upsertItems).toHaveBeenCalledWith(rows);
		});

		it("countItems returns item count", async () => {
			mockElectronDb.countItems.mockResolvedValueOnce(42);
			expect(await bridge.countItems()).toBe(42);
		});

		it("clearItems clears the items table", async () => {
			await bridge.clearItems();
			expect(mockElectronDb.clearItems).toHaveBeenCalled();
		});

		// ── Customers ───────────────────────────────────────────

		it("getCustomers passes search and limit", async () => {
			const customers = [{ name: "C-001", customer_name: "Ali" }];
			mockElectronDb.getCustomers.mockResolvedValueOnce(customers);

			const result = await bridge.getCustomers({ search: "Ali", limit: 5 });

			expect(mockElectronDb.getCustomers).toHaveBeenCalledWith({ search: "Ali", limit: 5 });
			expect(result).toEqual(customers);
		});

		it("addLocalCustomer delegates correctly", async () => {
			const cust = { customer_name: "New Cust", phone: "123" };
			mockElectronDb.addLocalCustomer.mockResolvedValueOnce({
				name: "local_abc",
				local_id: "local_abc",
			});

			const result = await bridge.addLocalCustomer(cust);

			expect(mockElectronDb.addLocalCustomer).toHaveBeenCalledWith(cust);
			expect(result).toEqual({ name: "local_abc", local_id: "local_abc" });
		});

		// ── Stock ──────────────────────────────────────────────

		it("getStock by warehouse", async () => {
			const entries = [{ item_code: "A", actual_qty: 10 }];
			mockElectronDb.getStock.mockResolvedValueOnce(entries);

			const result = await bridge.getStock("Store-01");

			expect(mockElectronDb.getStock).toHaveBeenCalledWith("Store-01", undefined);
			expect(result).toEqual(entries);
		});

		it("getStock by warehouse and item", async () => {
			const entry = { item_code: "A", actual_qty: 10 };
			mockElectronDb.getStock.mockResolvedValueOnce(entry);

			const result = await bridge.getStock("Store-01", "A");

			expect(mockElectronDb.getStock).toHaveBeenCalledWith("Store-01", "A");
			expect(result).toEqual(entry);
		});

		it("upsertStock delegates correctly", async () => {
			const entries = [{ item_code: "A", actual_qty: 5 }];
			await bridge.upsertStock("WH-1", entries);
			expect(mockElectronDb.upsertStock).toHaveBeenCalledWith("WH-1", entries);
		});

		// ── Pending Invoices ────────────────────────────────────

		it("addPendingInvoice returns id and local_id", async () => {
			mockElectronDb.addPendingInvoice.mockResolvedValueOnce({ id: 7, local_id: "inv_xyz" });

			const result = await bridge.addPendingInvoice({
				data: { items: [] },
				customer_name: "Test",
				grand_total: 100,
			});

			expect(result).toEqual({ id: 7, local_id: "inv_xyz" });
		});

		it("addPendingInvoice sends plain data over IPC, which cannot clone reactive arrays", async () => {
			const payments = reactive([{ mode_of_payment: "Cash", amount: 20 }]);

			await bridge.addPendingInvoice({ data: { payments }, grand_total: 20 });

			const sent = mockElectronDb.addPendingInvoice.mock.calls.at(-1)![0];
			expect(() => structuredClone(sent)).not.toThrow();
			expect(sent.data.payments).toEqual([{ mode_of_payment: "Cash", amount: 20 }]);
		});

		it("getPendingInvoices filters by status", async () => {
			const invoices = [{ id: 1, status: "pending", data: "{}" }];
			mockElectronDb.getPendingInvoices.mockResolvedValueOnce(invoices);

			const result = await bridge.getPendingInvoices("pending");

			expect(mockElectronDb.getPendingInvoices).toHaveBeenCalledWith("pending");
			expect(result).toEqual(invoices);
		});

		it("updatePendingInvoice sends id and updates", async () => {
			await bridge.updatePendingInvoice(5, { status: "synced" });
			expect(mockElectronDb.updatePendingInvoice).toHaveBeenCalledWith(5, { status: "synced" });
		});

		it("deletePendingInvoice by id", async () => {
			await bridge.deletePendingInvoice(3);
			expect(mockElectronDb.deletePendingInvoice).toHaveBeenCalledWith(3);
		});

		// ── Pending Purchases ───────────────────────────────────

		it("addPendingPurchase returns id and local_id", async () => {
			mockElectronDb.addPendingPurchase.mockResolvedValueOnce({ id: 2, local_id: "pur_abc" });

			const result = await bridge.addPendingPurchase({
				type: "purchase_order",
				data: { items: [] },
				supplier_name: "Supplier A",
				grand_total: 500,
			});

			expect(result).toEqual({ id: 2, local_id: "pur_abc" });
		});

		it("countPendingPurchases returns count", async () => {
			mockElectronDb.countPendingPurchases.mockResolvedValueOnce(3);
			expect(await bridge.countPendingPurchases()).toBe(3);
		});

		// ── Sync ID Map ────────────────────────────────────────

		it("addSyncId stores local-to-server mapping", async () => {
			await bridge.addSyncId("inv_123", "INV-00001", "Sales Invoice");
			expect(mockElectronDb.addSyncId).toHaveBeenCalledWith("inv_123", "INV-00001", "Sales Invoice");
		});

		it("getServerName returns mapped name", async () => {
			mockElectronDb.getServerName.mockResolvedValueOnce("INV-00001");
			expect(await bridge.getServerName("inv_123")).toBe("INV-00001");
		});

		// ── Sync Metadata ──────────────────────────────────────

		it("getSyncMeta returns stored value", async () => {
			mockElectronDb.getMeta.mockResolvedValueOnce("2024-01-01T00:00:00Z");
			expect(await bridge.getSyncMeta("last_sync")).toBe("2024-01-01T00:00:00Z");
		});

		it("setSyncMeta stores value", async () => {
			await bridge.setSyncMeta("last_sync", "2024-06-01T00:00:00Z");
			expect(mockElectronDb.setMeta).toHaveBeenCalledWith("last_sync", "2024-06-01T00:00:00Z");
		});

		// ── Settings ───────────────────────────────────────────

		it("getSetting delegates to IPC", async () => {
			mockElectronDb.getSetting.mockResolvedValueOnce("dark");
			expect(await bridge.getSetting("theme")).toBe("dark");
		});

		it("setSetting delegates to IPC", async () => {
			await bridge.setSetting("theme", "dark", "ui");
			expect(mockElectronDb.setSetting).toHaveBeenCalledWith("theme", "dark", "ui");
		});

		// ── idbService-compatible wrappers ─────────────────────

		it("cacheItems clears and upserts through IPC", async () => {
			const items = [{ item_code: "A", item_name: "Widget" }];
			await bridge.cacheItems(items as any);
			expect(mockElectronDb.clearItems).toHaveBeenCalled();
			expect(mockElectronDb.upsertItems).toHaveBeenCalled();
		});

		it("cacheItems with empty array only clears", async () => {
			await bridge.cacheItems([]);
			expect(mockElectronDb.clearItems).toHaveBeenCalled();
			expect(mockElectronDb.upsertItems).not.toHaveBeenCalled();
		});

		it("getCachedItemByCode returns item or undefined", async () => {
			mockElectronDb.getItem.mockResolvedValueOnce({ item_code: "A", item_name: "Widget" });
			const result = await bridge.getCachedItemByCode("A");
			expect(result).toEqual({ item_code: "A", item_name: "Widget" });

			mockElectronDb.getItem.mockResolvedValueOnce(null);
			const result2 = await bridge.getCachedItemByCode("MISSING");
			expect(result2).toBeUndefined();
		});

		it("searchCachedItems passes search and group", async () => {
			mockElectronDb.getItems.mockResolvedValueOnce([]);
			await bridge.searchCachedItems("widget", "Electronics");
			expect(mockElectronDb.getItems).toHaveBeenCalledWith({
				search: "widget",
				group: "Electronics",
			});
		});

		it("searchCachedItems ignores 'All Item Groups'", async () => {
			mockElectronDb.getItems.mockResolvedValueOnce([]);
			await bridge.searchCachedItems("widget", "All Item Groups");
			expect(mockElectronDb.getItems).toHaveBeenCalledWith({
				search: "widget",
				group: undefined,
			});
		});

		it("cacheItemGroups stores groups as JSON metadata", async () => {
			const groups = [{ name: "G1" }];
			const parents = [{ name: "P1" }];
			await bridge.cacheItemGroups(groups as any, parents as any);
			expect(mockElectronDb.setMeta).toHaveBeenCalledWith("item_groups", JSON.stringify(groups));
			expect(mockElectronDb.setMeta).toHaveBeenCalledWith(
				"item_parent_groups",
				JSON.stringify(parents),
			);
		});

		it("getCachedItemGroups parses JSON metadata", async () => {
			mockElectronDb.getMeta.mockResolvedValueOnce('[{"name":"G1"}]');
			mockElectronDb.getMeta.mockResolvedValueOnce('[{"name":"P1"}]');
			const result = await bridge.getCachedItemGroups();
			expect(result).toEqual({
				groups: [{ name: "G1" }],
				parentGroups: [{ name: "P1" }],
			});
		});

		it("getCachedItemGroups returns empty arrays when no data", async () => {
			mockElectronDb.getMeta.mockResolvedValueOnce(null);
			mockElectronDb.getMeta.mockResolvedValueOnce(null);
			const result = await bridge.getCachedItemGroups();
			expect(result).toEqual({ groups: [], parentGroups: [] });
		});

		it("getCachedStockForItem returns stock entry or undefined", async () => {
			const entry = { warehouse: "WH", item_code: "A", actual_qty: 10 };
			mockElectronDb.getStock.mockResolvedValueOnce(entry);
			const result = await bridge.getCachedStockForItem("WH", "A");
			expect(result).toEqual(entry);
		});

		it("getCachedStockForItem returns undefined for array result", async () => {
			mockElectronDb.getStock.mockResolvedValueOnce([]);
			const result = await bridge.getCachedStockForItem("WH", "MISSING");
			expect(result).toBeUndefined();
		});

		it("cachePOSData stores as JSON", async () => {
			const data = { profile: "P1", items: [] };
			await bridge.cachePOSData(data);
			expect(mockElectronDb.setMeta).toHaveBeenCalledWith("pos_complete_data", JSON.stringify(data));
		});

		it("getCachedPOSData parses JSON", async () => {
			mockElectronDb.getMeta.mockResolvedValueOnce('{"profile":"P1"}');
			const result = await bridge.getCachedPOSData();
			expect(result).toEqual({ profile: "P1" });
		});

		it("getCachedPOSData returns null when empty", async () => {
			mockElectronDb.getMeta.mockResolvedValueOnce(null);
			const result = await bridge.getCachedPOSData();
			expect(result).toBeNull();
		});

		it("cacheItemTax stores with composite key", async () => {
			const taxData = { item_tax_template: "T1", item_tax_map: { VAT: 5 } };
			await bridge.cacheItemTax("ITEM-1", "Company", taxData);
			expect(mockElectronDb.setMeta).toHaveBeenCalledWith(
				"item_tax::Company::ITEM-1",
				JSON.stringify(taxData),
			);
		});

		it("getCachedItemTax retrieves with composite key", async () => {
			const taxData = { item_tax_template: "T1", item_tax_map: { VAT: 5 } };
			mockElectronDb.getMeta.mockResolvedValueOnce(JSON.stringify(taxData));
			const result = await bridge.getCachedItemTax("ITEM-1", "Company");
			expect(result).toEqual(taxData);
		});

		it("cacheCustomerGroups stores as JSON", async () => {
			await bridge.cacheCustomerGroups(["Retail", "Wholesale"]);
			expect(mockElectronDb.setMeta).toHaveBeenCalledWith("customer_groups", '["Retail","Wholesale"]');
		});

		it("getCachedCustomerGroups returns parsed array", async () => {
			mockElectronDb.getMeta.mockResolvedValueOnce('["Retail","Wholesale"]');
			const result = await bridge.getCachedCustomerGroups();
			expect(result).toEqual(["Retail", "Wholesale"]);
		});

		it("getAllPendingInvoices delegates to getPendingInvoices", async () => {
			const invoices = [{ id: 1 }];
			mockElectronDb.getPendingInvoices.mockResolvedValueOnce(invoices);
			const result = await bridge.getAllPendingInvoices();
			expect(result).toEqual(invoices);
		});

		it("getAllPendingPurchases delegates to getPendingPurchases", async () => {
			const purchases = [{ id: 2 }];
			mockElectronDb.getPendingPurchases.mockResolvedValueOnce(purchases);
			const result = await bridge.getAllPendingPurchases();
			expect(result).toEqual(purchases);
		});

		// ── Electron-only endpoints ────────────────────────────

		it("getCompanies returns data in Electron mode", async () => {
			mockElectronDb.getCompanies.mockResolvedValueOnce([{ name: "Test Co" }]);
			const result = await bridge.getCompanies();
			expect(result).toEqual([{ name: "Test Co" }]);
		});

		it("getWarehouses passes options", async () => {
			await bridge.getWarehouses({ company: "Test Co", isGroup: false });
			expect(mockElectronDb.getWarehouses).toHaveBeenCalledWith({ company: "Test Co", isGroup: false });
		});

		it("clearAllData delegates", async () => {
			await bridge.clearAllData();
			expect(mockElectronDb.clearAllData).toHaveBeenCalled();
		});

		it("clearPendingData delegates", async () => {
			await bridge.clearPendingData();
			expect(mockElectronDb.clearPendingData).toHaveBeenCalled();
		});
	});

	// ══════════════════════════════════════════════════════════════
	// Browser / PWA Mode Tests
	// ══════════════════════════════════════════════════════════════

	describe("Browser mode (IndexedDB fallback)", () => {
		beforeEach(() => {
			electronMode = false;
			delete (window as any).electronAPI;
		});

		it("getItems falls back to idbService in browser mode", async () => {
			const result = await bridge.getItems();
			// In browser mode, it queries Dexie - the mock returns []
			expect(result).toEqual([]);
		});

		it("addPendingInvoice keeps the receipt beside the invoice data, not inside it", async () => {
			const table = mockDb.table("pendingInvoices");
			const receipt = { name: "", grand_total: 10, items: [] } as any;

			const result = await bridge.addPendingInvoice({
				data: { customer: "Walk-in Customer" },
				customer_name: "Walk-in Customer",
				grand_total: 10,
				receipt,
			});

			expect(result).toEqual({ id: 1, local_id: expect.stringMatching(/^inv_/) });
			const stored = table.add.mock.calls.at(-1)![0];
			expect(stored.receipt).toEqual(receipt);
			expect(stored.data).toEqual({ customer: "Walk-in Customer" });
			expect(stored.status).toBe("pending");
		});

		// A cash sale's payments and change legs arrive as live Vue arrays. IndexedDB copies with
		// the structured clone algorithm, which throws DataCloneError on a Proxy -- the sale then
		// failed with "Failed to save invoice offline".
		it("addPendingInvoice stores plain data when the cart passes reactive arrays", async () => {
			const table = mockDb.table("pendingInvoices");
			const payments = reactive([{ mode_of_payment: "Cash", amount: 20 }]);
			const changeLegs = ref([{ mode_of_payment: "Cash", amount: 5 }]);
			expect(() => structuredClone({ payments })).toThrow();

			await bridge.addPendingInvoice({
				data: { customer: "Walk-in", payments, pos_change_legs: changeLegs.value },
				grand_total: 15,
				receipt: { name: "", payments, change_legs: changeLegs.value } as any,
			});

			const stored = table.add.mock.calls.at(-1)![0];
			expect(() => structuredClone(stored)).not.toThrow();
			expect(isProxy(stored.data.payments)).toBe(false);
			expect(stored.data.payments).toEqual([{ mode_of_payment: "Cash", amount: 20 }]);
			expect(stored.data.pos_change_legs).toEqual([{ mode_of_payment: "Cash", amount: 5 }]);
			expect(stored.receipt.change_legs).toEqual([{ mode_of_payment: "Cash", amount: 5 }]);
		});

		it("addPendingPurchase stores plain data when given reactive arrays", async () => {
			const table = mockDb.table("pendingPurchases");
			const items = reactive([{ item_code: "SKU1", qty: 2 }]);

			await bridge.addPendingPurchase({ type: "purchase_invoice", data: { items } } as any);

			const stored = table.add.mock.calls.at(-1)![0];
			expect(() => structuredClone(stored)).not.toThrow();
			expect(stored.data.items).toEqual([{ item_code: "SKU1", qty: 2 }]);
		});

		it("countItems falls back to idbService", async () => {
			const result = await bridge.countItems();
			expect(result).toBe(0);
		});

		it("getSetting uses localStorage in browser mode", async () => {
			localStorage.setItem("xpos_setting_theme", "dark");
			const result = await bridge.getSetting("theme");
			expect(result).toBe("dark");
			localStorage.removeItem("xpos_setting_theme");
		});

		it("setSetting uses localStorage in browser mode", async () => {
			await bridge.setSetting("theme", "light");
			expect(localStorage.getItem("xpos_setting_theme")).toBe("light");
			localStorage.removeItem("xpos_setting_theme");
		});

		it("getCompanies returns empty array in browser mode", async () => {
			expect(await bridge.getCompanies()).toEqual([]);
		});

		it("getWarehouses returns empty array in browser mode", async () => {
			expect(await bridge.getWarehouses()).toEqual([]);
		});

		it("getModesOfPayment returns empty array in browser mode", async () => {
			expect(await bridge.getModesOfPayment()).toEqual([]);
		});

		it("getBrands returns empty array in browser mode", async () => {
			expect(await bridge.getBrands()).toEqual([]);
		});
	});
});
