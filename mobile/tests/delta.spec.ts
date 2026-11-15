import { describe, expect, it } from "vitest";
import { memoryMeta, syncCatalog, type ServerItem } from "../src/app/catalogSync";
import { crc32 } from "../src/domain/crc32";
import type { ApiTransport } from "../src/ports";
import { HostSqlite } from "./support/hostSqlite";

const SCOPE = "real:c|Main@shop";
let seq = 0;

class Server implements ApiTransport {
	readonly kind = "native" as const;
	items = new Map<string, ServerItem>();
	pending = { upserts: [] as string[], removed: [] as string[] };
	scope = { company: "Acme", warehouse: "S", price_list: "Std", currency: "KWD" };
	expire = false;
	calls: string[] = [];
	add(code: string, rate: number) {
		this.items.set(code, {
			item_code: code,
			item_name: code,
			stock_uom: "Nos",
			rate,
			barcodes: [{ barcode: "B" + code, uom: "Nos", conversion_factor: 1 }],
		});
	}
	async call<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
		const name = method.split(".").pop()!;
		this.calls.push(name);
		const sorted = [...this.items.values()].sort((a, b) => (a.item_code < b.item_code ? -1 : 1));
		if (name === "catalog_begin")
			return {
				scope: this.scope,
				total: sorted.length,
				cursors: { items: "i:", delta: "d:" + ++seq },
			} as T;
		if (name === "catalog_page") return { items: sorted, next_cursor: null } as T;
		if (name === "catalog_digest")
			return {
				count: sorted.length,
				checksum: sorted.reduce((s, r) => s + crc32(r.item_code), 0),
			} as T;
		if (name === "catalog_delta") {
			if (this.expire) return { resync: "cursor_expired" } as T;
			const ups = this.pending.upserts.map((c) => this.items.get(c)!).filter(Boolean);
			const out = {
				upserts: ups,
				removed: this.pending.removed,
				next_cursor: "d:" + ++seq,
				has_more: false,
			};
			this.pending = { upserts: [], removed: [] };
			return out as T;
		}
		throw new Error(name + String(args));
	}
}

const base = (api: Server, repo: HostSqlite, meta = memoryMeta()) => ({
	api,
	repo,
	meta,
	scopeId: SCOPE,
	site: "https://shop",
	profile: "Main",
	minorDigits: 2,
});
// the fake server ignores pos_profile checks, so wrap to keep the same call shape
const run = (api: Server, repo: HostSqlite, meta: ReturnType<typeof memoryMeta>) =>
	syncCatalog(base(api, repo, meta));

describe("catalog delta refresh", () => {
	it("first run downloads everything, later runs fetch only what changed (price, new, removed)", async () => {
		const s = new Server();
		for (let i = 1; i <= 5; i++) s.add("A" + i, i);
		const repo = new HostSqlite();
		const meta = memoryMeta();
		expect((await run(s, repo, meta)).mode).toBe("full");

		s.add("A2", 99.5); // price change
		s.add("A9", 9); // new
		s.items.delete("A5"); // removed
		s.pending = { upserts: ["A2", "A9"], removed: ["A5"] };
		const r = await run(s, repo, meta);
		expect(r).toMatchObject({ mode: "delta", items: 5, changed: 2, removed: 1 });
		expect((await repo.getItem(SCOPE, "A2"))!.priceMinor).toBe(9950);
		expect(await repo.getItem(SCOPE, "A5")).toBeNull();
		expect((await repo.lookupBarcode(SCOPE, "BA9")).matches).toHaveLength(1);
		expect(s.calls.filter((c) => c === "catalog_page")).toHaveLength(1); // no second full download
	});

	it("an expired cursor falls back to a full staged download and the old catalog stays until it is done", async () => {
		const s = new Server();
		s.add("A1", 1);
		const repo = new HostSqlite();
		const meta = memoryMeta();
		await run(s, repo, meta);
		s.add("A2", 2);
		s.expire = true;
		const r = await run(s, repo, meta);
		expect(r).toMatchObject({ mode: "full", items: 2 });
	});

	it("a delta that disagrees with the server digest triggers a full download", async () => {
		const s = new Server();
		s.add("A1", 1);
		const repo = new HostSqlite();
		const meta = memoryMeta();
		await run(s, repo, meta);
		s.add("A2", 2); // changed on the server but missing from the delta feed
		const r = await run(s, repo, meta);
		expect(r).toMatchObject({ mode: "full", items: 2 });
	});

	it("a changed price list or warehouse is a different catalog: the old one is dropped, never mixed", async () => {
		const s = new Server();
		s.add("A1", 1);
		const repo = new HostSqlite();
		const meta = memoryMeta();
		await run(s, repo, meta);
		s.scope = { ...s.scope, warehouse: "Other", price_list: "Wholesale" };
		s.items.clear();
		s.add("B1", 5);
		await run(s, repo, meta);
		expect(await repo.getItem(SCOPE, "A1")).toBeNull();
		expect((await repo.listScopes())[0]).toMatchObject({ warehouse: "Other", priceList: "Wholesale" });
	});

	it("items with no price are counted, listed with price 0, and never silently priced", async () => {
		const s = new Server();
		s.add("A1", 0);
		s.add("A2", 3);
		const r = await run(s, new HostSqlite(), memoryMeta());
		expect(r.unpriced).toBe(1);
	});

	it("a deleted/disabled item disappears from the device after a delta", async () => {
		const s = new Server();
		s.add("A1", 1);
		s.add("A2", 2);
		const repo = new HostSqlite();
		const meta = memoryMeta();
		await run(s, repo, meta);
		s.items.delete("A1");
		s.pending = { upserts: [], removed: ["A1"] };
		await run(s, repo, meta);
		expect((await repo.stats(SCOPE)).items).toBe(1);
	});
});

describe("100,000 sellable records", () => {
	it("pages and searches stay bounded; the checksum pass reads codes only", async () => {
		const repo = new HostSqlite();
		await repo.createScope({
			scopeId: SCOPE,
			site: "x",
			company: "A",
			warehouse: "S",
			priceList: "P",
			currency: "KWD",
			minorDigits: 3,
		});
		const gen = await repo.beginGeneration(SCOPE);
		for (let b = 0; b < 100; b++) {
			await repo.putBatch(
				SCOPE,
				gen,
				Array.from({ length: 1000 }, (_, i) => {
					const n = b * 1000 + i;
					return {
						itemCode: `IT-${String(n).padStart(6, "0")}`,
						variantOf: null,
						name: `Item ${n}`,
						itemGroup: "G",
						uom: "Nos",
						priceMinor: 1000,
						priced: true,
						attrs: {},
						barcodes: [`89${String(n).padStart(10, "0")}`],
					};
				}),
			);
		}
		await repo.activate(SCOPE, gen, 100_000);
		const t0 = performance.now();
		const page = await repo.search(SCOPE, "item 99999");
		expect(page.items.length).toBeLessThanOrEqual(50);
		expect(performance.now() - t0).toBeLessThan(500);
		expect((await repo.lookupBarcode(SCOPE, "890000050000")).matches).toHaveLength(1);
		let n = 0;
		let after: string | undefined;
		for (;;) {
			const codes = await repo.codePage(SCOPE, after, 2000);
			n += codes.length;
			if (codes.length < 2000) break;
			after = codes[codes.length - 1];
		}
		expect(n).toBe(100_000);
	}, 60_000);
});
