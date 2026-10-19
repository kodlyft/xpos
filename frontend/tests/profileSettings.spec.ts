/**
 * @vitest-environment jsdom
 *
 * POS Profile settings previewed in the cart (the server re-checks all of them):
 * force_price_from_customer_price_list, allow_zero_rated_items,
 * apply_customer_discount and use_delivery_charges.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick, reactive } from "vue";
import { setActivePinia, createPinia } from "pinia";

vi.mock("@/services/api", () => ({
	call: vi.fn(),
	default: { call: vi.fn() },
	showError: vi.fn(),
	showSuccess: vi.fn(),
	showInfo: vi.fn(),
}));

vi.mock("@/services/dbBridge", () => ({
	getCachedItemByCode: vi.fn(async () => null),
	getCachedStockForItem: vi.fn(async () => null),
}));

const online = { value: true };
vi.mock("@/utils", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/utils")>()),
	isOnline: () => online.value,
}));

const pos = reactive({
	taxes: [] as unknown[],
	taxInclusiveMode: false,
	profileName: "POS-1",
	companyName: "Test Co",
	sellingPriceList: "Standard Selling",
	warehouse: "Stores - TC",
	currency: "USD",
	currencySymbol: "$",
	disableRoundedTotal: true,
	allowChangePostingDate: false,
	blockSaleBeyondAvailableQty: false,
	stockSettings: { allow_negative_stock: true },
	forcePriceFromCustomerPriceList: false,
	allowZeroRatedItems: false,
	applyCustomerDiscount: false,
	maxDiscountAllowed: 0,
	useDeliveryCharges: false,
	posProfile: { default_purchase_uom: "" } as Record<string, unknown>,
});
vi.mock("@/stores/posStore", () => ({ usePosStore: vi.fn(() => pos) }));

vi.mock("@/services/pricingService", () => ({
	resolveCartPricing: vi.fn(async () => ({
		updates: [],
		free_lines: [],
		invoice_updates: {
			additional_discount_percentage: 0,
			discount_amount: 0,
			apply_discount_on: "Grand Total",
			from_pricing_rule: false,
		},
		source: "server",
	})),
	refreshPricingRuleSnapshot: vi.fn(async () => []),
}));

import { call } from "@/services/api";
import { getCachedItemByCode } from "@/services/dbBridge";
import { useCartStore } from "@/stores/cartStore";
import type { POSItem, POSOffer } from "@/types/pos.types";

const mockedCall = vi.mocked(call);

function posItem(overrides: Partial<POSItem> = {}): POSItem {
	return {
		item_code: "ITEM-A",
		item_name: "Item A",
		rate: 100,
		uom: "Nos",
		stock_uom: "Nos",
		is_stock_item: false,
		...overrides,
	} as POSItem;
}

function priceReply(priceList: string, price: number | null) {
	return (_method: string, args: Record<string, unknown>) => {
		const lines = JSON.parse(String(args.lines)) as { row_id: string }[];
		return Promise.resolve({
			price_list: priceList,
			prices: Object.fromEntries(lines.map((l) => [l.row_id, price])),
		});
	};
}

beforeEach(() => {
	setActivePinia(createPinia());
	vi.clearAllMocks();
	online.value = true;
	Object.assign(pos, {
		forcePriceFromCustomerPriceList: false,
		allowZeroRatedItems: false,
		applyCustomerDiscount: false,
		maxDiscountAllowed: 0,
		useDeliveryCharges: false,
	});
});

describe("force_price_from_customer_price_list", () => {
	it("reprices lines from the customer's list and back when the customer is cleared", async () => {
		pos.forcePriceFromCustomerPriceList = true;
		const cart = useCartStore();
		cart.addItem(posItem());

		mockedCall.mockImplementation(priceReply("VIP List", 80) as never);
		cart.setCustomer({ name: "CUST-VIP" });
		await cart.applyCustomerPriceList();
		expect(cart.items[0].rate).toBe(80);
		expect(cart.cartPriceList).toBe("VIP List");
		expect(mockedCall.mock.calls[0][1]).toMatchObject({ pos_profile: "POS-1", customer: "CUST-VIP" });

		mockedCall.mockImplementation(priceReply("Standard Selling", 100) as never);
		cart.setCustomer(null);
		await cart.applyCustomerPriceList();
		expect(cart.items[0].rate).toBe(100);
		expect(cart.cartPriceList).toBe("Standard Selling");
	});

	it("marks a missing price as unavailable instead of selling it free", async () => {
		pos.forcePriceFromCustomerPriceList = true;
		pos.allowZeroRatedItems = true;
		const cart = useCartStore();
		cart.addItem(posItem());
		mockedCall.mockImplementation(priceReply("VIP List", null) as never);
		cart.setCustomer({ name: "CUST-VIP" });
		await cart.applyCustomerPriceList();

		expect(cart.items[0].rate).toBe(0);
		expect(cart.items[0].pos_price_unavailable).toBe(true);
		expect(cart.items[0].pos_price_state).toBe("no_price");
		expect(cart.pricingIssues[0]).toContain("no price is configured");
	});

	it("leaves a manually overridden rate alone", async () => {
		pos.forcePriceFromCustomerPriceList = true;
		const cart = useCartStore();
		cart.addItem(posItem());
		cart.updateItemRate(0, 55);
		cart.setCustomer({ name: "CUST-VIP" });
		await cart.applyCustomerPriceList();

		expect(cart.items[0].rate).toBe(55);
		expect(mockedCall).not.toHaveBeenCalled();
	});

	it("offline, a customer with a different list cannot be priced, so checkout blocks", async () => {
		pos.forcePriceFromCustomerPriceList = true;
		online.value = false;
		const cart = useCartStore();
		cart.addItem(posItem());
		cart.setCustomer({ name: "CUST-VIP", pos_price_list: "VIP List" } as never);
		await cart.applyCustomerPriceList();

		expect(cart.items[0].pos_price_unavailable).toBe(true);
		expect(cart.items[0].pos_price_state).toBe("needs_connection");
		expect(cart.pricingIssues[0]).toContain("connect to the server");
		expect(cart.items).toHaveLength(1);
		expect(mockedCall).not.toHaveBeenCalled();
	});

	it("reprices lines that needed a connection as soon as it is back", async () => {
		vi.useFakeTimers();
		try {
			pos.forcePriceFromCustomerPriceList = true;
			online.value = false;
			const cart = useCartStore();
			cart.addItem(posItem());
			cart.setCustomer({ name: "CUST-VIP", pos_price_list: "VIP List" } as never);
			await cart.applyCustomerPriceList();
			expect(cart.items[0].pos_price_state).toBe("needs_connection");

			online.value = true;
			mockedCall.mockImplementation(priceReply("VIP List", 80) as never);
			window.dispatchEvent(new Event("online"));
			await vi.advanceTimersByTimeAsync(200);

			// (Stores left by earlier tests listen too; this cart's line is what matters.)
			expect(mockedCall).toHaveBeenCalled();
			expect(cart.items[0].rate).toBe(80);
			expect(cart.items[0].pos_price_unavailable).toBe(false);
			expect(cart.pricingIssues).toHaveLength(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("offline, a customer-group list from the server is used to decide what is known", async () => {
		pos.forcePriceFromCustomerPriceList = true;
		online.value = false;
		const cart = useCartStore();
		cart.addItem(posItem());
		// The group fallback resolved to the profile list: cached profile prices are valid.
		vi.mocked(getCachedItemByCode).mockResolvedValue({ stock_uom: "Nos", rate: 100 } as never);
		cart.setCustomer({ name: "CUST-GROUP", pos_price_list: "Standard Selling" } as never);
		await cart.applyCustomerPriceList();
		expect(cart.items[0].pos_price_state).toBeUndefined();
		expect(cart.items[0].rate).toBe(100);
		vi.mocked(getCachedItemByCode).mockResolvedValue(null as never);
	});

	it("does nothing when the profile does not force customer prices", async () => {
		const cart = useCartStore();
		cart.addItem(posItem());
		cart.setCustomer({ name: "CUST-VIP" });
		await cart.applyCustomerPriceList();

		expect(cart.items[0].rate).toBe(100);
		expect(mockedCall).not.toHaveBeenCalled();
	});
});

describe("allow_zero_rated_items", () => {
	it("flags zero-price and 100%-discount lines unless the profile allows them", () => {
		const cart = useCartStore();
		cart.addItem(posItem({ rate: 0 }));
		cart.addItem(posItem({ item_code: "ITEM-B", item_name: "Item B" }));
		cart.updateItemDiscount(1, "percentage", 100);
		expect(cart.pricingIssues).toHaveLength(2);

		pos.allowZeroRatedItems = true;
		expect(cart.pricingIssues).toHaveLength(0);
	});
});

describe("server repricing", () => {
	it("adopts the server's prices and blocks payment until the cashier reviews them", () => {
		const cart = useCartStore();
		cart.addItem(posItem({ rate: 90 }));
		const rowId = cart.getInvoiceData("POS-1", "SHIFT-1").items[0].row_id;
		expect(rowId).toBeTruthy();

		cart.applyServerRepricing({
			status: "reprice_required",
			lines: [
				{
					row_id: rowId,
					index: 0,
					item_code: "ITEM-A",
					quoted_rate: 90,
					rate: 100,
					price_list_rate: 100,
					discount_percentage: 0,
					discount_amount: 0,
				},
			],
			additional_discount_percentage: 0,
			discount_amount: 0,
			discount_changed: false,
			grand_total: 100,
			rounded_total: 100,
			message: "Prices changed",
		});

		expect(cart.items[0].rate).toBe(100);
		expect(cart.items[0].pos_repriced_from).toBe(90);
		expect(cart.items).toHaveLength(1);
		expect(cart.pricingIssues[0]).toContain("Review the updated prices");

		cart.acknowledgeRepricing();
		expect(cart.pricingIssues).toHaveLength(0);
		expect(cart.items[0].pos_repriced_from).toBeUndefined();
	});
});

describe("server discount with POS Offers", () => {
	it("blocks payment until the offers are removed, then takes the server's discount", () => {
		const cart = useCartStore();
		cart.addItem(posItem({ rate: 100 }));
		cart.applyOffer({
			name: "OFFER-1",
			title: "10% off",
			offer_type: "",
			disabled: false,
			offer: "Item Price",
			apply_on: "Item Code",
			item: "ITEM-A",
			discount_type: "Discount Percentage",
			discount_percentage: 10,
		} as POSOffer);
		expect(cart.offerItemDiscountTotal).toBeGreaterThan(0);

		const response = {
			status: "reprice_required" as const,
			lines: [],
			additional_discount_percentage: 5,
			discount_amount: 0,
			discount_changed: true,
			offer_conflict: true,
			grand_total: 95,
			rounded_total: 95,
			message: "A pricing rule sets this sale's invoice discount",
		};
		cart.applyServerRepricing(response);
		cart.acknowledgeRepricing();
		expect(cart.pricingIssues.join()).toContain("Remove the offers");

		cart.removeOffer("OFFER-1");
		expect(cart.pricingIssues).toHaveLength(0);
		// The next answer, now without offers, is adopted like any other repricing.
		cart.applyServerRepricing({ ...response, offer_conflict: false });
		expect(cart.discountPercentage).toBe(5);
	});
});

describe("zero payable", () => {
	it("an invoice discount that wipes out the total is refused unless zero prices are allowed", () => {
		const cart = useCartStore();
		cart.addItem(posItem());
		cart.setDiscount("percentage", 100);
		expect(cart.pricingIssues.join()).toContain("totals zero");
		pos.allowZeroRatedItems = true;
		expect(cart.pricingIssues).toHaveLength(0);
	});
});

describe("apply_customer_discount", () => {
	it("applies, replaces and removes the customer's discount without stacking", async () => {
		pos.applyCustomerDiscount = true;
		const cart = useCartStore();
		cart.addItem(posItem());

		cart.setCustomer({ name: "CUST-VIP", discount: 10 } as never);
		await nextTick();
		expect(cart.discountPercentage).toBe(10);
		expect(cart.getInvoiceData("POS-1", "SHIFT-1").discount_source).toBe("customer");

		cart.setCustomer({ name: "CUST-VIP", discount: 10 } as never);
		await nextTick();
		expect(cart.discountPercentage).toBe(10);

		cart.setCustomer({ name: "CUST-PLAIN", discount: 0 } as never);
		await nextTick();
		expect(cart.discountPercentage).toBe(0);
	});

	it("never overrides a manual discount, and respects the profile maximum", async () => {
		pos.applyCustomerDiscount = true;
		pos.maxDiscountAllowed = 5;
		const cart = useCartStore();
		cart.addItem(posItem());

		cart.setCustomer({ name: "CUST-VIP", discount: 10 } as never);
		await nextTick();
		expect(cart.discountPercentage).toBe(5);

		cart.setDiscount("percentage", 3);
		cart.setCustomer({ name: "CUST-OTHER", discount: 8 } as never);
		await nextTick();
		expect(cart.discountPercentage).toBe(3);
		expect(cart.getInvoiceData("POS-1", "SHIFT-1").discount_source).toBeUndefined();
	});

	it("is off when the profile setting is off", async () => {
		const cart = useCartStore();
		cart.addItem(posItem());
		cart.setCustomer({ name: "CUST-VIP", discount: 10 } as never);
		await nextTick();
		expect(cart.discountPercentage).toBe(0);
	});
});

describe("use_delivery_charges", () => {
	it("only sends a delivery charge when the profile enables delivery", () => {
		const cart = useCartStore();
		cart.addItem(posItem());
		cart.setDeliveryCharge({ name: "Home", label: "Home", rate: 20, default_rate: 20 } as never);

		expect(cart.getInvoiceData("POS-1", "SHIFT-1").pos_delivery_charges).toBeUndefined();
		pos.useDeliveryCharges = true;
		expect(cart.getInvoiceData("POS-1", "SHIFT-1").pos_delivery_charges).toBe("Home");
	});
});

describe("default_purchase_uom", () => {
	it("defaults new purchase lines to the profile UOM only when the item converts to it", async () => {
		const { usePurchaseStore } = await import("@/stores/purchaseStore");
		const purchase = usePurchaseStore();
		const item = {
			item_code: "BOXED",
			item_name: "Boxed",
			stock_uom: "Nos",
			purchase_uom: "Pack",
			item_uoms: [
				{ uom: "Nos", conversion_factor: 1 },
				{ uom: "Box", conversion_factor: 12 },
				{ uom: "Pack", conversion_factor: 6 },
			],
		};

		pos.posProfile = { default_purchase_uom: "Box" };
		expect(purchase.defaultPurchaseUom(item)).toEqual({ uom: "Box", conversion_factor: 12 });

		pos.posProfile = { default_purchase_uom: "Pallet" };
		expect(purchase.defaultPurchaseUom(item)).toEqual({ uom: "Pack", conversion_factor: 6 });

		expect(purchase.defaultPurchaseUom({ ...item, purchase_uom: undefined })).toEqual({
			uom: "Nos",
			conversion_factor: 1,
		});
	});
});
