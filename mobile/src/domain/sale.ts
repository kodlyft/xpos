/**
 * A real sale captured on the device. The record is written durably BEFORE any network call, keeps the tender and
 * receipt evidence the cashier saw, and is never deleted: ERPNext decides the posted result, the device keeps the
 * evidence until a manager has reconciled anything the server refused.
 */
import { canonicalJson, sha256Hex } from "./txn";
import { formatMinor, fromRate } from "./money";

export type SaleStatus =
	/** Saved on the device, not yet sent. */
	| "captured"
	/** A request is in flight (or was, when the app died): treat like uncertain on restart. */
	| "posting"
	/** ERPNext created the invoice. */
	| "posted"
	/** ERPNext priced the sale differently; waiting for the cashier to accept the new prices. */
	| "reprice"
	/** The request may have reached the server (timeout, lost reply). Retried with the same id. */
	| "uncertain"
	/** Could not be sent (offline, session expired). Retried when possible. */
	| "held"
	/** ERPNext refused the sale. Held for a manager; never deleted. */
	| "rejected"
	/** Invoice saved but the fiscal (FBR) step is not complete. */
	| "fiscal_pending";

export const OPEN_STATUSES: SaleStatus[] = [
	"captured",
	"posting",
	"reprice",
	"uncertain",
	"held",
	"rejected",
	"fiscal_pending",
];

export interface TenderEvidence {
	mode: string;
	type: string | null;
	amountMinor: number;
	/** Reference typed by the cashier from the card terminal / transfer slip. */
	reference?: string;
	/** The cashier states the terminal approved it. XPOS cannot verify this. */
	terminalConfirmed?: boolean;
	/** The mode needs a reference (company setting); ERPNext enforces the same rule when posting. */
	requiresReference?: boolean;
	giftCardAuth?: string;
	maskedCard?: string;
}

export interface ReceiptLine {
	itemCode: string;
	name: string;
	uom: string;
	priceMinor: number;
	qtyMilli: number;
	totalMinor: number;
	discountPct: number;
}

export interface SaleEvidence {
	tenders: TenderEvidence[];
	lines: ReceiptLine[];
	/** Estimate shown to the cashier (from the server quote); ERPNext's posted totals replace it. */
	quotedPayableMinor: number;
	changeMinor: number;
	customer: string;
	customerName: string;
	netMinor: number;
	taxMinor: number;
	discountMinor: number;
	loyaltyMinor: number;
	couponCodes: string[];
	capturedAt: number;
}

export interface SaleRecord {
	txnId: string;
	scopeId: string;
	status: SaleStatus;
	/** The exact `data` argument for xpos.api.invoices.create_invoice (JSON). */
	bodyJson: string;
	contentHash: string;
	currency: string;
	minorDigits: number;
	payableMinor: number;
	evidenceJson: string;
	/** Last server answer (JSON) or null. */
	serverJson: string | null;
	invoice: string | null;
	message: string;
	attempts: number;
	createdAt: number;
	updatedAt: number;
}

export interface NewSale {
	txnId: string;
	scopeId: string;
	body: Record<string, unknown>;
	currency: string;
	minorDigits: number;
	payableMinor: number;
	evidence: SaleEvidence;
}

/** A NewSale with its canonical strings and hash, as stored (Kotlin never has to canonicalize decimal JSON). */
export interface PreparedSale {
	txnId: string;
	scopeId: string;
	bodyJson: string;
	contentHash: string;
	currency: string;
	minorDigits: number;
	payableMinor: number;
	evidenceJson: string;
}

export async function prepareSale(s: NewSale): Promise<PreparedSale> {
	return {
		txnId: s.txnId,
		scopeId: s.scopeId,
		bodyJson: canonicalJson(s.body),
		contentHash: await hashBody(s.body),
		currency: s.currency,
		minorDigits: s.minorDigits,
		payableMinor: s.payableMinor,
		evidenceJson: canonicalJson(s.evidence),
	};
}

export interface SalePatch {
	status?: SaleStatus;
	serverJson?: string | null;
	invoice?: string | null;
	message?: string;
	bodyJson?: string;
	evidenceJson?: string;
	payableMinor?: number;
	/** Count one more send attempt. */
	attempt?: boolean;
}

export class SaleConflictError extends Error {
	constructor(readonly txnId: string) {
		super(`sale id ${txnId} already exists with different contents`);
		this.name = "SaleConflictError";
	}
}

export function newSaleId(): string {
	return "mob-" + globalThis.crypto.randomUUID();
}

export async function hashBody(body: unknown): Promise<string> {
	return sha256Hex(canonicalJson(body));
}

export interface CartLineInput {
	itemCode: string;
	name: string;
	uom: string;
	priceMinor: number;
	qtyMilli: number;
	discountPct?: number;
	rateOverride?: number;
}

