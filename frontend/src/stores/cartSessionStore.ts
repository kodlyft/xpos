import { defineStore } from "pinia";
import { computed, ref, shallowRef, watch } from "vue";
import { useCartStore, newCartId, splitSerials, type CartSnapshot } from "./cartStore";
import { usePosStore } from "./posStore";
import { scopeKey } from "@/services/sessionScope";
import {
	MAX_CARTS,
	clearRecord,
	createWriter,
	forStorage,
	loadRecord,
	saveRecord,
	type CartRecord,
	type CartStatus,
	type PersistedCart,
} from "@/services/cartPersistence";
import { createCartOwnership, type CartOwnership, type OwnershipState } from "@/services/cartOwnership";
import { findPendingInvoiceByLocalId } from "@/services/dbBridge";
import __ from "@/lib/translate";

export { MAX_CARTS };

interface Session {
	id: string;
	seq: number;
	status: CartStatus;
	/** Held while the cart is in the background. The cart on screen lives in the cart store. */
	snapshot: CartSnapshot | null;
	/** Restored from an earlier run or shift; flagged until the cashier has looked at it. */
	recovered?: boolean;
}

export interface CartTab {
	id: string;
	seq: number;
	label: string;
	hasCustomer: boolean;
	itemCount: number;
	status: CartStatus;
	attention: boolean;
	active: boolean;
}

export interface SwitchResult {
	ok: boolean;
	reason?: string;
}

export interface CloseResult extends SwitchResult {
	needsConfirm?: boolean;
}

function itemCountOf(snapshot: CartSnapshot | null): number {
	return (snapshot?.items ?? []).reduce((sum, item) => sum + Math.abs(item.qty), 0);
}

function lowestFreeSeq(sessions: Session[]): number {
	const used = new Set(sessions.map((s) => s.seq));
	let seq = 1;
	while (used.has(seq)) seq += 1;
	return seq;
}

