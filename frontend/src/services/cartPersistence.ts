import { deleteMeta, getMeta, setMeta } from "./idbService";
import type { CartSnapshot } from "@/stores/cartStore";

export const RECORD_VERSION = 1;
export const MAX_CARTS = 8;

export type CartStatus = "idle" | "submitting" | "uncertain";

export interface PersistedCart {
	id: string;
	seq: number;
	status: CartStatus;
	snapshot: CartSnapshot;
}

export interface CartRecord {
	v: typeof RECORD_VERSION;
	shift: string;
	activeId: string;
	savedAt: string;
	sessions: PersistedCart[];
}

export function cartRecordKey(scope: string): string {
	return `xpos-carts:${scope}`;
}

export function emptySnapshot(cartId: string): CartSnapshot {
	return {
		v: 1,
		cartId,
		localId: "",
		pricingDirty: false,
		items: [],
		selectedCartIndex: -1,
		customer: null,
		discountPercentage: 0,
		discountAmount: 0,
		ruleDiscountPercentage: 0,
		ruleDiscountAmount: 0,
		customerDiscountPercentage: 0,
		applyDiscountOn: "Grand Total",
		appliedOffers: [],
		appliedCoupon: null,
		couponCode: "",
		redeemLoyaltyPoints: false,
		loyaltyPoints: 0,
		loyaltyAmount: 0,
		orderNotes: "",
		deliveryDate: "",
		postingDate: "",
		salesPerson: "",
		writeOffAmount: 0,
		selectedDeliveryCharge: null,
		currency: "",
		conversionRate: 1,
		isReturnMode: false,
		returnAgainst: "",
		returnItemCodes: [],
		returnGiftCards: [],
		giftCardTender: false,
		sourceOrder: null,
		sourceQuotation: "",
		currentDraftName: "",
		currentDraftModified: "",
		payments: [],
		changeLegs: [],
		changeAmount: 0,
		effectivePriceList: "",
		pricingSource: "server",
		repriceReview: null,
		offerConflict: false,
	};
}

/** Payment drafts are never written to disk: tender references and amounts are re-entered at checkout. */
export function forStorage(snapshot: CartSnapshot): CartSnapshot {
	return { ...snapshot, payments: [], changeLegs: [], changeAmount: 0 };
}

function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Fill whatever a stored snapshot lacks, so records from an older build still open. */
export function normalizeSnapshot(raw: unknown, fallbackId: string): CartSnapshot | null {
	if (!isObject(raw) || !Array.isArray(raw.items)) return null;
	const base = emptySnapshot(typeof raw.cartId === "string" && raw.cartId ? raw.cartId : fallbackId);
	const merged = { ...base, ...raw, v: 1 } as CartSnapshot;
	merged.items = raw.items as CartSnapshot["items"];
	return merged;
}

/**
 * Read a stored record. Accepts the current format, and the single-cart format
 * (`{ items, customer, ... }`) that predates cart tabs, which becomes one open cart.
 */
export function parseRecord(raw: unknown, shift = ""): CartRecord | null {
	let value: unknown = raw;
	if (typeof raw === "string") {
		try {
			value = JSON.parse(raw);
		} catch {
			return null;
		}
	}
	if (!isObject(value)) return null;

	if (Array.isArray(value.sessions)) {
		if (value.v !== RECORD_VERSION) return null;
		const sessions: PersistedCart[] = [];
		const seen = new Set<string>();
		for (const entry of value.sessions) {
			if (!isObject(entry) || typeof entry.id !== "string" || seen.has(entry.id)) continue;
			const snapshot = normalizeSnapshot(entry.snapshot, entry.id);
			if (!snapshot) continue;
			snapshot.cartId = entry.id;
			seen.add(entry.id);
			sessions.push({
				id: entry.id,
				seq: Number(entry.seq) > 0 ? Number(entry.seq) : sessions.length + 1,
				status: entry.status === "submitting" || entry.status === "uncertain" ? entry.status : "idle",
				snapshot,
			});
		}
		if (!sessions.length) return null;
		const activeId =
			typeof value.activeId === "string" && seen.has(value.activeId) ? value.activeId : sessions[0].id;
		return {
			v: RECORD_VERSION,
			shift: typeof value.shift === "string" ? value.shift : "",
			activeId,
			savedAt: typeof value.savedAt === "string" ? value.savedAt : "",
			sessions,
		};
	}

	const legacy = normalizeSnapshot(value, `cart_legacy_${Date.now().toString(36)}`);
	if (!legacy) return null;
	return {
		v: RECORD_VERSION,
		shift,
		activeId: legacy.cartId,
		savedAt: "",
		sessions: [{ id: legacy.cartId, seq: 1, status: "idle", snapshot: legacy }],
	};
}

export async function loadRecord(scope: string, shift = ""): Promise<CartRecord | null> {
	return parseRecord(await getMeta(cartRecordKey(scope)), shift);
}

export async function saveRecord(scope: string, record: CartRecord): Promise<void> {
	await setMeta(cartRecordKey(scope), JSON.stringify(record));
}

export async function clearRecord(scope: string): Promise<void> {
	await deleteMeta(cartRecordKey(scope));
}

/**
 * One trailing write per quiet period, never overlapping. Scanning fires hundreds of changes;
 * this turns them into a bounded number of writes.
 */
export function createWriter(write: () => Promise<void>, wait = 800) {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let running: Promise<void> = Promise.resolve();
	let dirty = false;

	function run(): Promise<void> {
		timer = null;
		dirty = false;
		running = running.then(write);
		return running;
	}

	return {
		schedule(): void {
			dirty = true;
			if (timer) return;
			timer = setTimeout(() => void run().catch(() => {}), wait);
		},
		/** Write now if anything changed since the last write, and wait for it. */
		async flush(): Promise<void> {
			if (timer) clearTimeout(timer);
			timer = null;
			if (dirty) await run();
			else await running;
		},
		cancel(): void {
			if (timer) clearTimeout(timer);
			timer = null;
			dirty = false;
		},
		get pending(): boolean {
			return dirty;
		},
	};
}
