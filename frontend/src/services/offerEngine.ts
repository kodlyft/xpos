/**
 * POS Offer evaluation engine.
 *
 * Evaluates POS Offers against cart items and computes:
 *  - Item-level discounts (Item Price offers)
 *  - Free items (Give Product offers)
 *  - Grand Total discounts (Grand Total / Transaction‑level offers)
 *  - Loyalty point awards (Loyalty Point offers)
 */

import type { CartItem, POSOffer } from "@/types/pos.types";

export interface OfferItemDiscount {
	item_code: string;
	offer_name: string;
	offer_title: string;
	discount_percentage: number;
	discount_amount: number;
	fixed_rate: number | null;
}

export interface OfferFreeItem {
	item_code: string;
	item_name: string;
	qty: number;
	rate: number;
	offer_name: string;
	offer_title: string;
	is_replace: boolean;
}

export interface OfferGrandTotalDiscount {
	offer_name: string;
	offer_title: string;
	discount_percentage: number;
}

export interface OfferLoyaltyAward {
	offer_name: string;
	offer_title: string;
	loyalty_program: string;
	loyalty_points: number;
}

export interface OfferEvaluationResult {
	itemDiscounts: OfferItemDiscount[];
	freeItems: OfferFreeItem[];
	grandTotalDiscounts: OfferGrandTotalDiscount[];
	loyaltyAwards: OfferLoyaltyAward[];
}

function offerVal(offer: POSOffer, key: string, fallback: unknown = 0): unknown {
	const raw = (offer as Record<string, unknown>)[key];
	return raw ?? fallback;
}

function flt(v: unknown): number {
	if (typeof v === "number") return v;
	const n = parseFloat(String(v));
	return isNaN(n) ? 0 : n;
}

function str(v: unknown): string {
	if (typeof v === "string") return v;
	return String(v ?? "");
}

function doesOfferMatchItem(offer: POSOffer, item: CartItem): boolean {
	const applyOn = str(offerVal(offer, "apply_on", ""));

	if (applyOn === "Item Code") {
		const offerItem = str(offerVal(offer, "item", ""));
		return offerItem !== "" && offerItem === item.item_code;
	}

	if (applyOn === "Item Group") {
		const offerGroup = str(offerVal(offer, "item_group", ""));
		const itemGroup = str((item as Record<string, unknown>).item_group ?? "");
		return offerGroup !== "" && offerGroup === itemGroup;
	}

	if (applyOn === "Brand") {
		const offerBrand = str(offerVal(offer, "brand", ""));
		const itemBrand = str((item as Record<string, unknown>).brand ?? "");
		return offerBrand !== "" && offerBrand === itemBrand;
	}

	if (applyOn === "Transaction") {
		return false;
	}

	return false;
}

function checkQtyAmtConditions(offer: POSOffer, totalQty: number, totalAmt: number): boolean {
	const minQty = flt(offerVal(offer, "min_qty"));
	const maxQty = flt(offerVal(offer, "max_qty"));
	const minAmt = flt(offerVal(offer, "min_amt"));
	const maxAmt = flt(offerVal(offer, "max_amt"));

	if (minQty > 0 && totalQty < minQty) return false;
	if (maxQty > 0 && totalQty > maxQty) return false;
	if (minAmt > 0 && totalAmt < minAmt) return false;
	if (maxAmt > 0 && totalAmt > maxAmt) return false;

	return true;
}

/**
 * Evaluate a list of POS Offers against the current cart items.
 *
 * Only evaluates offers that are either auto-apply or explicitly applied
 * (e.g. via coupon). Coupon-based offers that haven't been activated
 * should be filtered out by the caller.
 */
export function evaluateOffers(offers: POSOffer[], cartItems: CartItem[]): OfferEvaluationResult {
	const result: OfferEvaluationResult = {
		itemDiscounts: [],
		freeItems: [],
		grandTotalDiscounts: [],
		loyaltyAwards: [],
	};

	if (!offers.length || !cartItems.length) return result;

	const realItems = cartItems.filter((i) => !i.pos_is_offer && i.qty > 0);
	if (!realItems.length) return result;

	for (const offer of offers) {
		if (offerVal(offer, "promo_source", "") === "Promotional Scheme") continue;

		const offerType = str(offerVal(offer, "offer", ""));
		const applyOn = str(offerVal(offer, "apply_on", ""));
		const offerName = offer.name || "";
		const offerTitle = str(offerVal(offer, "title", offerName));

		if (applyOn === "Transaction" || offerType === "Grand Total") {
			const totalQty = realItems.reduce((s, i) => s + Math.abs(i.qty), 0);
			const totalAmt = realItems.reduce((s, i) => s + Math.abs(i.qty) * i.rate, 0);

			if (!checkQtyAmtConditions(offer, totalQty, totalAmt)) continue;

			if (offerType === "Grand Total") {
				const discPct = flt(offerVal(offer, "discount_percentage"));
				if (discPct > 0) {
					result.grandTotalDiscounts.push({
						offer_name: offerName,
						offer_title: offerTitle,
						discount_percentage: discPct,
					});
				}
			} else if (offerType === "Give Product") {
				_evaluateGiveProduct(offer, offerName, offerTitle, realItems, result);
			} else if (offerType === "Loyalty Point") {
				_evaluateLoyaltyPoint(offer, offerName, offerTitle, result);
			}

			continue;
		}

		const matchingItems = realItems.filter((item) => doesOfferMatchItem(offer, item));
		if (!matchingItems.length) continue;

		const matchedQty = matchingItems.reduce((s, i) => s + Math.abs(i.qty), 0);
		const matchedAmt = matchingItems.reduce((s, i) => s + Math.abs(i.qty) * i.rate, 0);

		if (!checkQtyAmtConditions(offer, matchedQty, matchedAmt)) continue;

		if (offerType === "Item Price") {
			_evaluateItemPrice(offer, offerName, offerTitle, matchingItems, result);
		} else if (offerType === "Give Product") {
			_evaluateGiveProduct(offer, offerName, offerTitle, matchingItems, result);
		} else if (offerType === "Grand Total") {
			const discPct = flt(offerVal(offer, "discount_percentage"));
			if (discPct > 0) {
				result.grandTotalDiscounts.push({
					offer_name: offerName,
					offer_title: offerTitle,
					discount_percentage: discPct,
				});
			}
		} else if (offerType === "Loyalty Point") {
			_evaluateLoyaltyPoint(offer, offerName, offerTitle, result);
		}
	}

	return result;
}

