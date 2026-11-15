/**
 * A barcode that is not in the local catalog: the catalog keeps only barcodes of an item's stock unit, because a
 * box barcode priced as a single would charge the wrong amount. Online, the server resolves any barcode, including
 * the unit it sells in; the sale line then carries that unit and the quote prices it.
 */
import type { ApiTransport, CatalogItem } from "@mobile/ports";
import { fromRate } from "@mobile/domain/money";

interface BarcodeReply {
	item_code: string;
	uom?: string;
	rate?: number | null;
	conversion_factor?: number | null;
	is_scale_barcode?: boolean | number;
}

export type RemoteBarcode =
	| { kind: "found"; itemCode: string; uom: string; priceMinor: number }
	| { kind: "unsupported"; reason: string }
	| { kind: "none" };

export async function lookupRemoteBarcode(
	api: ApiTransport,
	profile: string,
	barcode: string,
	minorDigits: number,
): Promise<RemoteBarcode> {
	const r = await api.call<BarcodeReply | null>("xpos.api.items.search_barcode", {
		barcode,
		pos_profile: profile,
	});
	if (!r?.item_code) return { kind: "none" };
	if (r.is_scale_barcode)
		return { kind: "unsupported", reason: "Weighed-item barcodes are not supported on mobile yet." };
	return {
		kind: "found",
		itemCode: r.item_code,
		uom: r.uom ?? "",
		priceMinor: fromRate(Number(r.rate ?? 0), minorDigits),
	};
}

/** The catalog item sold in the barcode's unit, so the cart line and its estimate use that unit. */
export function asScanned(item: CatalogItem, found: Extract<RemoteBarcode, { kind: "found" }>): CatalogItem {
	return found.uom && found.uom !== item.uom
		? {
				...item,
				uom: found.uom,
				priceMinor: found.priceMinor,
				priced: found.priceMinor > 0 || item.priced,
			}
		: item;
}
