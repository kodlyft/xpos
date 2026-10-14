import { describe, expect, it } from "vitest";

import { evaluateOffers } from "@/services/offerEngine";
import type { CartItem, POSOffer } from "@/types/pos.types";

const item = { item_code: "ITEM-1", item_name: "Item 1", qty: 2, rate: 100 } as CartItem;

const itemPriceOffer = {
	name: "OFFER-1",
	title: "10% off",
	offer_type: "",
	disabled: false,
	offer: "Item Price",
	apply_on: "Item Code",
	item: "ITEM-1",
	discount_type: "Discount Percentage",
	discount_percentage: 10,
} as POSOffer;

describe("evaluateOffers", () => {
	it("applies an ordinary POS Offer", () => {
		const result = evaluateOffers([itemPriceOffer], [item]);

		expect(result.itemDiscounts).toHaveLength(1);
		expect(result.itemDiscounts[0].discount_percentage).toBe(10);
	});

	it("never applies a Promotional Scheme offer, which ERPNext already applies as a Pricing Rule", () => {
		const schemeOffer = {
			...itemPriceOffer,
			name: "ps-scheme-item_1-row",
			promo_source: "Promotional Scheme",
			promotional_scheme: "Scheme",
		} as POSOffer;

		const result = evaluateOffers([schemeOffer], [item]);

		expect(result.itemDiscounts).toHaveLength(0);
		expect(result.freeItems).toHaveLength(0);
		expect(result.grandTotalDiscounts).toHaveLength(0);
	});
});
