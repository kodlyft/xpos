/**
 * @vitest-environment jsdom
 *
 * Timings for switching and scanning with many carts. They print what was measured (jsdom on
 * Node, not a browser) and assert only generous ceilings, so a regression to something
 * pathological fails while normal machine noise does not.
 */
import { describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";

vi.mock("@/services/api", () => ({ call: vi.fn(), showError: vi.fn(), showInfo: vi.fn() }));
vi.mock("@/stores/posStore", async () => {
	const kit = await import("./cartTestKit");
	return { usePosStore: () => kit.posState };
});
const resolveCartPricing = vi.hoisted(() => vi.fn(async () => ({ source: "unavailable" })));
vi.mock("@/services/pricingService", () => ({
	resolveCartPricing,
	refreshPricingRuleSnapshot: vi.fn(async () => {}),
}));

import { useCartStore } from "@/stores/cartStore";
import { MAX_CARTS, useCartSessionStore } from "@/stores/cartSessionStore";
import { line, resetPos } from "./cartTestKit";

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
}

describe("cart tab performance", () => {
	it("switches between full carts quickly and without repricing", async () => {
		setActivePinia(createPinia());
		resetPos();
		const cart = useCartStore();
		const sessions = useCartSessionStore();
		const LINES = 200;

		for (let c = 0; c < MAX_CARTS; c++) {
			cart.customer = { name: `CUST-${c}`, customer_name: `Customer ${c}` };
			cart.items = Array.from({ length: LINES }, (_, i) =>
				line({ item_code: `C${c}-I${i}`, rate: i + 1 }),
			);
			if (c < MAX_CARTS - 1) sessions.create();
		}
		await nextTick();
		await new Promise((r) => setTimeout(r, 350));
		resolveCartPricing.mockClear();

		const samples: number[] = [];
		const ids = sessions.tabs.map((t) => t.id);
		for (let n = 0; n < 100; n++) {
			const started = performance.now();
			sessions.switchTo(ids[n % ids.length], { focus: false });
			samples.push(performance.now() - started);
			await nextTick();
		}
		await new Promise((r) => setTimeout(r, 400));

		const med = median(samples);
		const worst = Math.max(...samples);
		console.info(
			`[perf] switch between ${MAX_CARTS} carts x ${LINES} lines: median ${med.toFixed(2)} ms, worst ${worst.toFixed(2)} ms (n=${samples.length}); pricing calls during switches: ${resolveCartPricing.mock.calls.length}`,
		);
		expect(resolveCartPricing).not.toHaveBeenCalled();
		expect(med).toBeLessThan(50);
		expect(cart.items).toHaveLength(LINES);
	});

	it("adds scans to a long cart in steady time and builds a saved record cheaply", async () => {
		setActivePinia(createPinia());
		resetPos();
		const cart = useCartStore();
		const sessions = useCartSessionStore();
		for (let c = 0; c < MAX_CARTS - 1; c++) {
			cart.items = Array.from({ length: 200 }, (_, i) => line({ item_code: `B${c}-${i}` }));
			sessions.create();
		}

		const times: number[] = [];
		for (let i = 0; i < 300; i++) {
			const started = performance.now();
			cart.addItem({
				item_code: `SCAN-${i}`,
				item_name: `Scanned ${i}`,
				rate: 3,
				uom: "Nos",
				stock_uom: "Nos",
				actual_qty: 9999,
			} as never);
			times.push(performance.now() - started);
		}
		const firstTen = median(times.slice(0, 10));
		const lastTen = median(times.slice(-10));
		console.info(
			`[perf] addItem on a cart growing to 300 lines with ${MAX_CARTS - 1} other carts open: median ${median(times).toFixed(3)} ms, first-10 ${firstTen.toFixed(3)} ms, last-10 ${lastTen.toFixed(3)} ms`,
		);
		expect(cart.items).toHaveLength(300);
		expect(lastTen).toBeLessThan(25);

		const started = performance.now();
		const record = JSON.stringify(
			sessions.tabs.map((t) =>
				t.active ? cart.snapshot() : sessions.sessions.find((s) => s.id === t.id)?.snapshot,
			),
		);
		const built = performance.now() - started;
		console.info(
			`[perf] build + serialise all ${MAX_CARTS} carts for storage: ${built.toFixed(1)} ms, ${(record.length / 1024).toFixed(0)} KiB (debounced, once per quiet period)`,
		);
		expect(built).toBeLessThan(500);
	});
});
