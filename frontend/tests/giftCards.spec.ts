/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const posState = vi.hoisted(() => ({
	giftCards: { mode_of_payment: "Gift Card", item: "GIFT-CARD", min_amount: 5, max_amount: 500 } as {
		mode_of_payment: string;
		item: string;
		min_amount: number;
		max_amount: number;
	} | null,
	disableRoundedTotal: false,
}));

const queue = vi.hoisted(() => ({ addPendingInvoice: vi.fn() }));

vi.mock("@/services/api", () => ({ call: vi.fn(), showInfo: vi.fn(), default: { call: vi.fn() } }));
vi.mock("@/services/dbBridge", () => ({
	addPendingInvoice: queue.addPendingInvoice,
	getPendingInvoices: vi.fn(async () => []),
	getPendingCount: vi.fn(async () => 0),
}));
vi.mock("@/stores/posStore", () => ({
	usePosStore: vi.fn(() => ({
		taxes: [
			{
				description: "VAT",
				charge_type: "On Net Total",
				rate: 10,
				account_head: "VAT - T",
				included_in_print_rate: 0,
			},
		],
		taxInclusiveMode: false,
		disableRoundedTotal: posState.disableRoundedTotal,
		giftCards: posState.giftCards,
		currency: "USD",
		allowChangePostingDate: false,
		tenderModeFor: vi.fn(() => undefined),
	})),
}));

import { useCartStore } from "@/stores/cartStore";
import { hasGiftCardActivity } from "@/services/giftCards";
import { buildTenderLeg, mergeTenderLeg, negateForReturn, toInvoicePayments } from "@/services/tenderLegs";
import { buildGiftCardSlipHtml } from "@/services/receiptTemplate";
import type { CartItem, TenderLeg } from "@/types/pos.types";

const ctx = { invoiceCurrency: "USD", modeInfo: () => undefined };

function merch(rate: number): CartItem {
	return {
		item_code: "TSHIRT",
		item_name: "T-Shirt",
		qty: 1,
		rate,
		uom: "Nos",
		stock_uom: "Nos",
		discount_percentage: 0,
		discount_amount: 0,
	};
}

function giftLeg(card: string, amount: number): TenderLeg {
	return {
		...buildTenderLeg("Gift Card", amount, ctx),
		gift_card: card,
		gift_card_auth: `auth-${card}`,
		masked_code: "••••-1234",
	};
}

describe("gift card tender legs", () => {
	it("keeps two cards on separate rows and merges the same card", () => {
		const legs: TenderLeg[] = [];
		mergeTenderLeg(legs, giftLeg("A", 30.25), ctx);
		mergeTenderLeg(legs, giftLeg("B", 10), ctx);
		mergeTenderLeg(legs, buildTenderLeg("Cash", 5, ctx), ctx);
		mergeTenderLeg(legs, buildTenderLeg("Cash", 5, ctx), ctx);
		expect(legs.map((l) => [l.mode_of_payment, l.gift_card, l.native_amount])).toEqual([
			["Gift Card", "A", 30.25],
			["Gift Card", "B", 10],
			["Cash", undefined, 10],
		]);
	});

	it("sends the live-check token for a sale and the card for a refund, never the code", () => {
		const sale = toInvoicePayments([giftLeg("A", 100.5), buildTenderLeg("Cash", 20, ctx)], "USD");
		expect(sale).toEqual([
			{ mode_of_payment: "Gift Card", amount: 100.5, gift_card_auth: "auth-A" },
			{ mode_of_payment: "Cash", amount: 20 },
		]);
		const refundLeg = { ...buildTenderLeg("Gift Card", 30, ctx), gift_card: "A" };
		expect(negateForReturn(toInvoicePayments([refundLeg], "USD"))).toEqual([
			{ mode_of_payment: "Gift Card", amount: -30, gift_card: "A" },
		]);
		expect(JSON.stringify(sale)).not.toContain("masked");
	});

	it("recognises any sale that sells or spends a card", () => {
		expect(hasGiftCardActivity({ items: [], payments: [{ mode_of_payment: "Cash", amount: 1 }] })).toBe(
			false,
		);
		expect(
			hasGiftCardActivity({
				items: [],
				payments: [{ mode_of_payment: "Gift Card", amount: 1, gift_card_auth: "t" }],
			}),
		).toBe(true);
		expect(
			hasGiftCardActivity({
				items: [{ item_code: "GIFT-CARD", qty: 1, rate: 5, gift_card_issue: 1 } as never],
				payments: [],
			}),
		).toBe(true);
	});
});

describe("selling a gift card in the cart", () => {
	beforeEach(() => {
		posState.giftCards = {
			mode_of_payment: "Gift Card",
			item: "GIFT-CARD",
			min_amount: 5,
			max_amount: 500,
		};
		setActivePinia(createPinia());
	});

	it("adds an untaxed, unrounded line for the exact value", () => {
		const cart = useCartStore();
		expect(cart.addGiftCardLine(100.5).success).toBe(true);
		expect(cart.calculatedTaxes).toEqual([]);
		expect(cart.grandTotal).toBe(100.5);
		const [line] = cart.getInvoiceData("POS", "SHIFT").items;
		expect(line).toMatchObject({ item_code: "GIFT-CARD", rate: 100.5, qty: 1, gift_card_issue: 1 });
	});

	it("keeps gift cards and goods on separate sales", () => {
		const cart = useCartStore();
		cart.addGiftCardLine(20);
		expect(cart.addItem(merch(10)).success).toBe(false);

		const other = (setActivePinia(createPinia()), useCartStore());
		other.items.push(merch(10));
		expect(other.addGiftCardLine(20).success).toBe(false);
	});

	it("enforces the configured value range and needs gift cards enabled", () => {
		const cart = useCartStore();
		expect(cart.addGiftCardLine(1).success).toBe(false);
		expect(cart.addGiftCardLine(5000).success).toBe(false);
		expect(cart.addGiftCardLine(0).success).toBe(false);
		posState.giftCards = null;
		setActivePinia(createPinia());
		expect(useCartStore().addGiftCardLine(50).success).toBe(false);
	});

	it("stops rounding once a card is tendered, so the card pays to the cent", () => {
		const cart = useCartStore();
		cart.items.push(merch(27.5));
		expect(cart.grandTotal).toBe(30); // 27.50 + 10% VAT = 30.25, rounded
		cart.setGiftCardTender(true);
		expect(cart.grandTotal).toBe(30.25);
		cart.clearCart();
		expect(cart.giftCardTender).toBe(false);
	});
});

describe("offline queue", () => {
	beforeEach(() => {
		setActivePinia(createPinia());
		queue.addPendingInvoice.mockReset();
	});

	it("refuses to queue a sale that spends or sells a card", async () => {
		const { useOfflineStore } = await import("@/stores/offlineStore");
		const offline = useOfflineStore();
		const result = await offline.saveOffline({
			pos_profile: "POS",
			customer: "Walk-in",
			items: [],
			payments: [{ mode_of_payment: "Gift Card", amount: 10, gift_card_auth: "t" }],
		} as never);
		expect(result.success).toBe(false);
		expect(queue.addPendingInvoice).not.toHaveBeenCalled();
	});
});

describe("issued card slip", () => {
	it("prints the code once, escaped", () => {
		const html = buildGiftCardSlipHtml([
			{
				gift_card: "x",
				code: "ABCD-EFGH-JKMN-<b>",
				masked_code: "••••-<b>",
				amount: 100.5,
				currency: "USD",
			},
		]);
		expect(html).toContain("ABCD-EFGH-JKMN-&lt;b&gt;");
		expect(html).not.toContain("<b>");
	});
});
