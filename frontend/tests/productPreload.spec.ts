/** @vitest-environment jsdom */
import { beforeEach, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
const mocks = vi.hoisted(() => ({
	call: vi.fn(),
	cache: vi.fn(),
	stock: vi.fn(),
	profile: { xpos_product_preload_limit: 2 },
}));
vi.mock("@/services/api", () => ({ call: mocks.call, isNetworkError: () => false }));
vi.mock("@/services/electronBridge", () => ({ isElectron: () => false }));
vi.mock("@/stores/posStore", () => ({
	usePosStore: () => ({
		profileName: "Till",
		posProfile: mocks.profile,
		warehouse: "Store",
		useOfflineMode: true,
	}),
}));
vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => ({}) }));
vi.mock("@/utils", () => ({ isOnline: () => true }));
vi.mock("@/services/dbBridge", () => ({
	cacheItems: mocks.cache,
	getCachedItems: vi.fn(),
	searchCachedItems: vi.fn(),
	cacheItemGroups: vi.fn(),
	getCachedItemGroups: vi.fn(),
	cacheStockForWarehouse: mocks.stock,
	getCachedStock: vi.fn(),
	getCachedItemByCode: vi.fn(),
}));
import { useItemStore } from "@/stores/itemStore";
import { useCacheStatus } from "@/stores/cacheStatus";
beforeEach(() => {
	setActivePinia(createPinia());
	vi.clearAllMocks();
});
it("caches only the selected count and accurately reports partial coverage", async () => {
	mocks.call.mockResolvedValue([
		{ item_code: "Z", actual_qty: 4 },
		{ item_code: "A", actual_qty: 2 },
		{ item_code: "B" },
	]);
	await useItemStore().cacheAllItems("Till");
	expect(mocks.cache.mock.calls[0][0]).toHaveLength(2);
	expect(mocks.stock).toHaveBeenCalledWith("Store", [
		{ item_code: "Z", actual_qty: 4 },
		{ item_code: "A", actual_qty: 2 },
	]);
	expect(useCacheStatus().states["Products and stock"]).toMatchObject({
		count: 2,
		complete: false,
		error: false,
	});
});
it("reports all eligible products when fewer than the cap exist", async () => {
	mocks.call.mockResolvedValue([{ item_code: "A" }]);
	await useItemStore().cacheAllItems("Till");
	expect(useCacheStatus().states["Products and stock"]).toMatchObject({ count: 1, complete: true });
});
it("does not claim completeness or replace data after a failed refresh", async () => {
	mocks.call.mockRejectedValue(new Error("offline"));
	await useItemStore().cacheAllItems("Till");
	expect(mocks.cache).not.toHaveBeenCalled();
	expect(useCacheStatus().states["Products and stock"]).toMatchObject({
		complete: false,
		error: true,
		loading: false,
	});
});