/** A cart line as the server priced it. The server also says exactly what the sale must carry for it. */
export interface PricedLine {
	rowId: string;
	itemCode: string;
	name: string;
	uom: string;
	qtyMilli: number;
	/** Net unit rate after promotions and manual discounts (decimal). */
	rate: number;
	priceListRate: number;
	sendRate: number;
	sendDiscountPct: number;
	sendDiscountAmount: number;
	amountMinor: number;
	discountPct: number;
	rules: string | null;
	itemTaxTemplate: string | null;
	/** This line sells a gift card of `sendRate`: the server issues the card; it is never priced from a price list. */
	giftCardIssue?: boolean;
}

export interface SaleExtras {
	/** Invoice-level discount in currency units (customer discount, coupons, manual). */
	discountAmount: number;
	coupons: Record<string, unknown>[];
	offers: Record<string, unknown>[];
	loyaltyPoints: number;
	/** Free items a pricing rule gave, passed back exactly as the server returned them. */
	freeLines: Record<string, unknown>[];
}

export const NO_EXTRAS: SaleExtras = {
	discountAmount: 0,
	coupons: [],
	offers: [],
	loyaltyPoints: 0,
	freeLines: [],
};

export interface SaleContext {
	profile: string;
	customer: string;
	shift: string | null;
	minorDigits: number;
}

/** The create_invoice payload. ERPNext re-prices on save and refuses to continue when a rate moved. */
export function buildInvoiceBody(
	ctx: SaleContext,
	txnId: string,
	lines: PricedLine[],
	tenders: TenderEvidence[],
	changeMinor: number,
	extras: SaleExtras = NO_EXTRAS,
): Record<string, unknown> {
	const dec = (m: number) => Number(formatMinor(m, ctx.minorDigits));
	const items: Record<string, unknown>[] = lines.map((l, i) => ({
		row_id: String(i),
		item_code: l.itemCode,
		item_name: l.name,
		qty: l.qtyMilli / 1000,
		uom: l.uom,
		rate: l.sendRate,
		...(l.giftCardIssue ? { gift_card_issue: 1 } : {}),
		...(l.sendDiscountPct ? { discount_percentage: l.sendDiscountPct } : {}),
		...(l.sendDiscountAmount ? { discount_amount: l.sendDiscountAmount } : {}),
		...(l.itemTaxTemplate ? { item_tax_template: l.itemTaxTemplate } : {}),
	}));
	extras.freeLines.forEach((f, i) =>
		items.push({ ...f, row_id: `free-${i}`, is_free_item: 1, uom: f.uom ?? f.stock_uom }),
	);
	return {
		local_id: txnId,
		pos_profile: ctx.profile,
		customer: ctx.customer,
		pos_opening_shift: ctx.shift,
		items,
		payments: tenders.map((t) => ({
			mode_of_payment: t.mode,
			amount: dec(t.amountMinor),
			...(t.reference ? { reference_no: t.reference } : {}),
			...(t.giftCardAuth ? { gift_card_auth: t.giftCardAuth } : {}),
		})),
		change_amount: dec(changeMinor),
		...(extras.discountAmount
			? { discount_amount: extras.discountAmount, apply_discount_on: "Grand Total" }
			: {}),
		...(extras.coupons.length ? { coupons_detail: extras.coupons } : {}),
		...(extras.offers.length ? { offers_detail: extras.offers } : {}),
		...(extras.loyaltyPoints ? { redeem_loyalty_points: 1, loyalty_points: extras.loyaltyPoints } : {}),
	};
}

export function receiptLines(lines: PricedLine[], minorDigits: number): ReceiptLine[] {
	return lines.map((l) => ({
		itemCode: l.itemCode,
		name: l.name,
		uom: l.uom,
		priceMinor: fromRate(l.rate, minorDigits),
		qtyMilli: l.qtyMilli,
		totalMinor: l.amountMinor,
		discountPct: l.discountPct,
	}));
}

/** Plain-language state for the cashier. Never claims more than the server confirmed. */
export function describeSale(s: Pick<SaleRecord, "status" | "invoice" | "message">): string {
	switch (s.status) {
		case "captured":
			return "Saved on this device. Not sent to ERPNext yet.";
		case "posting":
			return "Sending to ERPNext…";
		case "posted":
			return s.invoice ? `Posted to ERPNext as ${s.invoice}.` : "Posted to ERPNext.";
		case "reprice":
			return s.message || "ERPNext changed the prices. Review them, then confirm.";
		case "uncertain":
			return "No answer from the server. The sale may already be posted; it will be checked with the same sale id.";
		case "held":
			return s.message || "Waiting for the server. The sale is safe on this device.";
		case "rejected":
			return `ERPNext refused this sale${s.message ? `: ${s.message}` : ""}. A manager must reconcile it; the sale is kept on this device.`;
		case "fiscal_pending":
			return `Invoice ${s.invoice ?? ""} is saved but not fiscalized yet. ${s.message}`.trim();
	}
}
