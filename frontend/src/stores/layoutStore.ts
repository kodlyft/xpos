import { defineStore } from "pinia";
import { computed, ref } from "vue";

import { call } from "@/services/api";
import { getCachedItemByCode, getSyncMeta, setSyncMeta } from "@/services/dbBridge";
import {
	builtinLayout,
	defaultPolicy,
	deviceClassFor,
	effectiveLayout,
	emptyPersonal,
	layoutCacheKey,
	migrate,
	personalFromEdit,
	sanitize,
	type DeviceClass,
	type Layout,
	type LayoutPolicy,
	type PersonalLayout,
} from "@/services/posLayout";
import { isNetworkError, isOnline } from "@/utils";
import type { POSItem } from "@/types/pos.types";

export interface LayoutPayload {
	pos_profile: string;
	company: string;
	revision: number;
	recovered: boolean;
	policy: LayoutPolicy;
	defaults: Layout;
	personal: PersonalLayout;
	layout: Layout;
}

interface SaveResult extends LayoutPayload {
	status: "saved" | "conflict" | "reset";
}

interface Pending {
	personal: PersonalLayout;
	baseRevision: number;
	reset: boolean;
}

export interface Scope {
	user: string;
	company: string;
	profile: string;
}

const AUTOSAVE_NOTE = "xpos-layout";

interface Ctx {
	epoch: number;
	target: Scope;
	key: string;
}

function host(): string {
	return typeof location !== "undefined" ? location.host : "";
}

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value));
}

