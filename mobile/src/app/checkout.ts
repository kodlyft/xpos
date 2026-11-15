/**
 * Connected checkout against ERPNext, using the existing authorized XPOS sale API:
 *   quote_sale (xpos.api.mobile_quote) what ERPNext would charge this customer: prices, promotions, discounts,
 *                                      taxes, amount to collect (read-only; uses the web POS's own engines)
 *   create_invoice (xpos.api.invoices) creates the invoice; idempotent on local_id, re-prices on save and refuses
 *                                      to continue when rates moved (reply status "reprice_required")
 *
 * Order of events for a sale: quote -> tender entry -> durable local capture (sale row with tender and receipt
 * evidence) -> send. The row is written before the first byte leaves the device and is never deleted; its status says
 * exactly how far ERPNext got. Retrying always uses the same sale id, so a lost reply can never double-post.
 */
import type { ApiTransport, TransactionStore } from "@mobile/ports";
import { OfflineError, ServerError, SessionExpiredError } from "@mobile/adapters/frappeHttp";
import { fromRate } from "@mobile/domain/money";
import { holdIssuedCards, withoutCodes } from "./giftCards";
import {
	buildInvoiceBody,
	OPEN_STATUSES,
	receiptLines,
	type CartLineInput,
	type PricedLine,
	type SaleContext,
	type SaleEvidence,
	type SaleExtras,
	type SaleRecord,
	type SaleStatus,
	type TenderEvidence,
} from "@mobile/domain/sale";

export interface QuoteLine extends PricedLine {
	manualDiscountPct: number;
	rateOverridden: boolean;
}

export interface Quote {
	/** Identifies the exact inputs this quote priced; a different one means the quote is stale. */
	quoteId: string;
	customer: string;
	payableMinor: number;
	netMinor: number;
	taxMinor: number;
	grandMinor: number;
	/** Invoice-level discount (customer discount, coupons, manual) in minor units. */
	discountMinor: number;
	loyaltyMinor: number;
	lines: QuoteLine[];
	priceList: string | null;
	extras: SaleExtras;
	couponCodes: string[];
	/** Offers that match but that mobile does not apply (nothing is charged wrongly because of them). */
	notices: string[];
}

export type QuoteErrorCode =
	| "price_unavailable"
	| "unsupported"
	| "refused"
	| "offline"
	| "session"
	| "server";

export class QuoteError extends Error {
	constructor(
		readonly code: QuoteErrorCode,
		message: string,
		readonly items: string[] = [],
	) {
		super(message);
		this.name = "QuoteError";
	}
}

interface QuoteReplyLine {
	row_id: string | number;
	item_code: string;
	uom: string;
	rate: number | null;
	price_list_rate?: number;
	send_rate?: number;
	send_discount_percentage?: number;
	send_discount_amount?: number;
	amount?: number;
	discount_pct?: number;
	pricing_rules?: string | null;
	manual_discount_pct?: number;
	rate_overridden?: number;
	item_tax_template?: string | null;
}

interface QuoteReply {
	quote_id: string;
	customer: string;
	price_unavailable?: string[];
	price_list?: string | null;
	net_total?: number;
	total_taxes_and_charges?: number;
	grand_total?: number;
	payable?: number;
	discount_amount?: number;
	loyalty_amount?: number;
	unsupported: { row_id: string | number | null; reason: string }[];
	refusals: { row_id: string | number | null; reason: string }[];
	notices: { reason: string }[];
	free_lines?: Record<string, unknown>[];
	coupons_detail?: Record<string, unknown>[];
	offers_detail?: Record<string, unknown>[];
	lines: QuoteReplyLine[];
}

export interface QuoteExtrasInput {
	coupons: string[];
	loyaltyPoints: number;
	extraDiscountPct: number;
}

export const NO_QUOTE_EXTRAS: QuoteExtrasInput = { coupons: [], loyaltyPoints: 0, extraDiscountPct: 0 };

