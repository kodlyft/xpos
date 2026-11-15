import { describe, expect, it } from "vitest";
import { CatalogSyncError, downloadCatalog, toCatalogItem } from "../src/app/catalogSync";
import { crc32 } from "../src/domain/crc32";
import { fromRate } from "../src/domain/money";
import type { ApiTransport } from "../src/ports";
import { ServerError } from "../src/adapters/frappeHttp";
import { HostSqlite } from "./support/hostSqlite";

interface Row {
	item_code: string;
	item_name: string;
	item_group: string;
	stock_uom: string;
	brand?: string;
	variant_of?: string;
	rate: number;
	barcodes: { barcode: string; uom: string | null; conversion_factor: number | null }[];
	attributes?: Record<string, string>;
}

/** The server API shape of xpos.api.catalog_sync, kept in memory (keyset pages by item code, count + CRC32 digest). */
class FakeServer implements ApiTransport {
	readonly kind = "native" as const;
	rows: Row[];
	calls: string[] = [];
	onPage?: (n: number) => void;
	failAtPage?: number;
	resyncAtPage?: number;
	resyncAlways = false;
	private pages = 0;
	constructor(rows: Row[]) {
		this.rows = [...rows].sort((a, b) => (a.item_code < b.item_code ? -1 : 1));
	}
	async call<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
		this.calls.push(method.split(".").pop()!);
		const name = method.split(".").pop();
		if (args.pos_profile !== "Main") throw new Error("profile is always sent");
		if (name === "catalog_begin")
			return {
				scope: {
					company: "Acme",
					warehouse: "Stores - A",
					price_list: "Standard Selling",
					currency: "KWD",
				},
				total: this.rows.length,
				cursors: { items: "after:" },
			} as T;
		if (name === "catalog_page") {
			this.pages++;
			if (this.failAtPage === this.pages) throw new TypeError("network down");
			if (this.resyncAlways || this.resyncAtPage === this.pages)
				return { resync: "scope_changed" } as T;
			const after = String(args.cursor).slice(6);
			const limit = Number(args.limit);
			const rest = this.rows.filter((r) => r.item_code > after);
			const items = rest.slice(0, limit);
			const more = rest.length > limit;
			const out = {
				items,
				next_cursor: more ? `after:${items[items.length - 1].item_code}` : null,
			} as T;
			this.onPage?.(this.pages); // data changes AFTER this page was served, like a live site
			return out;
		}
		if (name === "catalog_digest")
			return {
				count: this.rows.length,
				checksum: this.rows.reduce((s, r) => s + crc32(r.item_code), 0),
			} as T;
		throw new Error(`unexpected ${name}`);
	}
}

const row = (n: number, over: Partial<Row> = {}): Row => ({
	item_code: `IT-${String(n).padStart(5, "0")}`,
	item_name: `Item ${n}`,
	item_group: "Products",
	stock_uom: "Nos",
	rate: n + 0.5,
	barcodes: [{ barcode: `890${String(n).padStart(9, "0")}`, uom: "Nos", conversion_factor: 1 }],
	...over,
});
const many = (n: number) => Array.from({ length: n }, (_, i) => row(i + 1));
const opts = (api: ApiTransport, repo: HostSqlite) => ({
	api,
	repo,
	scopeId: "real:c|Main@shop",
	site: "https://shop.example.com",
	profile: "Main",
	minorDigits: 3,
});

