/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { offlineSaleBlockers, type OfflinePolicyInput } from "@/services/offlinePolicy";
import { backoffDelayMs, classifySyncError, BACKOFF_MAX_MS } from "@/services/syncClassify";
import { levelFor, classifyStorageError, requestPersistence } from "@/services/storageHealth";
import { updateBlockers } from "@/services/appUpdate";
import { runExclusive } from "@/services/tabCoordinator";
import { db } from "@/services/idbService";

const ready = { status: "complete", scopeMatches: true } as const;

function input(overrides: Partial<OfflinePolicyInput> = {}): OfflinePolicyInput {
	return {
		invoice: { items: [], payments: [{ mode_of_payment: "Cash", amount: 10 }] },
		offlinePaymentModes: ["Cash"],
		outstanding: 0,
		catalog: ready,
		dbState: "ready",
		storage: { level: "ok" },
		...overrides,
	};
}

const codes = (value: OfflinePolicyInput) => offlineSaleBlockers(value).map((b) => b.code);

describe("which sales may be completed offline", () => {
	it("allows a fully paid sale in a listed mode on a ready catalogue", () => {
		expect(codes(input())).toEqual([]);
	});

	it("offers no offline checkout until the profile lists a payment mode", () => {
		expect(codes(input({ offlinePaymentModes: [] }))).toEqual(["no_offline_modes"]);
	});

	it("refuses a mode the profile did not list, and says which are allowed", () => {
		const blockers = offlineSaleBlockers(
			input({
				invoice: { items: [], payments: [{ mode_of_payment: "Credit Card", amount: 10 }] },
				offlinePaymentModes: ["Cash", "Bank Transfer"],
			}),
		);
		expect(blockers.map((b) => b.code)).toEqual(["payment_mode"]);
		expect(blockers[0].message).toContain("Credit Card");
		expect(blockers[0].message).toContain("Cash, Bank Transfer");
	});

	it("never allows a credit sale or a part payment, whatever is configured", () => {
		expect(codes(input({ invoice: { items: [], payments: [], is_credit_sale: true } }))).toContain(
			"credit_sale",
		);
		expect(codes(input({ outstanding: 4 }))).toContain("credit_sale");
	});

	it("never allows gift card redemption or sale, or customer credit", () => {
		const redeem = {
			items: [],
			payments: [{ mode_of_payment: "Gift Card", amount: 10, gift_card_auth: "tok" }],
		};
		const sell = { items: [{ gift_card_issue: 1 }], payments: [{ mode_of_payment: "Cash", amount: 10 }] };
		const credit = {
			items: [],
			payments: [{ mode_of_payment: "Cash", amount: 5 }],
			customer_credit: [{ source_type: "Journal Entry", source_name: "J1", amount: 5 }],
		};
		expect(
			codes(input({ invoice: redeem as never, offlinePaymentModes: ["Gift Card", "Cash"] })),
		).toContain("gift_card");
		expect(codes(input({ invoice: sell as never }))).toContain("gift_card");
		expect(codes(input({ invoice: credit as never }))).toContain("customer_credit");
	});

	it("does not treat an offline-valid mode as a verified payment", () => {
		const card = { items: [], payments: [{ mode_of_payment: "Credit Card", amount: 10 }] };
		expect(codes(input({ invoice: card, offlinePaymentModes: ["Credit Card"] }))).toEqual([]);
	});

	it("needs a complete catalogue that belongs to this session", () => {
		expect(codes(input({ catalog: null }))).toEqual(["catalog"]);
		expect(codes(input({ catalog: { status: "partial", scopeMatches: true } }))).toEqual(["catalog"]);
		expect(codes(input({ catalog: { status: "complete", scopeMatches: false } }))).toEqual(["catalog"]);
	});

	it("refuses when the sale could not be kept safely", () => {
		expect(codes(input({ dbState: "storage_unavailable" }))).toEqual(["storage"]);
		expect(codes(input({ dbState: "needs_reload" }))).toEqual(["storage"]);
		expect(codes(input({ storage: { level: "full" } }))).toEqual(["storage_full"]);
		expect(codes(input({ storage: { level: "low" } }))).toEqual([]);
	});

	it("refuses returns", () => {
		expect(codes(input({ invoice: { items: [], payments: [], is_return: true } }))).toContain("return");
	});
});

