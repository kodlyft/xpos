/**
 * Browser development store for `yarn dev`. It implements the SAME ports as the Android SQLite adapter (catalog
 * repository and transaction store) with in-memory indexes that are snapshotted to IndexedDB, so a reload keeps the
 * catalog and the captured sales. It exists to develop the shared Vue UI against a real ERPNext site; it is NOT the
 * Android storage engine and proves nothing about device speed, SQLite behaviour or durability across power loss.
 */
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
import { clampLimit, normalize, normalizeQuery } from "@mobile/domain/search";
import { decodeCursor, encodeCursor } from "@mobile/domain/cursor";
import type { CommitResult } from "@mobile/domain/txn";
import {
	hashBody,
	SaleConflictError,
	type NewSale,
	type SalePatch,
	type SaleRecord,
	type SaleStatus,
} from "@mobile/domain/sale";
import { canonicalJson } from "@mobile/domain/txn";

interface Entry {
	item: CatalogItem;
	nameNorm: string;
	codeNorm: string;
}
interface Generation {
	state: "staging" | "active" | "retired";
	items: Map<string, CatalogItem>;
}
interface Snapshot {
	scopes: CatalogScopeInfo[];
	active: Record<string, { gen: number; items: CatalogItem[] }>;
	sales: SaleRecord[];
}

const DB = "xpos-web-dev";
const KEY = "snapshot";

function openDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const r = indexedDB.open(DB, 1);
		r.onupgradeneeded = () => r.result.createObjectStore("kv");
		r.onsuccess = () => resolve(r.result);
		r.onerror = () => reject(r.error);
	});
}

async function idbGet(): Promise<Snapshot | null> {
	if (typeof indexedDB === "undefined") return null;
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const q = db.transaction("kv").objectStore("kv").get(KEY);
		q.onsuccess = () => resolve((q.result as Snapshot) ?? null);
		q.onerror = () => reject(q.error);
	});
}

