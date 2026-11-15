/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const server = vi.hoisted(() => {
	const state = {
		items: new Map<string, Row>(),
		stock: new Map<string, number>(),
		customers: new Map<string, Row>(),
		log: [] as { seq: number; ref: string }[],
		seq: 0,
		scopeHash: "scope-1",
		calls: [] as string[],
		failAt: null as { method: string; nth: number } | null,
		resyncDelta: null as string | null,
		pageSize: 0,
		counts: {} as Record<string, number>,
		beforePage: null as { nth: number; run: () => void } | null,
		digestOffset: 0,
	};
	return state;
});

vi.mock("@/services/api", () => ({
	isNetworkError: (e: Error) => e.message === "__offline__",
	call: async (full: string, args: Record<string, unknown>) =>
		handle(full.split(".").pop() as string, args),
}));

import { crc32 } from "@/services/catalogSync";

function touch(code: string) {
	server.log.push({ seq: ++server.seq, ref: code });
}

function addItem(code: string, rate = 10, qty = 5) {
	server.items.set(code, { item_code: code, item_name: `Item ${code}`, item_group: "G", rate });
	server.stock.set(code, qty);
	touch(code);
}

function sortedCodes(after: string) {
	return [...server.items.keys()].sort().filter((code) => code > after);
}

function handle(method: string, args: Record<string, unknown>): unknown {
	server.counts[method] = (server.counts[method] || 0) + 1;
	server.calls.push(method);
	if (server.failAt && server.failAt.method === method && server.counts[method] === server.failAt.nth) {
		throw new Error("__offline__");
	}
	const limit = server.pageSize || Number(args.limit) || 200;
	const cursor = String(args.cursor || "");
	switch (method) {
		case "catalog_begin":
			return {
				snapshot_id: `snap-${server.seq}`,
				scope_hash: server.scopeHash,
				scope: { price_list: "Std" },
				total: server.items.size,
				retention_days: 7,
				cursors: {
					items: "items:",
					stock: "stock:",
					customers: "customers:",
					delta: `delta:${server.seq}`,
				},
			};
		case "catalog_page": {
			if (server.beforePage && server.counts.catalog_page === server.beforePage.nth)
				server.beforePage.run();
			const codes = sortedCodes(cursor.split(":")[1]);
			const page = codes.slice(0, limit);
			return {
				items: page.map((code) => server.items.get(code)),
				next_cursor: codes.length > limit ? `items:${page[page.length - 1]}` : null,
			};
		}
		case "catalog_stock_page": {
			const codes = sortedCodes(cursor.split(":")[1]);
			const page = codes.slice(0, limit);
			return {
				rows: page.map((code) => ({ item_code: code, actual_qty: server.stock.get(code) ?? 0 })),
				next_cursor: codes.length > limit ? `stock:${page[page.length - 1]}` : null,
				as_of: new Date().toISOString(),
			};
		}
		case "catalog_customers_page": {
			const names = [...server.customers.keys()].sort().filter((n) => n > cursor.split(":")[1]);
			const page = names.slice(0, limit);
			return {
				customers: page.map((n) => server.customers.get(n)),
				next_cursor: names.length > limit ? `customers:${page[page.length - 1]}` : null,
			};
		}
		case "catalog_delta": {
			if (server.resyncDelta) {
				const reason = server.resyncDelta;
				server.resyncDelta = null;
				return { resync: reason };
			}
			const watermark = Number(cursor.split(":")[1]);
			const refs = [...new Set(server.log.filter((l) => l.seq > watermark).map((l) => l.ref))].sort();
			return {
				upserts: refs.filter((r) => server.items.has(r)).map((r) => server.items.get(r)),
				removed: refs.filter((r) => !server.items.has(r)),
				next_cursor: `delta:${server.seq}`,
				has_more: false,
			};
		}
		case "catalog_digest": {
			const codes = [...server.items.keys()];
			return {
				count: codes.length + server.digestOffset,
				checksum: codes.reduce((sum, code) => sum + crc32(code), 0),
				scope_hash: server.scopeHash,
			};
		}
		case "get_item_groups":
			return { groups: [{ name: "G" }], parent_groups: [] };
		default:
			throw new Error(`unexpected ${method}`);
	}
}

import * as sync from "@/services/catalogSync";
import { db, getAllPendingInvoices } from "@/services/idbService";
import { setSessionScope } from "@/services/sessionScope";

const scope = { user: "cashier", profile: "Main", company: "TC", warehouse: "Stores", priceList: "Std" };

