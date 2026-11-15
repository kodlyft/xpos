/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isProxy, reactive, ref } from "vue";

// ── Mock idbService ───────────────────────
const mockDb = {
	transaction: vi.fn(async (...args: any[]) => args.at(-1)()),
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
		filter: vi.fn(() => ({ first: vi.fn().mockResolvedValue(undefined) })),
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
	ensureDatabaseReady: vi.fn(),
	addSyncIdMapping: vi.fn(),
	getServerName: vi.fn().mockResolvedValue(null),
}));

// ── Import after mocks ──────────────────────────────────────
import * as bridge from "@/services/dbBridge";

describe("dbBridge", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		const pending = mockDb.table("pendingInvoices");
		pending.get.mockImplementation(async () => ({
			local_id: pending.add.mock.calls.at(-1)?.[0].local_id,
		}));
	});

	describe("IndexedDB storage", () => {
		it("getItems reads from idbService", async () => {
			const result = await bridge.getItems();
			// In browser mode, it queries Dexie - the mock returns []
			expect(result).toEqual([]);
		});

		it("keeps the first-attempt identity when handing a sale to the offline queue", async () => {
			const table = mockDb.table("pendingInvoices");
			await bridge.addPendingInvoice({ data: { local_id: "first-attempt", customer: "Buyer" } });
			expect(table.add.mock.calls.at(-1)![0].local_id).toBe("first-attempt");
		});

		it("reuses an already journaled sale and refuses to overwrite an uncertain outcome", async () => {
			const table = mockDb.table("pendingInvoices");
			const data = { local_id: "same-sale", customer: "Buyer" };
			table.filter.mockReturnValueOnce({ first: vi.fn().mockResolvedValue({ id: 8, data }) });
			expect(await bridge.addPendingInvoice({ data })).toEqual({ id: 8, local_id: "same-sale" });
			table.filter.mockReturnValueOnce({ first: vi.fn().mockResolvedValue({ id: 8, data }) });
			await expect(
				bridge.addPendingInvoice({ data: { ...data, customer: "Changed" } }),
			).rejects.toThrow("awaiting confirmation");
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

		it("countItems reads from idbService", async () => {
			const result = await bridge.countItems();
			expect(result).toBe(0);
		});

		it("getSetting uses localStorage", async () => {
			localStorage.setItem("xpos_setting_theme", "dark");
			const result = await bridge.getSetting("theme");
			expect(result).toBe("dark");
			localStorage.removeItem("xpos_setting_theme");
		});

		it("setSetting uses localStorage", async () => {
			await bridge.setSetting("theme", "light");
			expect(localStorage.getItem("xpos_setting_theme")).toBe("light");
			localStorage.removeItem("xpos_setting_theme");
		});
	});
});
