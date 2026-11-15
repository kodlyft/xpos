/**
 * Host (Node, node:sqlite) implementation of the native storage contract.
 *
 * It builds the schema from the SAME model classes the Android build exports (SchemaSync) and implements
 * the same queries, so catalog semantics, atomicity and schema updates are verifiable here. It is NOT the
 * Android implementation: it proves SQL/logic behaviour, not device I/O or device speed.
 */
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { statSync } from "node:fs";
import type {
	BarcodeResult,
	CatalogItem,
	CatalogRepository,
	CatalogScopeInfo,
	CatalogStats,
	ItemPage,
	PageRequest,
	TransactionStore,
} from "@mobile/ports";
import { clampLimit, normalize, normalizeQuery, prefixUpperBound } from "@mobile/domain/search";
import { decodeCursor, encodeCursor } from "@mobile/domain/cursor";
import {
	canonicalJson,
	type CommitResult,
	sha256Hex,
	TxnConflictError,
	TxnWriteError,
	type SampleReceipt,
	type SampleSale,
} from "@mobile/domain/txn";
import { ALL_MODELS } from "@mobile/db/models/index.ts";
import { ALL_STEPS } from "@mobile/db/steps.ts";
import { SchemaSync, type SqlExecutor, type SyncReport } from "@mobile/db/schemaSync.ts";
import type { Model } from "@mobile/db/model.ts";
import {
	hashBody,
	SaleConflictError,
	type NewSale,
	type SalePatch,
	type SaleRecord,
	type SaleStatus,
} from "@mobile/domain/sale";
import { buildReceipt, validateSale } from "./validate";

export { buildReceipt, validateSale };

export type FaultStage = "after-sale" | "after-receipt" | "after-outbox";

export interface HostDbOptions {
	path?: string;
	/** Test hook: throw at a stage inside the commit transaction. */
	fault?: (stage: FaultStage) => void;
	now?: () => number;
	/** Models to sync (defaults to ALL_MODELS). Tests pass an older/newer set to simulate app upgrades. */
	models?: Model[];
}

export function cmpCodePoints(a: string, b: string): number {
	if (a === b) return 0;
	const ia = a[Symbol.iterator]();
	const ib = b[Symbol.iterator]();
	for (;;) {
		const x = ia.next();
		const y = ib.next();
		if (x.done || y.done) return x.done && y.done ? 0 : x.done ? -1 : 1;
		const cx = x.value.codePointAt(0)!;
		const cy = y.value.codePointAt(0)!;
		if (cx !== cy) return cx < cy ? -1 : 1;
	}
}

type Row = Record<string, unknown>;

export class HostSqlite implements CatalogRepository, TransactionStore {
	readonly kind = "host-test" as const;
	readonly db: DatabaseSync;
	private readonly opts: HostDbOptions;
	private readonly path: string;
	private stmts = new Map<string, StatementSync>();

	constructor(opts: HostDbOptions = {}) {
		this.opts = opts;
		this.path = opts.path ?? ":memory:";
		this.db = new DatabaseSync(this.path);
		this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
		this.sync();
	}

	private schemaSync?: SchemaSync;

	private executor(): SqlExecutor {
		return {
			exec: (sql) => this.db.exec(sql),
			all: (sql, params = []) => this.db.prepare(sql).all(...params) as Row[],
		};
	}

	/** Startup schema check: creates or updates tables/columns/indexes to match the models. */
	sync(): SyncReport {
		this.schemaSync ??= new SchemaSync(
			this.executor(),
			this.opts.models ?? ALL_MODELS,
			ALL_STEPS,
			this.opts.now,
		);
		const r = this.schemaSync.sync();
		this.stmts.clear();
		return r;
	}

	close(): void {
		this.db.close();
	}

	private q(sql: string): StatementSync {
		let s = this.stmts.get(sql);
		if (!s) this.stmts.set(sql, (s = this.db.prepare(sql)));
		return s;
	}

