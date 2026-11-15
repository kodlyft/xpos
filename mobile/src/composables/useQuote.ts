import { effectScope, reactive, watch } from "vue";
import { quoteCart, QuoteError, type Quote } from "@mobile/app/checkout";
import { OfflineError, SessionExpiredError } from "@mobile/adapters/frappeHttp";
import type { CartLineInput } from "@mobile/domain/sale";
import { saleCustomer } from "./saleCustomer";
import { getContainer, markSessionExpired, useApp } from "./useApp";
import { useCart, type CartLine } from "./useCart";

/**
 * What the server says this cart costs for this customer, kept current while the cashier works.
 * Any change to the lines, the customer, coupons, loyalty points or discounts drops the old quote at once (so a
 * previous customer's prices are never shown or charged) and asks the server again after a short pause.
 */
export interface LiveQuote {
	status: "idle" | "loading" | "ready" | "problem" | "offline";
	quote: Quote | null;
	message: string;
	/** Identifies the inputs the quote (or the pending request) is for. */
	key: string;
}

const live = reactive<LiveQuote>({ status: "idle", quote: null, message: "", key: "" });
let installed = false;
let seq = 0;

export const toInput = (l: CartLine): CartLineInput => ({
	itemCode: l.itemCode,
	name: l.name,
	uom: l.uom,
	priceMinor: l.priceMinor,
	qtyMilli: l.qtyMilli,
	discountPct: l.discountPct,
	rateOverride: l.rateOverride,
});

export function quoteKey(customer: string): string {
	const { cart } = useCart();
	return JSON.stringify([
		customer,
		cart.lines.map((l) => [l.itemCode, l.uom, l.qtyMilli, l.discountPct ?? 0, l.rateOverride ?? null]),
		cart.coupons,
		cart.loyaltyPoints,
		cart.extraDiscountPct,
	]);
}

export function currentCustomer(): string {
	const { state } = useApp();
	return saleCustomer.customer?.name ?? state.context.customer ?? "";
}

async function refresh(key: string) {
	const { state } = useApp();
	const { cart } = useCart();
	const mine = ++seq;
	const e = state.cashier;
	if (!e || !cart.lines.length) {
		Object.assign(live, { status: "idle", quote: null, message: "", key });
		return;
	}
	if (!state.online) {
		Object.assign(live, { status: "offline", quote: null, message: "", key });
		return;
	}
	try {
		const api = await getContainer().session(e.site);
		const customer = currentCustomer();
		const quote = await quoteCart(
			api,
			{ profile: e.profile, customer, shift: state.context.openShift, minorDigits: e.minorDigits },
			cart.lines.map(toInput),
			{
				coupons: [...cart.coupons],
				loyaltyPoints: cart.loyaltyPoints,
				extraDiscountPct: cart.extraDiscountPct,
			},
		);
		if (mine === seq) Object.assign(live, { status: "ready", quote, message: "", key });
	} catch (err) {
		if (mine !== seq) return;
		if (err instanceof SessionExpiredError || (err instanceof QuoteError && err.code === "session")) {
			markSessionExpired();
			Object.assign(live, {
				status: "problem",
				quote: null,
				message: "Sign in again to continue.",
				key,
			});
		} else if (err instanceof OfflineError || (err instanceof QuoteError && err.code === "offline"))
			Object.assign(live, { status: "offline", quote: null, message: "", key });
		else
			Object.assign(live, {
				status: "problem",
				quote: null,
				message: err instanceof Error ? err.message : String(err),
				key,
			});
	}
}

/** Starts the one watcher that keeps the quote current. Safe to call from any component; it installs once. */
export function useLiveQuote() {
	if (!installed) {
		installed = true;
		const { state } = useApp();
		let timer: ReturnType<typeof setTimeout> | undefined;
		effectScope(true).run(() => {
			watch(
				() =>
					[
						quoteKey(currentCustomer()),
						state.online,
						state.sessionExpired,
						state.cashier?.profile,
					] as const,
				([key]) => {
					clearTimeout(timer);
					seq++;
					const { cart } = useCart();
					if (!cart.lines.length) {
						Object.assign(live, { status: "idle", quote: null, message: "", key });
						return;
					}
					// the old quote is gone the moment an input changes: no stale prices are ever shown or charged
					Object.assign(live, { status: "loading", quote: null, message: "", key });
					timer = setTimeout(() => void refresh(key), 300);
				},
				{ immediate: true },
			);
		});
	}
	return { live };
}
