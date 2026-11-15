import type {
	AdapterKind,
	AuthService,
	BootstrapInfo,
	CatalogItem,
	CatalogRepository,
	PageRequest,
	Printer,
	Scanner,
	SyncEngine,
	TransactionStore,
	UnlockResult,
} from "@mobile/ports";
import type { CommitResult } from "@mobile/domain/txn";
import {
	prepareSale,
	SaleConflictError,
	type NewSale,
	type SalePatch,
	type SaleStatus,
} from "@mobile/domain/sale";
import { clampLimit } from "@mobile/domain/search";
import type { OnlineLogin } from "../onlineLogin";
import { XposNative } from "./plugin";

const kind: AdapterKind = "native";

export class NativeCatalog implements CatalogRepository {
	readonly kind = kind;
	createScope = (s: Parameters<CatalogRepository["createScope"]>[0]) => XposNative.createScope(s);
	listScopes = async () => (await XposNative.listScopes()).scopes;
	dropScope = (scopeId: string) => XposNative.dropScope({ scopeId });
	beginGeneration = async (scopeId: string) => (await XposNative.beginGeneration({ scopeId })).gen;
	putBatch: CatalogRepository["putBatch"] = async (scopeId, gen, items) => {
		for (let i = 0; i < items.length; i += 1000)
			await XposNative.putBatch({ scopeId, gen, items: items.slice(i, i + 1000) });
	};
	activate = (scopeId: string, gen: number, expectedItems: number) =>
		XposNative.activate({ scopeId, gen, expectedItems });
	discard = (scopeId: string, gen: number) => XposNative.discard({ scopeId, gen });
	lookupBarcode = (scopeId: string, barcode: string) => XposNative.lookupBarcode({ scopeId, barcode });
	getItem = async (scopeId: string, itemCode: string) =>
		(await XposNative.getItem({ scopeId, itemCode })).item;
	search = (scopeId: string, query: string, req: PageRequest & { variantsOnly?: boolean } = {}) =>
		XposNative.search({
			scopeId,
			query,
			after: req.after,
			limit: clampLimit(req.limit),
			variantsOnly: req.variantsOnly,
		});
	page = (scopeId: string, req: PageRequest & { variantsOnly?: boolean } = {}) =>
		XposNative.page({
			scopeId,
			after: req.after,
			limit: clampLimit(req.limit),
			variantsOnly: req.variantsOnly,
		});
	variantsOf = async (scopeId: string, templateCode: string) =>
		(await XposNative.variantsOf({ scopeId, templateCode })).items;
	stats = (scopeId: string) => XposNative.stats({ scopeId });
	codePage = async (scopeId: string, after: string | undefined, limit: number) =>
		(await XposNative.codePage({ scopeId, after, limit })).codes;
	applyDelta = async (scopeId: string, upserts: CatalogItem[], removed: string[]) => {
		for (let i = 0; i < Math.max(upserts.length, removed.length, 1); i += 1000)
			await XposNative.applyDelta({
				scopeId,
				upserts: upserts.slice(i, i + 1000),
				removed: removed.slice(i, i + 1000),
			});
	};
}

export class NativeTransactions implements TransactionStore {
	readonly kind = kind;
	commitSample = (sale: Parameters<TransactionStore["commitSample"]>[0]): Promise<CommitResult> =>
		XposNative.commitSample(sale);
	getReceipt = async (clientTxnId: string) => (await XposNative.getReceipt({ clientTxnId })).receipt;
	outboxCounts = async () => (await XposNative.outboxCounts()).counts;
	saveSale = async (sale: NewSale) => {
		try {
			return await XposNative.saveSale(await prepareSale(sale));
		} catch (e) {
			if ((e as { code?: string })?.code === "SALE_CONFLICT") throw new SaleConflictError(sale.txnId);
			throw e;
		}
	};
	getSale = async (txnId: string) => (await XposNative.getSale({ txnId })).sale;
	updateSale = async (txnId: string, patch: SalePatch) =>
		(await XposNative.updateSale({ txnId, ...patch })).sale;
	listSales = async (statuses: SaleStatus[], limit = 100) =>
		(await XposNative.listSales({ statuses, limit })).sales;
}

/** PIN/lease/vault live in Kotlin; only the PIN crosses the bridge, and never leaves the device. */
export class NativeAuth implements AuthService {
	readonly kind = kind;
	constructor(private readonly online: OnlineLogin) {}
	loginOnline = (origin: string, user: string, password: string) =>
		this.online.login(origin, user, password);
	enroll = (info: BootstrapInfo, pin: string) =>
		XposNative.enroll({
			user: info.user,
			site: info.site,
			profile: info.profile,
			currency: info.currency,
			minorDigits: info.minorDigits,
			issuedAt: info.issuedAt,
			leaseTtlSeconds: info.leaseTtlSeconds,
			pin,
		});
	enrolled = async () => (await XposNative.enrolled()).enrolled;
	unlock = async (pin: string): Promise<UnlockResult> => (await XposNative.unlock({ pin })) as UnlockResult;
	lock = () => XposNative.lock();
	leaseStatus = async () => (await XposNative.leaseStatus()).lease;
	signOut = () => XposNative.signOut();
}

/** No synchronisation exists in this milestone, and this class never reports success. */
export class NoSync implements SyncEngine {
	constructor(readonly kind: AdapterKind) {}
	status = async () => ({
		supported: false,
		reason: "Server synchronisation is not implemented in the foundation milestone.",
		pending: 0,
	});
}

export class UnsupportedScanner implements Scanner {
	capabilities = () => [
		{
			kind: "keyboard-wedge" as const,
			supported: true,
			tested: false,
			note: "Handheld scanners that type like a keyboard work through the scan field; no model has been tested.",
		},
		{
			kind: "camera" as const,
			supported: false,
			tested: false,
			note: "Camera scanning is not implemented in this milestone.",
		},
		{
			kind: "vendor-sdk" as const,
			supported: false,
			tested: false,
			note: "Zebra DS2278 / SUNMI scanner SDK adapters are stubs.",
		},
	];
	onScan = () => () => {};
}

export class UnsupportedPrinter implements Printer {
	capabilities = () => [
		{
			kind: "bluetooth-escpos" as const,
			supported: false,
			tested: false,
			note: "Epson TM-P20II Bluetooth printing is not implemented; ESC/POS behaviour differs per model and must be tested.",
		},
		{
			kind: "integrated" as const,
			supported: false,
			tested: false,
			note: "SUNMI V3 PLUS integrated printer SDK adapter is a stub. An integrated printer is not a card-payment terminal.",
		},
		{
			kind: "system-print" as const,
			supported: false,
			tested: false,
			note: "Android print service is not wired in this milestone.",
		},
	];
	print = async () => ({
		printed: false as const,
		reason: "Printing is not implemented in the foundation milestone.",
	});
}
