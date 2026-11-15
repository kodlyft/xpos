/**
 * layoutStore: scoped offline cache, draft/save/cancel, offline edit then sync, conflicts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

import {
	builtinLayout,
	defaultPolicy,
	effectiveLayout,
	emptyPersonal,
	layoutCacheKey,
} from "@/services/posLayout";

const call = vi.fn();
let online = true;
const meta = new Map<string, string>();

vi.mock("@/services/api", () => ({ call: (...args: unknown[]) => call(...args) }));
vi.mock("@/utils", () => ({
	isOnline: () => online,
	isNetworkError: (err: unknown) => err instanceof Error && err.message === "__offline__",
}));
const catalog = new Map<string, Record<string, unknown>>();

vi.mock("@/services/dbBridge", () => ({
	getCachedItemByCode: async (code: string) => catalog.get(code),
	getSyncMeta: async (key: string) => meta.get(key),
	setSyncMeta: async (key: string, value: string) => {
		meta.set(key, value);
	},
}));

import { useLayoutStore } from "@/stores/layoutStore";

const ALICE = { user: "alice", company: "C", profile: "P" };
const BOB = { user: "bob", company: "C", profile: "P" };

function payloadFor(personal = emptyPersonal(), revision = 0, profile = "P") {
	const policy = defaultPolicy();
	const defaults = builtinLayout();
	return {
		pos_profile: profile,
		company: "C",
		revision,
		recovered: false,
		policy,
		defaults,
		personal,
		layout: effectiveLayout(personal, defaults, policy),
	};
}

/** A tiny server: one stored layout per scope, optimistic revision check. */
function fakeServer() {
	const rows = new Map<string, { personal: ReturnType<typeof emptyPersonal>; revision: number }>();
	let currentUser = "alice";
	call.mockImplementation(async (method: string, args: Record<string, unknown>) => {
		const row = rows.get(currentUser) ?? { personal: emptyPersonal(), revision: 0 };
		if (method.endsWith("get_layout")) return payloadFor(row.personal, row.revision);
		if (method.endsWith("get_pinned_items")) return [];
		if (method.endsWith("save_layout")) {
			if (Number(args.base_revision) !== row.revision) {
				return { status: "conflict", ...payloadFor(row.personal, row.revision) };
			}
			const personal = JSON.parse(args.layout as string);
			rows.set(currentUser, { personal, revision: row.revision + 1 });
			return { status: "saved", ...payloadFor(personal, row.revision + 1) };
		}
		if (method.endsWith("reset_layout")) {
			rows.delete(currentUser);
			return { status: "reset", ...payloadFor() };
		}
		throw new Error(`unexpected ${method}`);
	});
	return { rows, as: (user: string) => (currentUser = user) };
}