describe("real catalog download", () => {
	it("downloads every page, converts server rates to exact minor units and activates atomically", async () => {
		const server = new FakeServer(many(1200));
		const repo = new HostSqlite();
		const progress: number[] = [];
		const r = await downloadCatalog({
			...opts(server, repo),
			onProgress: (p) => progress.push(p.downloaded),
		});
		expect(r).toMatchObject({ items: 1200, skippedBarcodes: 0, mode: "full" });
		expect(server.calls.filter((c) => c === "catalog_page")).toHaveLength(3); // 500 + 500 + 200
		expect(progress.at(-1)).toBe(1200);
		const scope = (await repo.listScopes())[0];
		expect(scope).toMatchObject({
			company: "Acme",
			warehouse: "Stores - A",
			priceList: "Standard Selling",
			currency: "KWD",
			minorDigits: 3,
			activeGen: 1,
		});
		const it = await repo.getItem("real:c|Main@shop", "IT-00007");
		expect(it).toMatchObject({ name: "Item 7", priceMinor: 7500, uom: "Nos", itemGroup: "Products" }); // 7.5 at 3 digits
		expect(
			(await repo.lookupBarcode("real:c|Main@shop", "890000000007")).matches.map((m) => m.itemCode),
		).toEqual(["IT-00007"]);
	});

	it("a refresh replaces the catalog in one step: removed items disappear, changed prices update", async () => {
		const server = new FakeServer(many(30));
		const repo = new HostSqlite();
		await downloadCatalog(opts(server, repo));
		server.rows = server.rows
			.filter((r) => r.item_code !== "IT-00001")
			.map((r) => (r.item_code === "IT-00002" ? { ...r, rate: 99 } : r));
		await downloadCatalog(opts(server, repo));
		expect(await repo.getItem("real:c|Main@shop", "IT-00001")).toBeNull();
		expect((await repo.getItem("real:c|Main@shop", "IT-00002"))?.priceMinor).toBe(99000);
		expect((await repo.stats("real:c|Main@shop")).items).toBe(29);
	});

	it("keeps variant attributes from the server and the variant_of link", async () => {
		const server = new FakeServer([
			row(1, { variant_of: "TEE", attributes: { Colour: "Red", Size: "M" } }),
			row(2, { variant_of: "TEE", attributes: { Colour: "Red", Size: "L" } }),
			row(3),
		]);
		const repo = new HostSqlite();
		await downloadCatalog(opts(server, repo));
		const variants = await repo.variantsOf("real:c|Main@shop", "TEE");
		expect(variants.map((v) => v.attrs)).toEqual([
			{ Colour: "Red", Size: "M" },
			{ Colour: "Red", Size: "L" },
		]);
		expect(variants).toHaveLength(2);
	});

	it("imports only barcodes it can price (stock UOM or a 1:1 conversion) and reports how many it skipped", async () => {
		const server = new FakeServer([
			row(1, {
				barcodes: [
					{ barcode: "A1", uom: "Nos", conversion_factor: 1 },
					{ barcode: "BOX1", uom: "Box", conversion_factor: 12 }, // would sell a box at the price of a unit
					{ barcode: "ODD1", uom: "Case", conversion_factor: null }, // no conversion: the till must refuse it
				],
			}),
		]);
		const repo = new HostSqlite();
		const r = await downloadCatalog(opts(server, repo));
		expect(r.skippedBarcodes).toBe(2);
		expect((await repo.lookupBarcode("real:c|Main@shop", "A1")).matches).toHaveLength(1);
		expect((await repo.lookupBarcode("real:c|Main@shop", "BOX1")).matches).toHaveLength(0);
	});

	it("retries when the catalog changed during the download, then succeeds", async () => {
		const server = new FakeServer(many(20));
		server.onPage = (n) => {
			if (n === 1) server.rows.push(row(21)); // a new item appears after page 1 was served
		};
		const repo = new HostSqlite();
		const r = await downloadCatalog(opts(server, repo));
		expect(r.items).toBe(21);
		expect(server.calls.filter((c) => c === "catalog_begin")).toHaveLength(2);
	});

	it("fails after three attempts if it never settles, leaving the previous catalog and no staged data", async () => {
		const server = new FakeServer(many(10));
		const repo = new HostSqlite();
		await downloadCatalog(opts(server, repo));
		let extra = 100;
		server.onPage = () => server.rows.push(row(extra++)); // the catalog keeps changing
		await expect(downloadCatalog(opts(server, repo))).rejects.toMatchObject({ code: "verify_failed" });
		expect((await repo.stats("real:c|Main@shop")).items).toBe(10); // still the earlier catalog
		const gens = repo.db
			.prepare("SELECT state FROM catalog_generation")
			.all()
			.map((g) => g.state);
		expect(gens).toEqual(["active"]); // every failed attempt discarded its staging generation
	});

	it("a network failure or a resync answer never touches the live catalog", async () => {
		const server = new FakeServer(many(1100));
		const repo = new HostSqlite();
		await downloadCatalog(opts(server, repo));
		server.failAtPage = server.calls.filter((c) => c === "catalog_page").length + 2;
		await expect(downloadCatalog(opts(server, repo))).rejects.toThrow("network down");
		server.failAtPage = undefined;
		server.resyncAlways = true; // the server keeps asking for a restart: the download gives up, the old catalog stays
		await expect(downloadCatalog(opts(server, repo))).rejects.toBeInstanceOf(CatalogSyncError);
		expect((await repo.stats("real:c|Main@shop")).items).toBe(1100);
		expect(
			repo.db.prepare("SELECT COUNT(*) n FROM catalog_generation WHERE state = 'staging'").get(),
		).toMatchObject({ n: 0 });
	});
});