	private tx<T>(fn: () => T, mode: "DEFERRED" | "IMMEDIATE" = "IMMEDIATE"): T {
		this.db.exec(`BEGIN ${mode}`);
		try {
			const r = fn();
			this.db.exec("COMMIT");
			return r;
		} catch (e) {
			this.db.exec("ROLLBACK");
			throw e;
		}
	}

	// ---- scopes & generations -------------------------------------------------------------

	async createScope(s: Omit<CatalogScopeInfo, "activeGen">): Promise<void> {
		this.q(
			"INSERT INTO catalog_scope (scope_id,site,company,warehouse,price_list,currency,minor_digits,created_at) VALUES (?,?,?,?,?,?,?,?)",
		).run(s.scopeId, s.site, s.company, s.warehouse, s.priceList, s.currency, s.minorDigits, this.now());
	}

	async listScopes(): Promise<CatalogScopeInfo[]> {
		return (this.q("SELECT * FROM catalog_scope ORDER BY scope_id").all() as Row[]).map(toScope);
	}

	async dropScope(scopeId: string): Promise<void> {
		this.tx(() => {
			for (const t of ["item", "item_barcode", "item_attr"])
				this.q(`DELETE FROM ${t} WHERE scope_id=?`).run(scopeId);
			this.q("DELETE FROM serial_known WHERE scope_id=?").run(scopeId);
			this.q("DELETE FROM batch_known WHERE scope_id=?").run(scopeId);
			this.q("DELETE FROM catalog_scope WHERE scope_id=?").run(scopeId); // generations cascade
		});
	}

	async beginGeneration(scopeId: string): Promise<number> {
		return this.tx(() => {
			const r = this.q(
				"SELECT COALESCE(MAX(gen),0)+1 AS g FROM catalog_generation WHERE scope_id=?",
			).get(scopeId) as Row;
			const gen = Number(r.g);
			this.q(
				"INSERT INTO catalog_generation (scope_id,gen,state,created_at) VALUES (?,?, 'staging', ?)",
			).run(scopeId, gen, this.now());
			return gen;
		});
	}

	async putBatch(scopeId: string, gen: number, items: CatalogItem[]): Promise<void> {
		this.tx(() => {
			const g = this.q("SELECT state FROM catalog_generation WHERE scope_id=? AND gen=?").get(
				scopeId,
				gen,
			) as Row | undefined;
			if (!g || g.state !== "staging") throw new Error(`generation ${gen} is not staging`);
			const ii = this.q(
				"INSERT INTO item (scope_id,gen,item_code,variant_of,name,name_norm,code_norm,item_group,uom,price_minor,priced,brand) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
			);
			const ib = this.q(
				"INSERT OR IGNORE INTO item_barcode (scope_id,gen,barcode,item_code,uom) VALUES (?,?,?,?,?)",
			);
			const ia = this.q("INSERT INTO item_attr (scope_id,gen,item_code,attr,value) VALUES (?,?,?,?,?)");
			for (const it of items) {
				ii.run(
					scopeId,
					gen,
					it.itemCode,
					it.variantOf,
					it.name,
					normalize(it.name),
					normalize(it.itemCode),
					it.itemGroup,
					it.uom,
					it.priceMinor,
					it.priced ? 1 : 0,
					it.brand ?? null,
				);
				for (const b of it.barcodes) ib.run(scopeId, gen, b, it.itemCode, it.uom);
				for (const [k, v] of Object.entries(it.attrs)) ia.run(scopeId, gen, it.itemCode, k, v);
			}
			this.q(
				"UPDATE catalog_generation SET item_count = item_count + ? WHERE scope_id=? AND gen=?",
			).run(items.length, scopeId, gen);
		});
	}

