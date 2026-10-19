/**
 * Client-side caller for the local (on-terminal) FBR fiscalization service.
 *
 * When the FBR cloud API is unreachable, the Frappe server hands the built invoice
 * payload back to the client (create_invoice → "fbr_local_required"). The local
 * fiscal service runs on the cashier's machine and can only be reached from here -
 * never from the server - so the client posts the payload to it, obtains the fiscal
 * invoice number, and finalizes the sale.
 *
 * Electron routes the request through the main process (no mixed-content/CORS limits).
 * The browser build calls the service directly with fetch; that requires the POS page
 * to be served over http (or the local service exposed over https with a permissive
 * CORS policy), otherwise the browser blocks the http://localhost request.
 */

import { isElectron } from "./electronBridge";
import { call } from "./api";

const LOCAL_SERVICE_PATH = "/api/IMSFiscal/GetInvoiceNumberByModel";
const REQUEST_TIMEOUT_MS = 12000;

/** Shape returned by the local IMSFiscal service. */
interface LocalFiscalResponse {
	InvoiceNumber?: string;
	Code?: string | number;
	Response?: string;
	Errors?: unknown;
}

export interface LocalFiscalResult {
	invoiceNumber: string;
}

function buildUrl(baseUrl: string): string {
	return `${(baseUrl || "http://localhost:8524").replace(/\/+$/, "")}${LOCAL_SERVICE_PATH}`;
}

function parseResult(raw: LocalFiscalResponse): LocalFiscalResult {
	const code = raw?.Code != null ? String(raw.Code).trim() : "";
	const invoiceNumber = (raw?.InvoiceNumber || "").trim();
	if (!invoiceNumber || (code && code !== "100")) {
		const message =
			raw?.Response ||
			(raw?.Errors ? String(raw.Errors) : "") ||
			"Local FBR service did not return an invoice number.";
		throw new LocalFiscalRejected(message);
	}
	return { invoiceNumber };
}

export class LocalFiscalRejected extends Error {}

export class FiscalUncertainError extends Error {
	constructor(
		public invoice: string,
		message: string,
	) {
		super(message);
	}
}

export interface FiscalPending {
	name: string;
	usin?: string;
	pos_profile?: string;
	doctype?: string;
	status?: string;
	message?: string;
	fbr_payload?: Record<string, unknown>;
	fbr_local_service_url?: string;
}

const NUMBER_KEY = "xpos:fbr-number:";

function rememberNumber(invoice: string, value: string | null): void {
	try {
		if (value) localStorage.setItem(NUMBER_KEY + invoice, value);
		else localStorage.removeItem(NUMBER_KEY + invoice);
	} catch {
		/* storage unavailable: the number is then only kept in memory for this attempt */
	}
}

function recallNumber(invoice: string): string | null {
	try {
		return localStorage.getItem(NUMBER_KEY + invoice);
	} catch {
		return null;
	}
}

export async function completeLocalFiscalization<T>(pending: FiscalPending): Promise<T> {
	let invoiceNumber = recallNumber(pending.name);
	if (!invoiceNumber) {
		try {
			({ invoiceNumber } = await fiscalizeViaLocalService(
				pending.fbr_payload || {},
				pending.fbr_local_service_url || "",
			));
		} catch (error) {
			if (error instanceof LocalFiscalRejected) throw error;
			await call("xpos.api.invoices.mark_fiscalization_uncertain", {
				name: pending.name,
				doctype: pending.doctype,
			}).catch(() => {
				/* the queue entry still holds the sale for the check; it is never retried on its own */
			});
			throw new FiscalUncertainError(
				pending.name,
				`The local FBR service did not answer for invoice ${pending.name}; it may have been fiscalized.`,
			);
		}
		rememberNumber(pending.name, invoiceNumber);
	}
	const result = await call<T>("xpos.api.invoices.finalize_fiscal_invoice", {
		name: pending.name,
		fbr_invoice_number: invoiceNumber,
		doctype: pending.doctype,
	});
	rememberNumber(pending.name, null);
	return result;
}

/**
 * Request a fiscal invoice number from the local service.
 * @param payload The FBR invoice model built by the server (create_invoice response).
 * @param baseUrl Base URL of the local service (POS Profile → FBR Local Service URL).
 */
export async function fiscalizeViaLocalService(
	payload: Record<string, unknown>,
	baseUrl: string,
): Promise<LocalFiscalResult> {
	if (isElectron() && window.electronAPI?.fbr?.fiscalizeLocal) {
		const res = await window.electronAPI.fbr.fiscalizeLocal(buildUrl(baseUrl), payload);
		if (!res.success) {
			throw new Error(res.error || "Local FBR service request failed.");
		}
		return parseResult((res.data || {}) as LocalFiscalResponse);
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const response = await fetch(buildUrl(baseUrl), {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify(payload),
			signal: controller.signal,
		});
		if (!response.ok) {
			const message = `Local FBR service responded with HTTP ${response.status}.`;
			throw response.status < 500 ? new LocalFiscalRejected(message) : new Error(message);
		}
		const data = (await response.json()) as LocalFiscalResponse;
		return parseResult(data);
	} finally {
		clearTimeout(timer);
	}
}
