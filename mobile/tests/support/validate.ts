import { lineTotalMinor } from "@mobile/domain/money";
import { SAMPLE_NOTICE, type SampleReceipt, type SampleSale } from "@mobile/domain/txn";

export function validateSale(sale: SampleSale): void {
	if (!sale.clientTxnId) throw new RangeError("clientTxnId required");
	if (!Number.isInteger(sale.minorDigits) || sale.minorDigits < 0 || sale.minorDigits > 4)
		throw new RangeError("minorDigits");
	if (!sale.lines.length) throw new RangeError("a sale needs at least one line");
	for (const l of sale.lines) {
		if (!Number.isSafeInteger(l.priceMinor) || !Number.isSafeInteger(l.qtyMilli) || l.qtyMilli === 0)
			throw new RangeError(`line ${l.itemCode}: price and qty must be integers (qty non-zero)`);
	}
}

export function buildReceipt(sale: SampleSale, capturedAt: number): SampleReceipt {
	const lines = sale.lines.map((l) => ({ ...l, totalMinor: lineTotalMinor(l.priceMinor, l.qtyMilli) }));
	return {
		clientTxnId: sale.clientTxnId,
		sample: true,
		notice: SAMPLE_NOTICE,
		currency: sale.currency,
		minorDigits: sale.minorDigits,
		lines,
		totalMinor: lines.reduce((s, l) => s + l.totalMinor, 0),
		capturedAt,
	};
}
