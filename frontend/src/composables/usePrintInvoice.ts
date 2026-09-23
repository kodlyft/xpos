import { usePosStore } from "@/stores/posStore";
import { call, showError } from "@/services/api";
import { getCachedReceiptContext } from "@/services/dbBridge";
import { buildReceiptHtml } from "@/services/receiptTemplate";
import type { ReceiptSnapshot } from "@/types/pos.types";
import { __ } from "@/lib/translate";

export interface PrintInvoiceOptions {
	format?: string;
	doctype?: "Sales Invoice" | "POS Invoice";
}

/**
 * Print an HTML document from a hidden iframe. Unlike window.open, this is not caught by
 * popup blockers after an await, and needs no network.
 */
export function printHtml(html: string): HTMLIFrameElement {
	const frame = document.createElement("iframe");
	frame.setAttribute("aria-hidden", "true");
	Object.assign(frame.style, {
		position: "fixed",
		right: "0",
		bottom: "0",
		width: "0",
		height: "0",
		border: "0",
	});
	frame.onload = () => {
		const win = frame.contentWindow;
		if (!win) return;
		win.onafterprint = () => setTimeout(() => frame.remove(), 0);
		// Give the logo a moment to load before the print dialog snapshots the page.
		setTimeout(() => {
			win.focus();
			win.print();
		}, 250);
	};
	frame.srcdoc = html;
	document.body.appendChild(frame);
	return frame;
}

/**
 * Shared invoice printing helpers used by the payment dialog (genuine receipt),
 * the terminal backup receipt, and the cashier settlement screen.
 */
export function usePrintInvoice() {
	const posStore = usePosStore();

	function resolveDoctype(): "Sales Invoice" | "POS Invoice" {
		return xpos.boot?.pos_settings?.invoice_type === "POS Invoice" ? "POS Invoice" : "Sales Invoice";
	}

	async function printInvoice(invoiceName: string, options: PrintInvoiceOptions = {}) {
		try {
			const printFormat = options.format || posStore?.defaultPrintFormat || "XPOS Thermal Receipt";
			const letterHead = posStore.printSettings?.letter_head || "";
			const doctype = options.doctype || resolveDoctype();

			const baseUrl = window.location.origin;
			const printUrl = `${baseUrl}/printview?doctype=${encodeURIComponent(doctype)}&name=${encodeURIComponent(
				invoiceName,
			)}&format=${encodeURIComponent(printFormat)}&no_letterhead=${letterHead ? "0" : "1"}`;
			const printWindow = window.open(printUrl, "_blank");

			if (printWindow) {
				printWindow.onload = () => {
					printWindow.onafterprint = () => {
						printWindow.close();
					};
					setTimeout(() => {
						printWindow.print();
					}, 500);
					call("xpos.api.print_formats.mark_invoice_printed", {
						doctype,
						name: invoiceName,
					}).catch(() => {
						/* non-fatal: reprint control is best-effort */
					});
				};
			} else {
				window.open(printUrl, "_blank");
			}
		} catch (error) {
			console.error("Print error:", error);
			showError(__("Failed to print invoice"));
		}
	}

	async function printInvoiceLocal(localId: number) {
		try {
			if (!window.electronAPI?.db || !window.electronAPI?.print) {
				showError(__("Print not available"));
				return;
			}

			const invoice = await window.electronAPI.db.getPendingInvoice(localId);
			if (!invoice) {
				showError(__("Invoice not found for printing"));
				return;
			}
			const snapshot = (invoice.data as Record<string, unknown>)?.receipt as
				| ReceiptSnapshot
				| undefined;
			const context = await getCachedReceiptContext(posStore.profileName);

			if (snapshot && context) {
				if (!snapshot.name) snapshot.name = `LOCAL-${localId}`;
				const html = buildReceiptHtml(snapshot, context);
				const result = await window.electronAPI.print.printReport(html);
				if (!result?.success) {
					showError(__("Failed to print invoice locally"));
				}
				return;
			}

			await window.electronAPI.print.printInvoice({
				localId,
				data: invoice.data,
				customerName: invoice.customer_name || "",
				grandTotal: invoice.grand_total,
				isReturn: invoice.is_return,
				printFormat: posStore.printSettings?.print_format || "POS Invoice",
				letterHead: posStore.printSettings?.letter_head || "",
				companyName: posStore.posProfile?.company || "",
			});
		} catch (error) {
			console.error("Local print error:", error);
			showError(__("Failed to print invoice locally"));
		}
	}

	/**
	 * Print a sale that exists only on this device. The server's print view is unreachable
	 * offline, so the receipt is built from the sale's snapshot and the cached receipt layout.
	 */
	async function printReceiptOffline(snapshot: ReceiptSnapshot): Promise<boolean> {
		try {
			const context = await getCachedReceiptContext(posStore.profileName);
			if (!context) {
				showError(
					__(
						"The receipt layout is not available offline. Reprint this sale from Order History once back online.",
					),
				);
				return false;
			}
			printHtml(buildReceiptHtml(snapshot, context));
			return true;
		} catch (error) {
			console.error("Offline print error:", error);
			showError(__("Failed to print invoice"));
			return false;
		}
	}

	return { printInvoice, printInvoiceLocal, printReceiptOffline };
}
