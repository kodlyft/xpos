/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InvoiceData, ReceiptSnapshot } from "@/types/pos.types";

const { cartStore, offlineStore, posStore, printReceiptOffline, showInfo, calls } = vi.hoisted(() => {
	const calls: string[] = [];
	return {
		calls,
		cartStore: {
			customerName: "Walk-in Customer",
			grandTotal: 10,
			getReceiptSnapshot: vi.fn(),
			getStockReservations: vi.fn(() => [{ item_code: "SKU1", stock_qty: 2 }]),
			clearAll: vi.fn(() => calls.push("clearAll")),
		},
		offlineStore: { saveOffline: vi.fn() },
		posStore: { profileName: "Shop Floor", lastInvoiceName: "" },
		printReceiptOffline: vi.fn(async () => {
			calls.push("print");
			return true;
		}),
		showInfo: vi.fn(),
	};
});

vi.mock("@/stores/cartStore", () => ({ useCartStore: () => cartStore }));
vi.mock("@/stores/offlineStore", () => ({ useOfflineStore: () => offlineStore }));
vi.mock("@/stores/posStore", () => ({ usePosStore: () => posStore }));
vi.mock("@/composables/usePrintInvoice", () => ({
	usePrintInvoice: () => ({ printReceiptOffline }),
}));
vi.mock("@/services/api", () => ({ showInfo }));

import { offlineReceiptName, useOfflineSale } from "@/composables/useOfflineSale";

const invoiceData = { customer: "Walk-in Customer", items: [] } as unknown as InvoiceData;

const receipt: ReceiptSnapshot = {
	name: "",
	posting_date: "2026-09-17",
	posting_time: "10:15:00",
	is_return: false,
	cashier: "David",
	customer_name: "Walk-in Customer",
	items: [{ item_code: "SKU1", item_name: "Paracetamol", qty: 2, rate: 5, amount: 10 }],
	taxes: [],
	payments: [{ mode_of_payment: "Cash", amount: 10 }],
	subtotal: 10,
	total_discount: 0,
	net_total: 10,
	grand_total: 10,
	total_qty: 2,
	change: 0,
};

beforeEach(() => {
	vi.clearAllMocks();
	calls.length = 0;
	posStore.lastInvoiceName = "";
	cartStore.getReceiptSnapshot.mockReturnValue(receipt);
	offlineStore.saveOffline.mockResolvedValue({ success: true, localId: 7 });
});

describe("offlineReceiptName", () => {
	it("marks the sale as not yet on the server", () => {
		expect(offlineReceiptName(7)).toBe("OFFLINE-7");
	});
});

describe("completeOfflineSale", () => {
	it("queues the invoice with its receipt, prints it, then clears the cart", async () => {
		const { completeOfflineSale } = useOfflineSale();

		await expect(completeOfflineSale(invoiceData, { withPrint: true, cashier: "David" })).resolves.toBe(
			true,
		);

		expect(cartStore.getReceiptSnapshot).toHaveBeenCalledWith("", "David");
		expect(offlineStore.saveOffline).toHaveBeenCalledWith(
			invoiceData,
			"Walk-in Customer",
			10,
			[{ item_code: "SKU1", stock_qty: 2 }],
			receipt,
		);
		expect(printReceiptOffline).toHaveBeenCalledWith({ ...receipt, name: "OFFLINE-7" });
		expect(calls).toEqual(["print", "clearAll"]);
	});

	it("takes the receipt before the cart is cleared", async () => {
		const { completeOfflineSale } = useOfflineSale();
		await completeOfflineSale(invoiceData, { withPrint: true });

		const snapshotAt = cartStore.getReceiptSnapshot.mock.invocationCallOrder[0];
		const clearedAt = cartStore.clearAll.mock.invocationCallOrder[0];
		expect(snapshotAt).toBeLessThan(clearedAt);
	});

	it("does not print when the cashier chose Save without printing", async () => {
		const { completeOfflineSale } = useOfflineSale();

		await expect(completeOfflineSale(invoiceData, { withPrint: false })).resolves.toBe(true);

		expect(printReceiptOffline).not.toHaveBeenCalled();
		expect(offlineStore.saveOffline).toHaveBeenCalled();
		expect(cartStore.clearAll).toHaveBeenCalled();
	});

	it("records the offline number as the last invoice, for Print Last", async () => {
		const { completeOfflineSale } = useOfflineSale();
		await completeOfflineSale(invoiceData, { withPrint: false });

		expect(posStore.lastInvoiceName).toBe("OFFLINE-7");
		expect(showInfo).toHaveBeenCalledWith(expect.stringContaining("OFFLINE-7"));
	});

	it("completes the sale even if printing fails, so the order is not lost", async () => {
		printReceiptOffline.mockResolvedValueOnce(false);
		const { completeOfflineSale } = useOfflineSale();

		await expect(completeOfflineSale(invoiceData, { withPrint: true })).resolves.toBe(true);
		expect(cartStore.clearAll).toHaveBeenCalled();
	});

	it("keeps the cart and prints nothing if the invoice could not be queued", async () => {
		offlineStore.saveOffline.mockResolvedValue({ success: false });
		const { completeOfflineSale } = useOfflineSale();

		await expect(completeOfflineSale(invoiceData, { withPrint: true })).resolves.toBe(false);

		expect(printReceiptOffline).not.toHaveBeenCalled();
		expect(cartStore.clearAll).not.toHaveBeenCalled();
		expect(posStore.lastInvoiceName).toBe("");
	});
});
