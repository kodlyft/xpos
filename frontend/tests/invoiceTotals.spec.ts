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

describe("tax inclusion follows the POS Profile's Tax Inclusive setting", () => {
	const vat = (included: number) => ({
		description: "VAT",
		charge_type: "On Net Total",
		rate: 10,
		account_head: "VAT - TC",
		included_in_print_rate: included,
	});

	beforeEach(() => {
		pos.taxes = [];
		pos.taxInclusiveMode = false;
	});

	it("keeps the price as the total when the profile is inclusive and the template row is not", () => {
		pos.taxes = [vat(0)];
		pos.taxInclusiveMode = true;
		const cart = useCartStore();
		cart.items.push(line({ rate: 100000 }));

		expect(cart.taxAmount).toBe(0);
		expect(cart.includedTaxAmount).toBeCloseTo(9090.91, 2);
		expect(cart.grandTotal).toBe(100000);
	});

	it("adds the tax on top when the profile is not inclusive and the template row is", () => {
		pos.taxes = [vat(1)];
		const cart = useCartStore();
		cart.items.push(line({ rate: 100000 }));

		expect(cart.includedTaxAmount).toBe(0);
		expect(cart.taxAmount).toBe(10000);
		expect(cart.grandTotal).toBe(110000);
	});

	it("treats an item tax account outside the profile template the same way", () => {
		pos.taxes = [vat(0)];
		pos.taxInclusiveMode = true;
		const cart = useCartStore();
		cart.items.push(line({ rate: 100000, item_tax_map: { "Sales Tax - TC": 10 } }));

		// 100000 / 1.2 = 83333.33 net, 8333.33 for each of the two 10% accounts
		expect(cart.taxAmount).toBe(0);
		expect(cart.calculatedTaxes.map((t) => t.amount)).toEqual([8333.33, 8333.33]);
		expect(cart.grandTotal).toBe(100000);
	});

	it("splits an inclusive price by the sum of the inclusive rates, like ERPNext", () => {
		pos.taxes = [
			{ ...vat(0), rate: 9, account_head: "CGST - TC", description: "CGST" },
			{ ...vat(0), rate: 9, account_head: "SGST - TC", description: "SGST" },
		];
		pos.taxInclusiveMode = true;
		const cart = useCartStore();
		cart.items.push(line({ rate: 100000 }));

		// 100000 / 1.18 = 84745.76 net, 7627.12 for each 9% row
		expect(cart.calculatedTaxes.map((t) => t.amount)).toEqual([7627.12, 7627.12]);
		expect(cart.grandTotal).toBe(100000);
	});

	it("takes an item's own rate for a template row when splitting an inclusive price", () => {
		pos.taxes = [vat(0)];
		pos.taxInclusiveMode = true;
		const cart = useCartStore();
		cart.items.push(line({ rate: 100000, item_tax_map: { "VAT - TC": 5 } }));

		// 100000 / 1.05 = 95238.10 net, 4761.90 VAT at the item's 5%
		expect(cart.calculatedTaxes.map((t) => t.amount)).toEqual([4761.9]);
		expect(cart.grandTotal).toBe(100000);
	});

	it("prints the net total without the included tax on the receipt", () => {
		pos.taxes = [vat(0)];
		pos.taxInclusiveMode = true;
		const cart = useCartStore();
		cart.items.push(line({ rate: 100000 }));

		const receipt = cart.getReceiptSnapshot("SINV-1");
		expect(receipt.subtotal).toBe(100000);
		expect(receipt.net_total).toBe(90909.09);
		expect(receipt.grand_total).toBe(100000);
	});
});
