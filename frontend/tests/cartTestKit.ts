import type { CartItem } from "@/types/pos.types";

/** A stand-in for the POS store: just the fields the cart reads. */
export const posState: Record<string, unknown> = {
	taxes: [],
	taxInclusiveMode: false,
	profile: { name: "POS-PROFILE-1", warehouse: "Store - TC", currency: "USD" },
	profileName: "POS-PROFILE-1",
	companyName: "Test Co",
	currency: "USD",
	warehouse: "Store - TC",
	defaultCustomer: "Walk-in",
	posOpeningShift: { name: "SHIFT-1" },
	isReady: true,
	tenderModeFor: () => undefined,
};

let seq = 0;
export function line(overrides: Partial<CartItem> = {}): CartItem {
	seq += 1;
	return {
		uid: `row-test-${seq}`,
		item_code: "ITEM-001",
		item_name: "Test Item",
		qty: 1,
		rate: 100,
		uom: "Nos",
		stock_uom: "Nos",
		discount_percentage: 0,
		discount_amount: 0,
		...overrides,
	} as CartItem;
}

export function resetPos(): void {
	posState.defaultCustomer = "Walk-in";
	posState.posOpeningShift = { name: "SHIFT-1" };
	posState.isReady = true;
	posState.blockSaleBeyondAvailableQty = false;
}
