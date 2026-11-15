/**
 * @vitest-environment jsdom
 *
 * Open carts survive a reload, stay with their own site/user/profile/shift, never overwrite
 * each other, and a failing disk never stops the till.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

vi.mock("@/services/api", () => ({ call: vi.fn(), showError: vi.fn(), showInfo: vi.fn() }));
vi.mock("@/stores/posStore", async () => {
	const kit = await import("./cartTestKit");
	return { usePosStore: () => kit.posState };
});
vi.mock("@/services/pricingService", () => ({
	resolveCartPricing: vi.fn(async () => ({ source: "unavailable" })),
	refreshPricingRuleSnapshot: vi.fn(async () => {}),
}));
const owner = vi.hoisted(() => ({
	state: "owner" as "owner" | "other",
	lost: [] as (() => void)[],
	takeovers: 0,
}));
vi.mock("@/services/cartOwnership", () => ({
	createCartOwnership: () => ({
		acquire: async () => owner.state,
		takeOver: async () => {
			owner.takeovers += 1;
			owner.state = "owner";
			return "owner";
		},
		release: async () => {},
		state: () => owner.state,
		onLost: (listener: () => void) => {
			owner.lost.push(listener);
			return () => {};
		},
	}),
}));
const pending = vi.hoisted(() => ({ queued: new Set<string>() }));
vi.mock("@/services/dbBridge", async (original) => ({
	...(await original<typeof import("@/services/dbBridge")>()),
	findPendingInvoiceByLocalId: vi.fn(async (id: string) =>
		pending.queued.has(id) ? { local_id: id } : undefined,
	),
}));
const writes = vi.hoisted(() => ({ fail: false, count: 0 }));
vi.mock("@/services/cartPersistence", async (original) => {
	const actual = await original<typeof import("@/services/cartPersistence")>();
	return {
		...actual,
		saveRecord: vi.fn(async (scope: string, record: never) => {
			writes.count += 1;
			if (writes.fail) throw new Error("QuotaExceededError");
			return actual.saveRecord(scope, record);
		}),
	};
});

import { useCartStore } from "@/stores/cartStore";
import { useCartSessionStore } from "@/stores/cartSessionStore";
import {
	cartRecordKey,
	loadRecord,
	parseRecord,
	createWriter,
	forStorage,
	emptySnapshot,
} from "@/services/cartPersistence";
import { setSessionScope, scopeKey } from "@/services/sessionScope";
import { db } from "@/services/idbService";
import { line, posState, resetPos } from "./cartTestKit";

const scope = { user: "amy@shop", profile: "P1", company: "Test Co", warehouse: "Store", priceList: "Std" };

function boot() {
	setActivePinia(createPinia());
	return { cart: useCartStore(), sessions: useCartSessionStore() };
}

/** What a page reload does: the old page writes its last state and goes, a new one starts. */
async function reload(old: ReturnType<typeof useCartSessionStore>) {
	await old.onShiftEnded();
	return boot();
}

beforeEach(async () => {
	vi.clearAllMocks();
	resetPos();
	owner.state = "owner";
	owner.lost = [];
	owner.takeovers = 0;
	pending.queued.clear();
	writes.fail = false;
	writes.count = 0;
	setSessionScope(scope);
	await db.meta.clear();
});

