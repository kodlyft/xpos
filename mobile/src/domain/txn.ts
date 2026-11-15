/** Canonical JSON + content hash: the basis of idempotent retry and conflicting-ID rejection. */

export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") {
		if (typeof value === "number" && !Number.isFinite(value)) throw new TypeError("non-finite number");
		if (value === undefined) throw new TypeError("undefined is not canonical");
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
	const obj = value as Record<string, unknown>;
	return (
		"{" +
		Object.keys(obj)
			.sort()
			.filter((k) => obj[k] !== undefined)
			.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k]))
			.join(",") +
		"}"
	);
}

export async function sha256Hex(text: string): Promise<string> {
	const buf = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface SampleLine {
	itemCode: string;
	name: string;
	priceMinor: number;
	qtyMilli: number;
}

/** What the cashier captured. `clientTxnId` is stable across retries (generated once per sale). */
export interface SampleSale {
	clientTxnId: string;
	scopeId: string;
	currency: string;
	minorDigits: number;
	lines: SampleLine[];
}

export interface SampleReceipt {
	clientTxnId: string;
	sample: true;
	notice: string;
	currency: string;
	minorDigits: number;
	lines: (SampleLine & { totalMinor: number })[];
	totalMinor: number;
	capturedAt: number;
}

export type CommitResult = { status: "created" | "duplicate"; receipt: SampleReceipt };

export class TxnConflictError extends Error {
	constructor(public readonly txnId: string) {
		super(`transaction id ${txnId} already exists with different contents`);
		this.name = "TxnConflictError";
	}
}

export class TxnWriteError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "TxnWriteError";
	}
}

export const SAMPLE_NOTICE = "SAMPLE ONLY - not an invoice, not posted to ERPNext, no payment taken.";

export function newClientTxnId(): string {
	return "smp-" + globalThis.crypto.randomUUID();
}
