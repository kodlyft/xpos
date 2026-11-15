import { computed } from "vue";

import {
	currencyMeta,
	displayPrecisionFor,
	formatFor,
	formatWithSymbol,
	symbolFor,
} from "@/composables/useCurrency";
import { usePosStore } from "@/stores/posStore";
import { floatPrecision, formatFloat, formatPercent, formatQty } from "@/utils/numberFormat";

function toNumber(value: number | string | null | undefined): number {
	if (typeof value === "number") return Number.isFinite(value) ? value : 0;
	const parsed = parseFloat(String(value ?? 0));
	return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Money and decimal formatting bound to the active POS Profile's currency.
 *
 * Every amount, rate and quantity a component prints should come from here rather
 * than from a local `toFixed`, so one site-wide change to System Settings (number
 * format, float precision, currency precision) moves the whole UI at once.
 *
 * - `money` includes the currency symbol, on the side the Currency doctype asks for
 * - `amount` is the same figure with no symbol, for cells that print the symbol in
 *   their own column or header
 * - `rate` uses the item rate precision (System Settings `float_precision`), which
 *   is finer than the currency's own precision
 */
export function useMoney() {
	const posStore = usePosStore();

	const currency = computed(() => posStore.invoiceCurrency || posStore.currency || "");
	const currencySymbol = computed(() => symbolFor(currency.value));

	const moneyPrecision = computed(() => displayPrecisionFor(currency.value));
	const ratePrecision = computed(() => floatPrecision());

	function money(value: number | string | null | undefined): string {
		return formatWithSymbol(currency.value, toNumber(value));
	}

	function amount(value: number | string | null | undefined): string {
		return formatFor(currency.value, toNumber(value));
	}

	function moneyIn(
		valueCurrency: string | null | undefined,
		value: number | string | null | undefined,
	): string {
		return formatWithSymbol(valueCurrency || currency.value, toNumber(value));
	}

	/** An item rate: finer than the currency precision, trailing zeros trimmed. */
	function rate(value: number | string | null | undefined, precision?: number): string {
		return formatQty(toNumber(value), precision ?? undefined);
	}

	function moneyRate(value: number | string | null | undefined, precision?: number): string {
		const figure = rate(value, precision);
		if (!currencySymbol.value) return figure;
		return currencyMeta(currency.value).symbol_on_right
			? `${figure} ${currencySymbol.value}`
			: `${currencySymbol.value} ${figure}`;
	}

	function qty(value: number | string | null | undefined, precision?: number): string {
		return formatQty(toNumber(value), precision ?? undefined);
	}

	function percent(value: number | string | null | undefined, precision?: number): string {
		return formatPercent(toNumber(value), precision ?? undefined);
	}

	/** Any non-currency decimal at an explicit precision. */
	function decimal(value: number | string | null | undefined, precision?: number): string {
		return formatFloat(toNumber(value), precision ?? undefined);
	}

	return {
		currency,
		currencySymbol,
		moneyPrecision,
		ratePrecision,
		money,
		amount,
		moneyIn,
		rate,
		moneyRate,
		qty,
		percent,
		decimal,
	};
}
