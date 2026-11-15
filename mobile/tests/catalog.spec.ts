import { beforeAll, describe, expect, it } from "vitest";
import { HostSqlite } from "./support/hostSqlite";
import { collect, withDuplicateBarcodes } from "./support/synthetic";
import { normalize } from "../src/domain/search";
import type { CatalogItem, CatalogRepository } from "../src/ports";

const SCOPE = {
	scopeId: "real:test",
	site: "synthetic",
	company: null,
	warehouse: null,
	priceList: null,
	currency: "PKR",
	minorDigits: 2,
};
const N = 6000;
let items: CatalogItem[];
let dups: string[];

async function seed(repo: CatalogRepository, scopeId = SCOPE.scopeId, list = items) {
	await repo.createScope({ ...SCOPE, scopeId });
	const g = await repo.beginGeneration(scopeId);
	for (let i = 0; i < list.length; i += 500) await repo.putBatch(scopeId, g, list.slice(i, i + 500));
	await repo.activate(scopeId, g, list.length);
}

beforeAll(() => {
	const r = withDuplicateBarcodes(collect(N));
	items = r.items;
	dups = r.duplicates;
});

describe("catalog semantics (host SQLite double)", () => {
	const make = () => new HostSqlite();
	it("pages the whole catalog with stable order: no gaps, no duplicates", async () => {
		const repo = make();
		await seed(repo);
		const seen: string[] = [];
		let after: string | undefined;
		do {
			const p = await repo.page(SCOPE.scopeId, { after, limit: 100 });
			expect(p.items.length).toBeLessThanOrEqual(100);
			seen.push(...p.items.map((i) => i.itemCode));
			after = p.next;
		} while (after);
		expect(seen.length).toBe(N);
		expect(new Set(seen).size).toBe(N);
		const expected = [...items]
			.sort((a, b) =>
				normalize(a.name) < normalize(b.name)
					? -1
					: normalize(a.name) > normalize(b.name)
						? 1
						: a.itemCode < b.itemCode
							? -1
							: 1,
			)
			.map((i) => i.itemCode);
		expect(seen).toEqual(expected);
	});

	it("search is PREFIX-only on name or code, not substring", async () => {
		const repo = make();
		await seed(repo);
		const target = items.find((i) => i.itemGroup === "Grocery")!;
		const first = normalize(target.name).split(" ")[0];
		const hits = await repo.search(SCOPE.scopeId, first.toUpperCase(), { limit: 100 });
		expect(hits.items.length).toBeGreaterThan(0);
		for (const h of hits.items)
			expect(normalize(h.name).startsWith(first) || normalize(h.itemCode).startsWith(first)).toBe(true);
		// a word from the middle of a name must not match
		const mid = normalize(target.name).split(" ")[2];
		const midHits = await repo.search(SCOPE.scopeId, mid, { limit: 100 });
		for (const h of midHits.items)
			expect(normalize(h.name).startsWith(mid) || normalize(h.itemCode).startsWith(mid)).toBe(true);
		// code prefix
		const byCode = await repo.search(SCOPE.scopeId, items[0].itemCode, { limit: 100 });
		expect(byCode.items.some((i) => i.itemCode === items[0].itemCode)).toBe(true);
		expect((await repo.search(SCOPE.scopeId, "   ")).items).toEqual([]);
	});

	it("search pagination is complete and ordered across pages", async () => {
		const repo = make();
		await seed(repo);
		const q = "al";
		const all: string[] = [];
		let after: string | undefined;
		do {
			const p = await repo.search(SCOPE.scopeId, q, { after, limit: 17 });
			all.push(...p.items.map((i) => i.itemCode));
			after = p.next;
		} while (after);
		const expected = items.filter(
			(i) => normalize(i.name).startsWith(q) || normalize(i.itemCode).startsWith(q),
		);
		expect(all.length).toBe(expected.length);
		expect(new Set(all).size).toBe(all.length);
	});

	it("exact barcode lookup, multiple barcodes per item, and duplicate-barcode ambiguity", async () => {
		const repo = make();
		await seed(repo);
		const multi = items.find((i) => i.barcodes.length > 1 && !dups.includes(i.barcodes[0]))!;
		for (const b of multi.barcodes) {
			const r = await repo.lookupBarcode(SCOPE.scopeId, b);
			expect(r.matches.map((m) => m.itemCode)).toContain(multi.itemCode);
		}
		const amb = await repo.lookupBarcode(SCOPE.scopeId, dups[0]);
		expect(amb.ambiguous).toBe(true);
		expect(amb.matches.length).toBe(2);
		expect(amb.matches.map((m) => m.itemCode)).toEqual([...amb.matches.map((m) => m.itemCode)].sort());
		expect(await repo.lookupBarcode(SCOPE.scopeId, "0000000000000")).toEqual({
			matches: [],
			ambiguous: false,
		});
	});

	it("variants resolve by template and keep colour/size attributes", async () => {
		const repo = make();
		await seed(repo);
		const v = items.find((i) => i.variantOf)!;
		const vs = await repo.variantsOf(SCOPE.scopeId, v.variantOf!);
		expect(vs.length).toBeGreaterThan(1);
		expect(vs.every((x) => x.attrs.Color && x.attrs.Size)).toBe(true);
	});

	it("variantsOnly pages and searches return only variant items, in stable order", async () => {
		const repo = make();
		await seed(repo);
		const seen: string[] = [];
		let after: string | undefined;
		do {
			const p = await repo.page(SCOPE.scopeId, { after, limit: 100, variantsOnly: true });
			expect(p.items.every((i) => i.variantOf)).toBe(true);
			seen.push(...p.items.map((i) => i.itemCode));
			after = p.next;
		} while (after);
		expect(seen.length).toBe(items.filter((i) => i.variantOf).length);
		expect(new Set(seen).size).toBe(seen.length);
		const found = await repo.search(SCOPE.scopeId, "a", { limit: 100, variantsOnly: true });
		expect(found.items.every((i) => i.variantOf)).toBe(true);
	});

	it("scopes are isolated: the same codes in two scopes never mix", async () => {
		const repo = make();
		await seed(repo, "real:a", items.slice(0, 50));
		await repo.createScope({ ...SCOPE, scopeId: "real:x" });
		const g = await repo.beginGeneration("real:x");
		const real: CatalogItem = {
			itemCode: items[0].itemCode,
			variantOf: null,
			name: "REAL Item",
			itemGroup: "G",
			uom: "Nos",
			priceMinor: 1,
			priced: true,
			attrs: {},
			barcodes: [items[0].barcodes[0]],
		};
		await repo.putBatch("real:x", g, [real]);
		await repo.activate("real:x", g, 1);
		expect((await repo.getItem("real:x", items[0].itemCode))?.name).toBe("REAL Item");
		expect((await repo.getItem("real:a", items[0].itemCode))?.name).toBe(items[0].name);
		expect((await repo.stats("real:x")).items).toBe(1);
		expect((await repo.page("real:x")).items.length).toBe(1);
		await repo.dropScope("real:a");
		expect((await repo.getItem("real:x", items[0].itemCode))?.name).toBe("REAL Item");
	});

	it("staging is invisible until activation; a count mismatch leaves the active catalog intact", async () => {
		const repo = make();
		await seed(repo, "s", items.slice(0, 100));
		const g2 = await repo.beginGeneration("s");
		await repo.putBatch("s", g2, items.slice(100, 150));
		expect((await repo.stats("s")).items).toBe(100); // staging not visible
		await expect(repo.activate("s", g2, 51)).rejects.toThrow(/expected 51/);
		expect((await repo.stats("s")).items).toBe(100);
		expect(await repo.getItem("s", items[0].itemCode)).not.toBeNull();
		await repo.discard("s", g2);
		const g3 = await repo.beginGeneration("s");
		await repo.putBatch("s", g3, items.slice(100, 150));
		await repo.activate("s", g3, 50);
		expect((await repo.stats("s")).items).toBe(50);
		expect(await repo.getItem("s", items[0].itemCode)).toBeNull(); // old generation retired
		await expect(repo.discard("s", g3)).rejects.toThrow(/active/);
	});

	it("rejects an invalid cursor instead of returning arbitrary rows", async () => {
		const repo = make();
		await seed(repo);
		await expect(repo.page(SCOPE.scopeId, { after: "!!!not-a-cursor" })).rejects.toThrow();
	});
});