describe("catalog helpers", () => {
	it("crc32 matches the standard check value (and MariaDB CRC32)", () => {
		expect(crc32("123456789")).toBe(0xcbf43926);
	});
	it("converts server rates to exact minor units at the currency precision", () => {
		expect(fromRate(12.5, 2)).toBe(1250);
		expect(fromRate(0.075, 3)).toBe(75);
		expect(fromRate(1999.99, 0)).toBe(2000);
		expect(fromRate(Number.NaN, 2)).toBe(0);
		expect(fromRate(-3, 2)).toBe(0);
	});
	it("falls back to the item code when a name is missing and tolerates missing optional fields", () => {
		const { item } = toCatalogItem({ item_code: "X" }, 2);
		expect(item).toMatchObject({
			itemCode: "X",
			name: "X",
			uom: "Nos",
			priceMinor: 0,
			barcodes: [],
			attrs: {},
			variantOf: null,
		});
	});

	it("keeps a missing price apart from an explicit zero price", () => {
		const base = { item_code: "P", stock_uom: "Nos" };
		const missing = toCatalogItem({ ...base, rate: 0, price_missing: 1 }, 2).item;
		const zero = toCatalogItem({ ...base, rate: 0, price_missing: 0 }, 2).item;
		const positive = toCatalogItem({ ...base, rate: 12.5, price_missing: 0 }, 2).item;
		expect([missing.priced, missing.priceMinor]).toEqual([false, 0]);
		expect([zero.priced, zero.priceMinor]).toEqual([true, 0]);
		expect([positive.priced, positive.priceMinor]).toEqual([true, 1250]);
		// an older server that does not send price_missing: 0 means no price, a positive rate is a price
		expect(toCatalogItem({ ...base, rate: 0 }, 2).item.priced).toBe(false);
		expect(toCatalogItem({ ...base, rate: 3 }, 2).item.priced).toBe(true);
	});

	it("downloads a 50,000 item catalog in 100 pages and verifies it", async () => {
		const server = new FakeServer(many(50_000));
		const repo = new HostSqlite();
		const r = await downloadCatalog(opts(server, repo));
		expect(r).toMatchObject({ items: 50_000, mode: "full" });
		expect(server.calls.filter((c) => c === "catalog_page")).toHaveLength(100);
		expect((await repo.stats("real:c|Main@shop")).items).toBe(50_000);
	}, 60_000);

	it("retries one failed page instead of restarting the whole download", async () => {
		const server = new FakeServer(many(1200));
		const real = server.call.bind(server);
		let failed = false;
		server.call = async <T>(method: string, args: Record<string, unknown> = {}) => {
			if (method.endsWith("catalog_page") && String(args.cursor) !== "after:" && !failed) {
				failed = true;
				throw new ServerError(502, "bad gateway");
			}
			return real<T>(method, args);
		};
		const r = await downloadCatalog(opts(server, new HostSqlite()));
		expect(r.items).toBe(1200);
		expect(server.calls.filter((c) => c === "catalog_begin")).toHaveLength(1);
	});
});
