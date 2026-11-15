import { computed, reactive } from "vue";
import type { CatalogItem } from "@mobile/ports";
import { lineTotalMinor, QTY_SCALE } from "@mobile/domain/money";

export interface CartLine {
	itemCode: string;
	name: string;
	uom: string;
	/** Display price per unit of `uom` until the server quote replaces it. The quote is what is charged. */
	priceMinor: number;
	qtyMilli: number;
	attrs: Record<string, string>;
	/** A manual line discount in percent: only a user allowed to discount can set it; the server checks again. */
	discountPct?: number;
	/** A price the cashier set (decimal): only a user allowed to change prices can set it; the server checks again. */
	rateOverride?: number;
}

/** One line per item and unit of measure: a box and a single are priced differently. */
export const lineKey = (l: Pick<CartLine, "itemCode" | "uom">) => `${l.itemCode}|${l.uom}`;

/**
 * ONE cart for all three selling layouts. It is a module-level singleton, so switching layout (or
 * tabs) never recreates it. The sale id is created when the sale is captured (see useCheckout), not here.
 * Everything that changes what the sale costs (lines, coupons, loyalty, extra discount) lives here so one
 * watcher can re-ask the server whenever any of it changes.
 */
const cart = reactive({
	lines: [] as CartLine[],
	error: "",
	coupons: [] as string[],
	loyaltyPoints: 0,
	extraDiscountPct: 0,
});

/** Only an item with no price is blocked here. A priced 0.00 is allowed or refused by the POS Profile on the server. */
export const sellable = (item: CatalogItem) => item.priced;

/** Drops everything the previous customer or cashier decided: coupons, loyalty points, discounts and set prices. */
export function resetPricingChoices(): boolean {
	const had =
		cart.coupons.length > 0 ||
		cart.loyaltyPoints > 0 ||
		cart.extraDiscountPct > 0 ||
		cart.lines.some((l) => l.discountPct || l.rateOverride !== undefined);
	cart.coupons = [];
	cart.loyaltyPoints = 0;
	cart.extraDiscountPct = 0;
	for (const l of cart.lines) {
		delete l.discountPct;
		delete l.rateOverride;
	}
	return had;
}

export function useCart(currency = { code: "PKR", minorDigits: 2 }) {
	const total = computed(() =>
		cart.lines.reduce((s, l) => s + lineTotalMinor(l.priceMinor, l.qtyMilli), 0),
	);
	const count = computed(() => cart.lines.reduce((s, l) => s + l.qtyMilli, 0) / QTY_SCALE);

	function add(item: CatalogItem, qty = 1): boolean {
		if (!sellable(item)) {
			cart.error = `${item.name} has no price in the price list, so it cannot be sold. Ask a manager to add a price.`;
			return false;
		}
		cart.error = "";
		const ex = cart.lines.find((l) => lineKey(l) === lineKey({ itemCode: item.itemCode, uom: item.uom }));
		if (ex) ex.qtyMilli += qty * QTY_SCALE;
		else
			cart.lines.push({
				itemCode: item.itemCode,
				name: item.name,
				uom: item.uom,
				priceMinor: item.priceMinor,
				qtyMilli: qty * QTY_SCALE,
				attrs: { ...item.attrs },
			});
		return true;
	}
	function change(key: string, deltaUnits: number) {
		const l = cart.lines.find((x) => lineKey(x) === key);
		if (!l) return;
		l.qtyMilli += deltaUnits * QTY_SCALE;
		if (l.qtyMilli <= 0) remove(key);
	}
	function remove(key: string) {
		cart.lines = cart.lines.filter((l) => lineKey(l) !== key);
	}
	function clear() {
		cart.lines = [];
		cart.error = "";
		cart.coupons = [];
		cart.loyaltyPoints = 0;
		cart.extraDiscountPct = 0;
	}

	return {
		cart,
		total,
		count,
		add,
		change,
		remove,
		clear,
	};
}