export async function quoteCart(
	api: ApiTransport,
	ctx: SaleContext,
	lines: CartLineInput[],
	extras: QuoteExtrasInput = NO_QUOTE_EXTRAS,
): Promise<Quote> {
	let r: QuoteReply;
	try {
		r = await api.call<QuoteReply>("xpos.api.mobile_quote.quote_sale", {
			pos_profile: ctx.profile,
			customer: ctx.customer,
			items: lines.map((l, i) => ({
				row_id: String(i),
				item_code: l.itemCode,
				qty: l.qtyMilli / 1000,
				uom: l.uom,
				...(l.discountPct ? { discount_percentage: l.discountPct } : {}),
				...(l.rateOverride !== undefined ? { rate_override: l.rateOverride } : {}),
			})),
			coupons: extras.coupons,
			loyalty_points: extras.loyaltyPoints,
			additional_discount_percentage: extras.extraDiscountPct,
		});
	} catch (e) {
		if (e instanceof OfflineError)
			throw new QuoteError("offline", "The server cannot be reached. Checkout needs a connection.");
		if (e instanceof SessionExpiredError)
			throw new QuoteError("session", "Your server session has expired. Sign in again to continue.");
		if (e instanceof ServerError) throw new QuoteError("server", e.message);
		throw e;
	}
	if (r.price_unavailable?.length)
		throw new QuoteError(
			"price_unavailable",
			`No price in the price list for: ${r.price_unavailable.join(", ")}. Remove them or ask a manager to add a price.`,
			r.price_unavailable,
		);
	if (r.unsupported.length)
		throw new QuoteError(
			"unsupported",
			`Mobile cannot price this sale correctly yet, so it will not be charged here: ${r.unsupported.map((u) => u.reason).join(" ")} Use the web POS.`,
		);
	if (r.refusals.length) throw new QuoteError("refused", r.refusals.map((x) => x.reason).join(" "));
	const m = (n: number | undefined) => fromRate(Number(n ?? 0), ctx.minorDigits);
	const byRow = new Map(r.lines.map((l) => [String(l.row_id), l]));
	return {
		quoteId: r.quote_id,
		customer: r.customer,
		payableMinor: m(r.payable ?? r.grand_total),
		netMinor: m(r.net_total),
		taxMinor: m(r.total_taxes_and_charges),
		grandMinor: m(r.grand_total),
		discountMinor: m(r.discount_amount),
		loyaltyMinor: m(r.loyalty_amount),
		priceList: r.price_list ?? null,
		couponCodes: extras.coupons,
		notices: r.notices.map((n) => n.reason),
		extras: {
			discountAmount: Number(r.discount_amount ?? 0),
			coupons: r.coupons_detail ?? [],
			offers: r.offers_detail ?? [],
			loyaltyPoints: extras.loyaltyPoints,
			freeLines: r.free_lines ?? [],
		},
		lines: lines.map((l, i) => {
			const q = byRow.get(String(i));
			if (!q || q.rate === null) throw new QuoteError("server", `The server did not price ${l.name}.`);
			return {
				rowId: String(i),
				itemCode: l.itemCode,
				name: l.name,
				uom: q.uom,
				qtyMilli: l.qtyMilli,
				rate: Number(q.rate),
				priceListRate: Number(q.price_list_rate ?? q.rate),
				sendRate: Number(q.send_rate ?? q.rate),
				sendDiscountPct: Number(q.send_discount_percentage ?? 0),
				sendDiscountAmount: Number(q.send_discount_amount ?? 0),
				amountMinor: m(q.amount),
				discountPct: Number(q.discount_pct ?? 0),
				rules: q.pricing_rules ?? null,
				itemTaxTemplate: q.item_tax_template ?? null,
				manualDiscountPct: Number(q.manual_discount_pct ?? 0),
				rateOverridden: !!q.rate_overridden,
			};
		}),
	};
}