beforeEach(async () => {
	setSessionScope(scope);
	await db.open();
	await Promise.all(db.tables.map((table) => table.clear()));
	Object.assign(server, {
		items: new Map(),
		stock: new Map(),
		customers: new Map(),
		log: [],
		seq: 0,
		scopeHash: "scope-1",
		calls: [],
		failAt: null,
		resyncDelta: null,
		pageSize: 0,
		counts: {},
		beforePage: null,
		digestOffset: 0,
	});
	for (let n = 1; n <= 7; n++) addItem(`I-${n}`, n * 10, n);
	server.customers.set("C-1", { name: "C-1", customer_name: "Ann" });
	server.customers.set("C-2", { name: "C-2", customer_name: "Bob" });
	server.pageSize = 3;
});

const itemCodes = async () => (await db.items.toArray()).map((i) => i.item_code).sort();

describe("crc32", () => {
	it("matches the standard check value", () => {
		expect(crc32("123456789")).toBe(0xcbf43926);
	});
});

describe("full download", () => {
	it("stages in bounded pages, then makes everything current at once", async () => {
		expect(await sync.syncCatalog("Main")).toBe("full");

		expect(await itemCodes()).toHaveLength(7);
		expect((await db.stockCache.get("Stores::I-3"))?.actual_qty).toBe(3);
		expect((await db.customers.toArray()).map((c) => c.name).sort()).toEqual(["C-1", "C-2"]);
		expect((await db.itemGroups.get("__groups__"))?.data).toEqual([{ name: "G" }]);
		expect(await db.itemsStage.count()).toBe(0);
		expect(server.counts.catalog_page).toBe(3);

		const status = await sync.getCatalogStatus();
		expect(status).toMatchObject({
			status: "complete",
			scopeMatches: true,
			itemCount: 7,
			downloading: false,
		});
		expect(status.freshness).toBe("fresh");
	});

	it("never exposes a half-written catalogue while pages are still arriving", async () => {
		const old = { item_code: "OLD", item_name: "Old", item_group: "G", rate: 1 };
		await db.items.put(old as never);
		await db.meta.put({
			key: "catalog_state",
			value: { status: "complete", scope_key: "stale-scope" },
			updated_at: "",
		});
		const seen: number[] = [];
		const realPut = db.itemsStage.bulkPut.bind(db.itemsStage);
		vi.spyOn(db.itemsStage, "bulkPut").mockImplementation(async (rows: never) => {
			seen.push(await db.items.count());
			return realPut(rows);
		});

		await sync.syncCatalog("Main");

		expect(seen.length).toBeGreaterThan(1);
		expect(seen.every((count) => count === 0 || count === 7)).toBe(true);
		vi.restoreAllMocks();
	});
});

describe("an interrupted first download", () => {
	it("leaves the live catalogue alone and resumes from the saved page", async () => {
		await sync.syncCatalog("Main");
		await db.meta.delete("catalog_state");
		await db.items.clear();
		addItem("I-8");
		server.counts = {};
		server.failAt = { method: "catalog_page", nth: 3 };

		await expect(sync.syncCatalog("Main")).rejects.toThrow("__offline__");
		expect(await db.items.count()).toBe(0);
		expect((await sync.getCatalogStatus()).status).toBe("partial");
		const staged = await db.itemsStage.count();
		expect(staged).toBeGreaterThan(0);
		expect(staged).toBeLessThan(8);

		server.failAt = null;
		server.counts = {};
		await sync.syncCatalog("Main");

		expect(server.counts.catalog_begin).toBeUndefined();
		expect(server.counts.catalog_page).toBe(1);
		expect(await db.items.count()).toBe(8);
		expect((await sync.getCatalogStatus()).status).toBe("complete");
	});

	it("keeps selling from the previous catalogue until the new one is complete", async () => {
		await sync.syncCatalog("Main");
		server.scopeHash = "scope-2";
		server.resyncDelta = "scope_changed";
		server.failAt = { method: "catalog_page", nth: 2 };
		server.counts = {};

		await expect(sync.syncCatalog("Main")).rejects.toThrow();

		expect(await db.items.count()).toBe(7);
		expect((await sync.getCatalogStatus()).status).toBe("complete");
	});

	it("drops a stale job instead of resuming it against a new session", async () => {
		server.failAt = { method: "catalog_page", nth: 2 };
		await expect(sync.syncCatalog("Main")).rejects.toThrow();
		setSessionScope({ ...scope, user: "someone-else" });
		server.failAt = null;
		server.counts = {};

		await sync.syncCatalog("Main");

		expect(server.counts.catalog_begin).toBe(1);
		expect(await db.items.count()).toBe(7);
	});
});

