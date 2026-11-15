/**
 * @vitest-environment jsdom
 *
 * Offline barcode scans: every barcode of an item reaches the local index with its UOM, factor and
 * rate; a changed or removed barcode follows the delta; a refused or ambiguous scan says why.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Dexie from "dexie";
import { IDBFactory } from "fake-indexeddb";
import { createPinia, setActivePinia } from "pinia";

const online = vi.hoisted(() => ({ value: false }));

vi.mock("@/services/api", () => ({ call: vi.fn(), isNetworkError: () => false, showError: vi.fn() }));
vi.mock("@/utils", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/utils")>()),
	isOnline: () => online.value,
}));
vi.mock("@/stores/posStore", () => ({
	usePosStore: () => ({ useOfflineMode: true, warehouse: "Stores - TC", profileName: "Main" }),
}));
vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => ({ itemSearchFields: ["item_name"] }) }));

const BOX = { barcode: "590002", uom: "Box", conversion_factor: 12, rate: 120 };
const UNIT = { barcode: "590001", uom: "Nos", conversion_factor: 1, rate: 10 };
const PAIR = { barcode: "590003", uom: "Pair", conversion_factor: null, rate: null };

function item(code: string, extra: Record<string, unknown> = {}) {
	return {
		item_code: code,
		item_name: code,
		item_group: "G",
		stock_uom: "Nos",
		rate: 10,
		barcodes: [],
		...extra,
	};
}

async function load() {
	vi.resetModules();
	globalThis.indexedDB = new IDBFactory();
	Dexie.dependencies.indexedDB = globalThis.indexedDB;
	const idb = await import("@/services/idbService");
	const { useItemStore, BarcodeScanError } = await import("@/stores/itemStore");
	const { useCartStore } = await import("@/stores/cartStore");
	setActivePinia(createPinia());
	return { idb, store: useItemStore(), BarcodeScanError, useCartStore };
}

beforeEach(() => {
	online.value = false;
});

describe("offline barcode scan", () => {
	it("finds a barcode that is not the item code, in its own UOM, factor and rate", async () => {
		const { idb, store } = await load();
		await idb.db.items.bulkPut([item("SKU-1", { barcodes: [UNIT, BOX] }), item("SKU-2")] as never[]);
		idb.invalidateCatalogIndex();

		const box = await store.searchByBarcode("590002");
		expect(box).toMatchObject({ item_code: "SKU-1", uom: "Box", conversion_factor: 12, rate: 120 });
		const unit = await store.searchByBarcode("590001");
		expect(unit).toMatchObject({ item_code: "SKU-1", uom: "Nos", conversion_factor: 1, rate: 10 });
		expect(await store.searchByBarcode("sku-2")).toMatchObject({
			uom: "Nos",
			conversion_factor: 1,
			rate: 10,
		});
		expect(await store.searchByBarcode("nothing")).toBeNull();
	});

	it("survives a reload: the rows, not memory, hold the barcodes", async () => {
		const first = await load();
		await first.idb.db.items.bulkPut([item("SKU-1", { barcodes: [BOX] })] as never[]);
		vi.resetModules();
		const idb = await import("@/services/idbService");
		const { useItemStore } = await import("@/stores/itemStore");
		setActivePinia(createPinia());
		expect(await useItemStore().searchByBarcode("590002")).toMatchObject({
			item_code: "SKU-1",
			uom: "Box",
		});
		expect(idb).toBeDefined();
	});

	it("follows a barcode that is changed, moved or removed", async () => {
		const { idb, store } = await load();
		await idb.db.items.bulkPut([item("SKU-1", { barcodes: [BOX] }), item("SKU-2")] as never[]);
		idb.invalidateCatalogIndex();
		expect(await store.searchByBarcode("590002")).toMatchObject({ item_code: "SKU-1" });

		await idb.db.items.bulkPut([
			item("SKU-1", { barcodes: [] }),
			item("SKU-2", { barcodes: [{ ...BOX, uom: "Nos", conversion_factor: 1, rate: 10 }] }),
		] as never[]);
		idb.invalidateCatalogIndex();
		expect(await store.searchByBarcode("590002")).toMatchObject({ item_code: "SKU-2", uom: "Nos" });

		await idb.db.items.bulkPut([item("SKU-2", { barcodes: [] })] as never[]);
		idb.invalidateCatalogIndex();
		expect(await store.searchByBarcode("590002")).toBeNull();
	});

	it("refuses a barcode whose UOM cannot be converted", async () => {
		const { idb, store, BarcodeScanError } = await load();
		await idb.db.items.bulkPut([item("SKU-1", { barcodes: [PAIR] })] as never[]);
		idb.invalidateCatalogIndex();
		await expect(store.searchByBarcode("590003")).rejects.toBeInstanceOf(BarcodeScanError);
		await expect(store.searchByBarcode("590003")).rejects.toThrow(/Pair/);
	});

	it("reports a barcode two items claim instead of picking one", async () => {
		const { idb, store, BarcodeScanError } = await load();
		await idb.db.items.bulkPut([
			item("SKU-1", { barcodes: [BOX] }),
			item("SKU-2", { barcodes: [BOX] }),
		] as never[]);
		idb.invalidateCatalogIndex();
		const failure = await store.searchByBarcode("590002").catch((error) => error);
		expect(failure).toBeInstanceOf(BarcodeScanError);
		expect(failure.message).toMatch(/SKU-1.*SKU-2/);
	});

	it("lets a barcode win over another item's code, as the server does", async () => {
		const { idb, store } = await load();
		await idb.db.items.bulkPut([
			item("SKU-1", { barcodes: [{ barcode: "SKU-2", uom: "Nos", conversion_factor: 1, rate: 10 }] }),
			item("SKU-2"),
		] as never[]);
		idb.invalidateCatalogIndex();
		expect(await store.searchByBarcode("SKU-2")).toMatchObject({ item_code: "SKU-1" });
	});

	it("keeps the old items table usable: a legacy single barcode field still scans", async () => {
		const { idb, store } = await load();
		await idb.db.items.bulkPut([{ ...item("SKU-9"), barcodes: undefined, barcode: "111" }] as never[]);
		idb.invalidateCatalogIndex();
		expect(await store.searchByBarcode("111")).toMatchObject({
			item_code: "SKU-9",
			conversion_factor: 1,
		});
	});
});

describe("selling a scanned barcode", () => {
	it("prices and converts a box line, and keeps unit and box lines apart", async () => {
		const { idb, store, useCartStore } = await load();
		await idb.db.items.bulkPut([item("SKU-1", { barcodes: [UNIT, BOX], actual_qty: 30 })] as never[]);
		idb.invalidateCatalogIndex();
		const cart = useCartStore();

		for (const code of ["590002", "590002", "590001"]) {
			const scanned = await store.searchByBarcode(code);
			expect(cart.addItem(scanned!).success).toBe(true);
		}
		const lines = cart.items.map((row) => [row.uom, row.qty, row.rate, row.conversion_factor]);
		expect(lines).toEqual([
			["Box", 2, 120, 12],
			["Nos", 1, 10, 1],
		]);
		expect(cart.items.reduce((sum, row) => sum + row.qty * row.rate, 0)).toBe(250);
		// 2 boxes + 1 unit = 25 stock units of the 30 on hand
		expect(cart.items.reduce((sum, row) => sum + row.qty * (row.conversion_factor || 1), 0)).toBe(25);
	});
});
