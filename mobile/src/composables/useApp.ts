import { reactive, readonly } from "vue";
import type {
	BootstrapInfo,
	Enrolled,
	GiftCardConfig,
	Lifecycle,
	PaymentMode,
	ProfileChoice,
} from "@mobile/ports";
import { createContainer, NotAndroidError, type Container } from "@mobile/app/container";
import { createLifecycle } from "@mobile/app/lifecycle";
import { CatalogSyncError, syncCatalog, type SyncMeta } from "@mobile/app/catalogSync";
import { drainPending } from "@mobile/app/checkout";
import { OfflineError, SessionExpiredError } from "@mobile/adapters/frappeHttp";
import { fetchBootstrap } from "@mobile/adapters/onlineLogin";
import { useCart } from "./useCart";
import { resetSaleCustomer } from "./saleCustomer";

export type Phase =
	| "booting"
	| "unsupported"
	| "setup"
	| "login"
	| "profile"
	| "enroll"
	| "locked"
	| "unlocked";
export type Tab = "sell" | "sales" | "account" | "diagnostics";

const ORIGIN_KEY = "xpos-mobile-origin";
/** The origin is not a secret; it is the one thing remembered about the server (never the WebView host). */
function loadOrigin(): string | null {
	try {
		return localStorage.getItem(ORIGIN_KEY);
	} catch {
		return null;
	}
}
function saveOrigin(o: string | null) {
	try {
		if (o) localStorage.setItem(ORIGIN_KEY, o);
		else localStorage.removeItem(ORIGIN_KEY);
	} catch {
		/* preference only */
	}
}

export const AUTO_LOCK_MS = 30_000;
/** A catalog older than this is refreshed on unlock when the server is reachable. */
export const CATALOG_STALE_MS = 60 * 60 * 1000;

/** Server-provided selling context for the signed-in profile, cached so a locked/offline start still has it. */
export interface SellContext {
	profiles: ProfileChoice[];
	paymentModes: PaymentMode[];
	customer: string | null;
	openShift: string | null;
	priceList: string | null;
	company: string;
	warehouse: string;
	erpnextVersion: string | null;
	frappeVersion: string;
	permissions: Record<string, boolean>;
	fullName: string | null;
	customerName: string | null;
	canCreateCustomer: boolean;
	canEditCustomer: boolean;
	giftCards: GiftCardConfig | null;
}

const emptyContext = (): SellContext => ({
	profiles: [],
	paymentModes: [],
	customer: null,
	openShift: null,
	priceList: null,
	company: "",
	warehouse: "",
	erpnextVersion: null,
	frappeVersion: "",
	permissions: {},
	fullName: null,
	customerName: null,
	canCreateCustomer: false,
	canEditCustomer: false,
	giftCards: null,
});

const ctxKey = (scopeId: string) => `xpos-mobile-ctx:${scopeId}`;
const lsGet = (k: string): string | null => {
	try {
		return localStorage.getItem(k);
	} catch {
		return null;
	}
};
const lsSet = (k: string, v: string | null) => {
	try {
		if (v === null) localStorage.removeItem(k);
		else localStorage.setItem(k, v);
	} catch {
		/* informational / cache only */
	}
};
/** Delta cursors and sync times: not secret, safe to lose (the next refresh is then a full download). */
const syncMeta: SyncMeta = {
	get: (k) => lsGet(`xpos-mobile-sync:${k}`),
	set: (k, v) => lsSet(`xpos-mobile-sync:${k}`, v),
};

export interface CatalogStatus {
	scopeId: string;
	/** A usable catalog is on the device (it keeps working offline). */
	ready: boolean;
	items: number;
	syncing: boolean;
	downloaded: number;
	total: number;
	message: string;
	syncedAt: number | null;
	skippedBarcodes: number;
	unpriced: number | null;
	lastMode: "full" | "delta" | null;
}

const emptyCatalog = (): CatalogStatus => ({
	scopeId: "",
	ready: false,
	items: 0,
	syncing: false,
	downloaded: 0,
	total: 0,
	message: "",
	syncedAt: null,
	skippedBarcodes: 0,
	unpriced: null,
	lastMode: null,
});

const state = reactive({
	phase: "booting" as Phase,
	tab: "sell" as Tab,
	origin: loadOrigin(),
	pending: null as BootstrapInfo | null,
	cashier: null as Enrolled | null,
	lockReason: "",
	catalog: emptyCatalog(),
	context: emptyContext(),
	kind: "native" as "native" | "web-dev",
	online: true,
	sessionExpired: false,
	salesTick: 0,
});

let container: Container;
let lifecycle: Lifecycle;
let hiddenAt = 0;

export function getContainer(): Container {
	return (container ??= createContainer());
}
export function getLifecycle(): Lifecycle {
	return (lifecycle ??= createLifecycle());
}

