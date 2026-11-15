/**
 * Explicit seams between the shared Vue UI and the platform. Each port has a native (Android,
 * Capacitor plugin) implementation under adapters/native.
 */
import type { CommitResult, SampleSale } from "@mobile/domain/txn";
import type { NewSale, SalePatch, SaleRecord, SaleStatus } from "@mobile/domain/sale";

/** "host-test" is the node:sqlite double used only by the unit tests; "web-dev" is the browser development adapter. */
export type AdapterKind = "native" | "host-test" | "web-dev";

export interface CatalogItem {
	itemCode: string;
	variantOf: string | null;
	name: string;
	itemGroup: string;
	uom: string;
	priceMinor: number;
	priced: boolean;
	brand?: string | null;
	attrs: Record<string, string>;
	barcodes: string[];
}

export interface CatalogScopeInfo {
	scopeId: string;
	site: string;
	company: string | null;
	warehouse: string | null;
	priceList: string | null;
	currency: string;
	minorDigits: number;
	activeGen: number | null;
}

export interface ItemPage {
	items: CatalogItem[];
	/** Opaque keyset cursor; absent on the last page. */
	next?: string;
}

export interface BarcodeResult {
	matches: CatalogItem[];
	/** True when the same barcode is assigned to more than one item (data error; needs review). */
	ambiguous: boolean;
}

export interface PageRequest {
	after?: string;
	limit?: number;
}

export interface CatalogStats {
	items: number;
	barcodes: number;
	activeGen: number | null;
	dbBytes: number | null;
}

/** Storage/catalog repository. Every call is scoped to one cashier/profile/server catalog. */
export interface CatalogRepository {
	readonly kind: AdapterKind;
	createScope(scope: Omit<CatalogScopeInfo, "activeGen">): Promise<void>;
	listScopes(): Promise<CatalogScopeInfo[]>;
	dropScope(scopeId: string): Promise<void>;
	beginGeneration(scopeId: string): Promise<number>;
	putBatch(scopeId: string, gen: number, items: CatalogItem[]): Promise<void>;
	/** Atomically make `gen` the active generation; verifies the expected item count first. */
	activate(scopeId: string, gen: number, expectedItems: number): Promise<void>;
	discard(scopeId: string, gen: number): Promise<void>;
	lookupBarcode(scopeId: string, barcode: string): Promise<BarcodeResult>;
	getItem(scopeId: string, itemCode: string): Promise<CatalogItem | null>;
	search(scopeId: string, query: string, req?: PageRequest & { variantsOnly?: boolean }): Promise<ItemPage>;
	page(scopeId: string, req?: PageRequest & { variantsOnly?: boolean }): Promise<ItemPage>;
	variantsOf(scopeId: string, templateCode: string): Promise<CatalogItem[]>;
	stats(scopeId: string): Promise<CatalogStats>;
	/** Item codes of the active catalog in code order, after `after` (exclusive), at most `limit` (<= 2000). */
	codePage(scopeId: string, after: string | undefined, limit: number): Promise<string[]>;
	/**
	 * Applies a change-feed delta to the ACTIVE generation in one transaction: `upserts` replace (or add) items with all
	 * their barcodes and attributes, `removed` delete items. Nothing changes if it fails.
	 */
	applyDelta(scopeId: string, upserts: CatalogItem[], removed: string[]): Promise<void>;
}

export interface TransactionStore {
	readonly kind: AdapterKind;
	/** Resolves only after the sale, receipt snapshot and outbox command are durably committed. */
	commitSample(sale: SampleSale): Promise<CommitResult>;
	getReceipt(clientTxnId: string): Promise<CommitResult["receipt"] | null>;
	outboxCounts(): Promise<Record<string, number>>;
	/** Writes the sale (with tender and receipt evidence) durably; an existing id with the same contents is a no-op. */
	saveSale(sale: NewSale): Promise<{ created: boolean; sale: SaleRecord }>;
	getSale(txnId: string): Promise<SaleRecord | null>;
	updateSale(txnId: string, patch: SalePatch): Promise<SaleRecord>;
	/** Newest first, bounded. */
	listSales(statuses: SaleStatus[], limit?: number): Promise<SaleRecord[]>;
}

export interface ApiTransport {
	readonly kind: AdapterKind;
	/** Base origin is fixed by ServerIdentity, never taken from location. */
	call<T>(method: string, args?: Record<string, unknown>, opts?: { get?: boolean }): Promise<T>;
}

export type UnlockResult =
	| { ok: true }
	| {
			ok: false;
			reason: "wrong_pin" | "locked" | "not_enrolled" | "lease_expired" | "clock_rollback";
			retryInMs?: number;
	  };

export interface AuthSession {
	user: string;
	site: string;
	profile: string;
	currency: string;
	minorDigits: number;
}

export interface PaymentMode {
	mode_of_payment: string;
	default: boolean;
	type: string | null;
	requires_reference?: boolean;
}

export interface ProfileChoice {
	name: string;
	company: string;
	warehouse: string;
}

export interface BootstrapInfo extends AuthSession {
	/** null when the server did not report an ERPNext version (the Frappe version is never substituted). */
	erpnextVersion: string | null;
	frappeVersion: string;
	priceList: string | null;
	customer: string | null;
	profiles: ProfileChoice[];
	paymentModes: PaymentMode[];
	openShift: string | null;
	company: string;
	warehouse: string;
	leaseTtlSeconds: number;
	issuedAt: number;
	permissions: Record<string, boolean>;
	fullName: string | null;
	customerName: string | null;
	canCreateCustomer: boolean;
	canEditCustomer: boolean;
	/** Gift cards on this profile (the payment mode that spends a card, the item that sells one); null when off. */
	giftCards: GiftCardConfig | null;
}

export interface GiftCardConfig {
	modeOfPayment: string;
	item: string;
	minAmount: number;
	maxAmount: number;
}

export interface Enrolled {
	user: string;
	site: string;
	profile: string;
	currency: string;
	minorDigits: number;
}

export interface AuthService {
	readonly kind: AdapterKind;
	loginOnline(origin: string, user: string, password: string): Promise<BootstrapInfo>;
	enroll(info: BootstrapInfo, pin: string): Promise<void>;
	enrolled(): Promise<Enrolled | null>;
	unlock(pin: string): Promise<UnlockResult>;
	lock(): Promise<void>;
	leaseStatus(): Promise<{ status: "valid" | "expired" | "rollback"; remainingMs: number } | null>;
	signOut(): Promise<void>;
}

export interface Lifecycle {
	onBackground(cb: () => void): () => void;
	onForeground(cb: () => void): () => void;
	onConnectivity(cb: (online: boolean) => void): () => void;
	isOnline(): boolean;
}

/** Outbound sync contract. No implementation in this milestone may report success. */
export interface SyncEngine {
	readonly kind: AdapterKind;
	status(): Promise<{ supported: boolean; reason: string; pending: number }>;
}

export interface ScannerCapabilities {
	kind: "camera" | "keyboard-wedge" | "vendor-sdk";
	supported: boolean;
	tested: boolean;
	note: string;
}
export interface Scanner {
	capabilities(): ScannerCapabilities[];
	onScan(cb: (code: string) => void): () => void;
}

export interface PrinterCapabilities {
	kind: "bluetooth-escpos" | "integrated" | "system-print";
	supported: boolean;
	tested: boolean;
	note: string;
}
export interface Printer {
	capabilities(): PrinterCapabilities[];
	print(text: string): Promise<{ printed: false; reason: string }>;
}
