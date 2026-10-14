import { convertToBase, minorUnitFor, roundFor } from "@/composables/useCurrency";
import type { InvoiceChangeLeg, InvoicePayment, TenderLeg } from "@/types/pos.types";

export interface TenderModeInfo {
	mode_of_payment: string;
	pos_tender_currency?: string;
	exchange_rate?: number;
	type?: string;
}

export interface TenderContext {
	invoiceCurrency: string;
	modeInfo: (mode: string) => TenderModeInfo | undefined;
}

let legSequence = 0;

export function nextLegId(): string {
	legSequence += 1;
	return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
		? crypto.randomUUID()
		: `leg-${legSequence}`;
}

export function resetLegIds(): void {
	legSequence = 0;
}

export function currencyOf(mode: string, ctx: TenderContext): string {
	return ctx.modeInfo(mode)?.pos_tender_currency || ctx.invoiceCurrency;
}

export function rateOf(mode: string, ctx: TenderContext): number {
	const info = ctx.modeInfo(mode);
	if (!info) return 1;
	return info.exchange_rate ?? 1;
}

export function buildTenderLeg(
	mode: string,
	nativeAmount: number,
	ctx: TenderContext,
	id?: string,
): TenderLeg {
	const currency = currencyOf(mode, ctx);
	const rate = rateOf(mode, ctx);
	const native = roundFor(currency, nativeAmount);

	return {
		id: id || nextLegId(),
		mode_of_payment: mode,
		currency,
		native_amount: native,
		exchange_rate: rate,
		base_amount: convertToBase(currency, ctx.invoiceCurrency, native, rate),
	};
}

export function mergeTenderLeg(legs: TenderLeg[], leg: TenderLeg, ctx: TenderContext): TenderLeg[] {
	const existing = legs.find(
		(row) =>
			row.mode_of_payment === leg.mode_of_payment &&
			row.currency === leg.currency &&
			row.exchange_rate === leg.exchange_rate &&
			// each gift card is its own row: they are different balances
			row.gift_card === leg.gift_card,
	);

	if (!existing) {
		legs.push(leg);
		return legs;
	}

	const merged = roundFor(existing.currency, existing.native_amount + leg.native_amount);
	existing.native_amount = merged;
	existing.base_amount = convertToBase(
		existing.currency,
		ctx.invoiceCurrency,
		merged,
		existing.exchange_rate,
	);
	return legs;
}

export function tenderBaseTotal(legs: TenderLeg[], invoiceCurrency: string): number {
	return roundFor(
		invoiceCurrency,
		legs.reduce((sum, leg) => sum + (leg.base_amount || 0), 0),
	);
}

export interface CurrencyGroup {
	currency: string;
	native: number;
	base: number;
	rate: number;
}

/** Tender grouped by currency, for the "USD 100.00 @ 90,000 = 9,000,000 LBP" breakdown. */
export function groupTenderByCurrency(legs: TenderLeg[], invoiceCurrency: string): CurrencyGroup[] {
	const groups = new Map<string, CurrencyGroup>();

	for (const leg of legs) {
		const entry = groups.get(leg.currency) || {
			currency: leg.currency,
			native: 0,
			base: 0,
			rate: leg.exchange_rate,
		};
		entry.native = roundFor(leg.currency, entry.native + leg.native_amount);
		entry.base = roundFor(invoiceCurrency, entry.base + leg.base_amount);
		groups.set(leg.currency, entry);
	}

	return [...groups.values()];
}

/** Change legs are stored positive; consumers subtract them. */
export function buildChangeLeg(mode: string, nativeAmount: number, ctx: TenderContext): InvoiceChangeLeg {
	const currency = currencyOf(mode, ctx);
	const rate = rateOf(mode, ctx);
	const amount = roundFor(currency, Math.abs(nativeAmount));

	return {
		mode_of_payment: mode,
		currency,
		amount,
		exchange_rate: rate,
		base_amount: convertToBase(currency, ctx.invoiceCurrency, amount, rate),
	};
}

export function changeBaseTotal(legs: InvoiceChangeLeg[], invoiceCurrency: string): number {
	return roundFor(
		invoiceCurrency,
		legs.reduce((sum, leg) => sum + (leg.base_amount || 0), 0),
	);
}

export function changeRemaining(
	changeAmount: number,
	legs: InvoiceChangeLeg[],
	invoiceCurrency: string,
): number {
	return roundFor(invoiceCurrency, changeAmount - changeBaseTotal(legs, invoiceCurrency));
}

/** The legs must account for exactly the change due, within one minor unit of rounding. */
export function isChangeAllocationValid(
	changeAmount: number,
	legs: InvoiceChangeLeg[],
	invoiceCurrency: string,
): boolean {
	if (changeAmount <= 0) return true;
	return Math.abs(changeRemaining(changeAmount, legs, invoiceCurrency)) <= minorUnitFor(invoiceCurrency);
}

/** What the outstanding change works out to in `currency`, so the cashier need not divide. */
export function remainingIn(
	remaining: number,
	currency: string,
	invoiceCurrency: string,
	rate: number,
): number {
	if (!currency || currency === invoiceCurrency) return roundFor(invoiceCurrency, Math.max(0, remaining));
	if (!rate) return 0;
	return roundFor(currency, Math.max(0, remaining) / rate);
}

/**
 * Turn tender legs into Sales Invoice Payment rows.
 *
 * `amount` is always the invoice-currency value, because ERPNext sums it into `paid_amount`. The
 * native figure rides along in the `pos_tender_*` fields, which ERPNext never touches.
 */
export function toInvoicePayments(legs: TenderLeg[], invoiceCurrency: string): InvoicePayment[] {
	return legs
		.filter((leg) => Math.abs(leg.base_amount || 0) > 0)
		.map((leg) => {
			const row: InvoicePayment = {
				mode_of_payment: leg.mode_of_payment,
				amount: roundFor(invoiceCurrency, leg.base_amount),
			};
			if (leg.currency && leg.currency !== invoiceCurrency) {
				row.pos_tender_currency = leg.currency;
				row.pos_tender_amount = leg.native_amount;
				row.pos_exchange_rate = leg.exchange_rate;
			}
			if (leg.gift_card_auth) row.gift_card_auth = leg.gift_card_auth;
			else if (leg.gift_card) row.gift_card = leg.gift_card;
			return row;
		});
}

/** Flip a sale's payment rows into refund rows, keeping the native figure in step. */
export function negateForReturn(payments: InvoicePayment[]): InvoicePayment[] {
	return payments.map((payment) => ({
		...payment,
		amount: -Math.abs(payment.amount),
		...(payment.pos_tender_amount === undefined
			? {}
			: { pos_tender_amount: -Math.abs(payment.pos_tender_amount) }),
	}));
}