/** One scope per cashier, profile and server: the catalog depends on the user's permissions and profile. */
export function scopeIdFor(e: Enrolled): string {
	return `real:${e.user}|${e.profile}@${new URL(e.site).host}`;
}

export function bumpSales(): void {
	state.salesTick++;
}

/** Opens a POS shift on the server (online, as the signed-in cashier) with the counted opening amounts. */
export async function openShift(openingMinor: Record<string, number>): Promise<void> {
	const e = state.cashier;
	if (!e) return;
	const c = getContainer();
	const api = await c.session(e.site);
	const dec = (m: number) => m / 10 ** e.minorDigits;
	try {
		const r = await api.call<{ pos_opening_shift?: { name?: string } }>("xpos.api.shifts.open_shift", {
			pos_profile: e.profile,
			company: state.context.company,
			balance_details: JSON.stringify(
				state.context.paymentModes.map((m) => ({
					mode_of_payment: m.mode_of_payment,
					opening_amount: dec(openingMinor[m.mode_of_payment] ?? 0),
				})),
			),
		});
		const name = r.pos_opening_shift?.name;
		if (!name) throw new Error("The server did not return the opened shift.");
		state.context.openShift = name;
		lsSet(ctxKey(scopeIdFor(e)), JSON.stringify(state.context));
	} catch (err) {
		if (err instanceof SessionExpiredError) state.sessionExpired = true;
		throw err;
	}
}

/** Called from screens when a server call reports an expired session. */
export function markSessionExpired(): void {
	state.sessionExpired = true;
}

export async function boot(): Promise<void> {
	let c: Container;
	try {
		c = getContainer();
	} catch (e) {
		if (e instanceof NotAndroidError) {
			state.phase = "unsupported";
			return;
		}
		throw e;
	}
	state.kind = c.kind;
	const lc = getLifecycle();
	state.online = lc.isOnline();
	lc.onBackground(() => {
		hiddenAt = Date.now();
	});
	lc.onForeground(() => {
		if (state.phase === "unlocked" && hiddenAt && Date.now() - hiddenAt >= AUTO_LOCK_MS)
			void lock("Locked after the app was in the background");
		else if (state.phase === "unlocked") void settlePending();
		hiddenAt = 0;
	});
	lc.onConnectivity((on) => {
		state.online = on;
		if (on && state.phase === "unlocked") void reconnect();
	});
	const enrolled = await c.auth.enrolled();
	state.cashier = enrolled;
	state.phase = enrolled ? "locked" : "setup";
}

function loadContext(scopeId: string): SellContext {
	try {
		return { ...emptyContext(), ...JSON.parse(lsGet(ctxKey(scopeId)) ?? "{}") };
	} catch {
		return emptyContext();
	}
}

function applyBootstrap(scopeId: string, b: BootstrapInfo): void {
	state.context = {
		profiles: b.profiles,
		paymentModes: b.paymentModes,
		customer: b.customer,
		openShift: b.openShift,
		priceList: b.priceList,
		company: b.company,
		warehouse: b.warehouse,
		erpnextVersion: b.erpnextVersion,
		frappeVersion: b.frappeVersion,
		permissions: b.permissions,
		fullName: b.fullName,
		customerName: b.customerName,
		canCreateCustomer: b.canCreateCustomer,
		canEditCustomer: b.canEditCustomer,
		giftCards: b.giftCards,
	};
	lsSet(ctxKey(scopeId), JSON.stringify(state.context));
}

export async function refreshContext(): Promise<void> {
	const e = state.cashier;
	if (!e) return;
	const scopeId = scopeIdFor(e);
	try {
		const c = getContainer();
		const t = await c.session(e.site);
		applyBootstrap(scopeId, await fetchBootstrap(t, e.site, e.profile));
	} catch (err) {
		if (err instanceof SessionExpiredError) state.sessionExpired = true;
		else if (!(err instanceof OfflineError))
			state.catalog.message ||= "The sale settings could not be refreshed from the server.";
	}
}

/** Reads what is on the device; refreshes from the server when there is none or it is stale (and we are online). */
export async function startCatalog(): Promise<void> {
	const e = state.cashier;
	if (!e) return;
	const scopeId = scopeIdFor(e);
	const c = getContainer();
	const cat = state.catalog;
	if (cat.scopeId !== scopeId) Object.assign(cat, emptyCatalog(), { scopeId });
	state.context = loadContext(scopeId);
	const mine = (await c.catalog.listScopes()).find((s) => s.scopeId === scopeId);
	if (mine?.activeGen != null) {
		cat.ready = true;
		cat.items = (await c.catalog.stats(scopeId)).items;
		const at = Number(syncMeta.get(`at:${scopeId}`));
		cat.syncedAt = at > 0 ? at : null;
	}
	if (getLifecycle().isOnline()) {
		await refreshContext();
		const stale = !cat.syncedAt || Date.now() - cat.syncedAt > CATALOG_STALE_MS;
		if (!cat.ready || stale) await refreshCatalog();
		await settlePending();
	} else if (!cat.ready)
		cat.message = "No catalog on this device yet. Connect to the server to download it.";
}