	async activate(scopeId: string, gen: number, expectedItems: number): Promise<void> {
		this.tx(() => {
			const g = this.q(
				"SELECT state,item_count FROM catalog_generation WHERE scope_id=? AND gen=?",
			).get(scopeId, gen) as Row | undefined;
			if (!g || g.state !== "staging") throw new Error(`generation ${gen} is not staging`);
			const actual = Number(
				(this.q("SELECT COUNT(*) AS n FROM item WHERE scope_id=? AND gen=?").get(scopeId, gen) as Row)
					.n,
			);
			if (actual !== expectedItems)
				throw new Error(`staged ${actual} items, expected ${expectedItems}; not activating`);
			this.q("UPDATE catalog_generation SET state='retired' WHERE scope_id=? AND state='active'").run(
				scopeId,
			);
			this.q("UPDATE catalog_generation SET state='active' WHERE scope_id=? AND gen=?").run(
				scopeId,
				gen,
			);
			this.q("UPDATE catalog_scope SET active_gen=? WHERE scope_id=?").run(gen, scopeId);
		});
		this.pruneRetired(scopeId);
	}

	private pruneRetired(scopeId: string): void {
		const gens = this.q("SELECT gen FROM catalog_generation WHERE scope_id=? AND state='retired'").all(
			scopeId,
		) as Row[];
		for (const g of gens) this.deleteGeneration(scopeId, Number(g.gen));
	}

	private deleteGeneration(scopeId: string, gen: number): void {
		this.tx(() => {
			for (const t of ["item", "item_barcode", "item_attr"])
				this.q(`DELETE FROM ${t} WHERE scope_id=? AND gen=?`).run(scopeId, gen);
			this.q("DELETE FROM catalog_generation WHERE scope_id=? AND gen=?").run(scopeId, gen);
		});
	}

	async discard(scopeId: string, gen: number): Promise<void> {
		const g = this.q("SELECT state FROM catalog_generation WHERE scope_id=? AND gen=?").get(
			scopeId,
			gen,
		) as Row | undefined;
		if (g?.state === "active") throw new Error("cannot discard the active generation");
		this.deleteGeneration(scopeId, gen);
	}

	// ---- reads ----------------------------------------------------------------------------

	private activeGen(scopeId: string): number | null {
		const r = this.q("SELECT active_gen FROM catalog_scope WHERE scope_id=?").get(scopeId) as
			| Row
			| undefined;
		if (!r) throw new Error(`unknown scope ${scopeId}`);
		return r.active_gen === null ? null : Number(r.active_gen);
	}

	private hydrate(scopeId: string, gen: number, rows: Row[]): CatalogItem[] {
		const bq = this.q(
			"SELECT barcode FROM item_barcode WHERE scope_id=? AND gen=? AND item_code=? ORDER BY barcode",
		);
		const aq = this.q("SELECT attr,value FROM item_attr WHERE scope_id=? AND gen=? AND item_code=?");
		return rows.map((r) => ({
			itemCode: String(r.item_code),
			variantOf: (r.variant_of as string | null) ?? null,
			name: String(r.name),
			itemGroup: String(r.item_group),
			uom: String(r.uom),
			priceMinor: Number(r.price_minor),
			priced: Number(r.priced) === 1,
			brand: (r.brand as string | null) ?? null,
			attrs: Object.fromEntries(
				(aq.all(scopeId, gen, r.item_code as string) as Row[]).map((a) => [
					String(a.attr),
					String(a.value),
				]),
			),
			barcodes: (bq.all(scopeId, gen, r.item_code as string) as Row[]).map((b) => String(b.barcode)),
		}));
	}

	async lookupBarcode(scopeId: string, barcode: string): Promise<BarcodeResult> {
		const gen = this.activeGen(scopeId);
		if (gen === null) return { matches: [], ambiguous: false };
		const codes = this.q(
			"SELECT item_code FROM item_barcode WHERE scope_id=? AND gen=? AND barcode=? ORDER BY item_code LIMIT 5",
		).all(scopeId, gen, barcode) as Row[];
		const items: CatalogItem[] = [];
		for (const c of codes) {
			const it = await this.getItem(scopeId, String(c.item_code));
			if (it) items.push(it);
		}
		return { matches: items, ambiguous: items.length > 1 };
	}

