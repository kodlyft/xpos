/**
 * catalogIndex: the offline product search must answer exactly what the old "read every item,
 * filter in JavaScript" search answered - same matches, same order - while only scanning as far
 * as the requested page.
 */
import { describe, expect, it } from "vitest";
import { buildCatalogIndex, type CatalogRow } from "@/services/catalogIndex";

const FIELDS = ["name", "item_name", "local_item_name", "description"];

/** The implementation this index replaced (idbService.searchCachedItems), kept as the oracle. */
function oldSearch(rows: CatalogRow[], term: string, group: string, fields: string[]): string[] {
	let results = [...rows].sort((a, b) =>
		a.item_code < b.item_code ? -1 : a.item_code > b.item_code ? 1 : 0,
	);
	if (group && group !== "All Item Groups") results = results.filter((r) => r.item_group === group);
	if (term) {
		const lower = term.toLowerCase();
		const cols = fields.map((f) => (f === "name" ? "item_code" : f));
		results = results.filter((item) => {
			const matchesField = cols.some((field) => {
				const value = item[field];
				return typeof value === "string" && value.toLowerCase().includes(lower);
			});
			return matchesField || (!!item.barcode && item.barcode.toLowerCase().includes(lower));
		});
	}
	return results.map((r) => r.item_code);
}

function seeded(seed: number) {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const WORDS = [
	"Drill",
	"Hammer",
	"BOLT",
	"paint",
	"Ünïcode",
	"قفل",
	"Straße",
	"İstanbul",
	"mug",
	"10mm",
	"a-b",
];

function catalogue(count: number): CatalogRow[] {
	const r = seeded(11);
	const pick = () => WORDS[Math.floor(r() * WORDS.length)];
	return Array.from({ length: count }, (_, i) => ({
		item_code: `SKU-${String(Math.floor(r() * count * 3)).padStart(6, "0")}-${i}`,
		item_name: `${pick()} ${pick()}`,
		local_item_name: r() < 0.3 ? `${pick()}` : undefined,
		description: r() < 0.5 ? `${pick()} for ${pick()}` : "",
		item_group: ["Hardware", "Garden", "Kitchen"][Math.floor(r() * 3)],
		barcode: r() < 0.3 ? `ean${String(i).padStart(8, "0")}` : undefined,
	}));
}

function all(index: ReturnType<typeof buildCatalogIndex>, term: string, group = "") {
	const pages: string[] = [];
	for (let offset = 0; ; offset += 7) {
		const page = index.search({ term, group, offset, limit: 7 });
		pages.push(...page.codes);
		if (!page.hasMore) return pages;
	}
}

describe("catalogIndex.search", () => {
	const rows = catalogue(600);
	const index = buildCatalogIndex(rows, FIELDS);
	const terms = [
		"",
		"dr",
		"DRILL",
		"bolt",
		"ünï",
		"قف",
		"straße",
		"i̇stanbul",
		"10mm",
		"a-b",
		"ean0000",
		"ean00000012",
		"sku-0001",
		"nomatch",
		" ",
		"dr ill",
	];

	it.each(terms)("returns the old results, in the old order, for %j", (term) => {
		expect(all(index, term)).toEqual(oldSearch(rows, term, "", FIELDS));
	});

	it.each(["Hardware", "Garden", "Nothing", "All Item Groups"])(
		"filters by group %j like before",
		(group) => {
			for (const term of ["", "mug", "ean"]) {
				expect(all(index, term, group)).toEqual(oldSearch(rows, term, group, FIELDS));
			}
		},
	);

	it("honours the configured search fields", () => {
		const nameOnly = buildCatalogIndex(rows, ["item_name"]);
		for (const term of ["drill", "paint", "ean0000", "sku"]) {
			expect(all(nameOnly, term)).toEqual(oldSearch(rows, term, "", ["item_name"]));
		}
	});

	it("reports hasMore without reading past the page", () => {
		const first = index.search({ term: "", limit: 5 });
		expect(first.codes).toHaveLength(5);
		expect(first.hasMore).toBe(true);
		const tail = index.search({ term: "", offset: rows.length - 5, limit: 5 });
		expect(tail.codes).toHaveLength(5);
		expect(tail.hasMore).toBe(false);
		expect(index.search({ term: "", offset: rows.length, limit: 5 })).toEqual({
			codes: [],
			hasMore: false,
		});
	});

	it("never matches across two fields", () => {
		const two = buildCatalogIndex(
			[{ item_code: "X1", item_name: "alpha", local_item_name: "beta" }],
			["item_name", "local_item_name"],
		);
		expect(two.search({ term: "alphabeta", limit: 5 }).codes).toEqual([]);
		expect(two.search({ term: "alpha", limit: 5 }).codes).toEqual(["X1"]);
		expect(two.search({ term: "alpha\u0000beta", limit: 5 }).codes).toEqual([]);
	});

	it("stays bounded: a broad term over 100,000 items stops at the page", () => {
		const big = Array.from({ length: 100_000 }, (_, i) => ({
			item_code: `SKU-${String(i).padStart(6, "0")}`,
			item_name: `Widget ${i}`,
			item_group: "G",
		}));
		const bigIndex = buildCatalogIndex(big, ["item_name"]);
		const started = performance.now();
		const page = bigIndex.search({ term: "widget", limit: 40 });
		expect(page.codes).toHaveLength(40);
		expect(page.hasMore).toBe(true);
		expect(performance.now() - started).toBeLessThan(50);
	});
});

describe("catalogIndex.lookup", () => {
	const rows: CatalogRow[] = [
		{ item_code: "B-2", item_name: "Second", barcode: "6281000000012" },
		{ item_code: "A-1", item_name: "First", barcode: "" },
		{ item_code: "C-3", item_name: "Third", barcode: "a-1" },
	];
	const index = buildCatalogIndex(rows, FIELDS);

	it("finds an item by code or barcode, ignoring case", () => {
		expect(index.lookup("b-2")).toBe("B-2");
		expect(index.lookup("6281000000012")).toBe("B-2");
		expect(index.lookup("missing")).toBeUndefined();
	});

	it("prefers the first item in code order when a code and a barcode collide", () => {
		// "a-1" is the code of A-1 and the barcode of C-3; the old .find walked rows in code order.
		expect(index.lookup("a-1")).toBe("A-1");
	});

	it("does a substring match only in search, not in lookup", () => {
		expect(index.lookup("6281")).toBeUndefined();
	});
});
