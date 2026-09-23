import { useCartStore } from "@/stores/cartStore";
import { useOfflineStore } from "@/stores/offlineStore";
import { usePosStore } from "@/stores/posStore";
import { usePrintInvoice } from "@/composables/usePrintInvoice";
import { showInfo } from "@/services/api";
import type { InvoiceData } from "@/types/pos.types";
import { __ } from "@/lib/translate";

/** The number a sale carries on its receipt until it reaches the server. */
export function offlineReceiptName(localId: number): string {
	return `OFFLINE-${localId}`;
}

/**
 * Complete a sale with no server: queue the invoice, print its receipt from local data when
 * asked, and clear the cart. Returns false if the invoice could not be queued, leaving the
 * cart as it was.
 */
export function useOfflineSale() {
	const cartStore = useCartStore();
	const offlineStore = useOfflineStore();
	const posStore = usePosStore();
	const { printReceiptOffline } = usePrintInvoice();

	async function completeOfflineSale(
		invoiceData: InvoiceData,
		options: { withPrint: boolean; cashier?: string },
	): Promise<boolean> {
		// Taken before the cart is cleared: it is what the customer paid for.
		const receipt = cartStore.getReceiptSnapshot("", options.cashier || "");

		const result = await offlineStore.saveOffline(
			invoiceData,
			cartStore.customerName,
			cartStore.grandTotal,
			cartStore.getStockReservations(),
			receipt,
		);
		if (!result.success || result.localId === undefined) return false;

		const name = offlineReceiptName(result.localId);
		posStore.lastInvoiceName = name;
		showInfo(__("Invoice saved offline ({0}). It will sync when you're back online.", [name]));

		if (options.withPrint) {
			await printReceiptOffline({ ...receipt, name });
		}

		cartStore.clearAll();
		return true;
	}

	return { completeOfflineSale };
}