describe("delta", () => {
	it("applies changes and removals without downloading everything again", async () => {
		await sync.syncCatalog("Main");
		server.counts = {};
		server.items.set("I-2", { ...server.items.get("I-2"), rate: 99 });
		touch("I-2");
		server.items.delete("I-4");
		touch("I-4");
		addItem("I-9");

		expect(await sync.syncCatalog("Main")).toBe("delta");

		expect(server.counts.catalog_page).toBeUndefined();
		expect((await db.items.get("I-2"))?.rate).toBe(99);
		expect(await db.items.get("I-4")).toBeUndefined();
		expect(await db.items.get("I-9")).toBeDefined();
		expect(await db.stockCache.get("Stores::I-4")).toBeUndefined();
	});

	it("downloads again, without touching queued sales, when the server says the cursor is no good", async () => {
		await sync.syncCatalog("Main");
		await db.pendingInvoices.add({
			local_id: "inv_p",
			data: {},
			status: "pending",
			created_at: "",
			retry_count: 0,
		});
		server.resyncDelta = "cursor_expired";
		server.counts = {};
		server.items.delete("I-1");
		touch("I-1");

		expect(await sync.syncCatalog("Main")).toBe("full");

		expect(server.counts.catalog_begin).toBeGreaterThanOrEqual(1);
		expect(await db.items.get("I-1")).toBeUndefined();
		expect((await getAllPendingInvoices()).map((r) => r.local_id)).toEqual(["inv_p"]);
	});

	it("catches up on changes made while the pages were downloading", async () => {
		server.beforePage = {
			nth: 2,
			run: () => {
				server.items.delete("I-1");
				touch("I-1");
				addItem("I-LATE", 77);
			},
		};

		await sync.syncCatalog("Main");

		expect(await db.items.get("I-1")).toBeUndefined();
		expect((await db.items.get("I-LATE"))?.rate).toBe(77);
		expect(await db.items.count()).toBe(7);
	});

	it("refuses to go live when the staged copy does not match the server's count", async () => {
		server.digestOffset = 1;
		vi.spyOn(console, "warn").mockImplementation(() => {});

		await expect(sync.syncCatalog("Main")).rejects.toThrow();

		expect(await db.items.count()).toBe(0);
		expect((await sync.getCatalogStatus()).status).not.toBe("complete");
	});
});

describe("stock and queued sales", () => {
	it("keeps stock taken by an unsent sale deducted when stock is refreshed", async () => {
		await sync.syncCatalog("Main");
		await db.pendingInvoices.add({
			local_id: "inv_q",
			data: { items: [{ item_code: "I-3", qty: 2 }] },
			reservations: [{ item_code: "I-3", stock_qty: 2 }],
			status: "pending",
			created_at: "",
			retry_count: 0,
		});

		await sync.refreshCatalogStock("Main");

		expect((await db.stockCache.get("Stores::I-3"))?.actual_qty).toBe(1);
		expect((await db.stockCache.get("Stores::I-2"))?.actual_qty).toBe(2);
	});
});

describe("session boundaries", () => {
	it("discards another user's catalogue but keeps the queued sales", async () => {
		await sync.syncCatalog("Main");
		await db.pendingInvoices.add({
			local_id: "inv_k",
			data: {},
			status: "pending",
			created_at: "",
			retry_count: 0,
		});
		setSessionScope({ ...scope, user: "second-cashier" });

		expect((await sync.getCatalogStatus()).scopeMatches).toBe(false);
		await sync.ensureScope();

		expect(await db.items.count()).toBe(0);
		expect((await sync.getCatalogStatus()).status).toBe("none");
		expect((await getAllPendingInvoices()).map((r) => r.local_id)).toEqual(["inv_k"]);
	});

	it("records which prices a sale was rung up with", async () => {
		await sync.syncCatalog("Main");
		const evidence = await sync.currentCatalogEvidence();
		expect(evidence).toMatchObject({ price_list: "Std" });
		expect(evidence?.snapshot_id).toMatch(/^snap-/);
	});
});

describe("freshness", () => {
	it("moves from fresh to aging to stale with the age of the last confirmation", () => {
		expect(sync.freshnessOf(null)).toBe("none");
		expect(sync.freshnessOf(60_000)).toBe("fresh");
		expect(sync.freshnessOf(sync.PRICES_AGING_MS)).toBe("aging");
		expect(sync.freshnessOf(sync.PRICES_STALE_MS)).toBe("stale");
	});

	it("reports how old the prices are", async () => {
		await sync.syncCatalog("Main");
		const later = Date.now() + 5 * 60 * 60_000;
		const status = await sync.getCatalogStatus(later);
		expect(status.freshness).toBe("aging");
		expect(status.ageMs).toBeGreaterThan(4 * 60 * 60_000);
	});
});
