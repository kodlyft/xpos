/**
 * Deterministic fixture catalog for the unit tests. Records are fabricated; they must
 * only be used in tests.
 */
import type { CatalogItem } from "@mobile/ports";

export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const NOUNS = ["Tee", "Hoodie", "Jeans", "Kurta", "Scarf", "Cap", "Sneaker", "Sandal", "Jacket", "Socks"];
const SIMPLE_NOUNS = [
	"Cola",
	"Biscuit",
	"Notebook",
	"Pen",
	"Soap",
	"Shampoo",
	"Rice",
	"Tea",
	"Battery",
	"Cable",
	"Bulb",
	"Juice",
	"Cereal",
	"Candle",
	"Mug",
];
const BRANDS = [
	"Alpha",
	"Zenith",
	"Crown",
	"Nova",
	"Orion",
	"Pearl",
	"Delta",
	"Vista",
	"Maple",
	"Indus",
	"Kite",
	"Lumen",
];
const DESC = ["Classic", "Premium", "Mini", "Family", "Eco", "Daily", "Pro", "Lite", "Select", "Fresh"];
export const COLORS = ["Black", "White", "Red", "Blue", "Green", "Grey", "Navy", "Beige"];
export const SIZES = ["XS", "S", "M", "L", "XL", "XXL"];
const GROUPS = ["Grocery", "Stationery", "Household", "Electronics", "Beverages"];

function ean13(n: number): string {
	const base = String(200000000000 + n).padStart(12, "0");
	let sum = 0;
	for (let i = 0; i < 12; i++) sum += Number(base[i]) * (i % 2 ? 3 : 1);
	return base + ((10 - (sum % 10)) % 10);
}

export const DUPLICATE_BARCODE_FIXTURES = 5;

/** Exactly `count` sellable records: ~40% apparel variants (colour × size), the rest simple items. */
export function* syntheticItems(count: number, seed = 42, minorDigits = 2): Generator<CatalogItem> {
	const rnd = mulberry32(seed);
	const unit = 10 ** minorDigits;
	let emitted = 0;
	let bc = 0;
	let tpl = 0;
	while (emitted < count) {
		if (rnd() < 0.4) {
			const noun = NOUNS[Math.floor(rnd() * NOUNS.length)];
			const brand = BRANDS[Math.floor(rnd() * BRANDS.length)];
			const tcode = `TPL-${String(++tpl).padStart(6, "0")}`;
			const tname = `${brand} ${DESC[Math.floor(rnd() * DESC.length)]} ${noun}`;
			const base = Math.round((8 + rnd() * 90) * unit);
			const nColors = 2 + Math.floor(rnd() * 3);
			const nSizes = 3 + Math.floor(rnd() * 3);
			for (let c = 0; c < nColors && emitted < count; c++) {
				for (let s = 0; s < nSizes && emitted < count; s++) {
					const color = COLORS[(c + tpl) % COLORS.length];
					const size = SIZES[s];
					const codes = 1 + Math.floor(rnd() * 3);
					yield {
						itemCode: `${tcode}-${color.toUpperCase()}-${size}`,
						variantOf: tcode,
						name: `${tname} - ${color} / ${size}`,
						itemGroup: "Apparel",
						uom: "Nos",
						priceMinor: base + s * Math.round(unit / 2),
						priced: true,
						brand,
						attrs: { Color: color, Size: size },
						barcodes: Array.from({ length: codes }, () => ean13(++bc)),
					};
					emitted++;
				}
			}
		} else {
			const noun = SIMPLE_NOUNS[Math.floor(rnd() * SIMPLE_NOUNS.length)];
			const brand = BRANDS[Math.floor(rnd() * BRANDS.length)];
			const id = emitted + 1;
			const codes = 1 + (rnd() < 0.25 ? 1 : 0);
			yield {
				itemCode: `SKU-${String(id).padStart(7, "0")}`,
				variantOf: null,
				name: `${brand} ${DESC[Math.floor(rnd() * DESC.length)]} ${noun} ${Math.floor(rnd() * 900) + 100}`,
				itemGroup: GROUPS[Math.floor(rnd() * GROUPS.length)],
				uom: rnd() < 0.2 ? "Kg" : "Nos",
				priceMinor: Math.round((0.5 + rnd() * 40) * unit),
				priced: true,
				brand,
				attrs: {},
				barcodes: Array.from({ length: codes }, () => ean13(++bc)),
			};
			emitted++;
		}
	}
}

export function collect(count: number, seed = 42, minorDigits = 2): CatalogItem[] {
	return Array.from(syntheticItems(count, seed, minorDigits));
}

/** Plant a few barcodes on two items each (wrong data, but it happens): lookup must flag ambiguity. */
export function withDuplicateBarcodes(items: CatalogItem[]): { items: CatalogItem[]; duplicates: string[] } {
	const dups: string[] = [];
	for (let i = 0; i < DUPLICATE_BARCODE_FIXTURES && i * 2 + 1 < items.length; i++) {
		const a = items[i * 2];
		const b = items[i * 2 + 1];
		if (!b.barcodes.includes(a.barcodes[0])) b.barcodes.push(a.barcodes[0]);
		dups.push(a.barcodes[0]);
	}
	return { items, duplicates: dups };
}