export async function reconnect(): Promise<void> {
	await refreshContext();
	await refreshCatalog();
	await settlePending();
}

export async function settlePending(): Promise<void> {
	const e = state.cashier;
	if (!e || !getLifecycle().isOnline() || state.sessionExpired) return;
	try {
		const c = getContainer();
		const api = await c.session(e.site);
		await drainPending(c.transactions, api, scopeIdFor(e));
	} catch (err) {
		if (err instanceof SessionExpiredError) state.sessionExpired = true;
	} finally {
		state.salesTick++;
	}
}

export async function refreshCatalog(): Promise<void> {
	const e = state.cashier;
	const cat = state.catalog;
	if (!e || cat.syncing) return;
	const c = getContainer();
	cat.syncing = true;
	cat.message = "";
	cat.downloaded = 0;
	try {
		const api = await c.session(e.site);
		const r = await syncCatalog({
			api,
			repo: c.catalog,
			meta: syncMeta,
			scopeId: cat.scopeId,
			site: e.site,
			profile: e.profile,
			minorDigits: e.minorDigits,
			onProgress: (p) => Object.assign(cat, { downloaded: p.downloaded, total: p.total }),
		});
		cat.ready = true;
		cat.items = r.items;
		cat.skippedBarcodes = r.mode === "full" ? r.skippedBarcodes : cat.skippedBarcodes;
		cat.unpriced = r.unpriced;
		cat.lastMode = r.mode;
		cat.syncedAt = Date.now();
		syncMeta.set(`at:${cat.scopeId}`, String(cat.syncedAt));
	} catch (err) {
		const have = cat.ready ? " The catalog from the last update is still available." : "";
		if (err instanceof SessionExpiredError) state.sessionExpired = true;
		cat.message =
			err instanceof OfflineError
				? "The server cannot be reached." + have
				: err instanceof SessionExpiredError
					? "Your server session has expired. Sign in again to update the catalog." + have
					: err instanceof CatalogSyncError
						? err.message + have
						: "The catalog could not be updated." + have;
	} finally {
		cat.syncing = false;
	}
}

export async function reSignIn(password: string): Promise<void> {
	const e = state.cashier;
	if (!e) throw new Error("not signed in");
	await getContainer().auth.loginOnline(e.site, e.user, password);
	state.sessionExpired = false;
	await refreshContext();
	await refreshCatalog();
	await settlePending();
}

export async function lock(reason = ""): Promise<void> {
	await getContainer().auth.lock();
	state.lockReason = reason;
	state.phase = "locked";
}

export function setOrigin(origin: string): void {
	state.origin = origin;
	saveOrigin(origin);
	state.phase = "login";
}
export function changeServer(): void {
	state.phase = "setup";
}
export function loggedIn(info: BootstrapInfo): void {
	state.pending = info;
	state.phase = info.profiles.length > 1 ? "profile" : "enroll";
}

export async function chooseProfile(name: string): Promise<void> {
	const p = state.pending;
	if (!p) return;
	if (name !== p.profile) {
		const t = await getContainer().session(p.site);
		state.pending = await fetchBootstrap(t, p.site, name);
	}
	state.phase = "enroll";
}
/** A new user or profile starts with an empty sale: nothing of the previous one's cart, customer or choices carries over. */
function clearSale(): void {
	useCart().clear();
	resetSaleCustomer();
}

/** Asks for the same user's other POS Profile; the cashier then sets the unlock PIN for it. Sales waiting under the old one stay on the device. */
export async function switchProfile(name: string): Promise<void> {
	const e = state.cashier;
	if (!e || name === e.profile) return;
	const t = await getContainer().session(e.site);
	state.pending = await fetchBootstrap(t, e.site, name);
	state.phase = "enroll";
}

export async function enrolled(): Promise<void> {
	clearSale();
	state.cashier = await getContainer().auth.enrolled();
	if (state.cashier && state.pending) applyBootstrap(scopeIdFor(state.cashier), state.pending);
	state.pending = null;
	state.phase = "unlocked";
	await startCatalog();
}
export async function unlocked(): Promise<void> {
	state.lockReason = "";
	state.phase = "unlocked";
	await startCatalog();
}
export async function signOut(): Promise<void> {
	await getContainer().auth.signOut();
	clearSale();
	state.cashier = null;
	state.catalog = emptyCatalog();
	state.context = emptyContext();
	state.sessionExpired = false;
	state.phase = "setup";
}
export function selectTab(t: Tab) {
	state.tab = t;
}

export const useApp = () => ({ state: readonly(state) });