/** The "quote" of a gift card sale: the card's value is the whole amount, with no tax, discount or price list. */
export function giftCardQuote(
	customer: string,
	itemCode: string,
	valueMinor: number,
	minorDigits: number,
): Quote {
	const rate = valueMinor / 10 ** minorDigits;
	return {
		quoteId: `gift-card:${valueMinor}`,
		customer,
		payableMinor: valueMinor,
		netMinor: valueMinor,
		taxMinor: 0,
		grandMinor: valueMinor,
		discountMinor: 0,
		loyaltyMinor: 0,
		priceList: null,
		couponCodes: [],
		notices: [],
		extras: { discountAmount: 0, coupons: [], offers: [], loyaltyPoints: 0, freeLines: [] },
		lines: [
			{
				rowId: "0",
				itemCode,
				name: "Gift card",
				uom: "Nos",
				qtyMilli: 1000,
				rate,
				priceListRate: rate,
				sendRate: rate,
				sendDiscountPct: 0,
				sendDiscountAmount: 0,
				amountMinor: valueMinor,
				discountPct: 0,
				rules: null,
				itemTaxTemplate: null,
				giftCardIssue: true,
				manualDiscountPct: 0,
				rateOverridden: false,
			},
		],
	};
}

export function settleTenders(
	payableMinor: number,
	tenders: TenderEvidence[],
): { ok: true; changeMinor: number } | { ok: false; reason: string } {
	if (!tenders.length || tenders.some((t) => !Number.isSafeInteger(t.amountMinor) || t.amountMinor <= 0))
		return { ok: false, reason: "Enter an amount for each payment." };
	const total = tenders.reduce((s, t) => s + t.amountMinor, 0);
	if (total < payableMinor) return { ok: false, reason: "The payments do not cover the amount due." };
	const over = total - payableMinor;
	const cash = tenders.filter((t) => t.type === "Cash").reduce((s, t) => s + t.amountMinor, 0);
	if (over > cash)
		return { ok: false, reason: "Only cash can be over the amount due (that is the change)." };
	const gift = tenders.filter((t) => t.giftCardAuth).reduce((s, t) => s + t.amountMinor, 0);
	if (gift > payableMinor) return { ok: false, reason: "A gift card cannot pay more than the amount due." };
	for (const t of tenders) {
		if (t.giftCardAuth) continue;
		if (t.type !== "Cash" && !t.terminalConfirmed)
			return { ok: false, reason: `Confirm that you saw ${t.mode} approved on the terminal or slip.` };
		if (t.requiresReference && !t.reference?.trim())
			return { ok: false, reason: `${t.mode} needs the terminal or transfer reference.` };
	}
	return { ok: true, changeMinor: over };
}

export interface CaptureInput {
	txnId: string;
	scopeId: string;
	ctx: SaleContext;
	customerName: string;
	currency: string;
	quote: Quote;
	tenders: TenderEvidence[];
	now?: number;
}

/** A sale whose invoice exists in ERPNext but whose fiscal step is unfinished. Another sale cannot start until it is. */
export async function fiscalPendingSale(
	store: TransactionStore,
	scopeId: string,
): Promise<SaleRecord | null> {
	return (await store.listSales(["fiscal_pending"], 50)).find((s) => s.scopeId === scopeId) ?? null;
}

export function fiscalPendingMessage(sale: SaleRecord): string {
	return `Sale ${sale.invoice ?? sale.txnId} is not fiscally complete. Finish it in the web POS before starting another sale.`;
}

