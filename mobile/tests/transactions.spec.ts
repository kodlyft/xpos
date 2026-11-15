import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HostSqlite } from "./support/hostSqlite";
import { TxnConflictError, TxnWriteError, type SampleSale } from "../src/domain/txn";

const sale = (over: Partial<SampleSale> = {}): SampleSale => ({
	clientTxnId: "smp-1",
	scopeId: "bench:test",
	currency: "KWD",
	minorDigits: 3,
	lines: [
		{ itemCode: "A", name: "Apple", priceMinor: 1250, qtyMilli: 2000 },
		{ itemCode: "B", name: "Bean", priceMinor: 333, qtyMilli: 1500 },
	],
	...over,
});

const counts = (r: HostSqlite) => ({
	sale: Number((r.db.prepare("SELECT COUNT(*) n FROM sample_txn").get() as { n: number }).n),
	outbox: Number((r.db.prepare("SELECT COUNT(*) n FROM outbox").get() as { n: number }).n),
});

describe("sample transaction (host SQLite)", () => {
	it("commits sale + receipt + outbox atomically with integer minor units at the given precision", async () => {
		const r = new HostSqlite();
		const res = await r.commitSample(sale());
		expect(res.status).toBe("created");
		expect(res.receipt.totalMinor).toBe(2500 + 500); // 333 * 1.5 = 499.5 -> 500
		expect(res.receipt.minorDigits).toBe(3);
		expect(res.receipt.sample).toBe(true);
		expect(res.receipt.notice).toMatch(/SAMPLE ONLY/);
		expect(counts(r)).toEqual({ sale: 1, outbox: 1 });
		expect(await r.outboxCounts()).toEqual({ blocked: 1 });
	});

	it.each(["after-sale", "after-receipt", "after-outbox"] as const)(
		"rolls everything back when the write fails %s",
		async (stage) => {
			let armed = true;
			const r = new HostSqlite({
				fault: (s) => {
					if (armed && s === stage) throw new Error("disk full");
				},
			});
			await expect(r.commitSample(sale())).rejects.toBeInstanceOf(TxnWriteError);
			expect(counts(r)).toEqual({ sale: 0, outbox: 0 });
			expect(await r.getReceipt("smp-1")).toBeNull(); // no acknowledgement possible
			armed = false;
			expect((await r.commitSample(sale())).status).toBe("created"); // the same cart can be retried
		},
	);

	it("retry with the same id and contents is idempotent and returns the original receipt", async () => {
		let t = 1000;
		const r = new HostSqlite({ now: () => t++ });
		const first = await r.commitSample(sale());
		const again = await r.commitSample(sale());
		expect(again.status).toBe("duplicate");
		expect(again.receipt).toEqual(first.receipt);
		expect(counts(r)).toEqual({ sale: 1, outbox: 1 });
	});

	it("rejects the same id with different contents and keeps the original", async () => {
		const r = new HostSqlite();
		const first = await r.commitSample(sale());
		const changed = sale({ lines: [{ itemCode: "A", name: "Apple", priceMinor: 1, qtyMilli: 1000 }] });
		await expect(r.commitSample(changed)).rejects.toBeInstanceOf(TxnConflictError);
		expect(await r.getReceipt("smp-1")).toEqual(first.receipt);
	});

	it("rejects non-integer money and empty sales before touching storage", async () => {
		const r = new HostSqlite();
		await expect(
			r.commitSample(sale({ lines: [{ itemCode: "A", name: "x", priceMinor: 1.5, qtyMilli: 1000 }] })),
		).rejects.toThrow();
		await expect(r.commitSample(sale({ lines: [] }))).rejects.toThrow();
		await expect(r.commitSample(sale({ minorDigits: 9 }))).rejects.toThrow();
		expect(counts(r)).toEqual({ sale: 0, outbox: 0 });
	});

	it("persists across a process restart (reopen the file)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "xpos-txn-"));
		const path = join(dir, "t.db");
		try {
			const a = new HostSqlite({ path });
			const first = await a.commitSample(sale());
			a.close();
			const b = new HostSqlite({ path });
			expect(await b.getReceipt("smp-1")).toEqual(first.receipt);
			expect((await b.commitSample(sale())).status).toBe("duplicate");
			b.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("SAMPLE commands can never be claimed for posting, and the database itself forbids a pending SAMPLE row", async () => {
		const r = new HostSqlite();
		await r.commitSample(sale());
		expect(r.claimNext("tok", 60_000)).toBeNull();
		expect(() => r.db.exec("UPDATE outbox SET state='pending'")).toThrow(/CHECK/);
		expect(() =>
			r.db.exec(
				"INSERT INTO outbox (command_id,txn_id,kind,state,created_at) VALUES ('x','y','SAMPLE','pending',1)",
			),
		).toThrow(/CHECK/);
	});

	it("claims are atomic and expire (shared by foreground + background processors)", () => {
		let now = 1000;
		const r = new HostSqlite({ now: () => now });
		r.db.exec(
			"INSERT INTO outbox (command_id,txn_id,kind,state,created_at) VALUES ('c1','t1','INVOICE','pending',1)",
		);
		const a = r.claimNext("fg", 5000);
		expect(a?.commandId).toBe("c1");
		expect(r.claimNext("bg", 5000)).toBeNull(); // already claimed
		now += 6000;
		expect(r.claimNext("bg", 5000)?.commandId).toBe("c1"); // lease expired, taken over
		expect(r.db.prepare("SELECT attempts, claim_token FROM outbox").get()).toMatchObject({
			attempts: 2,
			claim_token: "bg",
		});
	});
});
