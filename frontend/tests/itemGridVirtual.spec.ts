/**
 * @vitest-environment jsdom
 *
 * ItemGrid renders only the rows near the viewport, however many items are loaded, and keeps the
 * list semantics (item count and position) that assistive technology reads.
 *
 * jsdom has no layout engine, so the scroll box's size and the grid's column count are supplied
 * here; real scrolling and focus are covered by the Cypress catalogue spec and the benchmark.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { reactive } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import type { POSItem } from "@/types/pos.types";

const pos = reactive({
	displayItemCode: true,
	hideImages: true,
	hideVariantsItems: false,
	allowZeroRatedItems: false,
	stockSettings: {} as Record<string, unknown>,
	currencySymbol: "$",
});
vi.mock("@/stores/posStore", () => ({ usePosStore: () => pos }));
vi.mock("@/stores/layoutStore", () => ({
	useLayoutStore: () => ({
		shared: { productDisplay: ["image", "item_code", "stock"] },
		device: { density: "comfortable" },
	}),
}));

import ItemGrid from "@/components/items/ItemGrid.vue";

const VIEWPORT = 600;
const COLUMNS = 4;

beforeAll(() => {
	class FakeResizeObserver {
		constructor(private cb: ResizeObserverCallback) {}
		observe(target: Element) {
			this.cb(
				[{ target, contentRect: { width: 800, height: VIEWPORT } } as ResizeObserverEntry],
				this as never,
			);
		}
		unobserve() {}
		disconnect() {}
	}
	vi.stubGlobal("ResizeObserver", FakeResizeObserver);

	Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => VIEWPORT });
	Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 800 });
	Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => VIEWPORT });
	Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 800 });
	const style = window.getComputedStyle;
	vi.spyOn(window, "getComputedStyle").mockImplementation((el: Element) => {
		const real = style(el);
		return new Proxy(real, {
			get(target, prop) {
				if (prop === "gridTemplateColumns") return Array(COLUMNS).fill("160px").join(" ");
				if (prop === "rowGap") return "12px";
				const value = Reflect.get(target, prop);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	});
});

const catalogue = (n: number): POSItem[] =>
	Array.from({ length: n }, (_, i) => ({
		item_code: `SKU-${i}`,
		item_name: `Item ${i}`,
		rate: 1,
		uom: "Nos",
		stock_uom: "Nos",
		actual_qty: 5,
		is_stock_item: true,
	}));

function scroller() {
	const el = document.createElement("div");
	document.body.appendChild(el);
	return el;
}

describe("ItemGrid virtualization", () => {
	it.each(["grid", "list"] as const)("renders a bounded window of a 100,000-item %s", async (viewMode) => {
		const wrapper = mount(ItemGrid, {
			attachTo: document.body,
			props: { items: catalogue(100_000), scrollElement: scroller(), viewMode },
		});
		await wrapper.vm.$nextTick();
		await wrapper.vm.$nextTick();

		const rendered = wrapper.findAll("[data-item-index]");
		expect(rendered.length).toBeGreaterThan(0);
		expect(rendered.length).toBeLessThan(200);
		expect(rendered[0].attributes("data-item-index")).toBe("0");
		wrapper.unmount();
	});

	it("tells assistive technology how many products there are and where each sits", async () => {
		const wrapper = mount(ItemGrid, {
			attachTo: document.body,
			props: { items: catalogue(5000), scrollElement: scroller(), viewMode: "list" },
		});
		await wrapper.vm.$nextTick();
		await wrapper.vm.$nextTick();

		const first = wrapper.get("[data-item-index='0']");
		expect(first.attributes("aria-setsize")).toBe("5000");
		expect(first.attributes("aria-posinset")).toBe("1");
		wrapper.unmount();
	});

	it("shows a highlighted item as highlighted", async () => {
		const wrapper = mount(ItemGrid, {
			attachTo: document.body,
			props: { items: catalogue(50), scrollElement: scroller(), viewMode: "list", highlightedIndex: 2 },
		});
		await wrapper.vm.$nextTick();
		await wrapper.vm.$nextTick();
		expect(wrapper.get("[data-item-index='2']").classes().join(" ")).toContain("bg-surface-selected");
		wrapper.unmount();
	});

	it("asks for the next page once the rendered rows reach the end of what is loaded", async () => {
		const wrapper = mount(ItemGrid, {
			attachTo: document.body,
			props: { items: catalogue(8), scrollElement: scroller(), viewMode: "list" },
		});
		await wrapper.vm.$nextTick();
		await wrapper.vm.$nextTick();
		await flushPromises();
		expect(wrapper.emitted("loadMore")).toBeTruthy();
		wrapper.unmount();
	});

	it("does not ask for more while loading or after an error", async () => {
		const loading = mount(ItemGrid, {
			attachTo: document.body,
			props: { items: catalogue(8), scrollElement: scroller(), viewMode: "list", isLoading: true },
		});
		await loading.vm.$nextTick();
		await loading.vm.$nextTick();
		expect(loading.emitted("loadMore")).toBeFalsy();
		loading.unmount();

		const failed = mount(ItemGrid, {
			attachTo: document.body,
			props: { items: catalogue(8), scrollElement: scroller(), viewMode: "list", loadError: "boom" },
		});
		await failed.vm.$nextTick();
		await failed.vm.$nextTick();
		expect(failed.emitted("loadMore")).toBeFalsy();
		failed.unmount();
	});
});
