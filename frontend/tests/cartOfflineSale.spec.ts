/**
 * @vitest-environment jsdom
 *
 * An offline sale belongs to the cart it was rung up on. Whatever cart is on screen when the
 * queue answers is left exactly as it was, and a queued sale never becomes editable again.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

vi.mock("@/services/api", () => ({ call: vi.fn(), showError: vi.fn(), showInfo: vi.fn() }));
vi.mock("@/stores/posStore", async () => {
	const kit = await import("./cartTestKit");
	return { usePosStore: () => kit.posState };
});
vi.mock("@/services/pricingService", () => ({
	resolveCartPricing: vi.fn(async () => ({ source: "unavailable" })),
	refreshPricingRuleSnapshot: vi.fn(async () => {}),
}));
const offline = vi.hoisted(() => ({
	saveOffline: vi.fn(async () => ({ success: true, localId: 7 })),
}));
vi.mock("@/stores/offlineStore", () => ({ useOfflineStore: () => offline }));
vi.mock("@/composables/usePrintInvoice", () => ({
	usePrintInvoice: () => ({ printReceiptOffline: vi.fn(async () => true) }),
}));

import { useCartStore } from "@/stores/cartStore";
import { useCartSessionStore } from "@/stores/cartSessionStore";
import { captureSaleOrigin, useOfflineSale } from "@/composables/useOfflineSale";
import { line, resetPos } from "./cartTestKit";

beforeEach(() => {
	vi.clearAllMocks();
	setActivePinia(createPinia());
	resetPos();
});

describe("completeOfflineSale", () => {
	it("queues the sale of the cart it came from, even after the cashier switched", async () => {
		const cart = useCartStore();
		const sessions = useCartSessionStore();
		const { completeOfflineSale } = useOfflineSale();

		cart.customer = { name: "CUST-A", customer_name: "Alice" };
		cart.items = [line({ item_code: "TV", qty: 1, rate: 300 })];
		const alice = cart.cartId;
		const invoice = cart.getInvoiceData("P", "S");
		const origin = captureSaleOrigin(cart, invoice, "Dana");
		sessions.beginSubmit(alice);

		sessions.create({ force: true });
		cart.customer = { name: "CUST-B", customer_name: "Bob" };
		cart.items = [line({ item_code: "PEN", rate: 5 })];

		const saved = await completeOfflineSale(invoice, { withPrint: false, cashier: "Dana", origin });
		expect(saved).toBe(true);

		const [queuedInvoice, customerName, total] = offline.saveOffline.mock.calls[0] as unknown as [
			{ customer: string },
			string,
			number,
		];
		expect(queuedInvoice.customer).toBe("CUST-A");
		expect(customerName).toBe("Alice");
		expect(total).toBe(300);

		expect(cart.customer?.name).toBe("CUST-B");
		expect(cart.items[0].item_code).toBe("PEN");
		expect(sessions.tabs.map((t) => t.id)).not.toContain(alice);
	});

	it("keeps the cart when the queue refuses the sale", async () => {
		const cart = useCartStore();
		const sessions = useCartSessionStore();
		const { completeOfflineSale, lastFailure } = useOfflineSale();
		cart.items = [line()];
		const invoice = cart.getInvoiceData("P", "S");
		offline.saveOffline.mockResolvedValueOnce({ success: false, reason: "quota" } as never);

		const saved = await completeOfflineSale(invoice, {
			withPrint: false,
			origin: captureSaleOrigin(cart, invoice, "Dana"),
		});
		expect(saved).toBe(false);
		expect(lastFailure.value).toMatch(/NOT saved/);
		expect(cart.items).toHaveLength(1);
		expect(sessions.count).toBe(1);
	});

	it("does not clear a cart that became a different sale while the queue was busy", async () => {
		const cart = useCartStore();
		const { completeOfflineSale } = useOfflineSale();
		cart.items = [line()];
		const invoice = cart.getInvoiceData("P", "S");
		const origin = captureSaleOrigin(cart, invoice, "Dana");
		cart.clearCart(); // cashier started over; the cart now has a new identity
		cart.items = [line({ item_code: "NEW" })];

		await completeOfflineSale(invoice, { withPrint: false, origin });
		expect(cart.items[0].item_code).toBe("NEW");
	});
});
