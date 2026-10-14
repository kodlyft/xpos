export interface NumberFormatInfo {
	decimalStr: string;
	groupSep: string;
	precision: number;
}

export const NUMBER_FORMAT_INFO: Record<string, { decimalStr: string; groupSep: string }> = {
	"#,###.##": { decimalStr: ".", groupSep: "," },
	"#.###,##": { decimalStr: ",", groupSep: "." },
	"# ###.##": { decimalStr: ".", groupSep: " " },
	"# ###,##": { decimalStr: ",", groupSep: " " },
	"#'###.##": { decimalStr: ".", groupSep: "'" },
	"#, ###.##": { decimalStr: ".", groupSep: ", " },
	"#,##,###.##": { decimalStr: ".", groupSep: "," },
	"#,###.###": { decimalStr: ".", groupSep: "," },
	"#.###": { decimalStr: "", groupSep: "." },
	"#,###": { decimalStr: "", groupSep: "," },
	"#.########": { decimalStr: ".", groupSep: "" },
};

export const DEFAULT_NUMBER_FORMAT = "#,###.##";
const DEFAULT_MASK_PRECISION = 2;
export const DEFAULT_FLOAT_PRECISION = 3;
const INDIAN_NUMBER_FORMAT = "#,##,###.##";

export interface NumberFormatSettings {
	number_format: string;
	float_precision: number | string;
	currency_precision: number | string;
	use_number_format_from_currency: number | boolean;
	hide_currency_symbol: number | boolean | string;
}

const FALLBACK_SETTINGS: NumberFormatSettings = {
	number_format: DEFAULT_NUMBER_FORMAT,
	float_precision: "",
	currency_precision: "",
	use_number_format_from_currency: 0,
	hide_currency_symbol: 0,
};

let settings: NumberFormatSettings | null = null;

function readBootSettings(): NumberFormatSettings | null {
	const boot = (window as any)?.xpos?.boot;
	if (!boot) return null;

	const source = boot.xpos_number_format || boot.sysdefaults;
	if (!source) return null;

	return normalizeSettings(source);
}

export function normalizeSettings(source: Partial<NumberFormatSettings> | null | undefined) {
	return {
		...FALLBACK_SETTINGS,
		number_format: (source?.number_format as string) || DEFAULT_NUMBER_FORMAT,
		float_precision: source?.float_precision ?? "",
		currency_precision: source?.currency_precision ?? "",
		use_number_format_from_currency: source?.use_number_format_from_currency ?? 0,
		hide_currency_symbol: source?.hide_currency_symbol ?? 0,
	} satisfies NumberFormatSettings;
}

export function setNumberFormatSettings(source: Partial<NumberFormatSettings> | null | undefined): void {
	settings = normalizeSettings(source);
}

export function resetNumberFormatSettings(): void {
	settings = null;
}

export function numberFormatSettings(): NumberFormatSettings {
	if (settings === null) settings = readBootSettings() || { ...FALLBACK_SETTINGS };
	return settings;
}

export function systemNumberFormat(): string {
	return numberFormatSettings().number_format || DEFAULT_NUMBER_FORMAT;
}

export function useNumberFormatFromCurrency(): boolean {
	return !!toInt(numberFormatSettings().use_number_format_from_currency);
}

export function hideCurrencySymbol(): boolean {
	const value = numberFormatSettings().hide_currency_symbol;
	return value === "Yes" || !!toInt(value);
}

export function floatPrecision(): number {
	const value = toOptionalInt(numberFormatSettings().float_precision);
	return value === null ? DEFAULT_FLOAT_PRECISION : value;
}

export function currencyPrecisionOverride(): number | null {
	return toOptionalInt(numberFormatSettings().currency_precision);
}

function toInt(value: unknown): number {
	const parsed = parseInt(String(value ?? ""), 10);
	return Number.isFinite(parsed) ? parsed : 0;
}