export const useCartSessionStore = defineStore("cartSessions", () => {
	const cart = useCartStore();
	const posStore = usePosStore();

	// A shallow list: background carts are plain data, not reactive trees.
	const sessions = shallowRef<Session[]>([{ id: cart.cartId, seq: 1, status: "idle", snapshot: null }]);
	const ownership = ref<OwnershipState>("other");
	const persistError = ref("");
	const pendingRecovery = shallowRef<CartRecord | null>(null);

	let scope = "";
	let shift = "";
	let handle: CartOwnership | null = null;
	let stopWatch: (() => void) | null = null;
	let persistenceOn = false;

	const activeId = computed(() => cart.cartId);
	const activeSession = computed(() => sessions.value.find((s) => s.id === cart.cartId));
	const count = computed(() => sessions.value.length);
	const atLimit = computed(() => count.value >= MAX_CARTS);

	function customerLabel(customer: { name: string; customer_name?: string } | null | undefined): string {
		if (!customer) return "";
		if (posStore.defaultCustomer && customer.name === String(posStore.defaultCustomer)) return "";
		return customer.customer_name || customer.name || "";
	}

	const tabs = computed<CartTab[]>(() =>
		sessions.value.map((s) => {
			const active = s.id === cart.cartId;
			const snapshot = active ? null : s.snapshot;
			const customer = active ? cart.customer : snapshot?.customer;
			const name = customerLabel(customer);
			return {
				id: s.id,
				seq: s.seq,
				label: name || __("Cart {0}", [String(s.seq)]),
				hasCustomer: !!name,
				itemCount: active ? cart.itemCount : itemCountOf(snapshot),
				status: s.status,
				attention:
					s.status === "uncertain" ||
					!!s.recovered ||
					(active ? !!cart.repriceReview : !!snapshot?.repriceReview),
				active,
			};
		}),
	);

	const activeIndex = computed(() => sessions.value.findIndex((s) => s.id === cart.cartId));

	/** Why checkout must not go ahead from this window, or "". */
	const submitBlockedReason = computed(() =>
		ownership.value === "lost"
			? __("These carts were taken over by another window. Reload this page before taking payment.")
			: "",
	);

	// ---- other carts' serial and batch claims ---------------------------------------------

	const claims = computed(() => {
		const serials = new Map<string, string>();
		const batches = new Map<string, number>();
		for (const s of sessions.value) {
			if (s.id === cart.cartId || !s.snapshot) continue;
			const label = tabs.value.find((t) => t.id === s.id)?.label ?? "";
			for (const line of s.snapshot.items) {
				for (const serial of splitSerials(line.serial_no)) serials.set(serial, label);
				if (line.batch_no) {
					const key = `${line.item_code}\u0000${line.batch_no}`;
					const qty = Math.abs(line.qty) * (line.conversion_factor || 1);
					batches.set(key, (batches.get(key) ?? 0) + qty);
				}
			}
		}
		return {
			serialCart: (serial: string) => serials.get(serial) ?? "",
			batchQty: (itemCode: string, batchNo: string) => batches.get(`${itemCode}\u0000${batchNo}`) ?? 0,
		};
	});
	cart.setForeignClaims(() => claims.value);

	// ---- persistence ------------------------------------------------------------------------

	function buildRecord(): CartRecord {
		const persisted: PersistedCart[] = sessions.value.map((s) => ({
			id: s.id,
			seq: s.seq,
			status: s.status,
			snapshot: forStorage(s.id === cart.cartId ? cart.snapshot() : (s.snapshot as CartSnapshot)),
		}));
		return {
			v: 1,
			shift,
			activeId: cart.cartId,
			savedAt: new Date().toISOString(),
			sessions: persisted,
		};
	}

	function canWrite(): boolean {
		return persistenceOn && !!scope && ownership.value === "owner" && !pendingRecovery.value;
	}

	async function writeNow(prebuilt?: CartRecord): Promise<void> {
		if (!prebuilt && !canWrite()) return;
		try {
			const record = prebuilt ?? buildRecord();
			const hasWork = record.sessions.some((p) => p.snapshot.items.length || p.status !== "idle");
			if (hasWork) await saveRecord(scope, record);
			else await clearRecord(scope);
			persistError.value = "";
		} catch (error) {
			persistError.value = error instanceof Error ? error.message : String(error);
		}
	}

	const writer = createWriter(() => writeNow());

	function schedulePersist(): void {
		if (persistenceOn) writer.schedule();
	}

	async function flush(): Promise<void> {
		if (persistenceOn) await writer.flush();
	}

	function setSessions(next: Session[]): void {
		sessions.value = next;
		schedulePersist();
	}

	function watchActiveCart(): void {
		stopWatch?.();
		// One cheap string per change; the write itself is debounced.
		stopWatch = watch(
			() =>
				[
					cart.cartId,
					cart.customer?.name ?? "",
					cart.orderNotes,
					cart.discountPercentage,
					cart.discountAmount,
					cart.couponCode,
					cart.isReturnMode,
					cart.currentDraftName,
					cart.items
						.map(
							(i) =>
								`${i.uid}:${i.qty}:${i.rate}:${i.discount_percentage}:${i.discount_amount}:${i.serial_no}:${i.batch_no}`,
						)
						.join("|"),
				].join("~"),
			() => schedulePersist(),
		);
	}

	function onHide(): void {
		if (typeof document !== "undefined" && document.visibilityState === "hidden") void flush();
	}
	function onPageHide(event?: PageTransitionEvent): void {
		// Written now; the lease is let go too unless the page may come back from the back/forward cache.
		void flush().then(() => (event?.persisted ? undefined : handle?.release()));
	}

	// ---- lifecycle --------------------------------------------------------------------------

	function resetToFreshCart(): void {
		cart.startNewCart();
		sessions.value = [{ id: cart.cartId, seq: 1, status: "idle", snapshot: null }];
	}

	/** Stop writing, release ownership. The saved record stays for the next shift or window. */
	async function suspend(): Promise<void> {
		writer.cancel();
		persistenceOn = false;
		stopWatch?.();
		stopWatch = null;
		if (typeof document !== "undefined") {
			document.removeEventListener("visibilitychange", onHide);
			window.removeEventListener("pagehide", onPageHide);
		}
		await handle?.release();
		handle = null;
		ownership.value = "other";
		scope = "";
		shift = "";
		pendingRecovery.value = null;
	}

	function hasWork(s: Session): boolean {
		return s.id === cart.cartId ? !cart.isEmpty : (s.snapshot?.items.length ?? 0) > 0;
	}

	/** Bring a stored record back, next to whatever is already open. Never evicts a cart. */
	function restore(record: CartRecord, flag: boolean): void {
		const liveHasWork = !cart.isEmpty;
		const mine = sessions.value.filter((s) => s.id === cart.cartId);
		const merged: Session[] = liveHasWork ? mine.map((s) => ({ ...s })) : [];
		const existing = new Set([cart.cartId]);
		for (const entry of record.sessions) {
			if (existing.has(entry.id) || (!entry.snapshot.items.length && entry.status === "idle")) continue;
			existing.add(entry.id);
			merged.push({
				id: entry.id,
				seq: lowestFreeSeq(merged),
				status: entry.status,
				snapshot: entry.snapshot,
				recovered: flag || entry.status !== "idle",
			});
		}
		if (liveHasWork) {
			setSessions(merged);
			return;
		}
		if (!merged.length) return;
		const target = merged.find((s) => s.id === record.activeId) ?? merged[0];
		const snap = target.snapshot as CartSnapshot;
		target.snapshot = null;
		cart.hydrate(snap);
		setSessions(merged);
	}

	/** After a reload an interrupted sale is either safely queued or of unknown outcome. */
	async function reconcile(): Promise<void> {
		const queued: string[] = [];
		const unknown: string[] = [];
		for (const s of sessions.value) {
			if (s.status === "idle") continue;
			const localId = s.id === cart.cartId ? cart.currentLocalId() : s.snapshot?.localId;
			let inQueue = false;
			try {
				inQueue = !!localId && !!(await findPendingInvoiceByLocalId(localId));
			} catch {
				inQueue = false;
			}
			if (inQueue) queued.push(s.id);
			else if (s.status === "submitting") unknown.push(s.id);
		}
		if (unknown.length) {
			setSessions(
				sessions.value.map((x) =>
					unknown.includes(x.id) ? { ...x, status: "uncertain" as CartStatus } : x,
				),
			);
		}
		// The durable journal owns a queued sale now; it must not stay editable here.
		for (const id of queued) drop(id);
	}

	async function activateNow(options: { takeOver?: boolean } = {}): Promise<void> {
		const key = scopeKey();
		if (!key) return;
		if (scope && scope !== key) {
			await flush();
			await suspend();
			resetToFreshCart();
		}
		if (scope === key && ownership.value === "owner" && !options.takeOver) return;

		scope = key;
		shift = posStore.posOpeningShift?.name ?? "";
		handle?.release();
		handle = createCartOwnership(key);
		handle.onLost(() => {
			ownership.value = "lost";
			writer.cancel();
			persistenceOn = false;
		});
		ownership.value = options.takeOver ? await handle.takeOver() : await handle.acquire();
		if (ownership.value !== "owner") return;

		let record: CartRecord | null = null;
		try {
			record = await loadRecord(key, shift);
		} catch (error) {
			persistError.value = error instanceof Error ? error.message : String(error);
		}
		if (record && !record.sessions.some((p) => p.snapshot.items.length || p.status !== "idle"))
			record = null;
		if (record) {
			if (record.shift && shift && record.shift !== shift) pendingRecovery.value = record;
			else restore(record, false);
		}
		await reconcile();

		persistenceOn = true;
		watchActiveCart();
		if (typeof document !== "undefined") {
			document.addEventListener("visibilitychange", onHide);
			window.addEventListener("pagehide", onPageHide);
		}
		if (!pendingRecovery.value) schedulePersist();
	}

	// Activation, take-over and shift end must not interleave: each one starts from the other's result.
	let chain: Promise<unknown> = Promise.resolve();
	function serial<T>(work: () => Promise<T>): Promise<T> {
		const run = chain.then(work, work);
		chain = run.catch(() => {});
		return run;
	}

	function activate(options: { takeOver?: boolean } = {}): Promise<void> {
		return serial(() => activateNow(options));
	}

	/** Called whenever shift, profile or user may have changed. */
	function sync(ready: boolean): Promise<void> {
		return ready ? activate() : onShiftEnded();
	}

	/**
	 * The shift ended or was lost. Unfinished carts are written first so the next shift can offer
	 * them back; the caller then clears the screen.
	 */
	function onShiftEnded(): Promise<void> {
		// The record is built now, before the caller clears the screen; the write and teardown follow.
		const record = canWrite() ? buildRecord() : undefined;
		return serial(() => onShiftEndedNow(record));
	}

	async function onShiftEndedNow(record?: CartRecord): Promise<void> {
		if (!scope) return;
		if (record) {
			writer.cancel();
			await writeNow(record);
		}
		await suspend();
		sessions.value = [{ id: cart.cartId, seq: 1, status: "idle", snapshot: null }];
	}

	function recoverPrevious(): void {
		const record = pendingRecovery.value;
		if (!record) return;
		pendingRecovery.value = null;
		restore(record, true);
		void reconcile();
		schedulePersist();
	}

	async function discardPrevious(): Promise<void> {
		pendingRecovery.value = null;
		if (scope) await clearRecord(scope).catch(() => {});
		schedulePersist();
	}

	function takeOver(): Promise<void> {
		return activate({ takeOver: true });
	}

	/** Anything that stops the shift from closing, or "". */
	function shiftCloseBlocker(): string {
		const stuck = sessions.value.find((s) => s.status !== "idle");
		return stuck
			? __("A payment on {0} has not been confirmed. Finish or recover it before closing the shift.", [
					tabs.value.find((t) => t.id === stuck.id)?.label ?? "",
				])
			: "";
	}

	function unfinishedCount(): number {
		return sessions.value.filter(hasWork).length;
	}

	// ---- switching --------------------------------------------------------------------------

	function guard(force = false): SwitchResult {
		if (force) return { ok: true };
		if (cart.showPaymentDialog) return { ok: false, reason: __("Close the payment window first.") };
		if (activeSession.value?.status === "submitting")
			return { ok: false, reason: __("A payment is being saved. Wait for it to finish.") };
		return { ok: true };
	}

	function focusSearch(): void {
		if (typeof window === "undefined") return;
		// On a touch screen, focusing the field would raise the on-screen keyboard over the cart.
		if (window.matchMedia?.("(pointer: coarse)").matches) return;
		requestAnimationFrame(() => {
			// Never pull focus out of an open dialog.
			if (document.querySelector('[role="dialog"][data-state="open"]')) return;
			window.dispatchEvent(new CustomEvent("xpos:focus-search"));
		});
	}

	function parkActive(): void {
		const current = activeSession.value;
		if (current) current.snapshot = cart.snapshot();
	}

	function switchTo(id: string, options: { force?: boolean; focus?: boolean } = {}): SwitchResult {
		if (id === cart.cartId) return { ok: true };
		const target = sessions.value.find((s) => s.id === id);
		if (!target?.snapshot) return { ok: false, reason: __("That cart is no longer open.") };
		const allowed = guard(options.force);
		if (!allowed.ok) return allowed;

		parkActive();
		const snap = target.snapshot;
		target.snapshot = null;
		target.recovered = false;
		cart.hydrate(snap);
		setSessions([...sessions.value]);
		if (options.focus !== false) focusSearch();
		return { ok: true };
	}

	function step(direction: 1 | -1): SwitchResult {
		const list = sessions.value;
		if (list.length < 2) return { ok: true };
		const from = Math.max(0, activeIndex.value);
		const next = list[(from + direction + list.length) % list.length];
		return switchTo(next.id);
	}

	function next(): SwitchResult {
		return step(1);
	}
	function prev(): SwitchResult {
		return step(-1);
	}

	function create(options: { force?: boolean } = {}): SwitchResult & { id?: string } {
		if (atLimit.value) {
			return {
				ok: false,
				reason: __("{0} carts are open, the most this screen keeps. Finish or close one first.", [
					String(MAX_CARTS),
				]),
			};
		}
		const allowed = guard(options.force);
		if (!allowed.ok) return allowed;

		parkActive();
		const id = newCartId();
		const session: Session = { id, seq: lowestFreeSeq(sessions.value), status: "idle", snapshot: null };
		cart.startNewCart(id);
		setSessions([...sessions.value, session]);
		focusSearch();
		return { ok: true, id };
	}

	// ---- closing and finishing --------------------------------------------------------------

	function canDiscard(id: string): SwitchResult {
		const s = sessions.value.find((x) => x.id === id);
		if (!s) return { ok: false, reason: __("That cart is no longer open.") };
		if (s.status === "submitting")
			return { ok: false, reason: __("A payment is being saved. Wait for it to finish.") };
		if (s.status === "uncertain")
			return {
				ok: false,
				reason: __(
					"This sale's payment is not confirmed yet. Press Pay to finish it; it will not be charged twice.",
				),
			};
		return { ok: true };
	}

	/** Remove a cart from the list and, if it was on screen, show its neighbour or a fresh cart. */
	function drop(id: string): void {
		const list = sessions.value;
		const index = list.findIndex((s) => s.id === id);
		if (index < 0) return;
		const rest = list.filter((s) => s.id !== id);
		if (id !== cart.cartId) {
			setSessions(rest);
			return;
		}
		if (!rest.length) {
			cart.clearAll();
			setSessions([{ id: cart.cartId, seq: 1, status: "idle", snapshot: null }]);
			return;
		}
		const neighbour = rest[Math.max(0, index - 1)];
		const snap = neighbour.snapshot as CartSnapshot;
		neighbour.snapshot = null;
		neighbour.recovered = false;
		cart.hydrate(snap);
		setSessions(rest);
		focusSearch();
	}

	function close(id: string, options: { confirmed?: boolean } = {}): CloseResult {
		const allowed = canDiscard(id);
		if (!allowed.ok) return allowed;
		const session = sessions.value.find((s) => s.id === id)!;
		if (hasWork(session) && !options.confirmed) return { ok: false, needsConfirm: true };

		if (sessions.value.length === 1) {
			if (hasWork(session)) cart.clearAll();
			schedulePersist();
			return { ok: true };
		}
		drop(id);
		return { ok: true };
	}

	/**
	 * A sale (or hold) for this cart finished. `localId` is the sale identity the caller submitted;
	 * if the cart has since become a different sale, it is left alone.
	 */
	function finish(ref: { cartId: string; localId?: string }): boolean {
		const session = sessions.value.find((s) => s.id === ref.cartId);
		if (!session) return false;
		if (ref.localId !== undefined) {
			const current =
				session.id === cart.cartId ? cart.currentLocalId() : (session.snapshot?.localId ?? "");
			if (current !== ref.localId) return false;
		}
		session.status = "idle";
		if (sessions.value.length > 1) drop(session.id);
		else {
			cart.clearAll();
			setSessions([{ ...session, snapshot: null }]);
		}
		return true;
	}

	function beginSubmit(cartId: string): void {
		const s = sessions.value.find((x) => x.id === cartId);
		if (!s) return;
		s.status = "submitting";
		setSessions([...sessions.value]);
		void flush();
	}

	function endSubmit(cartId: string, outcome: "idle" | "uncertain" = "idle"): void {
		const s = sessions.value.find((x) => x.id === cartId);
		if (!s || s.status === outcome) return;
		s.status = outcome;
		setSessions([...sessions.value]);
		void flush();
	}

	/** Change a cart that may be in the background: the live cart, or its stored copy. */
	function applyToCart(cartId: string, edit: (snapshot: CartSnapshot) => void): boolean {
		const s = sessions.value.find((x) => x.id === cartId);
		if (!s?.snapshot) return false;
		edit(s.snapshot);
		setSessions([...sessions.value]);
		return true;
	}

	/** The open cart already holding this held order, if any. */
	function findByDraft(draftName: string): string {
		if (!draftName) return "";
		if (cart.currentDraftName === draftName) return cart.cartId;
		return sessions.value.find((s) => s.snapshot?.currentDraftName === draftName)?.id ?? "";
	}

	/**
	 * Where to load an incoming order (a recalled hold, a return, an order or a repeat sale):
	 * the cart on screen if it is empty, otherwise a new cart. Never over a cart with work in it.
	 */
	function prepareForLoad(): SwitchResult & { id?: string } {
		if (cart.isEmpty && !cart.currentDraftName && !cart.isReturnMode) return { ok: true };
		return create();
	}

	/**
	 * Run a loader that replaces the cart's contents (recall, return, repeat, order) on a cart that
	 * has nothing in it. A cart opened just for it is closed again if the load fails.
	 */
	async function loadIntoCart(
		load: () => boolean | void | Promise<boolean | void>,
	): Promise<SwitchResult & { loaded?: boolean }> {
		const prep = prepareForLoad();
		if (!prep.ok) return prep;
		let loaded = false;
		try {
			loaded = (await load()) !== false;
		} finally {
			if (!loaded && prep.id && prep.id === cart.cartId && cart.isEmpty) close(prep.id);
		}
		return { ok: loaded, loaded };
	}

	return {
		sessions,
		tabs,
		activeId,
		activeIndex,
		count,
		atLimit,
		ownership,
		persistError,
		pendingRecovery,
		submitBlockedReason,
		sync,
		activate,
		takeOver,
		onShiftEnded,
		recoverPrevious,
		discardPrevious,
		shiftCloseBlocker,
		unfinishedCount,
		switchTo,
		next,
		prev,
		create,
		close,
		canDiscard,
		finish,
		beginSubmit,
		endSubmit,
		applyToCart,
		findByDraft,
		prepareForLoad,
		loadIntoCart,
		flush,
		focusSearch,
	};
});
