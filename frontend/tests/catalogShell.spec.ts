/**
 * @vitest-environment jsdom
 *
 * Product browsing pieces of the v3 shell: the item-group tree behind CategoryBar, the
 * state a catalogue tile shows for each POS Profile setting, and the connection status labels.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reactive } from "vue";
import { mount } from "@vue/test-utils";
import { buildCategoryTree, ALL_GROUPS } from "@/composables/useCategoryTree";
import type { POSItem } from "@/types/pos.types";

const pos = reactive({
	displayItemCode: true,
	hideImages: false,
	hideVariantsItems: false,
	allowZeroRatedItems: false,
	stockSettings: { allow_negative_stock: false } as Record<string, unknown>,
	currencySymbol: "$",
});
vi.mock("@/stores/posStore", () => ({ usePosStore: () => pos }));
vi.mock("@/stores/layoutStore", () => ({
	useLayoutStore: () => ({
		shared: { productDisplay: ["image", "item_code", "stock"] },
		device: { density: "comfortable" },
	}),
}));

const offline = reactive({
	isOnline: true,
	isSyncing: false,
	pendingCount: 0,
	hasPending: false,
	hasDeadLetters: false,
});
vi.mock("@/stores/offlineStore", () => ({ useOfflineStore: () => offline }));

import ItemCard from "@/components/items/ItemCard.vue";
import ItemListRow from "@/components/items/ItemListRow.vue";
import ConnectionStatus from "@/components/ConnectionStatus.vue";

const g = (name: string, parent: string) => ({ name, parent_item_group: parent });

describe("buildCategoryTree", () => {
	const parents = [
		g(ALL_GROUPS, ""),
		g("Tools", ALL_GROUPS),
		g("Tools - Hand", "Tools"),
		g("Paint", ALL_GROUPS),
	];
	const leaves = [
		g("Tools - Hand - Small", "Tools - Hand"),
		g("Tools - Hand - Large", "Tools - Hand"),
		g("Paint - Matte", "Paint"),
	];

	it("builds levels, paths and leaf siblings", () => {
		const tree = buildCategoryTree(leaves, parents);
		expect(tree.childrenOf(ALL_GROUPS)).toEqual(["Tools", "Paint"]);
		expect(tree.pathTo("Tools - Hand - Small")).toEqual([
			"Tools",
			"Tools - Hand",
			"Tools - Hand - Small",
		]);
		expect(tree.levelFor("Tools")).toEqual({ parent: "Tools", options: ["Tools - Hand"] });
		// A leaf shows its siblings, so the row never goes empty.
		expect(tree.levelFor("Tools - Hand - Large").options).toEqual([
			"Tools - Hand - Small",
			"Tools - Hand - Large",
		]);
		expect(tree.levelFor("Unknown group").parent).toBe(ALL_GROUPS);
	});

	it("treats groups whose parent was not sent as top level (restricted POS Profile)", () => {
		// get_item_groups for a profile limited to "Tools" returns it plus its leaves, not the groups between.
		const tree = buildCategoryTree([g("Tools - Hand - Small", "Tools - Hand")], [g("Tools", ALL_GROUPS)]);
		expect(tree.childrenOf(ALL_GROUPS)).toEqual(["Tools", "Tools - Hand - Small"]);
		expect(tree.pathTo("Tools - Hand - Small")).toEqual(["Tools - Hand - Small"]);
	});

	it("caps search results and matches translated labels", () => {
		const many = Array.from({ length: 80 }, (_, i) => g(`Bolt ${i}`, ALL_GROUPS));
		const tree = buildCategoryTree(many, []);
		expect(tree.search("bolt", (n) => n)).toHaveLength(50);
		expect(tree.search("bolt", (n) => n, 5)).toHaveLength(5);
		expect(tree.search("", (n) => n)).toEqual([]);
		expect(tree.search("perno", (n) => n.replace("Bolt", "Perno"), 3)).toEqual([
			"Bolt 0",
			"Bolt 1",
			"Bolt 2",
		]);
	});

	it("survives a parent cycle in bad data", () => {
		const tree = buildCategoryTree([g("A", "B")], [g("B", "A")]);
		expect(tree.pathTo("A")).toEqual(["B", "A"]);
	});
});

const item = (over: Partial<POSItem> = {}): POSItem => ({
	item_code: "SKU-1",
	item_name: "Hex Bolt M8",
	rate: 10,
	uom: "Nos",
	stock_uom: "Nos",
	image: "/files/bolt.png",
	actual_qty: 20,
	is_stock_item: true,
	...over,
});

describe.each([
	["ItemCard", ItemCard],
	["ItemListRow", ItemListRow],
])("%s states", (_name, Tile) => {
	beforeEach(() => {
		Object.assign(pos, {
			displayItemCode: true,
			hideImages: false,
			hideVariantsItems: false,
			allowZeroRatedItems: false,
			stockSettings: { allow_negative_stock: false },
		});
	});

	const render = (over: Partial<POSItem> = {}) => mount(Tile as never, { props: { item: item(over) } });

	it("offers separate add and details buttons", async () => {
		const w = render();
		const add = w.get("[data-testid='item-add']");
		expect(add.attributes("aria-label")).toBe("Add Hex Bolt M8");
		expect(add.attributes("tabindex")).toBeUndefined();
		expect(w.get("[data-testid='item-details']").attributes("aria-label")).toBe(
			"Details for Hex Bolt M8",
		);
		await add.trigger("click");
		await w.get("[data-testid='item-details']").trigger("click");
		expect(w.emitted("click")).toHaveLength(1);
		expect(w.emitted("showDetail")).toHaveLength(1);
		expect(w.text()).toContain("SKU-1");
	});

	it("blocks out-of-stock items only when negative stock is not allowed", async () => {
		const blocked = render({ actual_qty: 0 });
		expect(blocked.get("[data-testid='item-add']").attributes("aria-disabled")).toBe("true");
		await blocked.get("[data-testid='item-add']").trigger("click");
		expect(blocked.emitted("click")).toBeUndefined();
		expect(blocked.text()).toContain("Out of stock");

		pos.stockSettings = { allow_negative_stock: true };
		const allowed = render({ actual_qty: 0 });
		expect(allowed.get("[data-testid='item-add']").attributes("aria-disabled")).toBeUndefined();
		await allowed.get("[data-testid='item-add']").trigger("click");
		expect(allowed.emitted("click")).toHaveLength(1);
	});

	it("says 'No price' for zero-rated items unless the profile allows them", async () => {
		expect(render({ rate: 0 }).find("[data-testid='price-missing']").exists()).toBe(true);
		pos.allowZeroRatedItems = true;
		expect(render({ rate: 0 }).find("[data-testid='price-missing']").exists()).toBe(false);
		// Still addable either way: checkout decides.
		pos.allowZeroRatedItems = false;
		const w = render({ rate: 0 });
		await w.get("[data-testid='item-add']").trigger("click");
		expect(w.emitted("click")).toHaveLength(1);
	});

	it("marks templates unless variants are hidden", () => {
		const template = render({ has_variants: true });
		expect(template.text()).toContain("Variants");
		expect(template.get("[data-testid='item-add']").attributes("aria-label")).toBe(
			"Choose variant of Hex Bolt M8",
		);
		pos.hideVariantsItems = true;
		expect(render({ has_variants: true }).text()).not.toContain("Variants");
	});

	it("follows image, item-code and stock visibility settings", async () => {
		expect(render().find("img").exists()).toBe(true);
		const broken = render();
		await broken.get("img").trigger("error");
		expect(broken.find("img").exists()).toBe(false);

		pos.hideImages = true;
		pos.displayItemCode = false;
		const plain = render();
		expect(plain.find("img").exists()).toBe(false);
		expect(plain.text()).not.toContain("SKU-1");
		expect(render({ is_stock_item: false, actual_qty: 0 }).text()).not.toContain("stock");
	});
});

describe("ConnectionStatus", () => {
	const label = () =>
		mount(ConnectionStatus, { global: { stubs: { OfflinePendingPanel: true } } }).get(
			"[data-testid='connection-status']",
		);

	beforeEach(() =>
		Object.assign(offline, {
			isOnline: true,
			isSyncing: false,
			pendingCount: 0,
			hasPending: false,
			hasDeadLetters: false,
		}),
	);

	it.each([
		[{}, "online", "Online"],
		[{ isSyncing: true }, "syncing", "Syncing"],
		[{ pendingCount: 3, hasPending: true }, "pending", "3 pending"],
		[{ hasDeadLetters: true }, "failed", "Sync issue"],
		[{ isOnline: false, pendingCount: 2, hasPending: true }, "offline", "Offline · 2 pending"],
	])("%o shows %s", (state, key, text) => {
		Object.assign(offline, state);
		const el = label();
		expect(el.attributes("data-state")).toBe(key);
		expect(el.text()).toContain(text);
		expect(el.attributes("aria-label")).toBeTruthy();
	});
});
