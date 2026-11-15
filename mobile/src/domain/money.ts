/**
 * Integer minor-unit money. The number of minor digits is a property of the currency (supplied
 * by the server bootstrap), never assumed to be 2. Quantities are integer thousandths so
 * fractional units (kg, m) stay exact.
 */

export const QTY_SCALE = 1000;

export interface Currency {
	code: string;
	minorDigits: number;
}

export function assertMinorDigits(d: number): void {
	if (!Number.isInteger(d) || d < 0 || d > 4) throw new RangeError(`invalid minor digits: ${d}`);
}

/** Parse a plain decimal string ("12.5", "-3", "0.075") into minor units; rejects excess precision. */
export function toMinor(text: string, minorDigits: number): number {
	assertMinorDigits(minorDigits);
	const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text.trim());
	if (!m) throw new RangeError(`not a decimal amount: ${text}`);
	const frac = m[3] ?? "";
	if (frac.length > minorDigits && /[1-9]/.test(frac.slice(minorDigits)))
		throw new RangeError(`${text} has more than ${minorDigits} decimals`);
	const digits = (m[2] + frac.padEnd(minorDigits, "0").slice(0, minorDigits)).replace(/^0+(?=\d)/, "");
	const n = Number(digits);
	if (!Number.isSafeInteger(n)) throw new RangeError("amount out of range");
	return m[1] ? -n : n;
}

export function formatMinor(minor: number, minorDigits: number): string {
	assertMinorDigits(minorDigits);
	if (!Number.isSafeInteger(minor)) throw new RangeError("minor amount must be a safe integer");
	const neg = minor < 0;
	const s = String(Math.abs(minor)).padStart(minorDigits + 1, "0");
	const whole = minorDigits ? s.slice(0, -minorDigits) : s;
	const frac = minorDigits ? "." + s.slice(-minorDigits) : "";
	return (neg ? "-" : "") + whole + frac;
}

/** price (minor per 1 unit) × qty (thousandths), rounded half away from zero to a minor unit. */
export function lineTotalMinor(priceMinor: number, qtyMilli: number): number {
	if (!Number.isSafeInteger(priceMinor) || !Number.isSafeInteger(qtyMilli))
		throw new RangeError("price and qty must be integers");
	const p = BigInt(priceMinor) * BigInt(qtyMilli);
	const s = BigInt(QTY_SCALE);
	const abs = p < 0n ? -p : p;
	const q = (abs * 2n + s) / (s * 2n);
	const r = Number(p < 0n ? -q : q);
	if (!Number.isSafeInteger(r)) throw new RangeError("line total out of range");
	return r;
}

export function qtyToMilli(qty: number): number {
	const n = Math.round(qty * QTY_SCALE);
	if (Math.abs(n / QTY_SCALE - qty) > 1e-9) throw new RangeError(`qty ${qty} has more than 3 decimals`);
	return n;
}

/** A server rate (a JS number in the profile currency) as exact minor units: rounds to the currency precision first. */
export function fromRate(rate: number, minorDigits: number): number {
	assertMinorDigits(minorDigits);
	if (!Number.isFinite(rate) || rate < 0) return 0;
	return toMinor(rate.toFixed(minorDigits), minorDigits);
}