function _evaluateItemPrice(
	offer: POSOffer,
	offerName: string,
	offerTitle: string,
	matchingItems: CartItem[],
	result: OfferEvaluationResult,
): void {
	const discountType = str(offerVal(offer, "discount_type", ""));

	for (const item of matchingItems) {
		const disc: OfferItemDiscount = {
			item_code: item.item_code,
			offer_name: offerName,
			offer_title: offerTitle,
			discount_percentage: 0,
			discount_amount: 0,
			fixed_rate: null,
		};

		if (discountType === "Rate") {
			disc.fixed_rate = flt(offerVal(offer, "rate"));
		} else if (discountType === "Discount Percentage") {
			disc.discount_percentage = flt(offerVal(offer, "discount_percentage"));
		} else if (discountType === "Discount Amount") {
			disc.discount_amount = flt(offerVal(offer, "discount_amount"));
		}

		result.itemDiscounts.push(disc);
	}
}

function _evaluateGiveProduct(
	offer: POSOffer,
	offerName: string,
	offerTitle: string,
	matchingItems: CartItem[],
	result: OfferEvaluationResult,
): void {
	const givenQty = flt(offerVal(offer, "given_qty"));
	if (givenQty <= 0) return;

	const applyType = str(offerVal(offer, "apply_type", ""));
	const replaceItem = !!offerVal(offer, "replace_item");
	const replaceCheapest = !!offerVal(offer, "replace_cheapest_item");

	if (replaceItem) {
		for (const item of matchingItems) {
			result.freeItems.push({
				item_code: item.item_code,
				item_name: item.item_name,
				qty: givenQty,
				rate: 0,
				offer_name: offerName,
				offer_title: offerTitle,
				is_replace: true,
			});
		}
		return;
	}

	if (replaceCheapest && matchingItems.length > 0) {
		const cheapest = [...matchingItems].sort((a, b) => a.rate - b.rate)[0];
		result.freeItems.push({
			item_code: cheapest.item_code,
			item_name: cheapest.item_name,
			qty: givenQty,
			rate: 0,
			offer_name: offerName,
			offer_title: offerTitle,
			is_replace: true,
		});
		return;
	}

	if (applyType === "Item Code") {
		const freeItemCode = str(offerVal(offer, "apply_item_code", ""));
		if (freeItemCode) {
			const lessThen = flt(offerVal(offer, "less_then"));
			result.freeItems.push({
				item_code: freeItemCode,
				item_name: freeItemCode,
				qty: givenQty,
				rate: lessThen > 0 ? lessThen : 0,
				offer_name: offerName,
				offer_title: offerTitle,
				is_replace: false,
			});
		}
	} else if (applyType === "Item Group") {
		const freeGroup = str(offerVal(offer, "apply_item_group", ""));
		if (freeGroup) {
			result.freeItems.push({
				item_code: "",
				item_name: `Free item from group: ${freeGroup}`,
				qty: givenQty,
				rate: 0,
				offer_name: offerName,
				offer_title: offerTitle,
				is_replace: false,
			});
		}
	}
}

function _evaluateLoyaltyPoint(
	offer: POSOffer,
	offerName: string,
	offerTitle: string,
	result: OfferEvaluationResult,
): void {
	const points = flt(offerVal(offer, "loyalty_points"));
	const program = str(offerVal(offer, "loyalty_program", ""));
	if (points > 0 && program) {
		result.loyaltyAwards.push({
			offer_name: offerName,
			offer_title: offerTitle,
			loyalty_program: program,
			loyalty_points: points,
		});
	}
}

/**
 * Given the list of grand-total-level offer discounts, compute the
 * total discount percentage (summed, capped at 100).
 */
export function computeGrandTotalDiscountPct(discounts: OfferGrandTotalDiscount[]): number {
	if (!discounts.length) return 0;
	const total = discounts.reduce((s, d) => s + d.discount_percentage, 0);
	return Math.min(total, 100);
}
