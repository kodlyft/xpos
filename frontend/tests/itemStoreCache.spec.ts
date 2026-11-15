import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

vi.mock("@/services/api", () => ({ call: vi.fn(), isNetworkError: () => false }));
vi.mock("@/utils", () => ({ isOnline: () => true }));
vi.mock("@/stores/posStore", () => ({
	usePosStore: () => ({ useOfflineMode: true, warehouse: "Stores - TC", profileName: "Main" }),
}));
vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => ({ itemSearchFields: ["item_name"] }) }));

const sync = vi.hoisted(() => ({
	syncCatalog: vi.fn(async (_profile: string) => "full"),
	getCatalogStatus: vi.fn(async () => ({ status: "none", scopeMatches: false, ageMs: null })),
}));
vi.mock("@/services/catalogSync", () => sync);

const idb = vi.hoisted(() => ({ warmCatalogIndex: vi.fn(async () => {}) }));
vi.mock("@/services/dbBridge", () => idb);

import { useItemStore } from "@/stores/itemStore";

const fresh = (ageMs: number) => ({ status: "complete", scopeMatches: true, ageMs });

describe("itemStore.cacheAllItems", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		setActivePinia(createPinia());
		sync.syncCatalog.mockReset().mockResolvedValue("full");
		sync.getCatalogStatus
			.mockReset()
			.mockResolvedValue({ status: "none", scopeMatches: false, ageMs: null });
		idb.warmCatalogIndex.mockClear();
	});
	afterEach(() => vi.useRealTimers());

	it("hands the download to the catalogue sync and warms the search index", async () => {
		await useItemStore().cacheAllItems("Main");
		expect(sync.syncCatalog).toHaveBeenCalledWith("Main");
		expect(idb.warmCatalogIndex).toHaveBeenCalledTimes(1);
	});

	it("shares one sync between callers that ask while it runs", async () => {
		const store = useItemStore();
		await Promise.all([
			store.cacheAllItems("Main"),
			store.cacheAllItems("Main"),
			store.cacheAllItems("Main"),
		]);
		expect(sync.syncCatalog).toHaveBeenCalledTimes(1);
	});

	it("does not sync again while the catalogue was confirmed a moment ago", async () => {
		sync.getCatalogStatus.mockResolvedValue(fresh(10_000));
		await useItemStore().cacheAllItems("Main");
		expect(sync.syncCatalog).not.toHaveBeenCalled();
	});

	it("builds the search index while idle even when nothing needs syncing", async () => {
		sync.getCatalogStatus.mockResolvedValue(fresh(10_000));
		await useItemStore().cacheAllItems("Main");
		await vi.advanceTimersByTimeAsync(2500);
		expect(idb.warmCatalogIndex).toHaveBeenCalledTimes(1);
	});

	it("syncs again once the confirmation is older than the freshness window", async () => {
		sync.getCatalogStatus.mockResolvedValue(fresh(5 * 60_000));
		await useItemStore().cacheAllItems("Main");
		expect(sync.syncCatalog).toHaveBeenCalledTimes(1);
	});

	it("syncs when the stored catalogue belongs to another session", async () => {
		sync.getCatalogStatus.mockResolvedValue({ status: "complete", scopeMatches: false, ageMs: 1000 });
		await useItemStore().cacheAllItems("Other");
		expect(sync.syncCatalog).toHaveBeenCalledWith("Other");
	});

	it("retries after a failed sync instead of waiting out the freshness window", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		sync.syncCatalog.mockRejectedValueOnce(new Error("offline"));
		const store = useItemStore();
		await store.cacheAllItems("Main");
		await store.cacheAllItems("Main");
		expect(sync.syncCatalog).toHaveBeenCalledTimes(2);
	});
});