describe("telling a retry from a refusal", () => {
	it("retries network failures, timeouts and server errors", () => {
		expect(classifySyncError(new Error("__offline__")).kind).toBe("transient");
		expect(classifySyncError(Object.assign(new Error("x"), { status: 503 })).kind).toBe("transient");
		expect(classifySyncError(Object.assign(new Error("x"), { status: 429 })).kind).toBe("transient");
		expect(
			classifySyncError(Object.assign(new Error("x"), { excType: "SessionExpired", status: 401 })).kind,
		).toBe("transient");
		expect(classifySyncError(Object.assign(new Error("x"), { excType: "QueryDeadlockError" })).kind).toBe(
			"transient",
		);
	});

	it("retries what it cannot explain, rather than parking a paid sale", () => {
		expect(classifySyncError(new Error("Unexpected token <")).kind).toBe("transient");
		expect(classifySyncError(undefined).kind).toBe("transient");
	});

	it("holds sales the server refused", () => {
		const refusal = classifySyncError(
			Object.assign(new Error("Insufficient stock"), {
				excType: "XPosInsufficientStockError",
				status: 417,
			}),
		);
		expect(refusal).toMatchObject({ kind: "rejected", code: "XPosInsufficientStockError" });
	});

	it("backs off from 15 seconds to a 15 minute ceiling", () => {
		const delays = [1, 2, 3, 4, 5, 6, 7, 8, 20].map((n) => backoffDelayMs(n, () => 0));
		expect(delays[0]).toBe(15_000);
		expect(delays[1]).toBe(30_000);
		expect(delays.slice(1)).toEqual([...delays.slice(1)].sort((a, b) => a - b));
		expect(delays.at(-1)).toBe(BACKOFF_MAX_MS);
		expect(backoffDelayMs(1, () => 1)).toBe(18_000);
	});
});

describe("storage", () => {
	it("grades free space", () => {
		const gb = 1024 ** 3;
		expect(levelFor(1 * gb, 10 * gb)).toBe("ok");
		expect(levelFor(8 * gb, 10 * gb)).toBe("low");
		expect(levelFor(9.5 * gb, 10 * gb)).toBe("full");
		expect(levelFor(100, 100 + 10 * 1024 * 1024)).toBe("full");
		expect(levelFor(0, 0)).toBe("unknown");
	});

	it("names storage failures", () => {
		expect(classifyStorageError(new DOMException("x", "QuotaExceededError"))).toBe("quota");
		expect(classifyStorageError(new DOMException("x", "DataCloneError"))).toBe("data");
		expect(classifyStorageError(Object.assign(new Error("x"), { name: "DatabaseClosedError" }))).toBe(
			"unavailable",
		);
		expect(classifyStorageError(new Error("something else"))).toBe("unknown");
	});

	afterEach(() => vi.unstubAllGlobals());

	it("asks the browser for persistent storage, and says when it cannot", async () => {
		const persist = vi.fn().mockResolvedValue(true);
		Object.defineProperty(navigator, "storage", {
			value: { persist, persisted: vi.fn().mockResolvedValue(false) },
			configurable: true,
		});
		expect(await requestPersistence()).toBe(true);
		expect(persist).toHaveBeenCalled();
		Object.defineProperty(navigator, "storage", { value: undefined, configurable: true });
		expect(await requestPersistence()).toBeNull();
	});
});

describe("updating the app", () => {
	const idle = { cartEmpty: true, paymentDialogOpen: false, sendingCount: 0, dbState: "ready" as const };

	it("is allowed only when nothing is in flight", () => {
		expect(updateBlockers(idle)).toEqual([]);
		expect(updateBlockers({ ...idle, cartEmpty: false })).toHaveLength(1);
		expect(updateBlockers({ ...idle, paymentDialogOpen: true })).toHaveLength(1);
		expect(updateBlockers({ ...idle, sendingCount: 2 })).toHaveLength(1);
		expect(updateBlockers({ ...idle, dbState: "upgrading" })).toHaveLength(1);
	});
});

describe("two tabs", () => {
	it("runs a job in only one tab at a time with Web Locks", async () => {
		const held = new Set<string>();
		Object.defineProperty(navigator, "locks", {
			configurable: true,
			value: {
				request: async (name: string, _o: unknown, cb: (lock: object | null) => Promise<unknown>) => {
					if (held.has(name)) return cb(null);
					held.add(name);
					try {
						return await cb({});
					} finally {
						held.delete(name);
					}
				},
			},
		});
		const order: string[] = [];
		const first = runExclusive("drain", async () => {
			order.push("first start");
			const second = await runExclusive("drain", async () => order.push("second ran"));
			order.push(second.ran ? "second ran" : "second refused");
			return 1;
		});
		expect(await first).toEqual({ ran: true, value: 1 });
		expect(order).toEqual(["first start", "second refused"]);
		expect((await runExclusive("drain", async () => 2)).ran).toBe(true);
		Object.defineProperty(navigator, "locks", { value: undefined, configurable: true });
	});

	it("falls back to a lease when the browser has no Web Locks, and respects another tab's", async () => {
		await db.open();
		await db.meta.put({
			key: "lease::drain",
			value: { owner: "tab_other", expires: Date.now() + 60_000 },
			updated_at: "",
		});
		expect((await runExclusive("drain", async () => 1)).ran).toBe(false);

		await db.meta.put({
			key: "lease::drain",
			value: { owner: "tab_other", expires: Date.now() - 1 },
			updated_at: "",
		});
		expect(await runExclusive("drain", async () => 1)).toEqual({ ran: true, value: 1 });
		expect(await db.meta.get("lease::drain")).toBeUndefined();
	});
});