	async getItem(scopeId: string, itemCode: string): Promise<CatalogItem | null> {
		const gen = this.activeGen(scopeId);
		if (gen === null) return null;
		const r = this.q("SELECT * FROM item WHERE scope_id=? AND gen=? AND item_code=?").get(
			scopeId,
			gen,
			itemCode,
		) as Row | undefined;
		return r ? this.hydrate(scopeId, gen, [r])[0] : null;
	}

	private finishPage(scopeId: string, gen: number, rows: Row[], limit: number): ItemPage {
		const more = rows.length > limit;
		const slice = more ? rows.slice(0, limit) : rows;
		const last = slice[slice.length - 1];
		return {
			items: this.hydrate(scopeId, gen, slice),
			next:
				more && last
					? encodeCursor({ nameNorm: String(last.name_norm), itemCode: String(last.item_code) })
					: undefined,
		};
	}

	async search(
		scopeId: string,
		query: string,
		req: PageRequest & { variantsOnly?: boolean } = {},
	): Promise<ItemPage> {
		const gen = this.activeGen(scopeId);
		const qn = normalizeQuery(query);
		if (gen === null || !qn) return { items: [] };
		const limit = clampLimit(req.limit);
		const cur = decodeCursor(req.after);
		const afterName = cur?.nameNorm ?? "";
		const afterCode = cur?.itemCode ?? "";
		const hi = prefixUpperBound(qn);
		const keyset =
			(cur ? "AND name_norm >= ? AND (name_norm > ? OR (name_norm = ? AND item_code > ?))" : "") +
			(req.variantsOnly ? " AND variant_of IS NOT NULL" : "");
		const extra = cur ? [afterName, afterName, afterName, afterCode] : [];
		const byName = this.q(
			`SELECT * FROM item WHERE scope_id=? AND gen=? AND name_norm >= ? AND name_norm < ? ${keyset} ORDER BY name_norm, item_code LIMIT ?`,
		).all(scopeId, gen, qn, hi, ...extra, limit + 1) as Row[];
		const byCode = this.q(
			`SELECT * FROM item WHERE scope_id=? AND gen=? AND code_norm >= ? AND code_norm < ? ${keyset} ORDER BY name_norm, item_code LIMIT ?`,
		).all(scopeId, gen, qn, hi, ...extra, limit + 1) as Row[];
		const seen = new Set<string>();
		const merged = [...byName, ...byCode].filter((r) =>
			seen.has(String(r.item_code)) ? false : (seen.add(String(r.item_code)), true),
		);
		merged.sort(
			(a, b) =>
				cmpCodePoints(String(a.name_norm), String(b.name_norm)) ||
				cmpCodePoints(String(a.item_code), String(b.item_code)),
		);
		return this.finishPage(scopeId, gen, merged.slice(0, limit + 1), limit);
	}

	async page(scopeId: string, req: PageRequest & { variantsOnly?: boolean } = {}): Promise<ItemPage> {
		const gen = this.activeGen(scopeId);
		if (gen === null) return { items: [] };
		const limit = clampLimit(req.limit);
		const cur = decodeCursor(req.after);
		const variants = req.variantsOnly ? "AND variant_of IS NOT NULL" : "";
		const keyset = cur
			? "AND name_norm >= ? AND (name_norm > ? OR (name_norm = ? AND item_code > ?))"
			: "";
		const args: (string | number)[] = [scopeId, gen];
		if (cur) args.push(cur.nameNorm, cur.nameNorm, cur.nameNorm, cur.itemCode);
		const rows = this.q(
			`SELECT * FROM item WHERE scope_id=? AND gen=? ${variants} ${keyset} ORDER BY name_norm, item_code LIMIT ?`,
		).all(...args, limit + 1) as Row[];
		return this.finishPage(scopeId, gen, rows, limit);
	}

