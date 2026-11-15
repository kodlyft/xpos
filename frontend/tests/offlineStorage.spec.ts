/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Dexie from "dexie";
import { IDBFactory } from "fake-indexeddb";

const DB_NAME = "xpos_offline_v3";

async function seedV2Database(rows: { invoices: object[]; items: object[] }) {
	const old = new Dexie(DB_NAME);
	old.version(1).stores({
		items: "item_code, item_name, item_group, barcode",
		itemGroups: "name",
		customers: "name, customer_name, mobile_no, email_id",
		suppliers: "name, supplier_name, mobile_no, email_id",
		pendingInvoices: "++id, status, created_at",
		pendingPurchases: "++id, type, status, created_at",
		stockCache: "cache_key, warehouse, item_code",
		meta: "key",
	});
	old.version(2).stores({ syncIdMap: "local_id, server_name, doctype" });
	await old.open();
	await old.table("pendingInvoices").bulkAdd(rows.invoices);
	await old.table("items").bulkAdd(rows.items);
	old.close();
}

async function load() {
	vi.resetModules();
	const idb = await import("@/services/idbService");
	const bridge = await import("@/services/dbBridge");
	return { idb, bridge };
}

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
	Dexie.dependencies.indexedDB = globalThis.indexedDB;
});

describe("schema upgrade", () => {
	it("keeps queued sales, their receipts and the cached items when v2 becomes v3", async () => {
		await seedV2Database({
			invoices: [
				{
					local_id: "inv_a",
					data: { customer: "A" },
					status: "failed",
					created_at: "2026-10-20",
					retry_count: 2,
					receipt: { grand_total: 5 },
				},
				{
					local_id: "inv_b",
					data: { customer: "B" },
					status: "pending",
					created_at: "2026-10-21",
					retry_count: 0,
				},
			],
			items: [{ item_code: "X", item_name: "X", item_group: "G", barcode: "1" }],
		});
		const { idb } = await load();
		await idb.ensureDatabaseReady();

		const rows = await idb.getAllPendingInvoices();
		expect(rows.map((r) => r.local_id).sort()).toEqual(["inv_a", "inv_b"]);
		const a = rows.find((r) => r.local_id === "inv_a")!;
		expect(a.receipt).toEqual({ grand_total: 5 });
		expect(a.status).toBe("failed");
		expect(a.owner).toBeNull();
		expect(a.attempts).toBe(2);
		expect((await idb.getCachedItems()).map((i) => i.item_code)).toEqual(["X"]);
		expect(idb.getDbState()).toBe("ready");
	});

	it("opens a database a newer build already upgraded without resetting or losing anything", async () => {
		const newer = new Dexie(DB_NAME);
		newer.version(9).stores({ pendingInvoices: "++id, status" });
		await newer.open();
		await newer.table("pendingInvoices").add({ local_id: "inv_keep", status: "pending" });
		newer.close();

		const { idb } = await load();
		await idb.ensureDatabaseReady();
		expect((await idb.getAllPendingInvoices()).map((r) => r.local_id)).toEqual(["inv_keep"]);
	});

	it("lets go of the database and flags a reload when another tab upgrades it", async () => {
		const { idb } = await load();
		await idb.ensureDatabaseReady();
		expect(idb.db.isOpen()).toBe(true);

		const upgrading = indexedDB.open(DB_NAME, 900);
		await new Promise((resolve) => (upgrading.onsuccess = resolve));
		upgrading.result.close();

		expect(idb.getDbState()).toBe("needs_reload");
		expect(idb.db.isOpen()).toBe(false);
	});
});