/** Writes the sale durably. Resolves only after the row (with tender and receipt evidence) is committed. */
export async function captureSale(store: TransactionStore, c: CaptureInput): Promise<SaleRecord> {
	const blocking = await fiscalPendingSale(store, c.scopeId);
	if (blocking && blocking.txnId !== c.txnId) throw new Error(fiscalPendingMessage(blocking));
	if (c.quote.customer !== c.ctx.customer)
		throw new Error("The prices are for a different customer. Charge again to get fresh prices.");
	const settled = settleTenders(c.quote.payableMinor, c.tenders);
	if (!settled.ok) throw new Error(settled.reason);
	const evidence: SaleEvidence = {
		tenders: c.tenders,
		lines: receiptLines(c.quote.lines, c.ctx.minorDigits),
		quotedPayableMinor: c.quote.payableMinor,
		changeMinor: settled.changeMinor,
		customer: c.ctx.customer,
		customerName: c.customerName,
		netMinor: c.quote.netMinor,
		taxMinor: c.quote.taxMinor,
		discountMinor: c.quote.discountMinor,
		loyaltyMinor: c.quote.loyaltyMinor,
		couponCodes: c.quote.couponCodes,
		capturedAt: c.now ?? Date.now(),
	};
	const { sale } = await store.saveSale({
		txnId: c.txnId,
		scopeId: c.scopeId,
		body: buildInvoiceBody(c.ctx, c.txnId, c.quote.lines, c.tenders, settled.changeMinor, c.quote.extras),
		currency: c.currency,
		minorDigits: c.ctx.minorDigits,
		payableMinor: c.quote.payableMinor,
		evidence,
	});
	return sale;
}

interface InvoiceReply {
	name?: string;
	status?: string;
	duplicate?: boolean;
	grand_total?: number;
	message?: string;
	lines?: { row_id: string; rate: number | null; quoted_rate: number }[];
	rounded_total?: number;
}

/** Statuses a sale can be (re)sent from. `rejected` and `posted` are never resent automatically. */
const SENDABLE: SaleStatus[] = ["captured", "held", "uncertain", "posting"];

/**
 * Sends one captured sale. Safe to call again for the same sale at any time: ERPNext answers a repeat with the
 * invoice it already made.
 */
export async function sendSale(
	store: TransactionStore,
	api: ApiTransport,
	txnId: string,
): Promise<SaleRecord> {
	const sale = await store.getSale(txnId);
	if (!sale) throw new Error(`unknown sale ${txnId}`);
	if (!SENDABLE.includes(sale.status)) return sale;
	await store.updateSale(txnId, { status: "posting", attempt: true });
	let reply: InvoiceReply;
	try {
		reply = await api.call<InvoiceReply>("xpos.api.invoices.create_invoice", {
			data: JSON.parse(sale.bodyJson),
			local_id: txnId,
		});
	} catch (e) {
		if (e instanceof SessionExpiredError)
			return store.updateSale(txnId, {
				status: "held",
				message:
					"Your session expired. Sign in again; the sale is safe on this device and will be sent.",
			});
		if (e instanceof OfflineError)
			// the request may or may not have reached the server: the retry with the same id settles it
			return store.updateSale(txnId, {
				status: "uncertain",
				message: "No answer from the server. It may already be posted.",
			});
		if (e instanceof ServerError) {
			if (e.status >= 500 || e.status === 408 || e.status === 429)
				return store.updateSale(txnId, { status: "uncertain", message: e.message });
			return store.updateSale(txnId, { status: "rejected", message: e.message });
		}
		throw e;
	}
	holdIssuedCards(txnId, reply);
	const serverJson = JSON.stringify(withoutCodes(reply as unknown as Record<string, unknown>));
	if (reply.status === "reprice_required")
		return store.updateSale(txnId, {
			status: "reprice",
			serverJson,
			message: reply.message || "ERPNext changed the prices.",
		});
	if (reply.status === "fbr_local_required" || reply.status === "fbr_uncertain")
		return store.updateSale(txnId, {
			status: "fiscal_pending",
			serverJson,
			invoice: reply.name ?? null,
			message:
				reply.status === "fbr_uncertain"
					? "FBR may have recorded this invoice without answering. A manager must check it in the web POS."
					: "The fiscal number is still needed. Finish it in the web POS.",
		});
	if (reply.name)
		return store.updateSale(txnId, {
			status: "posted",
			serverJson,
			invoice: reply.name,
			message: reply.status === "Queued" ? "Queued for submission on the server." : "",
		});
	return store.updateSale(txnId, {
		status: "rejected",
		serverJson,
		message: "The server answered without an invoice number.",
	});
}

