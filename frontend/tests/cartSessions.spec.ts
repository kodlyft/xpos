/**
 * @vitest-environment jsdom
 *
 * Several carts on one till: each keeps its own customer, lines and totals, a late answer never
 * lands in the wrong cart, and a finished sale only ever clears its own cart.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
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
import { line, posState, resetPos } from "./cartTestKit";

function setup() {
	setActivePinia(createPinia());
	resetPos();
	const cart = useCartStore();
	const sessions = useCartSessionStore();
	return { cart, sessions };
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("independent carts", () => {
	it("keeps two customers, prices and taxes apart", async () => {
		const { cart, sessions } = setup();
		const a = cart.cartId;

		cart.customer = { name: "CUST-A", customer_name: "Alice" };
		cart.items = [
			line({
				item_code: "TV",
				qty: 2,
				rate: 500,
				item_tax_template: "VAT 10",
				item_tax_map: { VAT: 10 },
			}),
		];
		cart.discountPercentage = 10;
		const totalA = cart.grandTotal;

		const created = sessions.create();
		expect(created.ok).toBe(true);
		const b = cart.cartId;
		expect(b).not.toBe(a);
		expect(cart.items).toHaveLength(0);
		expect(cart.discountPercentage).toBe(0);

		cart.customer = { name: "CUST-B", customer_name: "Bob" };
		cart.items = [line({ item_code: "PEN", qty: 3, rate: 5 })];
		const totalB = cart.grandTotal;
		expect(totalB).toBe(15);
		expect(totalA).toBe(990); // 2 x 500, 10% off, 10% tax on the net
		expect(cart.taxAmount).toBe(0); // Bob's cart carries none of Alice's tax

		expect(sessions.switchTo(a).ok).toBe(true);
		await nextTick();
		expect(cart.customer?.name).toBe("CUST-A");
		expect(cart.items[0].item_tax_map).toEqual({ VAT: 10 });
		expect(cart.discountPercentage).toBe(10);
		expect(cart.grandTotal).toBe(totalA);

		expect(sessions.switchTo(b).ok).toBe(true);
		await nextTick();
		expect(cart.customer?.name).toBe("CUST-B");
		expect(cart.grandTotal).toBe(totalB);
	});

	it("labels tabs by customer, falling back to Cart N, with item counts", () => {
		const { cart, sessions } = setup();
		cart.customer = { name: "Walk-in", customer_name: "Walk-in" };
		cart.items = [line({ qty: 2 })];
		sessions.create();
		cart.customer = { name: "CUST-B", customer_name: "Bob" };

		const tabs = sessions.tabs;
		expect(tabs.map((t) => t.label)).toEqual(["Cart 1", "Bob"]);
		expect(tabs[0].itemCount).toBe(2);
		expect(tabs[1].active).toBe(true);
	});

	it("gives each cart its own sale identity", () => {
		const { cart, sessions } = setup();
		cart.items = [line()];
		const first = cart.getInvoiceData("P", "S").local_id;
		sessions.create();
		cart.items = [line()];
		const second = cart.getInvoiceData("P", "S").local_id;
		expect(first).toBeTruthy();
		expect(second).toBeTruthy();
		expect(first).not.toBe(second);
		sessions.switchTo(sessions.tabs[0].id);
		expect(cart.getInvoiceData("P", "S").local_id).toBe(first);
	});

	it("does not reprice a cart just because it was switched to", async () => {
		const { cart, sessions } = setup();
		cart.items = [line({ rate: 40 })];
		await new Promise((r) => setTimeout(r, 300));
		sessions.create();
		cart.items = [line({ rate: 7 })];
		await new Promise((r) => setTimeout(r, 300));
		resolveCartPricing.mockClear();

		sessions.switchTo(sessions.tabs[0].id);
		sessions.switchTo(sessions.tabs[1].id);
		sessions.switchTo(sessions.tabs[0].id);
		await new Promise((r) => setTimeout(r, 400));
		expect(resolveCartPricing).not.toHaveBeenCalled();
		expect(cart.items[0].rate).toBe(40);
	});

	it("cycles with next and previous", () => {
		const { cart, sessions } = setup();
		const a = cart.cartId;
		sessions.create();
		const b = cart.cartId;
		sessions.create();
		const c = cart.cartId;
		sessions.next();
		expect(cart.cartId).toBe(a);
		sessions.prev();
		expect(cart.cartId).toBe(c);
		sessions.prev();
		expect(cart.cartId).toBe(b);
	});

	it("states a limit and never evicts a cart", () => {
		const { cart, sessions } = setup();
		for (let i = 1; i < MAX_CARTS; i++) {
			cart.items = [line()];
			expect(sessions.create().ok).toBe(true);
		}
		expect(sessions.count).toBe(MAX_CARTS);
		const refused = sessions.create();
		expect(refused.ok).toBe(false);
		expect(refused.reason).toContain(String(MAX_CARTS));
		expect(sessions.count).toBe(MAX_CARTS);
		expect(sessions.atLimit).toBe(true);
	});

	it("refuses to switch while the payment window is open or a payment is saving", () => {
		const { cart, sessions } = setup();
		const a = cart.cartId;
		cart.items = [line()];
		sessions.create();
		const b = cart.cartId;

		cart.showPaymentDialog = true;
		expect(sessions.switchTo(a).ok).toBe(false);
		cart.showPaymentDialog = false;

		sessions.beginSubmit(b);
		const blocked = sessions.switchTo(a);
		expect(blocked.ok).toBe(false);
		expect(blocked.reason).toMatch(/payment/i);
		expect(cart.cartId).toBe(b);
	});
});

describe("closing", () => {
	it("closes an empty cart at once and a full one only when confirmed", () => {
		const { cart, sessions } = setup();
		const a = cart.cartId;
		cart.items = [line()];
		sessions.create();
		const b = cart.cartId;

		expect(sessions.close(b).ok).toBe(true);
		expect(cart.cartId).toBe(a);
		expect(sessions.count).toBe(1);

		sessions.create();
		const c = cart.cartId;
		cart.items = [line()];
		const asked = sessions.close(c);
		expect(asked.ok).toBe(false);
		expect(asked.needsConfirm).toBe(true);
		expect(sessions.count).toBe(2);
		expect(sessions.close(c, { confirmed: true }).ok).toBe(true);
		expect(sessions.count).toBe(1);
	});

	it("keeps a usable cart when the last one is closed", () => {
		const { cart, sessions } = setup();
		cart.items = [line()];
		expect(sessions.close(cart.cartId).needsConfirm).toBe(true);
		expect(sessions.close(cart.cartId, { confirmed: true }).ok).toBe(true);
		expect(sessions.count).toBe(1);
		expect(cart.items).toHaveLength(0);
		expect(cart.customer?.name).toBe("Walk-in");
	});

	it("will not close or clear a cart whose payment is unconfirmed", () => {
		const { cart, sessions } = setup();
		cart.items = [line()];
		const id = cart.cartId;
		sessions.beginSubmit(id);
		expect(sessions.close(id, { confirmed: true }).ok).toBe(false);

		sessions.endSubmit(id, "uncertain");
		const refused = sessions.close(id, { confirmed: true });
		expect(refused.ok).toBe(false);
		expect(refused.reason).toMatch(/not confirmed/i);
		expect(sessions.canDiscard(id).ok).toBe(false);
		expect(cart.items).toHaveLength(1);

		sessions.endSubmit(id, "idle");
		expect(sessions.canDiscard(id).ok).toBe(true);
	});

	it("blocks closing the shift while a payment is unconfirmed", () => {
		const { cart, sessions } = setup();
		expect(sessions.shiftCloseBlocker()).toBe("");
		sessions.endSubmit(cart.cartId, "uncertain");
		expect(sessions.shiftCloseBlocker()).toMatch(/not been confirmed/i);
	});
});

describe("a sale finishing while another cart is active", () => {
	it("clears only the cart it came from", async () => {
		const { cart, sessions } = setup();
		const a = cart.cartId;
		cart.customer = { name: "CUST-A", customer_name: "Alice" };
		cart.items = [line({ rate: 30 })];
		const localId = cart.getInvoiceData("P", "S").local_id as string;
		sessions.beginSubmit(a);

		// The cashier is on Bob's cart when Alice's answer arrives.
		sessions.create({ force: true });
		const b = cart.cartId;
		cart.customer = { name: "CUST-B", customer_name: "Bob" };
		cart.items = [line({ item_code: "PEN", rate: 5 })];
		await nextTick();

		expect(sessions.finish({ cartId: a, localId })).toBe(true);
		expect(sessions.tabs.map((t) => t.id)).toEqual([b]);
		expect(cart.cartId).toBe(b);
		expect(cart.customer?.name).toBe("CUST-B");
		expect(cart.items).toHaveLength(1);
		expect(cart.items[0].item_code).toBe("PEN");
	});

	it("returns to the neighbouring cart when the active sale finishes, and keeps one when last", () => {
		const { cart, sessions } = setup();
		const a = cart.cartId;
		cart.customer = { name: "CUST-A", customer_name: "Alice" };
		cart.items = [line({ rate: 12 })];
		sessions.create();
		const b = cart.cartId;
		cart.items = [line({ rate: 8 })];
		const localId = cart.getInvoiceData("P", "S").local_id as string;

		expect(sessions.finish({ cartId: b, localId })).toBe(true);
		expect(cart.cartId).toBe(a);
		expect(cart.customer?.name).toBe("CUST-A");
		expect(cart.items[0].rate).toBe(12);

		const lastId = cart.getInvoiceData("P", "S").local_id as string;
		expect(sessions.finish({ cartId: a, localId: lastId })).toBe(true);
		expect(sessions.count).toBe(1);
		expect(cart.items).toHaveLength(0);
	});

	it("leaves a cart alone if it has become a different sale since", () => {
		const { cart, sessions } = setup();
		cart.items = [line()];
		const id = cart.cartId;
		cart.getInvoiceData("P", "S");
		expect(sessions.finish({ cartId: id, localId: "inv_some_other_sale" })).toBe(false);
		expect(cart.items).toHaveLength(1);
	});

	it("marks a cart submitting once, so a second submit has something to check", () => {
		const { cart, sessions } = setup();
		const id = cart.cartId;
		sessions.beginSubmit(id);
		expect(sessions.tabs[0].status).toBe("submitting");
		sessions.endSubmit(id, "idle");
		expect(sessions.tabs[0].status).toBe("idle");
	});
});

describe("answers that arrive after the cart changed", () => {
	it("recognises a token from before a switch, a clear or a close", () => {
		const { cart, sessions } = setup();
		cart.items = [line()];
		const token = cart.captureCart();
		expect(cart.isCurrentCart(token)).toBe(true);

		sessions.create();
		expect(cart.isCurrentCart(token)).toBe(false);

		sessions.switchTo(token.cartId);
		expect(cart.isCurrentCart(token)).toBe(false); // epoch moved on: same cart, not the same moment

		const fresh = cart.captureCart();
		cart.clearCart();
		expect(cart.isCurrentCart(fresh)).toBe(false);
	});

	it("drops a pricing answer that was in flight when the cart was switched", async () => {
		const { cart, sessions } = setup();
		let release: (value: unknown) => void = () => {};
		resolveCartPricing.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}) as never,
		);
		cart.items = [line({ item_code: "TV", rate: 100 })];
		await new Promise((r) => setTimeout(r, 300)); // the watcher's debounce fires, request pending

		sessions.create({ force: true });
		cart.items = [line({ item_code: "PEN", rate: 5 })];

		release({
			source: "server",
			lines: [{ index: 0, rate: 1, price_list_rate: 1, discount_percentage: 0, discount_amount: 0 }],
			free_items: [],
			discount: {},
		});
		await new Promise((r) => setTimeout(r, 50));
		expect(cart.items[0].item_code).toBe("PEN");
		expect(cart.items[0].rate).toBe(5);
	});

	it("loads a recalled order into a cart of its own and closes it again if loading fails", async () => {
		const { cart, sessions } = setup();
		cart.items = [line()];
		const a = cart.cartId;

		const failed = await sessions.loadIntoCart(() => false);
		expect(failed.ok).toBe(false);
		expect(sessions.count).toBe(1);
		expect(cart.cartId).toBe(a);

		const loaded = await sessions.loadIntoCart(() => {
			cart.currentDraftName = "DRAFT-1";
			cart.items = [line({ item_code: "RECALLED" })];
		});
		expect(loaded.ok).toBe(true);
		expect(sessions.count).toBe(2);
		expect(sessions.findByDraft("DRAFT-1")).toBe(cart.cartId);

		// Recalling it again goes to that tab instead of loading a second copy.
		sessions.switchTo(a);
		expect(sessions.findByDraft("DRAFT-1")).not.toBe("");
		expect(sessions.findByDraft("DRAFT-1")).not.toBe(a);
	});

	it("uses the cart on screen when it is empty", async () => {
		const { cart, sessions } = setup();
		const a = cart.cartId;
		const res = await sessions.loadIntoCart(() => {
			cart.items = [line({ item_code: "X" })];
		});
		expect(res.ok).toBe(true);
		expect(sessions.count).toBe(1);
		expect(cart.cartId).toBe(a);
	});
});

describe("serial and batch numbers across carts", () => {
	it("refuses a serial that is already in another cart", () => {
		const { cart, sessions } = setup();
		cart.items = [line({ item_code: "PHONE", serial_no: "SN-1", has_serial_no: true })];
		sessions.create();

		const result = cart.addItemWithDetails(
			{ item_code: "PHONE", item_name: "Phone", rate: 1, uom: "Nos", stock_uom: "Nos" } as never,
			1,
			1,
			"Nos",
			"SN-1",
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain("SN-1");
		expect(cart.serialCartElsewhere("SN-1")).toBe("Cart 1");
		expect(cart.serialCartElsewhere("SN-2")).toBe("");
	});

	it("blocks checkout when the same serial ends up in two carts", () => {
		const { cart, sessions } = setup();
		cart.items = [line({ item_code: "PHONE", serial_no: "SN-9" })];
		sessions.create();
		// forced in, as a restored or edited cart could be
		cart.items = [line({ item_code: "PHONE", serial_no: "SN-9" })];
		expect(cart.serialConflicts.length).toBe(1);
		expect(cart.checkoutBlockers.join(" ")).toContain("SN-9");
		cart.items = [];
		expect(cart.serialConflicts).toEqual([]);
	});

	it("counts batch quantity held in other carts", () => {
		const { cart, sessions } = setup();
		posState.blockSaleBeyondAvailableQty = true;
		cart.items = [line({ item_code: "MILK", batch_no: "B1", qty: 4, has_batch_no: true })];
		sessions.create();
		const check = cart.canAddItemWithDetails(
			{
				item_code: "MILK",
				item_name: "Milk",
				rate: 1,
				uom: "Nos",
				stock_uom: "Nos",
				has_batch_no: true,
				actual_qty: 5,
				batches: [{ batch_no: "B1", qty: 5 }],
			} as never,
			3,
			"B1",
		);
		expect(check.allowed).toBe(false);
	});
});
