import { reactive } from "vue";
import { OfflineError, SessionExpiredError } from "@mobile/adapters/frappeHttp";
import {
	acceptReprice,
	captureSale,
	giftCardQuote,
	fiscalPendingMessage,
	fiscalPendingSale,
	quoteCart,
	QuoteError,
	repriceOf,
	sendSale,
	settleTenders,
	type Quote,
	type Reprice,
} from "@mobile/app/checkout";
import { newSaleId, type SaleRecord, type TenderEvidence } from "@mobile/domain/sale";
import { bumpSales, getContainer, markSessionExpired, scopeIdFor, settlePending, useApp } from "./useApp";
import { useCart } from "./useCart";
import { resetSaleCustomer, saleCustomer } from "./saleCustomer";
import { currentCustomer, toInput } from "./useQuote";

/**
 * Checkout flow state shared by the cart panel and the payment sheet.
 *  idle -> (Charge) quoting -> paying -> sending -> done | problem
 * The sale is saved on the device before it is sent; leaving this flow never loses a captured sale (the Sales tab
 * lists it with its exact status).
 */
export type CheckoutStep = "idle" | "quoting" | "paying" | "sending" | "done";

const flow = reactive({
	step: "idle" as CheckoutStep,
	quote: null as Quote | null,
	/** Set once the sale is captured: the id never changes for this sale, including retries. */
	txnId: "",
	sale: null as SaleRecord | null,
	/** What this payment is for: a normal sale, or the sale of a gift card. */
	kind: "sale" as "sale" | "giftcard",
	reprice: null as Reprice | null,
	error: "",
});