	async variantsOf(scopeId: string, templateCode: string): Promise<CatalogItem[]> {
		const gen = this.activeGen(scopeId);
		if (gen === null) return [];
		const rows = this.q(
			"SELECT * FROM item WHERE scope_id=? AND gen=? AND variant_of=? ORDER BY name_norm, item_code LIMIT 500",
		).all(scopeId, gen, templateCode) as Row[];
		return this.hydrate(scopeId, gen, rows);
	}

	async codePage(scopeId: string, after: string | undefined, limit: number): Promise<string[]> {
		const gen = this.activeGen(scopeId);
		if (gen === null) return [];
		const rows = this.q(
			"SELECT item_code FROM item WHERE scope_id=? AND gen=? AND item_code > ? ORDER BY item_code LIMIT ?",
		).all(scopeId, gen, after ?? "", Math.min(2000, Math.max(1, limit))) as Row[];
		return rows.map((r) => String(r.item_code));
	}

	async stats(scopeId: string): Promise<CatalogStats> {
		const gen = this.activeGen(scopeId);
		const n = (sql: string) => Number((this.q(sql).get(scopeId, gen ?? -1) as Row).n);
		let dbBytes: number | null = null;
		if (this.path !== ":memory:") {
			this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
			dbBytes = statSync(this.path).size;
		}
		return {
			items: n("SELECT COUNT(*) AS n FROM item WHERE scope_id=? AND gen=?"),
			barcodes: n("SELECT COUNT(*) AS n FROM item_barcode WHERE scope_id=? AND gen=?"),
			activeGen: gen,
			dbBytes,
		};
	}

	// ---- sample transactions + outbox -------------------------------------------------------

	private now(): number {
		return this.opts.now ? this.opts.now() : Date.now();
	}

	async commitSample(sale: SampleSale): Promise<CommitResult> {
		validateSale(sale);
		const hash = await sha256Hex(canonicalJson(sale));
		const receipt = buildReceipt(sale, this.now());
		try {
			return this.tx(() => {
				const ex = this.q("SELECT content_hash, receipt_json FROM sample_txn WHERE txn_id=?").get(
					sale.clientTxnId,
				) as Row | undefined;
				if (ex) {
					if (ex.content_hash !== hash) throw new TxnConflictError(sale.clientTxnId);
					return {
						status: "duplicate",
						receipt: JSON.parse(String(ex.receipt_json)),
					} as CommitResult;
				}
				this.q(
					"INSERT INTO sample_txn (txn_id,content_hash,scope_id,currency,minor_digits,total_minor,sale_json,receipt_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
				).run(
					sale.clientTxnId,
					hash,
					sale.scopeId,
					sale.currency,
					sale.minorDigits,
					receipt.totalMinor,
					canonicalJson(sale),
					"{}",
					receipt.capturedAt,
				);
				this.opts.fault?.("after-sale");
				this.q("UPDATE sample_txn SET receipt_json=? WHERE txn_id=?").run(
					canonicalJson(receipt),
					sale.clientTxnId,
				);
				this.opts.fault?.("after-receipt");
				this.q(
					"INSERT INTO outbox (command_id,txn_id,kind,state,blocked_reason,created_at) VALUES (?,?,'SAMPLE','blocked','sample transaction: never posted to ERPNext',?)",
				).run("cmd-" + sale.clientTxnId, sale.clientTxnId, receipt.capturedAt);
				this.opts.fault?.("after-outbox");
				return { status: "created", receipt } as CommitResult;
			});
		} catch (e) {
			if (e instanceof TxnConflictError) throw e;
			throw new TxnWriteError("sample transaction was not saved", { cause: e });
		}
	}