describe("restore after reload", () => {
	it("brings back every open cart, the active one, and their contents", async () => {
		const first = boot();
		await first.sessions.activate();
		first.cart.customer = { name: "CUST-A", customer_name: "Alice" };
		first.cart.items = [line({ item_code: "TV", qty: 2, rate: 500 })];
		first.cart.orderNotes = "gift wrap";
		const idA = first.cart.cartId;
		first.sessions.create();
		const idB = first.cart.cartId;
		first.cart.customer = { name: "CUST-B", customer_name: "Bob" };
		first.cart.items = [line({ item_code: "PEN", qty: 1, rate: 5 })];
		first.cart.payments = [{ mode_of_payment: "Card", amount: 5, reference_no: "4111-secret" } as never];

		const second = await reload(first.sessions);
		await second.sessions.activate();

		expect(second.sessions.tabs.map((t) => t.id).sort()).toEqual([idA, idB].sort());
		expect(second.cart.cartId).toBe(idB);
		expect(second.cart.customer?.name).toBe("CUST-B");
		expect(second.cart.payments).toEqual([]); // payment details are never stored

		second.sessions.switchTo(idA);
		expect(second.cart.customer?.name).toBe("CUST-A");
		expect(second.cart.items[0].item_code).toBe("TV");
		expect(second.cart.orderNotes).toBe("gift wrap");
		expect(second.sessions.tabs.find((t) => t.id === idA)?.label).toBe("Alice");
	});

	it("keeps each cart's sale identity across the reload", async () => {
		const first = boot();
		await first.sessions.activate();
		first.cart.items = [line()];
		const localId = first.cart.getInvoiceData("P", "S").local_id;
		const second = await reload(first.sessions);
		await second.sessions.activate();
		expect(second.cart.getInvoiceData("P", "S").local_id).toBe(localId);
	});

	it("stores nothing for carts with nothing in them", async () => {
		const first = boot();
		await first.sessions.activate();
		first.sessions.create();
		await first.sessions.flush();
		expect(await loadRecord(scopeKey())).toBeNull();
	});

	it("keeps carts apart by user and by profile", async () => {
		const first = boot();
		await first.sessions.activate();
		first.cart.items = [line({ item_code: "MINE" })];
		await first.sessions.flush();

		setSessionScope({ ...scope, user: "bob@shop" });
		const other = await reload(first.sessions);
		await other.sessions.activate();
		expect(other.cart.items).toHaveLength(0);

		setSessionScope({ ...scope, profile: "P2" });
		const third = await reload(other.sessions);
		await third.sessions.activate();
		expect(third.cart.items).toHaveLength(0);

		setSessionScope(scope);
		const back = await reload(third.sessions);
		await back.sessions.activate();
		expect(back.cart.items[0]?.item_code).toBe("MINE");
	});

	it("adopts a cart already on screen next to the stored ones", async () => {
		const first = boot();
		await first.sessions.activate();
		first.cart.customer = { name: "CUST-A", customer_name: "Alice" };
		first.cart.items = [line({ item_code: "STORED" })];
		await first.sessions.onShiftEnded();

		const fresh = boot();
		fresh.cart.items = [line({ item_code: "ON-SCREEN" })];
		await fresh.sessions.activate();

		expect(fresh.sessions.count).toBe(2);
		expect(fresh.cart.items[0].item_code).toBe("ON-SCREEN");
		fresh.sessions.next();
		expect(fresh.cart.items[0].item_code).toBe("STORED");
	});
});

describe("migration from the single-cart format", () => {
	it("turns an old single cart record into one open cart", () => {
		const legacy = {
			items: [line({ item_code: "OLD" })],
			customer: { name: "CUST-A" },
			discountPercentage: 5,
		};
		const record = parseRecord(JSON.stringify(legacy), "SHIFT-1");
		expect(record?.sessions).toHaveLength(1);
		expect(record?.sessions[0].snapshot.items[0].item_code).toBe("OLD");
		expect(record?.sessions[0].snapshot.discountPercentage).toBe(5);
		expect(record?.sessions[0].snapshot.localId).toBe(""); // fields it never had are filled in
		expect(record?.shift).toBe("SHIFT-1");
	});

	it("restores a legacy record found in storage", async () => {
		await db.meta.put({
			key: cartRecordKey(scopeKey()),
			value: JSON.stringify({
				items: [line({ item_code: "OLD" })],
				customer: { name: "CUST-A", customer_name: "Alice" },
			}),
			updated_at: "",
		});
		const { cart, sessions } = boot();
		await sessions.activate();
		expect(cart.items[0].item_code).toBe("OLD");
		expect(sessions.tabs[0].label).toBe("Alice");
	});

	it("ignores garbage and records from the future", () => {
		expect(parseRecord("not json")).toBeNull();
		expect(parseRecord({ v: 99, sessions: [{}] })).toBeNull();
		expect(parseRecord({ v: 1, sessions: [] })).toBeNull();
		expect(parseRecord(null)).toBeNull();
	});

	it("never keeps payment details in what it stores", () => {
		const snap = emptySnapshot("c");
		snap.payments = [{ mode_of_payment: "Card", amount: 1 } as never];
		snap.changeAmount = 3;
		const stored = forStorage(snap);
		expect(stored.payments).toEqual([]);
		expect(stored.changeAmount).toBe(0);
	});
});

