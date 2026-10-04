import { addPendingInvoice, deletePendingInvoice } from "@/services/dbBridge";
import type { InvoiceData, ReceiptSnapshot } from "@/types/pos.types";

/** A browser-safe random identity, including tills served over LAN HTTP. */
export function newInvoiceId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	return `inv_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** Persist before sending: a lost response or page reload must retry this same sale. */
export async function submitDurableInvoice<T>(
	data: InvoiceData,
	receipt: ReceiptSnapshot,
	send: () => Promise<T>,
): Promise<T> {
	const pending = await addPendingInvoice({
		data,
		receipt,
		customer_name: data.customer,
		grand_total: receipt.grand_total,
	});
	window.dispatchEvent(new Event("xpos:pending-invoices-changed"));
	let result: T;
	try {
		result = await send();
	} catch (error) {
		// Only a structured Frappe rejection proves rollback. Proxy errors and malformed/lost responses stay recoverable.
		if ((error as { excType?: string })?.excType) {
			await deletePendingInvoice(pending.id);
			window.dispatchEvent(new Event("xpos:pending-invoices-changed"));
		}
		throw error;
	}
	try {
		await deletePendingInvoice(pending.id);
		window.dispatchEvent(new Event("xpos:pending-invoices-changed"));
	} catch (error) {
		// The sale is confirmed. A later queue retry safely resolves to the same invoice.
		console.warn("Could not remove confirmed invoice from recovery queue", error);
	}
	return result;
}
