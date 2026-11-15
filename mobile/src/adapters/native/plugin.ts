/**
 * Capacitor bridge to the Kotlin `XposNative` plugin (android/.../XposNativePlugin.kt).
 * Every payload is a plain JSON object and bounded (pages <= 100 rows, batches <= 1000 items).
 * Not exercised in browser or host tests: it needs the Android build (see foundation-status.md).
 */
import { registerPlugin } from "@capacitor/core";
import type {
	BarcodeResult,
	CatalogItem,
	CatalogScopeInfo,
	CatalogStats,
	Enrolled,
	ItemPage,
} from "@mobile/ports";
import type { CommitResult, SampleReceipt, SampleSale } from "@mobile/domain/txn";
import type { PreparedSale, SalePatch, SaleRecord, SaleStatus } from "@mobile/domain/sale";

export interface XposNativePlugin {
	createScope(s: Omit<CatalogScopeInfo, "activeGen">): Promise<void>;
	listScopes(): Promise<{ scopes: CatalogScopeInfo[] }>;
	dropScope(a: { scopeId: string }): Promise<void>;
	beginGeneration(a: { scopeId: string }): Promise<{ gen: number }>;
	putBatch(a: { scopeId: string; gen: number; items: CatalogItem[] }): Promise<void>;
	activate(a: { scopeId: string; gen: number; expectedItems: number }): Promise<void>;
	discard(a: { scopeId: string; gen: number }): Promise<void>;
	lookupBarcode(a: { scopeId: string; barcode: string }): Promise<BarcodeResult>;
	getItem(a: { scopeId: string; itemCode: string }): Promise<{ item: CatalogItem | null }>;
	search(a: {
		scopeId: string;
		query: string;
		after?: string;
		limit?: number;
		variantsOnly?: boolean;
	}): Promise<ItemPage>;
	page(a: { scopeId: string; after?: string; limit?: number; variantsOnly?: boolean }): Promise<ItemPage>;
	variantsOf(a: { scopeId: string; templateCode: string }): Promise<{ items: CatalogItem[] }>;
	stats(a: { scopeId: string }): Promise<CatalogStats>;

	applyDelta(a: { scopeId: string; upserts: CatalogItem[]; removed: string[] }): Promise<void>;
	codePage(a: { scopeId: string; after?: string; limit: number }): Promise<{ codes: string[] }>;

	saveSale(s: PreparedSale): Promise<{ created: boolean; sale: SaleRecord }>;
	getSale(a: { txnId: string }): Promise<{ sale: SaleRecord | null }>;
	updateSale(a: { txnId: string } & SalePatch): Promise<{ sale: SaleRecord }>;
	listSales(a: { statuses: SaleStatus[]; limit: number }): Promise<{ sales: SaleRecord[] }>;

	commitSample(s: SampleSale): Promise<CommitResult>;
	getReceipt(a: { clientTxnId: string }): Promise<{ receipt: SampleReceipt | null }>;
	outboxCounts(): Promise<{ counts: Record<string, number> }>;

	/** Auth vault, PIN, lease. All validation (PIN throttling, lease window, rollback) happens in Kotlin. */
	enroll(a: {
		user: string;
		site: string;
		profile: string;
		currency: string;
		minorDigits: number;
		issuedAt: number;
		leaseTtlSeconds: number;
		pin: string;
	}): Promise<void>;
	enrolled(): Promise<{ enrolled: Enrolled | null }>;
	unlock(a: { pin: string }): Promise<{ ok: boolean; reason?: string; retryInMs?: number }>;
	lock(): Promise<void>;
	leaseStatus(): Promise<{
		lease: { status: "valid" | "expired" | "rollback"; remainingMs: number } | null;
	}>;
	signOut(): Promise<void>;

	schemaInfo(): Promise<{
		fingerprint: string;
		tables: number;
		changedAtLastOpen: boolean | null;
		addedColumns: string[];
		unmanaged: string[];
	}>;
	scannerCapabilities(): Promise<{ capabilities: unknown[] }>;
	printerCapabilities(): Promise<{ capabilities: unknown[] }>;
}

export const XposNative = registerPlugin<XposNativePlugin>("XposNative");