export function useCheckout() {
	const { state } = useApp();
	const { cart } = useCart();

	function context() {
		const e = state.cashier!;
		return {
			profile: e.profile,
			customer: currentCustomer(),
			shift: state.context.openShift,
			minorDigits: e.minorDigits,
		};
	}

	/** What blocks charging right now, in plain words (null = can charge). */
	function blocker(opts: { ignoreCart?: boolean } = {}): string | null {
		if (!opts.ignoreCart && !cart.lines.length) return "The cart is empty.";
		if (state.sessionExpired) return "Sign in again to continue.";
		if (!state.online)
			return "Offline: selling is switched off until the device is online, because stock, serial, batch and receipt checks need the server. Saved sales are kept and sent later.";
		if (!currentCustomer())
			return "This POS Profile has no default customer. Set one in ERPNext, then reconnect.";
		if (!state.context.openShift) return "Open a shift first.";
		if (!state.context.paymentModes.length) return "This POS Profile has no payment methods.";
		return null;
	}

	async function begin() {
		const why = blocker();
		if (why) {
			flow.error = why;
			return;
		}
		flow.error = "";
		flow.kind = "sale";
		flow.step = "quoting";
		try {
			const c = getContainer();
			const blocking = await fiscalPendingSale(c.transactions, scopeIdFor(state.cashier!));
			if (blocking) {
				flow.step = "idle";
				flow.error = fiscalPendingMessage(blocking);
				return;
			}
			const api = await c.session(state.cashier!.site);
			flow.quote = await quoteCart(api, context(), cart.lines.map(toInput), {
				coupons: [...cart.coupons],
				loyaltyPoints: cart.loyaltyPoints,
				extraDiscountPct: cart.extraDiscountPct,
			});
			flow.step = "paying";
		} catch (e) {
			flow.step = "idle";
			if (e instanceof QuoteError && e.code === "session") markSessionExpired();
			flow.error =
				e instanceof QuoteError
					? e.message
					: e instanceof SessionExpiredError
						? (markSessionExpired(),
							"Your server session has expired. Sign in again to continue.")
						: e instanceof OfflineError
							? "The server cannot be reached. Checkout needs a connection."
							: e instanceof Error
								? e.message
								: String(e);
		}
	}

	/** Sells a gift card: the whole sale is the card's value, paid by an ordinary payment method. */
	function beginGiftCard(valueMinor: number) {
		const e = state.cashier!;
		const cfg = state.context.giftCards;
		const why = blocker({ ignoreCart: true });
		if (why || !cfg) {
			flow.error = why ?? "Gift cards are not set up on this POS Profile.";
			return;
		}
		flow.error = "";
		flow.kind = "giftcard";
		flow.txnId = "";
		flow.quote = giftCardQuote(currentCustomer(), cfg.item, valueMinor, e.minorDigits);
		flow.step = "paying";
	}

	/** Captures the sale durably, then sends it. Resolves when ERPNext answered or the problem is recorded. */
	async function pay(tenders: TenderEvidence[]) {
		const q = flow.quote;
		const e = state.cashier;
		if (!q || !e) return;
		const settled = settleTenders(q.payableMinor, tenders);
		if (!settled.ok) {
			flow.error = settled.reason;
			return;
		}
		flow.error = "";
		flow.step = "sending";
		try {
			const c = getContainer();
			flow.txnId ||= newSaleId();
			const sale = await captureSale(c.transactions, {
				txnId: flow.txnId,
				scopeId: scopeIdFor(e),
				ctx: context(),
				customerName:
					saleCustomer.customer?.customerName ?? state.context.customerName ?? currentCustomer(),
				currency: e.currency,
				quote: q,
				tenders,
			});
			// The sale is safe on the device from here on: release the cart, then talk to the server.
			if (flow.kind === "sale") {
				cart.lines = [];
				cart.coupons = [];
				cart.loyaltyPoints = 0;
				cart.extraDiscountPct = 0;
				resetSaleCustomer();
			}
			bumpSales();
			const api = await c.session(e.site);
			flow.sale = await sendSale(c.transactions, api, sale.txnId);
		} catch (err) {
			if (err instanceof SessionExpiredError) markSessionExpired();
			if (flow.txnId && !flow.sale)
				flow.sale = await getContainer()
					.transactions.getSale(flow.txnId)
					.catch(() => null);
			if (!flow.sale) flow.error = err instanceof Error ? err.message : String(err);
		} finally {
			flow.reprice = flow.sale ? repriceOf(flow.sale, e.minorDigits) : null;
			flow.step = flow.sale ? "done" : "paying";
			bumpSales();
		}
	}

	/** After the cashier accepted new prices: same sale id, new rates and tenders. */
	async function payRepriced(sale: SaleRecord, tenders: TenderEvidence[]) {
		const e = state.cashier!;
		const c = getContainer();
		flow.error = "";
		flow.step = "sending";
		try {
			const ready = await acceptReprice(c.transactions, sale, tenders, e.minorDigits);
			const api = await c.session(e.site);
			flow.sale = await sendSale(c.transactions, api, ready.txnId);
			flow.reprice = repriceOf(flow.sale, e.minorDigits);
			flow.step = "done";
		} catch (err) {
			flow.error = err instanceof Error ? err.message : String(err);
			flow.step = "paying";
		} finally {
			bumpSales();
		}
	}

	/** Review the new prices of a sale ERPNext re-priced (from the Sales tab). */
	function reviewReprice(sale: SaleRecord) {
		flow.sale = sale;
		flow.txnId = sale.txnId;
		flow.reprice = repriceOf(sale, state.cashier!.minorDigits);
		flow.quote = null;
		flow.step = "paying";
	}

	function finish() {
		flow.kind = "sale";
		flow.step = "idle";
		flow.quote = null;
		flow.txnId = "";
		flow.sale = null;
		flow.reprice = null;
		flow.error = "";
		void settlePending();
	}

	function cancel() {
		// A captured sale is never cancelled here; before capture it is just the payment sheet closing.
		if (flow.step === "paying" && !flow.sale) {
			flow.step = "idle";
			flow.quote = null;
			flow.error = "";
		} else if (flow.sale) finish();
	}

	return { flow, blocker, begin, beginGiftCard, pay, payRepriced, reviewReprice, finish, cancel };
}