	async getReceipt(clientTxnId: string): Promise<SampleReceipt | null> {
		const r = this.q("SELECT receipt_json FROM sample_txn WHERE txn_id=?").get(clientTxnId) as
			| Row
			| undefined;
		return r ? (JSON.parse(String(r.receipt_json)) as SampleReceipt) : null;
	}

	async outboxCounts(): Promise<Record<string, number>> {
		const rows = this.q("SELECT state, COUNT(*) AS n FROM outbox GROUP BY state").all() as Row[];
		return Object.fromEntries(rows.map((r) => [String(r.state), Number(r.n)]));
	}

	async saveSale(sale: NewSale): Promise<{ created: boolean; sale: SaleRecord }> {
		const hash = await hashBody(sale.body);
		const now = this.now();
		return this.tx(() => {
			const ex = this.q("SELECT * FROM sale WHERE txn_id=?").get(sale.txnId) as Row | undefined;
			if (ex) {
				if (ex.content_hash !== hash) throw new SaleConflictError(sale.txnId);
				return { created: false, sale: toSale(ex) };
			}
			this.q(
				"INSERT INTO sale (txn_id,scope_id,status,body_json,content_hash,currency,minor_digits,payable_minor,evidence_json,created_at,updated_at) VALUES (?,?,'captured',?,?,?,?,?,?,?,?)",
			).run(
				sale.txnId,
				sale.scopeId,
				canonicalJson(sale.body),
				hash,
				sale.currency,
				sale.minorDigits,
				sale.payableMinor,
				canonicalJson(sale.evidence),
				now,
				now,
			);
			this.opts.fault?.("after-sale");
			return {
				created: true,
				sale: toSale(this.q("SELECT * FROM sale WHERE txn_id=?").get(sale.txnId) as Row),
			};
		});
	}

	async getSale(txnId: string): Promise<SaleRecord | null> {
		const r = this.q("SELECT * FROM sale WHERE txn_id=?").get(txnId) as Row | undefined;
		return r ? toSale(r) : null;
	}

	async updateSale(txnId: string, patch: SalePatch): Promise<SaleRecord> {
		return this.tx(() => {
			const r = this.q("SELECT * FROM sale WHERE txn_id=?").get(txnId) as Row | undefined;
			if (!r) throw new Error(`unknown sale ${txnId}`);
			const cur = toSale(r);
			const bodyJson = patch.bodyJson ?? cur.bodyJson;
			this.q(
				"UPDATE sale SET status=?, server_json=?, invoice=?, message=?, body_json=?, evidence_json=?, payable_minor=?, attempts=attempts+?, updated_at=? WHERE txn_id=?",
			).run(
				patch.status ?? cur.status,
				patch.serverJson !== undefined ? patch.serverJson : cur.serverJson,
				patch.invoice !== undefined ? patch.invoice : cur.invoice,
				patch.message ?? cur.message,
				bodyJson,
				patch.evidenceJson ?? cur.evidenceJson,
				patch.payableMinor ?? cur.payableMinor,
				patch.attempt ? 1 : 0,
				this.now(),
				txnId,
			);
			return toSale(this.q("SELECT * FROM sale WHERE txn_id=?").get(txnId) as Row);
		});
	}

	async listSales(statuses: SaleStatus[], limit = 100): Promise<SaleRecord[]> {
		if (!statuses.length) return [];
		const rows = this.q(
			`SELECT * FROM sale WHERE status IN (${statuses.map(() => "?").join(",")}) ORDER BY created_at DESC LIMIT ?`,
		).all(...statuses, Math.min(limit, 200)) as Row[];
		return rows.map(toSale);
	}

