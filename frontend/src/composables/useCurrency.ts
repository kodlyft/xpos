import { computed } from "vue";

import { getCachedCurrencyMeta } from "@/services/dbBridge";
import {
	currencyPrecisionOverride,
	formatNumber,
	hideCurrencySymbol,
	precisionFromNumberFormat,
	roundTo,
	systemNumberFormat,
	useNumberFormatFromCurrency,
} from "@/utils/numberFormat";

export interface CurrencyMeta {
	name: string;
	symbol: string;
	precision: number;
	symbol_on_right: boolean;
	number_format: string;
}

export const DEFAULT_CURRENCY_PRECISION = 2;

export { precisionFromNumberFormat };

let cachedCurrencies: Record<string, CurrencyMeta> | null = null;

function toMeta(row: {
	name?: string;
	symbol?: string;
	number_format?: string;
	symbol_on_right?: number | boolean;
}): CurrencyMeta {
	return {
		name: row.name as string,
		symbol: row.symbol || (row.name as string),
		precision: precisionFromNumberFormat(row.number_format),
		symbol_on_right: !!row.symbol_on_right,
		number_format: row.number_format || "",
	};
}

function readBootCurrencies(): Record<string, CurrencyMeta> {
	const rows = (window.xpos as any)?.boot?.currencies;
	if (!Array.isArray(rows)) return {};

	const map: Record<string, CurrencyMeta> = {};
	for (const row of rows) {
		if (!row?.name) continue;
		map[row.name] = toMeta(row);
	}
	return map;
}

export async function primeCurrencyCache(): Promise<void> {
	const boot = readBootCurrencies();
	if (Object.keys(boot).length) {
		cachedCurrencies = boot;
		return;
	}

	try {
		const rows = await getCachedCurrencyMeta();
		const map: Record<string, CurrencyMeta> = {};
		for (const row of rows || []) {
			if (!row?.name) continue;
			map[row.name] = toMeta(row);
		}
		cachedCurrencies = map;
	} catch {
		cachedCurrencies = {};
	}
}

export function resetCurrencyCache(): void {
	cachedCurrencies = null;
}

export function currencyMeta(currency?: string | null): CurrencyMeta {
	const name = currency || "";
	if (cachedCurrencies === null) cachedCurrencies = readBootCurrencies();

	return (
		cachedCurrencies[name] || {
			name,
			symbol: name,
			precision: DEFAULT_CURRENCY_PRECISION,
			symbol_on_right: false,
			number_format: "",
		}
	);
}

export function precisionFor(currency?: string | null): number {
	return currencyMeta(currency).precision;
}

export function displayPrecisionFor(currency?: string | null): number {
	return currencyPrecisionOverride() ?? precisionFor(currency);
}

export function numberFormatFor(currency?: string | null): string {
	if (useNumberFormatFromCurrency()) {
		const own = currencyMeta(currency).number_format;
		if (own) return own;
	}
	return systemNumberFormat();
}

export function symbolFor(currency?: string | null): string {
	return currencyMeta(currency).symbol;
}

export function minorUnitFor(currency?: string | null): number {
	return 10 ** -precisionFor(currency);
}

export function roundFor(currency: string | null | undefined, value: number): number {
	return roundTo(value, precisionFor(currency));
}

export function formatFor(
	currency: string | null | undefined,
	value: number,
	precision?: number | null,
): string {
	return formatNumber(
		Number.isFinite(value) ? value : 0,
		numberFormatFor(currency),
		precision ?? displayPrecisionFor(currency),
	);
}

export function formatWithSymbol(
	currency: string | null | undefined,
	value: number,
	precision?: number | null,
): string {
	const meta = currencyMeta(currency);
	const amount = formatFor(currency, value, precision);
	if (hideCurrencySymbol() || !meta.symbol) return amount;

	return meta.symbol_on_right ? `${amount} ${meta.symbol}` : `${meta.symbol} ${amount}`;
}

export function convertToBase(
	currency: string | null | undefined,
	baseCurrency: string | null | undefined,
	nativeAmount: number,
	rate: number,
): number {
	if (!currency || currency === baseCurrency) return roundFor(baseCurrency, nativeAmount);
	const sign = nativeAmount < 0 ? -1 : 1;
	return roundFor(baseCurrency, Math.abs(nativeAmount) * (rate || 0)) * sign;
}

export function useCurrency() {
	return {
		currencyMeta,
		precisionFor,
		displayPrecisionFor,
		numberFormatFor,
		symbolFor,
		minorUnitFor,
		roundFor,
		formatFor,
		formatWithSymbol,
		convertToBase,
		primeCurrencyCache,
		defaultPrecision: computed(() => DEFAULT_CURRENCY_PRECISION),
	};
}