function toOptionalInt(value: unknown): number | null {
	if (value === null || value === undefined || value === "") return null;
	const parsed = parseInt(String(value), 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function getNumberFormatInfo(format?: string | null): NumberFormatInfo {
	const mask = format || systemNumberFormat();
	const info = NUMBER_FORMAT_INFO[mask] || { decimalStr: ".", groupSep: "," };
	return { ...info, precision: precisionFromNumberFormat(mask) };
}

export function precisionFromNumberFormat(format?: string | null): number {
	if (!format) return DEFAULT_MASK_PRECISION;

	const known = NUMBER_FORMAT_INFO[format];
	if (known) {
		return known.decimalStr === "" ? 0 : (format.split(known.decimalStr).slice(1)[0] || "").length;
	}

	const groups = format.trim().split(/[^#]+/).filter(Boolean);
	const separatorCount = groups.length - 1;
	if (separatorCount < 1) return 0;

	const trailing = groups[groups.length - 1].length;
	return trailing === 3 && separatorCount === 1 ? 0 : trailing;
}

export function roundTo(value: number, precision: number): number {
	if (!Number.isFinite(value)) return 0;

	const factor = 10 ** precision;
	const scaled = Number((Math.abs(value) * factor).toPrecision(15));
	const rounded = Math.round(scaled) / factor;

	return value < 0 ? -rounded : rounded;
}

function groupDigits(integer: string, groupSep: string, indian: boolean): string {
	if (!groupSep || integer.length < 4) return integer;

	if (!indian) {
		return integer.replace(/\B(?=(\d{3})+(?!\d))/g, () => groupSep);
	}

	const head = integer.slice(0, -3);
	const tail = integer.slice(-3);
	return head.replace(/\B(?=(\d{2})+(?!\d))/g, () => groupSep) + groupSep + tail;
}

/**
 * Format a number against a Frappe number-format mask.
 *
 * @param value     the number (or numeric string) to render
 * @param format    mask to use; defaults to the System Settings mask
 * @param precision decimals to keep; defaults to `float_precision` when no mask
 *                  was given, otherwise to the mask's own decimals
 */
export function formatNumber(
	value: number | string | null | undefined,
	format?: string | null,
	precision?: number | null,
): string {
	const mask = format || systemNumberFormat();
	const info = getNumberFormatInfo(mask);

	let decimals = precision ?? null;
	if (decimals === null) decimals = format ? info.precision : floatPrecision();
	if (info.decimalStr === "") decimals = 0;

	const parsed = typeof value === "number" ? value : parseNumber(value, mask);
	const rounded = roundTo(parsed, decimals);
	const isNegative = rounded < 0;

	const [integer, fraction] = Math.abs(rounded).toFixed(decimals).split(".");
	const grouped = groupDigits(integer || "0", info.groupSep, mask === INDIAN_NUMBER_FORMAT);
	const tail = fraction && info.decimalStr ? info.decimalStr + fraction : "";

	return `${isNegative ? "-" : ""}${grouped || "0"}${tail}`;
}

/** A Float / Percent value at the configured `float_precision`. */
export function formatFloat(value: number | string | null | undefined, precision?: number | null): string {
	return formatNumber(value, systemNumberFormat(), precision ?? floatPrecision());
}

/** An Int value: grouped, never fractional. */
export function formatInt(value: number | string | null | undefined): string {
	return formatNumber(value, systemNumberFormat(), 0);
}

export function formatPercent(value: number | string | null | undefined, precision?: number | null): string {
	return `${formatFloat(value, precision)}%`;
}

/**
 * A quantity: formatted at `float_precision` but with trailing zeros trimmed, so
 * a whole `2` prints as `2` rather than `2.000`.
 */
export function formatQty(value: number | string | null | undefined, precision?: number | null): string {
	const info = getNumberFormatInfo();
	const formatted = formatFloat(value, precision);
	if (!info.decimalStr || !formatted.includes(info.decimalStr)) return formatted;

	const escaped = info.decimalStr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return formatted.replace(new RegExp(`${escaped}?0+$`), "");
}

/**
 * Parse a display string back to a number, undoing the configured grouping and
 * decimal separator. Needed wherever a user can type into a formatted field.
 */
export function parseNumber(value: number | string | null | undefined, format?: string | null): number {
	if (typeof value === "number") return Number.isFinite(value) ? value : 0;
	if (value === null || value === undefined || value === "") return 0;

	const info = getNumberFormatInfo(format);
	let text = String(value).trim();

	text = text.replace(/[^\d\-+.,'’\s]/g, "").trim();

	if (info.groupSep) {
		text = text.split(info.groupSep).join("");
	}
	if (info.decimalStr && info.decimalStr !== ".") {
		text = text.split(info.decimalStr).join(".");
	}
	text = text.replace(/[\s'’]/g, "");
	if (info.decimalStr !== ",") text = text.split(",").join("");

	const parsed = parseFloat(text);
	return Number.isFinite(parsed) ? parsed : 0;
}

export function formatTaxAmount(
	value: number | string | null | undefined,
	included: boolean | number | null | undefined,
	format: (value: number | string) => string,
): string {
	const figure = format(value ?? 0);
	const amount = typeof value === "number" ? value : parseFloat(String(value));
	return !included && amount >= 0 ? `+${figure}` : figure;
}
