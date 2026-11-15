/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";

const call = vi.fn();
vi.mock("@/services/api", () => ({ call: (...args: unknown[]) => call(...args) }));

import PriceChecker from "@/views/PriceChecker.vue";

const found = {
	item_code: "SKU-1",
	item_name: "Green Tea",
	local_item_name: "",
	item_group: "Drinks",
	uom: "Nos",
	rate: 12.5,
	currency: "USD",
	symbol: "$",
	has_price: true,
	is_stock_item: true,
	in_stock: true,
};

async function scan(wrapper: ReturnType<typeof mount>, code: string) {
	const input = wrapper.get("[data-testid=price-checker-input]");
	await input.setValue(code);
	await input.trigger("keydown.enter");
	await flushPromises();
}

describe("PriceChecker", () => {
	beforeEach(() => {
		call.mockReset();
		call.mockImplementation(async (method: string) =>
			method.endsWith("get_terminal_context") ? { pos_profiles: [{ name: "Main" }] } : null,
		);
	});

	it("starts idle", async () => {
		const w = mount(PriceChecker);
		await flushPromises();
		expect(w.find("[data-testid=price-checker-idle]").exists()).toBe(true);
	});

	it("shows the price and stock for a known barcode, then clears it for the next scan", async () => {
		const w = mount(PriceChecker);
		await flushPromises();
		call.mockImplementation(async () => found);
		await scan(w, "123");
		expect(w.get("[data-testid=price-checker-price]").text()).toContain("12.5");
		expect(w.text()).toContain("Green Tea");
		expect(w.text()).toContain("In Stock");

		call.mockImplementation(async () => ({ ...found, item_name: "Plain Water", has_price: false }));
		await scan(w, "456");
		expect(w.text()).toContain("Plain Water");
		expect(w.text()).toContain("Price on request");
		expect(w.find("[data-testid=price-checker-price]").exists()).toBe(false);
	});

	it("shows not recognised for an unknown barcode and when the lookup fails", async () => {
		const w = mount(PriceChecker);
		await flushPromises();
		await scan(w, "nope");
		expect(w.get("[data-testid=price-checker-notfound]").text()).toContain("nope");

		call.mockImplementation(async () => {
			throw new Error("offline");
		});
		await scan(w, "again");
		expect(w.find("[data-testid=price-checker-notfound]").exists()).toBe(true);
	});

	it("keeps the last result until the next scan", async () => {
		vi.useFakeTimers();
		const w = mount(PriceChecker);
		await flushPromises();
		call.mockImplementation(async () => found);
		await scan(w, "123");
		vi.advanceTimersByTime(10 * 60 * 1000);
		await flushPromises();
		expect(w.text()).toContain("Green Tea");
		expect(w.find("[data-testid=price-checker-idle]").exists()).toBe(false);
		vi.useRealTimers();
	});
});