async function idbPut(s: Snapshot): Promise<void> {
	if (typeof indexedDB === "undefined") return;
	const db = await openDb();
	await new Promise<void>((resolve, reject) => {
		const tx = db.transaction("kv", "readwrite");
		tx.objectStore("kv").put(s, KEY);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export class WebStore implements CatalogRepository, TransactionStore {
	readonly kind = "web-dev" as const;
	private scopes = new Map<string, CatalogScopeInfo>();
	private gens = new Map<string, Map<number, Generation>>();
	private sales = new Map<string, SaleRecord>();
	private index = new Map<string, { byName: Entry[]; byCode: Entry[]; barcodes: Map<string, string[]> }>();
	private ready: Promise<void>;
	private saving: Promise<void> = Promise.resolve();

	constructor(private readonly now: () => number = Date.now) {
		this.ready = this.load();
	}

	private async load(): Promise<void> {
		const snap = await idbGet().catch(() => null);
		if (!snap) return;
		for (const s of snap.scopes) this.scopes.set(s.scopeId, s);
		for (const [scopeId, a] of Object.entries(snap.active))
			this.gens.set(
				scopeId,
				new Map([[a.gen, { state: "active", items: new Map(a.items.map((i) => [i.itemCode, i])) }]]),
			);
		for (const s of snap.sales) this.sales.set(s.txnId, s);
	}

	private persist(): void {
		const snap: Snapshot = {
			scopes: [...this.scopes.values()],
			active: {},
			sales: [...this.sales.values()],
		};
		for (const s of this.scopes.values()) {
			if (s.activeGen === null) continue;
			const g = this.gens.get(s.scopeId)?.get(s.activeGen);
			if (g) snap.active[s.scopeId] = { gen: s.activeGen, items: [...g.items.values()] };
		}
		this.saving = this.saving.then(() => idbPut(snap)).catch(() => undefined);
	}

	private gen(scopeId: string, gen: number): Generation {
		const g = this.gens.get(scopeId)?.get(gen);
		if (!g) throw new Error(`unknown generation ${gen}`);
		return g;
	}

	private active(scopeId: string): { gen: number; g: Generation } | null {
		const s = this.scopes.get(scopeId);
		if (!s) throw new Error(`unknown scope ${scopeId}`);
		return s.activeGen === null ? null : { gen: s.activeGen, g: this.gen(scopeId, s.activeGen) };
	}

	private idx(scopeId: string, gen: number, g: Generation) {
		const key = `${scopeId}#${gen}`;
		let ix = this.index.get(key);
		if (!ix) {
			const entries = [...g.items.values()].map((item) => ({
				item,
				nameNorm: normalize(item.name),
				codeNorm: normalize(item.itemCode),
			}));
			const byName = [...entries].sort(
				(a, b) => cmp(a.nameNorm, b.nameNorm) || cmp(a.item.itemCode, b.item.itemCode),
			);
			const byCode = [...entries].sort((a, b) => cmp(a.codeNorm, b.codeNorm));
			const barcodes = new Map<string, string[]>();
			for (const e of entries)
				for (const b of e.item.barcodes)
					barcodes.set(b, [...(barcodes.get(b) ?? []), e.item.itemCode]);
			ix = { byName, byCode, barcodes };
			this.index.set(key, ix);
		}
		return ix;
	}

	private dropIndex(scopeId: string): void {
		for (const k of [...this.index.keys()]) if (k.startsWith(`${scopeId}#`)) this.index.delete(k);
	}

	async createScope(s: Omit<CatalogScopeInfo, "activeGen">): Promise<void> {
		await this.ready;
		if (this.scopes.has(s.scopeId)) throw new Error("scope exists");
		this.scopes.set(s.scopeId, { ...s, activeGen: null });
		this.gens.set(s.scopeId, new Map());
		this.persist();
	}
	async listScopes(): Promise<CatalogScopeInfo[]> {
		await this.ready;
		return [...this.scopes.values()].sort((a, b) => cmp(a.scopeId, b.scopeId));
	}
	async dropScope(scopeId: string): Promise<void> {
		await this.ready;
		this.scopes.delete(scopeId);
		this.gens.delete(scopeId);
		this.dropIndex(scopeId);
		this.persist();
	}
	async beginGeneration(scopeId: string): Promise<number> {
		await this.ready;
		const gens = this.gens.get(scopeId);
		if (!gens) throw new Error(`unknown scope ${scopeId}`);
		const gen = Math.max(0, ...gens.keys()) + 1;
		gens.set(gen, { state: "staging", items: new Map() });
		return gen;
	}
	async putBatch(scopeId: string, gen: number, items: CatalogItem[]): Promise<void> {
		const g = this.gen(scopeId, gen);
		if (g.state !== "staging") throw new Error(`generation ${gen} is not staging`);
		for (const i of items) g.items.set(i.itemCode, i);
	}
	async activate(scopeId: string, gen: number, expectedItems: number): Promise<void> {
		const g = this.gen(scopeId, gen);
		if (g.state !== "staging") throw new Error(`generation ${gen} is not staging`);
		if (g.items.size !== expectedItems)
			throw new Error(`staged ${g.items.size} items, expected ${expectedItems}; not activating`);
		for (const [n, other] of this.gens.get(scopeId)!)
			if (n !== gen && other.state === "active") this.gens.get(scopeId)!.delete(n);
		g.state = "active";
		this.scopes.get(scopeId)!.activeGen = gen;
		this.dropIndex(scopeId);
		this.persist();
	}
	async discard(scopeId: string, gen: number): Promise<void> {
		const g = this.gens.get(scopeId)?.get(gen);
		if (g?.state === "active") throw new Error("cannot discard the active generation");
		this.gens.get(scopeId)?.delete(gen);
	}

	private hydrate(items: CatalogItem[]): CatalogItem[] {
		return items.map((i) => ({ ...i, attrs: { ...i.attrs }, barcodes: [...i.barcodes].sort() }));
	}

	async lookupBarcode(scopeId: string, barcode: string): Promise<BarcodeResult> {
		await this.ready;
		const a = this.active(scopeId);
		if (!a) return { matches: [], ambiguous: false };
		const codes = (this.idx(scopeId, a.gen, a.g).barcodes.get(barcode) ?? []).slice().sort().slice(0, 5);
		const matches = this.hydrate(codes.map((c) => a.g.items.get(c)!).filter(Boolean));
		return { matches, ambiguous: matches.length > 1 };
	}
	async getItem(scopeId: string, itemCode: string): Promise<CatalogItem | null> {
		await this.ready;
		const i = this.active(scopeId)?.g.items.get(itemCode);
		return i ? this.hydrate([i])[0] : null;
	}

	private pageOf(rows: Entry[], limit: number): ItemPage {
		const more = rows.length > limit;
		const slice = more ? rows.slice(0, limit) : rows;
		const last = slice[slice.length - 1];
		return {
			items: this.hydrate(slice.map((e) => e.item)),
			next:
				more && last
					? encodeCursor({ nameNorm: last.nameNorm, itemCode: last.item.itemCode })
					: undefined,
		};
	}

	private afterCursor(e: Entry, cur: { nameNorm: string; itemCode: string } | null): boolean {
		return (
			!cur ||
			cmp(e.nameNorm, cur.nameNorm) > 0 ||
			(e.nameNorm === cur.nameNorm && cmp(e.item.itemCode, cur.itemCode) > 0)
		);
	}

	async search(
		scopeId: string,
		query: string,
		req: PageRequest & { variantsOnly?: boolean } = {},
	): Promise<ItemPage> {
		await this.ready;
		const a = this.active(scopeId);
		const q = normalizeQuery(query);
		if (!a || !q) return { items: [] };
		const limit = clampLimit(req.limit);
		const cur = decodeCursor(req.after);
		const ix = this.idx(scopeId, a.gen, a.g);
		const seen = new Set<string>();
		const hits: Entry[] = [];
		for (const e of [...ix.byName, ...ix.byCode]) {
			if (!(e.nameNorm.startsWith(q) || e.codeNorm.startsWith(q))) continue;
			if (seen.has(e.item.itemCode) || !this.afterCursor(e, cur)) continue;
			if (req.variantsOnly && !e.item.variantOf) continue;
			seen.add(e.item.itemCode);
			hits.push(e);
		}
		hits.sort((x, y) => cmp(x.nameNorm, y.nameNorm) || cmp(x.item.itemCode, y.item.itemCode));
		return this.pageOf(hits.slice(0, limit + 1), limit);
	}
	async page(scopeId: string, req: PageRequest & { variantsOnly?: boolean } = {}): Promise<ItemPage> {
		await this.ready;
		const a = this.active(scopeId);
		if (!a) return { items: [] };
		const limit = clampLimit(req.limit);
		const cur = decodeCursor(req.after);
		const rows: Entry[] = [];
		for (const e of this.idx(scopeId, a.gen, a.g).byName) {
			if (!this.afterCursor(e, cur) || (req.variantsOnly && !e.item.variantOf)) continue;
			rows.push(e);
			if (rows.length > limit) break;
		}
		return this.pageOf(rows, limit);
	}
	async variantsOf(scopeId: string, templateCode: string): Promise<CatalogItem[]> {
		await this.ready;
		const a = this.active(scopeId);
		if (!a) return [];
		return this.hydrate(
			this.idx(scopeId, a.gen, a.g)
				.byName.filter((e) => e.item.variantOf === templateCode)
				.slice(0, 500)
				.map((e) => e.item),
		);
	}
	async stats(scopeId: string): Promise<CatalogStats> {
		await this.ready;
		const a = this.active(scopeId);
		const items = a ? [...a.g.items.values()] : [];
		return {
			items: items.length,
			barcodes: items.reduce((n, i) => n + i.barcodes.length, 0),
			activeGen: a?.gen ?? null,
			dbBytes: null,
		};
	}
	async codePage(scopeId: string, after: string | undefined, limit: number): Promise<string[]> {
		await this.ready;
		const a = this.active(scopeId);
		if (!a) return [];
		return [...a.g.items.keys()]
			.sort()
			.filter((c) => !after || c > after)
			.slice(0, Math.min(2000, limit));
	}
	async applyDelta(scopeId: string, upserts: CatalogItem[], removed: string[]): Promise<void> {
		await this.ready;
		const a = this.active(scopeId);
		if (!a) throw new Error("no active catalog to update");
		for (const c of removed) a.g.items.delete(c);
		for (const i of upserts) a.g.items.set(i.itemCode, i);
		this.dropIndex(scopeId);
		this.persist();
	}

	async commitSample(): Promise<CommitResult> {
		throw new Error("Sample sales are a developer tool of the Android build.");
	}
	async getReceipt() {
		return null;
	}
	async outboxCounts(): Promise<Record<string, number>> {
		return {};
	}

	async saveSale(sale: NewSale): Promise<{ created: boolean; sale: SaleRecord }> {
		await this.ready;
		const hash = await hashBody(sale.body);
		const ex = this.sales.get(sale.txnId);
		if (ex) {
			if (ex.contentHash !== hash) throw new SaleConflictError(sale.txnId);
			return { created: false, sale: ex };
		}
		const now = this.now();
		const rec: SaleRecord = {
			txnId: sale.txnId,
			scopeId: sale.scopeId,
			status: "captured",
			bodyJson: canonicalJson(sale.body),
			contentHash: hash,
			currency: sale.currency,
			minorDigits: sale.minorDigits,
			payableMinor: sale.payableMinor,
			evidenceJson: canonicalJson(sale.evidence),
			serverJson: null,
			invoice: null,
			message: "",
			attempts: 0,
			createdAt: now,
			updatedAt: now,
		};
		this.sales.set(rec.txnId, rec);
		this.persist();
		return { created: true, sale: rec };
	}
	async getSale(txnId: string): Promise<SaleRecord | null> {
		await this.ready;
		return this.sales.get(txnId) ?? null;
	}
	async updateSale(txnId: string, patch: SalePatch): Promise<SaleRecord> {
		await this.ready;
		const cur = this.sales.get(txnId);
		if (!cur) throw new Error(`unknown sale ${txnId}`);
		const next: SaleRecord = {
			...cur,
			status: patch.status ?? cur.status,
			serverJson: patch.serverJson !== undefined ? patch.serverJson : cur.serverJson,
			invoice: patch.invoice !== undefined ? patch.invoice : cur.invoice,
			message: patch.message ?? cur.message,
			bodyJson: patch.bodyJson ?? cur.bodyJson,
			evidenceJson: patch.evidenceJson ?? cur.evidenceJson,
			payableMinor: patch.payableMinor ?? cur.payableMinor,
			attempts: cur.attempts + (patch.attempt ? 1 : 0),
			updatedAt: this.now(),
		};
		this.sales.set(txnId, next);
		this.persist();
		return next;
	}
	async listSales(statuses: SaleStatus[], limit = 100): Promise<SaleRecord[]> {
		await this.ready;
		return [...this.sales.values()]
			.filter((s) => statuses.includes(s.status))
			.sort((a, b) => b.createdAt - a.createdAt)
			.slice(0, Math.min(200, limit));
	}
}