describe("writes", () => {
	it("turns a burst of scans into one write", async () => {
		vi.useFakeTimers();
		try {
			const write = vi.fn(async () => {});
			const writer = createWriter(write, 800);
			for (let i = 0; i < 200; i++) writer.schedule();
			expect(write).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(800);
			expect(write).toHaveBeenCalledTimes(1);
			writer.schedule();
			await writer.flush();
			expect(write).toHaveBeenCalledTimes(2);
			await writer.flush(); // nothing changed: nothing written
			expect(write).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not write on every change to the live cart", async () => {
		const { cart, sessions } = boot();
		await sessions.activate();
		writes.count = 0;
		for (let i = 0; i < 50; i++) cart.items.push(line({ item_code: `I${i}` }));
		await Promise.resolve();
		expect(writes.count).toBe(0);
		await sessions.flush();
		expect(writes.count).toBe(1);
	});

	it("shows a failure, keeps the till working, and recovers", async () => {
		const { cart, sessions } = boot();
		await sessions.activate();
		writes.fail = true;
		cart.items = [line()];
		await sessions.flush();
		expect(sessions.persistError).toContain("Quota");
		expect(sessions.create().ok).toBe(true); // still fully usable
		cart.items = [line({ item_code: "AFTER" })];

		writes.fail = false;
		await sessions.flush();
		expect(sessions.persistError).toBe("");
		expect((await loadRecord(scopeKey()))?.sessions).toHaveLength(2);
	});
});

describe("shifts", () => {
	it("offers carts from an earlier shift instead of silently loading or dropping them", async () => {
		posState.posOpeningShift = { name: "SHIFT-OLD" };
		const first = boot();
		await first.sessions.activate();
		first.cart.items = [line({ item_code: "LEFT-OVER" })];
		await first.sessions.onShiftEnded(); // the shift ended with a cart still open

		posState.posOpeningShift = { name: "SHIFT-NEW" };
		const second = boot();
		await second.sessions.activate();
		expect(second.cart.items).toHaveLength(0);
		expect(second.sessions.pendingRecovery?.sessions).toHaveLength(1);

		// While the question is open nothing overwrites the saved carts.
		second.cart.items = [line({ item_code: "NEW-WORK" })];
		await second.sessions.flush();
		expect((await loadRecord(scopeKey()))?.sessions[0].snapshot.items[0].item_code).toBe("LEFT-OVER");

		second.sessions.recoverPrevious();
		expect(second.sessions.pendingRecovery).toBeNull();
		expect(second.sessions.count).toBe(2);
		expect(second.sessions.tabs.some((t) => t.attention)).toBe(true);
		second.sessions.switchTo(second.sessions.tabs[1].id);
		expect(second.cart.items[0].item_code).toBe("LEFT-OVER");
	});

	it("discards earlier carts only when told to", async () => {
		posState.posOpeningShift = { name: "SHIFT-OLD" };
		const first = boot();
		await first.sessions.activate();
		first.cart.items = [line()];
		await first.sessions.onShiftEnded();

		posState.posOpeningShift = { name: "SHIFT-NEW" };
		const second = boot();
		await second.sessions.activate();
		await second.sessions.discardPrevious();
		expect(second.sessions.pendingRecovery).toBeNull();
		expect(await loadRecord(scopeKey())).toBeNull();
	});

	it("saves the open carts when the shift ends, before the screen is cleared", async () => {
		const { cart, sessions } = boot();
		await sessions.activate();
		cart.items = [line({ item_code: "KEEP" })];
		const done = sessions.onShiftEnded();
		cart.clearAll(); // what the shift-lost handler does right after
		await done;
		expect((await loadRecord(scopeKey()))?.sessions[0].snapshot.items[0].item_code).toBe("KEEP");
		expect(sessions.count).toBe(1);
	});
});

describe("interrupted payments", () => {
	it("marks a sale caught mid-payment as unconfirmed and keeps it locked", async () => {
		const first = boot();
		await first.sessions.activate();
		first.cart.items = [line()];
		first.cart.getInvoiceData("P", "S");
		first.sessions.beginSubmit(first.cart.cartId);
		await first.sessions.flush();

		const second = await reload(first.sessions);
		await second.sessions.activate();
		const tab = second.sessions.tabs.find((t) => t.active)!;
		expect(tab.status).toBe("uncertain");
		expect(tab.attention).toBe(true);
		expect(second.sessions.close(tab.id, { confirmed: true }).ok).toBe(false);
		expect(second.sessions.shiftCloseBlocker()).not.toBe("");
	});

	it("hands a sale that reached the offline queue to the queue", async () => {
		const first = boot();
		await first.sessions.activate();
		first.cart.items = [line({ item_code: "QUEUED" })];
		const queued = first.cart.getInvoiceData("P", "S").local_id as string;
		first.sessions.create();
		first.cart.items = [line({ item_code: "OTHER" })];
		first.sessions.next();
		first.sessions.beginSubmit(first.cart.cartId);
		await first.sessions.flush();
		pending.queued.add(queued);

		const second = await reload(first.sessions);
		await second.sessions.activate();
		const codes = second.sessions.tabs.map((t) => t.id);
		expect(codes).toHaveLength(1);
		expect(second.cart.items[0].item_code).toBe("OTHER");
	});
});

describe("another window", () => {
	it("does not restore or write carts another window owns", async () => {
		const mine = boot();
		await mine.sessions.activate();
		mine.cart.items = [line({ item_code: "OWNED" })];
		await mine.sessions.flush();

		owner.state = "other";
		const theirs = boot();
		await theirs.sessions.activate();
		expect(theirs.sessions.ownership).toBe("other");
		expect(theirs.cart.items).toHaveLength(0);
		writes.count = 0;
		theirs.cart.items = [line({ item_code: "SCRATCH" })];
		await theirs.sessions.flush();
		expect(writes.count).toBe(0);
		expect((await loadRecord(scopeKey()))?.sessions[0].snapshot.items[0].item_code).toBe("OWNED");
	});

	it("takes the carts over only on request", async () => {
		const mine = boot();
		await mine.sessions.activate();
		mine.cart.items = [line({ item_code: "OWNED" })];
		await mine.sessions.flush();

		owner.state = "other";
		const theirs = boot();
		await theirs.sessions.activate();
		await theirs.sessions.takeOver();
		expect(owner.takeovers).toBe(1);
		expect(theirs.sessions.ownership).toBe("owner");
		expect(theirs.cart.items[0].item_code).toBe("OWNED");
	});

	it("stops writing and blocks payment in the window that lost the carts", async () => {
		const { cart, sessions } = boot();
		await sessions.activate();
		cart.items = [line()];
		await sessions.flush();
		owner.lost.forEach((fire) => fire());
		expect(sessions.ownership).toBe("lost");
		expect(sessions.submitBlockedReason).not.toBe("");
		writes.count = 0;
		cart.items = [line({ item_code: "LATE" })];
		await sessions.flush();
		expect(writes.count).toBe(0);
	});
});
