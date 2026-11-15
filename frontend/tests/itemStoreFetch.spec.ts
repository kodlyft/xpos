/**
 * itemStore.fetchItems: the latest search wins and an older answer is never shown, a load-more
 * asked for mid-fetch is not lost, and a failed load must be told apart from an empty catalogue.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const call = vi.fn();
vi.mock("@/services/api", () => ({
	call: (...args: unknown[]) => call(...args),
	isNetworkError: () => false,
}));
vi.mock("@/utils", () => ({ isOnline: () => true }));
vi.mock("@/stores/posStore", () => ({ usePosStore: () => ({ useOfflineMode: false }) }));
vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => ({}) }));
vi.mock("@/services/dbBridge", () => ({}));

import { useItemStore } from "@/stores/itemStore";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("itemStore.fetchItems", () => {
	beforeEach(() => {
		setActivePinia(createPinia());
		call.mockReset();
	});

	it("re-runs a search that arrived while the previous fetch was in flight", async () => {
		const store = useItemStore();
		const first = deferred<unknown[]>();
		call.mockImplementationOnce(() => first.promise);
		call.mockImplementationOnce(async (_m: string, args: Record<string, unknown>) => [
			{ item_code: "DRILL", item_name: `match for ${args.search_term}` },
		]);

		const initial = store.fetchItems("Main");
		store.setSearchTerm("Cordless");
		await store.fetchItems("Main"); // dropped before the fix

		first.resolve([{ item_code: "OLD", item_name: "Initial page" }]);
		await initial;
		await vi.waitFor(() => expect(store.items.map((i) => i.item_code)).toEqual(["DRILL"]));
		expect(call).toHaveBeenCalledTimes(2);
		expect(call.mock.calls[1][1]).toMatchObject({ search_term: "Cordless", start: 0 });
	});

	it("does not queue a re-run for load-more pages", async () => {
		const store = useItemStore();
		const first = deferred<unknown[]>();
		call.mockImplementationOnce(() => first.promise);
		const initial = store.fetchItems("Main");
		await store.fetchItems("Main", true);
		first.resolve([]);
		await initial;
		expect(call).toHaveBeenCalledTimes(1);
	});

	const rows = (n: number, prefix: string) =>
		Array.from({ length: n }, (_, i) => ({ item_code: `${prefix}-${i}`, item_name: `${prefix} ${i}` }));

	it("never shows a slow answer to an older search over the newer one", async () => {
		const store = useItemStore();
		const slow = deferred<unknown[]>();
		call.mockImplementationOnce(() => slow.promise);
		call.mockResolvedValueOnce([{ item_code: "NEW", item_name: "Newer search" }]);

		store.setSearchTerm("dri");
		const older = store.fetchItems("Main");
		store.setSearchTerm("drill");
		await store.fetchItems("Main");
		expect(store.items.map((i) => i.item_code)).toEqual(["NEW"]);
		expect(store.isLoading).toBe(false);

		slow.resolve([{ item_code: "OLD", item_name: "Older search" }]);
		await older;
		expect(store.items.map((i) => i.item_code)).toEqual(["NEW"]);
		expect(store.isLoading).toBe(false);
	});

	it("drops a next page that arrives after the list was replaced by a new search", async () => {
		const store = useItemStore();
		call.mockResolvedValueOnce(rows(40, "A"));
		await store.fetchItems("Main");
		expect(store.hasMore).toBe(true);

		const page = deferred<unknown[]>();
		call.mockImplementationOnce(() => page.promise);
		const more = store.fetchItems("Main", true);

		call.mockResolvedValueOnce([{ item_code: "HIT", item_name: "Hit" }]);
		store.setSearchTerm("hit");
		await store.fetchItems("Main");

		page.resolve(rows(40, "LATE"));
		await more;
		expect(store.items.map((i) => i.item_code)).toEqual(["HIT"]);
		expect(store.hasMore).toBe(false);
	});

	it("runs a load-more that was asked for while the previous page was loading", async () => {
		const store = useItemStore();
		call.mockResolvedValueOnce(rows(40, "A"));
		await store.fetchItems("Main");

		const second = deferred<unknown[]>();
		call.mockImplementationOnce(() => second.promise);
		call.mockResolvedValueOnce(rows(40, "C"));
		const inFlight = store.fetchItems("Main", true);
		await store.fetchItems("Main", true); // asked for again while the page is loading

		second.resolve(rows(40, "B"));
		await inFlight;
		await vi.waitFor(() => expect(store.items).toHaveLength(120));
		expect(call.mock.calls.map((c) => c[1].start)).toEqual([0, 40, 80]);
		expect(store.items.map((i) => i.item_code).slice(39, 42)).toEqual(["A-39", "B-0", "B-1"]);
	});

	it("records a failed load and clears it on the next attempt", async () => {
		const store = useItemStore();
		vi.spyOn(console, "error").mockImplementation(() => {});
		call.mockRejectedValueOnce(new Error("Item service unavailable"));
		await store.fetchItems("Main");
		expect(store.loadError).toBe("Item service unavailable");
		expect(store.items).toEqual([]);

		call.mockResolvedValueOnce([{ item_code: "A", item_name: "A" }]);
		await store.fetchItems("Main");
		expect(store.loadError).toBeNull();
		expect(store.items).toHaveLength(1);
	});
});
