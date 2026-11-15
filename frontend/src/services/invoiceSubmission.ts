import { addPendingInvoice, deletePendingInvoice, updatePendingInvoice } from "@/services/dbBridge";
import { newInvoiceId } from "@/services/saleIdentity";
import type { InvoiceData, ReceiptSnapshot } from "@/types/pos.types";

export { newInvoiceId };

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
		claim: true,
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
		} else {
			try {
				await updatePendingInvoice(pending.id, { claimed_by: null, claim_expires: null });
			} catch {
				/* the claim lapses on its own */
			}
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
