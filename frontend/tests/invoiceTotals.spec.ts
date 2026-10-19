/**
 * @vitest-environment jsdom
 *
 * What the invoice payload claims: the total ERPNext will compute (#178) and the offers that fired (#180).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";

vi.mock("@/services/api", () => ({ call: vi.fn(), default: { call: vi.fn() } }));

const pos = {
	taxes: [] as unknown[],
	taxInclusiveMode: false,
	disableRoundedTotal: true,
	profile: { name: "P", warehouse: "W", currency: "VND" },
	currency: "VND",
	invoiceCurrency: "VND",
	tenderModeFor: vi.fn(() => undefined),
};
vi.mock("@/stores/posStore", () => ({ usePosStore: vi.fn(() => pos) }));

import { useCartStore } from "@/stores/cartStore";
import { resetCurrencyCache } from "@/composables/useCurrency";
import type { CartItem, POSOffer } from "@/types/pos.types";

function line(overrides: Partial<CartItem> = {}): CartItem {
	return {
		item_code: "ITEM-1",
		item_name: "Item 1",
		qty: 1,
		rate: 96662.5,
		uom: "Nos",
		discount_percentage: 0,
		discount_amount: 0,
		...overrides,
	};
}

const minQtyOffer = {
	name: "OFFER-MIN-100",
	title: "5% from 100",
	disabled: false,
	offer: "Item Price",
	apply_on: "Item Code",
	item: "ITEM-1",
	auto: 1,
	min_qty: 100,
	discount_type: "Discount Percentage",
	discount_percentage: 5,
} as unknown as POSOffer;

beforeEach(() => {
	setActivePinia(createPinia());
	(window as any).xpos = { boot: { currencies: [{ name: "VND", number_format: "#.###" }] } };
	resetCurrencyCache();
	pos.disableRoundedTotal = true;
});

describe("grand total with rounded total disabled (#178)", () => {
	it("is rounded to the currency precision like ERPNext's grand_total", () => {
		const cart = useCartStore();
		cart.items.push(line());

		expect(cart.grandTotal).toBe(96663);
	});
});

describe("offers on the invoice (#180)", () => {
	it("leaves out an auto offer whose conditions the cart does not meet", () => {
		const cart = useCartStore();
		cart.items.push(line({ rate: 100 }));
		cart.applyOffer(minQtyOffer);

		const data = cart.getInvoiceData("P", "SHIFT");
		expect(data.offers).toBeUndefined();
		expect(data.offers_detail).toBeUndefined();
	});

	it("records the offer once the cart meets it", () => {
		const cart = useCartStore();
		cart.items.push(line({ rate: 100, qty: 100 }));
		cart.applyOffer(minQtyOffer);

		const data = cart.getInvoiceData("P", "SHIFT");
		expect(JSON.parse(data.offers as string)).toEqual(["OFFER-MIN-100"]);
		expect(data.offers_detail).toMatchObject([{ offer_name: "OFFER-MIN-100", offer_applied: 1 }]);
	});
});