export interface Reprice {
	payableMinor: number;
	lines: { rowId: string; quotedRate: number; rate: number | null }[];
	message: string;
}

/** The new prices ERPNext reported, for the cashier to review. */
export function repriceOf(sale: SaleRecord, minorDigits: number): Reprice | null {
	if (sale.status !== "reprice" || !sale.serverJson) return null;
	const r = JSON.parse(sale.serverJson) as {
		lines?: { row_id: string; rate: number | null; quoted_rate: number }[];
		rounded_total?: number;
		grand_total?: number;
		message?: string;
	};
	return {
		payableMinor: fromRate(Number(r.rounded_total || r.grand_total || 0), minorDigits),
		lines: (r.lines ?? []).map((l) => ({
			rowId: String(l.row_id),
			quotedRate: l.quoted_rate,
			rate: l.rate,
		})),
		message: r.message ?? "",
	};
}

/**
 * The cashier accepted ERPNext's new prices and re-took payment: the same sale (same id) gets the new rates and
 * tenders and goes back to `captured`, ready to send.
 */
export async function acceptReprice(
	store: TransactionStore,
	sale: SaleRecord,
	tenders: TenderEvidence[],
	minorDigits: number,
): Promise<SaleRecord> {
	const rp = repriceOf(sale, minorDigits);
	if (!rp) throw new Error("This sale has no price change to accept.");
	const settled = settleTenders(rp.payableMinor, tenders);
	if (!settled.ok) throw new Error(settled.reason);
	const body = JSON.parse(sale.bodyJson) as {
		items: { row_id: string; rate: number; discount_percentage?: number; discount_amount?: number }[];
		payments: unknown[];
		change_amount: number;
	};
	for (const l of rp.lines) {
		const it = body.items.find((i) => i.row_id === l.rowId);
		if (it && l.rate !== null) {
			it.rate = l.rate;
			delete it.discount_percentage;
			delete it.discount_amount;
		}
	}
	const dec = (m: number) => m / 10 ** minorDigits;
	body.payments = tenders.map((t) => ({
		mode_of_payment: t.mode,
		amount: dec(t.amountMinor),
		...(t.reference ? { reference_no: t.reference } : {}),
	}));
	body.change_amount = dec(settled.changeMinor);
	const evidence = JSON.parse(sale.evidenceJson) as SaleEvidence;
	evidence.tenders = tenders;
	evidence.changeMinor = settled.changeMinor;
	evidence.quotedPayableMinor = rp.payableMinor;
	return store.updateSale(sale.txnId, {
		status: "captured",
		bodyJson: JSON.stringify(body),
		evidenceJson: JSON.stringify(evidence),
		payableMinor: rp.payableMinor,
		message: "",
		serverJson: null,
	});
}

/** Sales still to be settled, oldest first, that can be sent without cashier input. */
export async function pendingSales(store: TransactionStore, scopeId: string): Promise<SaleRecord[]> {
	// only this cashier's sales: another user's session must never post them
	return (await store.listSales(OPEN_STATUSES, 200))
		.filter((s) => s.scopeId === scopeId && SENDABLE.includes(s.status))
		.reverse();
}

/** Sends everything waiting, one at a time and in order. Stops at the first session or connectivity problem. */
export async function drainPending(
	store: TransactionStore,
	api: ApiTransport,
	scopeId: string,
): Promise<SaleRecord[]> {
	const done: SaleRecord[] = [];
	for (const s of await pendingSales(store, scopeId)) {
		const r = await sendSale(store, api, s.txnId);
		done.push(r);
		if (r.status === "held" || r.status === "uncertain") break;
	}
	return done;
}