describe("layoutStore", () => {
	beforeEach(() => {
		setActivePinia(createPinia());
		call.mockReset();
		meta.clear();
		catalog.clear();
		catalog.set("CACHED", { item_code: "CACHED" });
		online = true;
	});

	it("saves an edit, then shows it", async () => {
		fakeServer();
		const store = useLayoutStore();
		await store.load(ALICE);
		store.startCustomize();
		store.draft!.shared.view = "list";
		expect(store.shared.view).toBe("list"); // live preview before saving
		expect(await store.save()).toBe(true);
		expect(store.customizing).toBe(false);
		expect(store.shared.view).toBe("list");
		expect(store.payload?.revision).toBe(1);
	});

	it("cancel discards the draft and the preview", async () => {
		fakeServer();
		const store = useLayoutStore();
		await store.load(ALICE);
		store.startCustomize();
		store.draft!.shared.view = "list";
		store.cancelCustomize();
		expect(store.shared.view).toBe("grid");
		expect(call.mock.calls.some(([m]) => String(m).endsWith("save_layout"))).toBe(false);
	});

	it("separate users on one terminal never see each other's cached layout", async () => {
		const server = fakeServer();
		const store = useLayoutStore();
		await store.load(ALICE);
		store.startCustomize();
		store.draft!.shared.view = "list";
		await store.save();

		server.as("bob");
		online = false; // bob signs in offline: only bob's own (empty) cache may be read
		await store.load(BOB);
		expect(store.shared.view).toBe("grid");

		online = true;
		server.as("alice");
		await store.load(ALICE);
		expect(store.shared.view).toBe("list");
	});

	it("an offline edit is kept, applied locally and sent on reconnect", async () => {
		const server = fakeServer();
		const store = useLayoutStore();
		await store.load(ALICE);
		online = false;
		store.startCustomize();
		store.draft!.shared.view = "list";
		await store.save();
		expect(store.pendingSync).toBe(true);
		expect(store.shared.view).toBe("list");
		expect(server.rows.size).toBe(0);

		online = true;
		await store.syncPending();
		expect(store.pendingSync).toBe(false);
		expect(server.rows.get("alice")?.personal.shared.view).toBe("list");
	});

	it("an offline edit survives a reload", async () => {
		fakeServer();
		const first = useLayoutStore();
		await first.load(ALICE);
		online = false;
		first.startCustomize();
		first.draft!.shared.view = "list";
		await first.save();

		setActivePinia(createPinia());
		const second = useLayoutStore();
		await second.load(ALICE);
		expect(second.shared.view).toBe("list");
		expect(second.pendingSync).toBe(true);
	});

	it("a concurrent save from another device raises a conflict, and keep-mine wins on top", async () => {
		const server = fakeServer();
		const store = useLayoutStore();
		await store.load(ALICE);
		store.startCustomize();
		store.draft!.shared.view = "list";

		// another device saves first
		server.rows.set("alice", {
			personal: { ...emptyPersonal(), shared: { favoriteCategories: ["Drinks"] } },
			revision: 1,
		});

		expect(await store.save()).toBe(false);
		expect(store.conflict?.revision).toBe(1);

		await store.keepMine();
		expect(store.conflict).toBeNull();
		expect(server.rows.get("alice")?.revision).toBe(2);
		expect(server.rows.get("alice")?.personal.shared.view).toBe("list");
	});

	it("use-theirs adopts the server copy and drops the edit", async () => {
		const server = fakeServer();
		const store = useLayoutStore();
		await store.load(ALICE);
		store.startCustomize();
		store.draft!.shared.view = "list";
		server.rows.set("alice", { personal: { ...emptyPersonal(), shared: { view: "grid" } }, revision: 3 });
		await store.save();
		await store.useTheirs();
		expect(store.shared.view).toBe("grid");
		expect(store.pendingSync).toBe(false);
		expect(store.payload?.revision).toBe(3);
	});

	it("reset returns to the profile defaults", async () => {
		fakeServer();
		const store = useLayoutStore();
		await store.load(ALICE);
		store.startCustomize();
		store.draft!.shared.view = "list";
		await store.save();
		await store.reset();
		expect(store.shared.view).toBe("grid");
	});

	it("customization is unavailable when the profile switches it off", async () => {
		fakeServer();
		const store = useLayoutStore();
		await store.load(ALICE);
		store.payload!.policy.allow_customization = false;
		store.startCustomize();
		expect(store.customizing).toBe(false);
	});

	it("falls back to cached catalogue rows for pinned items offline", async () => {
		fakeServer();
		const store = useLayoutStore();
		await store.load(ALICE);
		store.startCustomize();
		store.draft!.shared.pinnedItems = ["CACHED", "GONE"];
		online = false;
		await store.save();
		expect(store.pinnedItems.map((row) => row.item_code)).toEqual(["CACHED"]);
	});

	describe("asynchronous races", () => {
		const PA = { user: "alice", company: "C", profile: "A" };
		const PB = { user: "alice", company: "C", profile: "B" };
		const keyOf = (scope: typeof PA) =>
			layoutCacheKey(location.host, scope.user, scope.company, scope.profile);
		const cached = (scope: typeof PA) => JSON.parse(meta.get(`xpos-layout:${keyOf(scope)}`) ?? "null");

		function gated() {
			const gates: Array<{
				resolve: (value: unknown) => void;
				reject: (err: unknown) => void;
				args: Record<string, unknown>;
			}> = [];
			call.mockImplementation(async (method: string, args: Record<string, unknown>) => {
				const profile = String(args.pos_profile);
				if (method.endsWith("get_layout")) return payloadFor(emptyPersonal(), 0, profile);
				if (method.endsWith("get_pinned_items")) return [];
				return new Promise((resolve, reject) => gates.push({ resolve, reject, args }));
			});
			return gates;
		}

		function savedFor(profile: string, view: "list" | "grid", revision: number) {
			const personal = { ...emptyPersonal(), shared: { view } };
			return { status: "saved", ...payloadFor(personal, revision, profile) };
		}

		it("a save answered after switching profile is cached for the old profile only", async () => {
			const gates = gated();
			const store = useLayoutStore();
			await store.load(PA);
			store.startCustomize();
			store.draft!.shared.view = "list";
			const saving = store.save();
			await vi.waitFor(() => expect(gates).toHaveLength(1));
			await store.load(PB);
			gates[0].resolve(savedFor("A", "list", 1));
			await saving;
			expect(store.payload?.pos_profile).toBe("B");
			expect(store.saved.shared.view).toBe("grid");
			expect(cached(PB)?.pos_profile).toBe("B");
			expect(cached(PA)?.revision).toBe(1);
		});

		it("an offline failure after a switch keeps the edit for its original scope", async () => {
			const gates = gated();
			const store = useLayoutStore();
			await store.load(PA);
			store.startCustomize();
			store.draft!.shared.view = "list";
			const saving = store.save();
			await vi.waitFor(() => expect(gates).toHaveLength(1));
			await store.load(PB);
			gates[0].reject(new Error("__offline__"));
			await saving;
			expect(store.pending).toBeNull();
			expect(JSON.parse(meta.get(`xpos-layout-pending:${keyOf(PA)}`)!).personal.shared.view).toBe(
				"list",
			);
			expect(meta.get(`xpos-layout-pending:${keyOf(PB)}`) ?? "null").toBe("null");
		});

		it("an edit made for a scope that is gone before it runs is kept, not sent", async () => {
			const gates = gated();
			const store = useLayoutStore();
			await store.load(PA);
			store.startCustomize();
			store.draft!.shared.view = "list";
			const first = store.save();
			await vi.waitFor(() => expect(gates).toHaveLength(1));
			store.startCustomize();
			store.draft!.shared.view = "grid";
			store.draft!.shared.pinnedItems = ["CACHED"];
			const second = store.save();
			await store.load(PB);
			gates[0].resolve(savedFor("A", "list", 1));
			await Promise.all([first, second]);
			expect(gates).toHaveLength(1);
			expect(
				JSON.parse(meta.get(`xpos-layout-pending:${keyOf(PA)}`)!).personal.shared.pinnedItems,
			).toEqual(["CACHED"]);
		});

		it("two saves in a row are sent one after the other on the newest revision", async () => {
			const gates = gated();
			const store = useLayoutStore();
			await store.load(PA);
			store.startCustomize();
			store.draft!.shared.view = "list";
			const first = store.save();
			await vi.waitFor(() => expect(gates).toHaveLength(1));
			store.startCustomize();
			store.draft!.shared.view = "grid";
			const second = store.save();
			expect(gates).toHaveLength(1);
			gates[0].resolve(savedFor("A", "list", 1));
			await vi.waitFor(() => expect(gates).toHaveLength(2));
			expect(gates[1].args.base_revision).toBe(1);
			gates[1].resolve(savedFor("A", "grid", 2));
			await Promise.all([first, second]);
			expect(store.saved.shared.view).toBe("grid");
		});

		it("overlapping reconnect flushes send a pending edit once", async () => {
			const gates = gated();
			const store = useLayoutStore();
			await store.load(PA);
			online = false;
			store.startCustomize();
			store.draft!.shared.view = "list";
			expect(await store.save()).toBe(true);
			online = true;
			const one = store.syncPending();
			const two = store.syncPending();
			await vi.waitFor(() => expect(gates).toHaveLength(1));
			gates[0].resolve(savedFor("A", "list", 1));
			await Promise.all([one, two]);
			expect(gates).toHaveLength(1);
			expect(store.pending).toBeNull();
		});

		it("keep-mine after the scope changed does not resend into the new scope", async () => {
			const gates = gated();
			const store = useLayoutStore();
			await store.load(PA);
			store.startCustomize();
			store.draft!.shared.view = "list";
			const saving = store.save();
			await vi.waitFor(() => expect(gates).toHaveLength(1));
			gates[0].resolve({ status: "conflict", ...payloadFor(emptyPersonal(), 3, "A") });
			await saving;
			expect(store.conflict?.revision).toBe(3);
			await store.load(PB);
			await store.keepMine();
			expect(gates).toHaveLength(1);
			expect(store.payload?.pos_profile).toBe("B");
		});

		it("pinned rows answered for the previous profile are dropped", async () => {
			let release!: (rows: unknown[]) => void;
			call.mockImplementation(async (method: string, args: Record<string, unknown>) => {
				const profile = String(args.pos_profile);
				if (method.endsWith("get_layout")) {
					const personal = { ...emptyPersonal(), shared: { pinnedItems: ["X"] } };
					return payloadFor(personal, 1, profile);
				}
				if (method.endsWith("get_pinned_items")) {
					if (profile === "A")
						return new Promise((resolve) => (release = resolve as typeof release));
					return [{ item_code: "B-ITEM" }];
				}
				throw new Error(method);
			});
			const store = useLayoutStore();
			const loadingA = store.load(PA);
			await vi.waitFor(() => expect(release).toBeTypeOf("function"));
			await store.load(PB);
			release([{ item_code: "A-ITEM" }]);
			await loadingA;
			expect(store.pinnedItems.map((row) => row.item_code)).toEqual(["B-ITEM"]);
		});
	});

	describe("pinned item freshness", () => {
		async function pinnedOffline(rows: Record<string, unknown>[]) {
			const store = useLayoutStore();
			call.mockImplementation(async (method: string) => {
				if (method.endsWith("get_layout")) {
					const personal = { ...emptyPersonal(), shared: { pinnedItems: ["P1"] } };
					return payloadFor(personal, 1);
				}
				if (method.endsWith("get_pinned_items")) return rows;
				throw new Error(method);
			});
			await store.load(ALICE);
			online = false;
			await store.resolvePinned();
			return store;
		}

		it("shows the catalogue's current price and stock after the price changed", async () => {
			const store = await pinnedOffline([{ item_code: "P1", rate: 10, actual_qty: 5 }]);
			catalog.set("P1", { item_code: "P1", rate: 12, actual_qty: 2 });
			await store.resolvePinned();
			expect(store.pinnedItems).toEqual([{ item_code: "P1", rate: 12, actual_qty: 2 }]);
		});

		it("drops a pinned item that left the permitted catalogue even if it was seen earlier", async () => {
			const store = await pinnedOffline([{ item_code: "P1", rate: 10 }]);
			expect(store.pinnedItems).toEqual([]);
		});

		it("forgets what it knew about items when the profile changes", async () => {
			const store = await pinnedOffline([{ item_code: "P1", rate: 10 }]);
			expect(store.itemInfo.P1).toBeDefined();
			await store.load({ ...ALICE, profile: "Q" });
			expect(store.itemInfo.P1).toBeUndefined();
		});
	});
});