	async applyDelta(scopeId: string, upserts: CatalogItem[], removed: string[]): Promise<void> {
		const gen = this.activeGen(scopeId);
		if (gen === null) throw new Error("no active catalog to update");
		this.tx(() => {
			const codes = [...removed, ...upserts.map((u) => u.itemCode)];
			for (const code of codes) {
				for (const t of ["item", "item_barcode", "item_attr"])
					this.q(`DELETE FROM ${t} WHERE scope_id=? AND gen=? AND item_code=?`).run(
						scopeId,
						gen,
						code,
					);
			}
			const ii = this.q(
				"INSERT INTO item (scope_id,gen,item_code,variant_of,name,name_norm,code_norm,item_group,uom,price_minor,priced,brand) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
			);
			const ib = this.q(
				"INSERT OR IGNORE INTO item_barcode (scope_id,gen,barcode,item_code,uom) VALUES (?,?,?,?,?)",
			);
			const ia = this.q("INSERT INTO item_attr (scope_id,gen,item_code,attr,value) VALUES (?,?,?,?,?)");
			for (const it of upserts) {
				ii.run(
					scopeId,
					gen,
					it.itemCode,
					it.variantOf,
					it.name,
					normalize(it.name),
					normalize(it.itemCode),
					it.itemGroup,
					it.uom,
					it.priceMinor,
					it.priced ? 1 : 0,
					it.brand ?? null,
				);
				for (const b of it.barcodes) ib.run(scopeId, gen, b, it.itemCode, it.uom);
				for (const [k, v] of Object.entries(it.attrs)) ia.run(scopeId, gen, it.itemCode, k, v);
			}
			const n = Number(
				(this.q("SELECT COUNT(*) AS n FROM item WHERE scope_id=? AND gen=?").get(scopeId, gen) as Row)
					.n,
			);
			this.q("UPDATE catalog_generation SET item_count=? WHERE scope_id=? AND gen=?").run(
				n,
				scopeId,
				gen,
			);
		});
	}

	/** Atomic claim shared by foreground and background processors (SAMPLE rows are never claimable). */
	claimNext(token: string, leaseMs: number): { commandId: string; txnId: string; kind: string } | null {
		const now = this.now();
		return this.tx(() => {
			const r = this.q(
				"SELECT command_id, txn_id, kind, state FROM outbox WHERE kind <> 'SAMPLE' AND (state = 'pending' OR (state = 'claimed' AND claim_until < ?)) ORDER BY created_at LIMIT 1",
			).get(now) as Row | undefined;
			if (!r) return null;
			const res = this.q(
				"UPDATE outbox SET state='claimed', claim_token=?, claim_until=?, attempts=attempts+1 WHERE command_id=? AND state=?",
			).run(token, now + leaseMs, r.command_id as string, r.state as string);
			return Number(res.changes) === 1
				? { commandId: String(r.command_id), txnId: String(r.txn_id), kind: String(r.kind) }
				: null;
		});
	}
}

function toSale(r: Row): SaleRecord {
	return {
		txnId: String(r.txn_id),
		scopeId: String(r.scope_id),
		status: String(r.status) as SaleStatus,
		bodyJson: String(r.body_json),
		contentHash: String(r.content_hash),
		currency: String(r.currency),
		minorDigits: Number(r.minor_digits),
		payableMinor: Number(r.payable_minor),
		evidenceJson: String(r.evidence_json),
		serverJson: (r.server_json as string | null) ?? null,
		invoice: (r.invoice as string | null) ?? null,
		message: String(r.message),
		attempts: Number(r.attempts),
		createdAt: Number(r.created_at),
		updatedAt: Number(r.updated_at),
	};
}

function toScope(r: Row): CatalogScopeInfo {
	return {
		scopeId: String(r.scope_id),
		site: String(r.site),
		company: (r.company as string | null) ?? null,
		warehouse: (r.warehouse as string | null) ?? null,
		priceList: (r.price_list as string | null) ?? null,
		currency: String(r.currency),
		minorDigits: Number(r.minor_digits),
		activeGen: r.active_gen === null ? null : Number(r.active_gen),
	};
}
