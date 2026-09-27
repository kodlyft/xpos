/** @vitest-environment jsdom */
import { beforeEach, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
const mocks = vi.hoisted(() => ({ call: vi.fn(), cache: vi.fn() }));
vi.mock("@/services/api", () => ({ call: mocks.call }));
vi.mock("@/stores/posStore", () => ({ usePosStore: () => ({ useOfflineMode: true }) }));
vi.mock("@/utils", () => ({ isOnline: () => true }));
vi.mock("@/services/dbBridge", () => ({
	cacheCustomers: mocks.cache,
	getCachedCustomers: vi.fn(),
	searchCachedCustomers: vi.fn(),
}));
import { useCustomerStore } from "@/stores/customerStore";
beforeEach(() => {
	setActivePinia(createPinia());
	vi.clearAllMocks();
});
it("preloads the configured selection and retains its rank for offline browsing", async () => {
	mocks.call.mockResolvedValue({ customers: [{ name: "Z" }, { name: "A" }], complete: true });
	await useCustomerStore().cacheAllCustomers("Till");
	expect(mocks.call).toHaveBeenCalledWith("xpos.api.customers.get_customers", {
		search_term: "",
		pos_profile: "Till",
		preload: 1,
		with_metadata: 1,
	});
	expect(mocks.cache).toHaveBeenCalledWith([
		{ name: "Z", xpos_cache_rank: 0 },
		{ name: "A", xpos_cache_rank: 1 },
	]);
});
it("searching for one customer does not replace the offline selection", async () => {
	mocks.call.mockResolvedValue([{ name: "A" }]);
	const store = useCustomerStore();
	await store.searchCustomers("A", "Till");
	expect(store.customers).toHaveLength(1);
	expect(mocks.cache).not.toHaveBeenCalled();
});
it("an empty refreshed selection clears the old cache", async () => {
	mocks.call.mockResolvedValue({ customers: [], complete: true });
	await useCustomerStore().cacheAllCustomers("Till");
	expect(mocks.cache).toHaveBeenCalledWith([]);
});
