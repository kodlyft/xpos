/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";

useCartStore;

// Mock the API module
vi.mock("@/services/api", () => ({
	call: vi.fn(),
	default: { call: vi.fn() },
}));

// Mock usePosStore
vi.mock("@/stores/posStore", () => ({
	usePosStore: vi.fn(() => ({
		taxes: [],
		taxInclusiveMode: false,
		profile: {
			name: "POS-PROFILE-1",
			warehouse: "Store - TC",
			currency: "USD",
		},
		currency: "USD",
		// The receipt snapshot reads the rate date off the mode, not the payment row.
		tenderModeFor: vi.fn(() => undefined),
	})),
}));

// Import after mocking
import { useCartStore } from "@/stores/cartStore.ts";
import type { CartItem } from "@/types/pos.types";

function makeItem(overrides: Partial<CartItem> = {}): CartItem {
	return {
		item_code: "ITEM-001",
		item_name: "Test Item",
		qty: 1,
		rate: 100,
		uom: "Nos",
		discount_percentage: 0,
		discount_amount: 0,
		...overrides,
	};
}

describe("Cart Store", () => {
	beforeEach(() => {
		setActivePinia(createPinia());
		vi.clearAllMocks();
	});

	describe("Item Management", () => {
		it("should start with empty cart", () => {
			const cartStore = useCartStore();

			expect(cartStore.items).toEqual([]);
			expect(cartStore.itemCount).toBe(0);
			expect(cartStore.isEmpty).toBe(true);
		});

		it("should add item to cart", () => {
			const cartStore = useCartStore();
			const item: CartItem = {
				item_code: "ITEM-001",
				item_name: "Test Item",
				qty: 1,
				rate: 100,
				uom: "Nos",
				discount_percentage: 0,
				discount_amount: 0,
			};

			cartStore.items.push(item);

			expect(cartStore.items.length).toBe(1);
			expect(cartStore.items[0].item_code).toBe("ITEM-001");
		});

		it("should calculate item count correctly", () => {
			const cartStore = useCartStore();
			cartStore.items = [
				{
					item_code: "ITEM-001",
					item_name: "Item 1",
					qty: 2,
					rate: 50,
					uom: "Nos",
					discount_percentage: 0,
					discount_amount: 0,
				},
				{
					item_code: "ITEM-002",
					item_name: "Item 2",
					qty: 3,
					rate: 30,
					uom: "Nos",
					discount_percentage: 0,
					discount_amount: 0,
				},
			];

			expect(cartStore.itemCount).toBe(5);
		});

		it("should handle return items with negative quantities", () => {
			const cartStore = useCartStore();
			cartStore.items = [
				{
					item_code: "ITEM-001",
					item_name: "Return Item",
					qty: -2,
					rate: 50,
					uom: "Nos",
					discount_percentage: 0,
					discount_amount: 0,
				},
			];

			expect(cartStore.itemCount).toBe(2); // Absolute value
		});
	});

	describe("Subtotal Calculation", () => {
		it("should calculate subtotal without discounts", () => {
			const cartStore = useCartStore();
			cartStore.items = [
				{
					item_code: "ITEM-001",
					item_name: "Item 1",
					qty: 2,
					rate: 50,
					uom: "Nos",
					discount_percentage: 0,
					discount_amount: 0,
				},
				{
					item_code: "ITEM-002",
					item_name: "Item 2",
					qty: 1,
					rate: 100,
					uom: "Nos",
					discount_percentage: 0,
					discount_amount: 0,
				},
			];

			expect(cartStore.subtotal).toBe(200); // 2*50 + 1*100
		});

		it("should apply percentage discount to items", () => {
			const cartStore = useCartStore();
			cartStore.items = [
				{
					item_code: "ITEM-001",
					item_name: "Item 1",
					qty: 1,
					rate: 100,
					uom: "Nos",
					discount_percentage: 10,
					discount_amount: 0,
				},
			];

			expect(cartStore.subtotal).toBe(90); // 100 - 10% = 90
		});

		it("should apply amount discount to items", () => {
			const cartStore = useCartStore();
			cartStore.items = [
				{
					item_code: "ITEM-001",
					item_name: "Item 1",
					qty: 1,
					rate: 100,
					uom: "Nos",
					discount_percentage: 0,
					discount_amount: 15,
				},
			];

			expect(cartStore.subtotal).toBe(85); // 100 - 15 = 85
		});

		it("should handle return item discounts correctly", () => {
			const cartStore = useCartStore();
			cartStore.items = [
				{
					item_code: "ITEM-001",
					item_name: "Return Item",
					qty: -1,
					rate: 100,
					uom: "Nos",
					discount_percentage: 0,
					discount_amount: 10,
				},
			];

			// For returns: qty*rate = -100, discount should increase refund
			expect(cartStore.subtotal).toBe(-90); // -100 - (-10) = -90
		});
	});

	describe("Return Mode", () => {
		it("should enable return mode", () => {
			const cartStore = useCartStore();

			cartStore.isReturnMode = true;
			cartStore.returnAgainst = "INV-001";

			expect(cartStore.isReturnMode).toBe(true);
			expect(cartStore.returnAgainst).toBe("INV-001");
		});

		it("should exit return mode", () => {
			const cartStore = useCartStore();
			cartStore.isReturnMode = true;
			cartStore.returnAgainst = "INV-001";

			cartStore.isReturnMode = false;
			cartStore.returnAgainst = "";

			expect(cartStore.isReturnMode).toBe(false);
			expect(cartStore.returnAgainst).toBe("");
		});
	});

	describe("Customer Management", () => {
		it("should set customer", () => {
			const cartStore = useCartStore();
			const customer = {
				name: "CUST-001",
				customer_name: "John Doe",
				mobile_no: "1234567890",
				email_id: "john@example.com",
			};

			cartStore.customer = customer;

			expect(cartStore.customer?.name).toBe("CUST-001");
			expect(cartStore.customer?.customer_name).toBe("John Doe");
		});

		it("should clear customer", () => {
			const cartStore = useCartStore();
			cartStore.customer = { name: "CUST-001", customer_name: "John Doe" };

			cartStore.customer = null;

			expect(cartStore.customer).toBeNull();
		});
	});

	describe("Discount Application", () => {
		it("should apply percentage discount to cart", () => {
			const cartStore = useCartStore();
			cartStore.discountPercentage = 10;

			expect(cartStore.discountPercentage).toBe(10);
		});

		it("should apply amount discount to cart", () => {
			const cartStore = useCartStore();
			cartStore.discountAmount = 50;

			expect(cartStore.discountAmount).toBe(50);
		});
	});

	describe("Payments", () => {
		it("should add payment method", () => {
			const cartStore = useCartStore();
			cartStore.payments = [{ mode_of_payment: "Cash", amount: 100 }];

			expect(cartStore.payments.length).toBe(1);
			expect(cartStore.payments[0].mode_of_payment).toBe("Cash");
		});

		it("should handle split payments", () => {
			const cartStore = useCartStore();
			cartStore.payments = [
				{ mode_of_payment: "Cash", amount: 50 },
				{ mode_of_payment: "Card", amount: 50 },
			];

			const totalPaid = cartStore.payments.reduce((sum: any, p: any) => sum + p.amount, 0);
			expect(totalPaid).toBe(100);
		});

		/**
		 * `setPayments` and friends previously had no callers at all, so `payments` was always empty
		 * at checkout. `getInvoiceData` never emitted a payment list and `getReceiptSnapshot` always
		 * reported an empty one with zero change, which is why Electron and cashier backup receipts
		 * printed no payment or change lines. The payment dialog now routes through these setters.
		 */
		it("carries payments set through the store into the invoice payload", () => {
			const cartStore = useCartStore();
			cartStore.items.push(makeItem({ rate: 100, qty: 1 }));
			cartStore.setPayments([{ mode_of_payment: "Cash", amount: 100 }]);

			const data = cartStore.getInvoiceData("POS-PROFILE-1", "SHIFT-1");

			expect(data.payments).toHaveLength(1);
			expect(data.payments?.[0].mode_of_payment).toBe("Cash");
		});

		it("carries payments and change into the receipt snapshot", () => {
			const cartStore = useCartStore();
			cartStore.items.push(makeItem({ rate: 100, qty: 1 }));
			cartStore.setPayments([{ mode_of_payment: "Cash", amount: 150 }]);

			const snapshot = cartStore.getReceiptSnapshot("SINV-1", "Cashier");

			expect(snapshot.payments).toHaveLength(1);
			expect(snapshot.payments[0].amount).toBe(150);
			expect(snapshot.change).toBe(50);
		});

		it("emits the change amount and legs when they are set", () => {
			const cartStore = useCartStore();
			cartStore.items.push(makeItem({ rate: 100, qty: 1 }));
			cartStore.setPayments([{ mode_of_payment: "Cash", amount: 150 }]);
			cartStore.setChangeAmount(50);
			cartStore.setChangeLegs([
				{
					mode_of_payment: "Cash",
					currency: "USD",
					amount: 50,
					base_amount: 50,
					exchange_rate: 1,
				},
			]);

			const data = cartStore.getInvoiceData("POS-PROFILE-1", "SHIFT-1");

			expect(data.change_amount).toBe(50);
			expect(data.pos_change_legs).toHaveLength(1);
		});

		it("tags a foreign tender row on the receipt snapshot", () => {
			const cartStore = useCartStore();
			cartStore.items.push(makeItem({ rate: 100, qty: 1 }));
			cartStore.setPayments([
				{
					mode_of_payment: "Cash USD",
					amount: 100,
					pos_tender_currency: "USD",
					pos_tender_amount: 1.11,
					pos_exchange_rate: 90,
				},
			]);

			const snapshot = cartStore.getReceiptSnapshot("SINV-1", "Cashier");

			expect(snapshot.payments[0].currency).toBe("USD");
			expect(snapshot.payments[0].native_amount).toBe(1.11);
			expect(snapshot.payments[0].exchange_rate).toBe(90);
		});

		it("clears change state along with payments", () => {
			const cartStore = useCartStore();
			cartStore.setPayments([{ mode_of_payment: "Cash", amount: 100 }]);
			cartStore.setChangeAmount(25);

			cartStore.clearPayments();

			expect(cartStore.payments).toHaveLength(0);
			expect(cartStore.changeAmount).toBe(0);
			expect(cartStore.changeLegs).toHaveLength(0);
		});
	});

	describe("Loyalty Points", () => {
		it("should track loyalty points redemption", () => {
			const cartStore = useCartStore();
			cartStore.redeemLoyaltyPoints = true;
			cartStore.loyaltyPoints = 100;
			cartStore.loyaltyAmount = 10; // 100 points = $10

			expect(cartStore.redeemLoyaltyPoints).toBe(true);
			expect(cartStore.loyaltyPoints).toBe(100);
			expect(cartStore.loyaltyAmount).toBe(10);
		});
	});

	describe("Offers and Coupons", () => {
		it("should track applied offers", () => {
			const cartStore = useCartStore();
			const offer = {
				name: "OFFER-001",
				offer_title: "10% Off",
				discount_percentage: 10,
			};

			cartStore.appliedOffers = [offer as any];

			expect(cartStore.appliedOffers.length).toBe(1);
		});

		it("discounts the paid row once when a free row shares the item", () => {
			const cartStore = useCartStore();
			cartStore.appliedOffers = [
				{
					name: "OFFER-1",
					title: "5% off",
					disabled: false,
					offer: "Item Price",
					apply_on: "Item Code",
					item: "CEM",
					discount_type: "Discount Percentage",
					discount_percentage: 5,
					min_qty: 10,
				} as any,
			];
			cartStore.items = [
				{ item_code: "CEM", item_name: "Cement", qty: 20, rate: 25, uid: "r1" },
				{ item_code: "CEM", item_name: "Cement", qty: 1, rate: 0, uid: "r2", pos_is_free_item: true },
			] as any;

			expect(cartStore.offerItemDiscountTotal).toBe(25);
		});

		it("should track applied coupon", () => {
			const cartStore = useCartStore();
			cartStore.couponCode = "SUMMER10";
			cartStore.appliedCoupon = {
				name: "COUPON-001",
				coupon_code: "SUMMER10",
				coupon_type: "Discount",
				discount_percentage: 10,
			} as any;

			expect(cartStore.couponCode).toBe("SUMMER10");
			expect(cartStore.appliedCoupon?.coupon_code).toBe("SUMMER10");
		});
	});

	describe("Draft Management", () => {
		it("should track draft state", () => {
			const cartStore = useCartStore();
			cartStore.currentDraftName = "DRAFT-001";
			cartStore.isSavingDraft = true;

			expect(cartStore.currentDraftName).toBe("DRAFT-001");
			expect(cartStore.isSavingDraft).toBe(true);
		});

		it("sends the concurrency token alongside the draft name", () => {
			const cartStore = useCartStore();
			cartStore.currentDraftName = "DRAFT-001";
			cartStore.currentDraftModified = "2026-08-10 21:00:00";

			const data = cartStore.getInvoiceData("POS-PROFILE-1", "POS-OS-0001");

			expect(data.name).toBe("DRAFT-001");
			expect(data.modified).toBe("2026-08-10 21:00:00");
		});

		it("omits the token for a cart that is not a recalled draft", () => {
			const cartStore = useCartStore();

			const data = cartStore.getInvoiceData("POS-PROFILE-1", "POS-OS-0001");

			expect(data.name).toBeUndefined();
			expect(data.modified).toBeUndefined();
		});

		it("omits the token when a draft was saved without one", () => {
			const cartStore = useCartStore();
			cartStore.currentDraftName = "DRAFT-001";
			cartStore.currentDraftModified = "";

			const data = cartStore.getInvoiceData("POS-PROFILE-1", "POS-OS-0001");

			expect(data.name).toBe("DRAFT-001");
			expect(data.modified).toBeUndefined();
		});

		it("clears the token with the rest of the cart", () => {
			const cartStore = useCartStore();
			cartStore.currentDraftName = "DRAFT-001";
			cartStore.currentDraftModified = "2026-08-10 21:00:00";

			cartStore.clearCart();

			expect(cartStore.currentDraftName).toBe("");
			expect(cartStore.currentDraftModified).toBe("");
		});
	});

	describe("Order Notes and Delivery", () => {
		it("should store order notes", () => {
			const cartStore = useCartStore();
			cartStore.orderNotes = "Please gift wrap";

			expect(cartStore.orderNotes).toBe("Please gift wrap");
		});

		it("should store delivery date", () => {
			const cartStore = useCartStore();
			cartStore.deliveryDate = "2026-01-20";

			expect(cartStore.deliveryDate).toBe("2026-01-20");
		});
	});
});