describe("saving a sale durably", () => {
	it("reads the sale back before reporting success and keeps the receipt beside it", async () => {
		const { bridge, idb } = await load();
		const receipt = { name: "", grand_total: 10, items: [] } as never;
		const saved = await bridge.addPendingInvoice({
			data: { local_id: "inv_1", customer: "Walk-in" },
			grand_total: 10,
			receipt,
		});
		const row = (await idb.getAllPendingInvoices())[0];
		expect(saved).toEqual({ id: row.id, local_id: "inv_1" });
		expect(row.receipt).toEqual(receipt);
		expect(row.status).toBe("pending");
	});

	it("gives a sale an identity of its own when the cart had none", async () => {
		const { bridge } = await load();
		const saved = await bridge.addPendingInvoice({ data: { customer: "Walk-in" } });
		expect(saved.local_id).toMatch(/^inv_[0-9a-f]{32}$/);
	});

	it("reuses the same row for the same sale and refuses a changed one", async () => {
		const { bridge, idb } = await load();
		const data = { local_id: "inv_same", customer: "A" };
		const first = await bridge.addPendingInvoice({ data });
		expect(await bridge.addPendingInvoice({ data })).toEqual(first);
		await expect(bridge.addPendingInvoice({ data: { ...data, customer: "B" } })).rejects.toThrow(
			"awaiting confirmation",
		);
		expect(await idb.getAllPendingInvoices()).toHaveLength(1);
	});

	it("reports a full disk as a storage failure and stores nothing", async () => {
		const { bridge, idb } = await load();
		await idb.ensureDatabaseReady();
		vi.spyOn(idb.db.Table.prototype, "add").mockRejectedValueOnce(
			new DOMException("disk full", "QuotaExceededError"),
		);
		await expect(bridge.addPendingInvoice({ data: { local_id: "inv_full" } })).rejects.toMatchObject({
			name: "StorageWriteError",
			reason: "quota",
		});
		expect(await idb.getAllPendingInvoices()).toHaveLength(0);
	});

	it("reports data that cannot be stored instead of dropping it", async () => {
		const { bridge, idb } = await load();
		await idb.ensureDatabaseReady();
		vi.spyOn(idb.db.Table.prototype, "add").mockRejectedValueOnce(
			new DOMException("bad", "DataCloneError"),
		);
		await expect(bridge.addPendingInvoice({ data: { local_id: "inv_x" } })).rejects.toMatchObject({
			reason: "data",
		});
	});

	it("counts a sale stuck in 'syncing' as pending", async () => {
		const { bridge, idb } = await load();
		const { id } = await bridge.addPendingInvoice({ data: { local_id: "inv_s" } });
		await bridge.updatePendingInvoice(id, { status: "syncing" });
		expect(await bridge.countPendingInvoices()).toBe(1);
		expect((await idb.getAllPendingInvoices())[0].status).toBe("syncing");
	});
});

describe("claims and crash recovery", () => {
	it("lets only one sender claim a sale", async () => {
		const { bridge } = await load();
		const { id } = await bridge.addPendingInvoice({ data: { local_id: "inv_c" } });
		const idb = await import("@/services/idbService");
		expect(await idb.claimPendingInvoice(id, "tab_a", 60_000)).toMatchObject({ claimed_by: "tab_a" });
		expect(await idb.claimPendingInvoice(id, "tab_b", 60_000)).toBeNull();
	});

	it("keeps the background queue away from a sale the foreground is still sending", async () => {
		const { bridge } = await load();
		const { id } = await bridge.addPendingInvoice({ data: { local_id: "inv_f" }, claim: true });
		expect(await bridge.claimPendingInvoice(id)).toBeNull();
	});

	it("puts a sale left 'syncing' by a crash back in the queue, and leaves a live claim alone", async () => {
		const { bridge, idb } = await load();
		const dead = await bridge.addPendingInvoice({ data: { local_id: "inv_dead" } });
		const live = await bridge.addPendingInvoice({ data: { local_id: "inv_live" } });
		await bridge.updatePendingInvoice(dead.id, {
			status: "syncing",
			claimed_by: "tab_gone",
			claim_expires: new Date(Date.now() - 1000).toISOString(),
		});
		await bridge.updatePendingInvoice(live.id, {
			status: "syncing",
			claimed_by: "tab_other",
			claim_expires: new Date(Date.now() + 60_000).toISOString(),
		});

		expect(await bridge.recoverStaleClaims()).toBe(1);
		const byId = Object.fromEntries(
			(await idb.getAllPendingInvoices()).map((r) => [r.local_id, r.status]),
		);
		expect(byId).toEqual({ inv_dead: "pending", inv_live: "syncing" });
	});
});

describe("recovering an unopenable database", () => {
	it("backs queued sales up before deleting, then restores them", async () => {
		await seedV2Database({
			invoices: [
				{ local_id: "inv_r", data: {}, status: "pending", created_at: "2026-10-21", retry_count: 0 },
			],
			items: [],
		});
		const { idb } = await load();
		const open = vi.spyOn(idb.db, "open");
		open.mockRejectedValueOnce(Object.assign(new Error("Internal error"), { name: "UnknownError" }));

		await idb.ensureDatabaseReady();

		expect((await idb.getAllPendingInvoices()).map((r) => r.local_id)).toEqual(["inv_r"]);
		expect(idb.getDbState()).toBe("ready");
	});

	it("leaves the database alone when the queued sales cannot be read and backed up", async () => {
		await seedV2Database({
			invoices: [
				{ local_id: "inv_n", data: {}, status: "pending", created_at: "2026-10-21", retry_count: 0 },
			],
			items: [],
		});
		const { idb } = await load();
		vi.spyOn(idb.db, "open").mockRejectedValue(
			Object.assign(new Error("Internal error"), { name: "UnknownError" }),
		);
		const realOpen = indexedDB.open.bind(indexedDB);
		vi.spyOn(indexedDB, "open").mockImplementation(() => {
			throw new Error("blocked by browser");
		});

		await expect(idb.ensureDatabaseReady()).rejects.toMatchObject({ name: "StorageWriteError" });
		expect(idb.getDbState()).toBe("storage_unavailable");

		vi.restoreAllMocks();
		indexedDB.open = realOpen;
		const check = new Dexie(DB_NAME);
		await check.open();
		expect(await check.table("pendingInvoices").count()).toBe(1);
		check.close();
	});
});