export const useLayoutStore = defineStore("layout", () => {
	const scope = ref<Scope | null>(null);
	const payload = ref<LayoutPayload | null>(null);
	const draft = ref<Layout | null>(null);
	const customizing = ref(false);
	const deviceClass = ref<DeviceClass>(
		deviceClassFor(typeof window !== "undefined" ? window.innerWidth : 1280),
	);
	const pending = ref<Pending | null>(null);
	const conflict = ref<LayoutPayload | null>(null);
	const saving = ref(false);
	const error = ref("");
	const recovered = ref(false);
	const pinnedItems = ref<POSItem[]>([]);
	const itemInfo = ref<Record<string, POSItem>>({});
	let loadToken = 0;

	const policy = computed<LayoutPolicy>(() => payload.value?.policy ?? defaultPolicy());
	const defaults = computed<Layout>(() => payload.value?.defaults ?? builtinLayout());
	const personal = computed<PersonalLayout>(() => payload.value?.personal ?? emptyPersonal());
	const saved = computed<Layout>(() => payload.value?.layout ?? builtinLayout());
	/** What the screen shows: the draft while customizing (live preview), else the saved layout. */
	const layout = computed<Layout>(() => (customizing.value && draft.value ? draft.value : saved.value));
	const shared = computed(() => layout.value.shared);
	const device = computed(() => layout.value.device[deviceClass.value]);
	const canCustomize = computed(() => policy.value.allow_customization && !!scope.value);
	const pendingSync = computed(() => pending.value !== null);
	const dirty = computed(
		() =>
			customizing.value && !!draft.value && JSON.stringify(draft.value) !== JSON.stringify(saved.value),
	);

	function cacheKey(target: Scope | null = scope.value): string {
		return target ? layoutCacheKey(host(), target.user, target.company, target.profile) : "";
	}

	function ctx(): Ctx | null {
		return scope.value ? { epoch: loadToken, target: scope.value, key: cacheKey() } : null;
	}

	/** False once the user, company or profile has changed since ``c`` was captured. */
	function isCurrent(c: Ctx): boolean {
		return c.epoch === loadToken;
	}

	/** Operations on the layout run one at a time, in the order they were asked for. */
	let chain: Promise<unknown> = Promise.resolve();
	let inflight = 0;

	function enqueue<T>(task: () => Promise<T>): Promise<T> {
		inflight++;
		saving.value = true;
		const run = chain.then(task, task);
		chain = run.then(
			() => undefined,
			() => undefined,
		);
		return run.finally(() => {
			if (--inflight === 0) saving.value = false;
		});
	}

	/** Write a scope's cache entry; each field is only touched when given. */
	async function persist(
		key: string,
		next: { payload?: LayoutPayload | null; pending?: Pending | null },
	): Promise<void> {
		if (!key) return;
		try {
			if (next.payload !== undefined) {
				await setSyncMeta(`${AUTOSAVE_NOTE}:${key}`, JSON.stringify(next.payload));
			}
			if (next.pending !== undefined) {
				await setSyncMeta(`${AUTOSAVE_NOTE}-pending:${key}`, JSON.stringify(next.pending));
			}
		} catch {
			/* the cache is a convenience; the server copy is the source of truth */
		}
	}

	function writeCache(c: Ctx | null = ctx()): Promise<void> {
		return c ? persist(c.key, { payload: payload.value, pending: pending.value }) : Promise.resolve();
	}

	async function readPending(key: string): Promise<Pending | null> {
		try {
			const raw = await getSyncMeta(`${AUTOSAVE_NOTE}-pending:${key}`);
			const waiting = typeof raw === "string" ? (JSON.parse(raw) as Pending | null) : null;
			return waiting && typeof waiting === "object" ? waiting : null;
		} catch {
			return null;
		}
	}

	/** The cached copy of a scope, read without touching the live state. */
	async function readCache(
		target: Scope,
	): Promise<{ payload: LayoutPayload | null; pending: Pending | null }> {
		const key = cacheKey(target);
		let cached: LayoutPayload | null = null;
		try {
			const raw = await getSyncMeta(`${AUTOSAVE_NOTE}:${key}`);
			const parsed = typeof raw === "string" ? (JSON.parse(raw) as LayoutPayload | null) : null;
			if (parsed && parsed.pos_profile === target.profile) {
				const pol = { ...defaultPolicy(), ...parsed.policy };
				const clean = sanitize(migrate(parsed.personal).layout, pol);
				cached = { ...parsed, policy: pol, personal: clean };
			}
		} catch {
			/* corrupt cache: fall back to defaults until the server answers */
		}
		return { payload: cached, pending: await readPending(key) };
	}

	function adopt(next: LayoutPayload): void {
		payload.value = next;
		recovered.value = next.recovered;
	}

	/**
	 * Pinned products come from the active catalogue: price and stock are never read from the layout
	 * or from an earlier lookup. ``itemInfo`` only stands in for a just-picked item while customizing.
	 */
	async function resolvePinned(): Promise<void> {
		const c = ctx();
		if (!c) return;
		const codes = (customizing.value && draft.value ? draft.value : saved.value).shared.pinnedItems;
		if (!codes.length) {
			pinnedItems.value = [];
			return;
		}
		if (isOnline() && !customizing.value) {
			try {
				const rows = await call<POSItem[]>("xpos.api.pos_preferences.get_pinned_items", {
					pos_profile: c.target.profile,
				});
				if (!isCurrent(c)) return;
				for (const row of rows) itemInfo.value[row.item_code] = row;
				pinnedItems.value = rows;
				return;
			} catch {
				/* fall through to the offline catalogue */
			}
		}
		const found: POSItem[] = [];
		for (const code of codes) {
			const row =
				(await getCachedItemByCode(code).catch(() => undefined)) ??
				(customizing.value ? itemInfo.value[code] : undefined);
			if (row) found.push(row);
		}
		if (isCurrent(c)) pinnedItems.value = found;
	}

	async function load(target: Scope): Promise<void> {
		const token = ++loadToken;
		scope.value = target;
		customizing.value = false;
		draft.value = null;
		conflict.value = null;
		payload.value = null;
		pending.value = null;
		pinnedItems.value = [];
		itemInfo.value = {};
		const cached = await readCache(target);
		if (token !== loadToken) return;
		if (cached.payload) payload.value = cached.payload;
		pending.value = cached.pending;
		void resolvePinned();
		if (!isOnline()) return;
		const c = ctx();
		try {
			if (pending.value) await flush(c);
			const fresh = await call<LayoutPayload>("xpos.api.pos_preferences.get_layout", {
				pos_profile: target.profile,
			});
			if (token !== loadToken) return;
			if (!pending.value) {
				adopt(fresh);
				await writeCache(c);
			}
			await resolvePinned();
		} catch (err) {
			if (token === loadToken && !isNetworkError(err)) {
				error.value = err instanceof Error ? err.message : String(err);
			}
		}
	}

	function clear(): void {
		loadToken++;
		scope.value = null;
		payload.value = null;
		draft.value = null;
		customizing.value = false;
		pending.value = null;
		conflict.value = null;
		pinnedItems.value = [];
		itemInfo.value = {};
	}

	function setDeviceClass(next: DeviceClass): void {
		deviceClass.value = next;
	}

	function startCustomize(): void {
		if (!canCustomize.value) return;
		draft.value = clone(saved.value);
		customizing.value = true;
		error.value = "";
	}

	function cancelCustomize(): void {
		customizing.value = false;
		draft.value = null;
		void resolvePinned();
	}

	function localApply(next: PersonalLayout, baseRevision: number): void {
		if (!payload.value) return;
		const resolved = effectiveLayout(next, payload.value.defaults, payload.value.policy);
		payload.value = { ...payload.value, personal: next, layout: resolved, revision: baseRevision };
	}

	function send(profile: string, waiting: Pending): Promise<SaveResult> {
		return waiting.reset
			? call<SaveResult>("xpos.api.pos_preferences.reset_layout", { pos_profile: profile })
			: call<SaveResult>("xpos.api.pos_preferences.save_layout", {
					pos_profile: profile,
					layout: JSON.stringify(waiting.personal),
					base_revision: waiting.baseRevision,
				});
	}

	/** Send the edit waiting for ``c``'s scope, once; a reconnect racing another send just queues behind it. */
	function flush(c: Ctx | null = ctx()): Promise<void> {
		if (!c) return Promise.resolve();
		return enqueue(async () => {
			if (!isOnline()) return;
			const waiting = isCurrent(c) ? pending.value : await readPending(c.key);
			if (!waiting) return;
			const result = await send(c.target.profile, waiting);
			if (!isCurrent(c)) {
				/* the user moved on: keep the outcome for that scope only */
				if (result.status !== "conflict") await persist(c.key, { payload: result, pending: null });
				return;
			}
			if (result.status === "conflict") {
				conflict.value = result;
				return;
			}
			pending.value = null;
			adopt(result);
			await writeCache(c);
			await resolvePinned();
		});
	}

	/**
	 * Run a save or reset for the scope it was started in. Returns false on a conflict or a server refusal.
	 * Offline, or once the scope has changed, the edit is kept under its own scope and sent later.
	 */
	function commit(waiting: Pending, c: Ctx): Promise<boolean> {
		return enqueue(async () => {
			error.value = "";
			const request: Pending = { ...waiting };
			if (!isCurrent(c)) {
				await persist(c.key, { pending: request });
				return true;
			}
			if (payload.value) request.baseRevision = payload.value.revision;
			try {
				if (!isOnline()) throw new Error("__offline__");
				const result = await send(c.target.profile, request);
				if (!isCurrent(c)) {
					if (result.status !== "conflict")
						await persist(c.key, { payload: result, pending: null });
					else await persist(c.key, { pending: request });
					return true;
				}
				if (result.status === "conflict") {
					pending.value = request;
					conflict.value = result;
					return false;
				}
				pending.value = null;
				adopt(result);
			} catch (err) {
				if (!isNetworkError(err)) {
					if (isCurrent(c)) error.value = err instanceof Error ? err.message : String(err);
					return false;
				}
				if (!isCurrent(c)) {
					await persist(c.key, { pending: request });
					return true;
				}
				pending.value = request;
				localApply(request.personal, request.baseRevision);
			}
			customizing.value = false;
			draft.value = null;
			await writeCache(c);
			await resolvePinned();
			return true;
		});
	}

	/** Save the draft. Online it goes to the server; offline it is kept and sent on reconnect. */
	async function save(): Promise<boolean> {
		const c = ctx();
		if (!draft.value || !payload.value || !c) return false;
		const next = personalFromEdit(
			personal.value,
			saved.value,
			draft.value,
			deviceClass.value,
			policy.value,
		);
		return commit({ personal: next, baseRevision: payload.value.revision, reset: false }, c);
	}

	async function reset(): Promise<boolean> {
		const c = ctx();
		if (!c || !payload.value) return false;
		return commit({ personal: emptyPersonal(), baseRevision: payload.value.revision, reset: true }, c);
	}

	/** Conflict answer "keep mine": resend my edit on top of the server's newer revision. */
	async function keepMine(): Promise<void> {
		const theirs = conflict.value;
		const mine = pending.value;
		const c = ctx();
		if (!theirs || !mine || !c) return;
		conflict.value = null;
		pending.value = { ...mine, baseRevision: theirs.revision };
		payload.value = theirs;
		await flush(c);
	}

	/** Conflict answer "use theirs": drop my edit and take what the server has. */
	async function useTheirs(): Promise<void> {
		const theirs = conflict.value;
		const c = ctx();
		if (!theirs || !c) return;
		conflict.value = null;
		pending.value = null;
		adopt(theirs);
		customizing.value = false;
		draft.value = null;
		await writeCache(c);
		await resolvePinned();
	}

	async function syncPending(): Promise<void> {
		if (!pending.value || conflict.value) return;
		try {
			await flush();
		} catch {
			/* still offline or the server is busy; try again at the next reconnect */
		}
	}

	return {
		scope,
		payload,
		draft,
		customizing,
		deviceClass,
		pending,
		conflict,
		saving,
		error,
		recovered,
		pinnedItems,
		itemInfo,
		policy,
		defaults,
		personal,
		saved,
		layout,
		shared,
		device,
		canCustomize,
		pendingSync,
		dirty,
		load,
		clear,
		setDeviceClass,
		startCustomize,
		cancelCustomize,
		save,
		reset,
		keepMine,
		useTheirs,
		syncPending,
		resolvePinned,
	};
});
