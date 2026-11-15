/**
 * @vitest-environment jsdom
 *
 * What happens to open carts when the profile or user changes, the shift ends, or the cashier
 * logs out: they are saved for their owner and never shown to anyone else.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const api = vi.hoisted(() => ({ order: [] as string[], call: vi.fn() }));
vi.mock("@/services/api", () => ({
	call: (method: string) => {
		api.order.push(`call:${method}`);
		return Promise.resolve(null);
	},
	showError: vi.fn(),
	showInfo: vi.fn(),
}));
vi.mock("@/stores/posStore", async () => {
	const kit = await import("./cartTestKit");
	return { usePosStore: () => kit.posState };
});
vi.mock("@/services/pricingService", () => ({
	resolveCartPricing: vi.fn(async () => ({ source: "unavailable" })),
	refreshPricingRuleSnapshot: vi.fn(async () => {}),
}));
vi.mock("@/services/cartOwnership", () => ({
	createCartOwnership: () => ({
		acquire: async () => "owner",
		takeOver: async () => "owner",
		release: async () => {},
		state: () => "owner",
		onLost: () => () => {},
	}),
}));
vi.mock("@/services/sessionCleanup", () => ({
	clearSessionData: vi.fn(async () => {
		api.order.push("clearSessionData");
	}),
}));
vi.mock("@/services/userRights", () => ({
	loadPermissions: vi.fn(),
	resetPermissions: vi.fn(),
	hasPermission: () => true,
}));

import { useCartStore } from "@/stores/cartStore";
import { useCartSessionStore } from "@/stores/cartSessionStore";
import { useAuthStore } from "@/stores/authStore";
import { loadRecord } from "@/services/cartPersistence";
import { setSessionScope, scopeKey } from "@/services/sessionScope";
import { db } from "@/services/idbService";
import { line, posState, resetPos } from "./cartTestKit";

const scope = { user: "amy@shop", profile: "P1", company: "Test Co", warehouse: "Store", priceList: "Std" };

beforeEach(async () => {
	vi.clearAllMocks();
	api.order.length = 0;
	resetPos();
	setSessionScope(scope);
	setActivePinia(createPinia());
	await db.meta.clear();
});

describe("profile and user changes", () => {
	it("saves the old profile's carts and starts clean on the new one, then brings them back", async () => {
		const cart = useCartStore();
		const sessions = useCartSessionStore();
		await sessions.sync(true);
		cart.customer = { name: "CUST-A", customer_name: "Alice" };
		cart.items = [line({ item_code: "P1-ITEM" })];

		setSessionScope({ ...scope, profile: "P2" });
		await sessions.sync(true);
		expect(cart.items).toHaveLength(0);
		expect(sessions.count).toBe(1);
		cart.items = [line({ item_code: "P2-ITEM" })];

		setSessionScope(scope);
		await sessions.sync(true);
		expect(cart.items[0].item_code).toBe("P1-ITEM");
		expect(sessions.tabs.some((t) => t.label === "Alice")).toBe(true);
	});

	it("never shows one user's carts to another", async () => {
		const cart = useCartStore();
		const sessions = useCartSessionStore();
		await sessions.sync(true);
		cart.items = [line({ item_code: "AMYS" })];

		setSessionScope({ ...scope, user: "bob@shop" });
		await sessions.sync(true);
		expect(cart.items).toHaveLength(0);
		expect(JSON.stringify(sessions.tabs)).not.toContain("AMYS");

		const bobs = await loadRecord(scopeKey());
		expect(bobs).toBeNull();
	});
});

describe("shift end", () => {
	it("keeps unfinished carts and empties the screen", async () => {
		const cart = useCartStore();
		const sessions = useCartSessionStore();
		await sessions.sync(true);
		cart.items = [line({ item_code: "UNFINISHED" })];
		expect(sessions.unfinishedCount()).toBe(1);

		const saved = sessions.onShiftEnded();
		cart.clearAll();
		await saved;
		expect(cart.items).toHaveLength(0);
		expect((await loadRecord(scopeKey()))?.sessions[0].snapshot.items[0].item_code).toBe("UNFINISHED");
		expect(sessions.unfinishedCount()).toBe(0);
	});

	it("is refused while a payment is unconfirmed, and says which cart", () => {
		const cart = useCartStore();
		const sessions = useCartSessionStore();
		cart.items = [line()];
		sessions.endSubmit(cart.cartId, "uncertain");
		expect(sessions.shiftCloseBlocker()).toContain("Cart 1");
	});

	it("opening a new shift offers the old carts back", async () => {
		posState.posOpeningShift = { name: "S-1" };
		const first = useCartStore();
		const sessions = useCartSessionStore();
		await sessions.sync(true);
		first.items = [line({ item_code: "OLD-SHIFT" })];
		await sessions.sync(false);

		posState.posOpeningShift = { name: "S-2" };
		setActivePinia(createPinia());
		const next = useCartSessionStore();
		await next.sync(true);
		expect(next.pendingRecovery).not.toBeNull();
		expect(useCartStore().items).toHaveLength(0);
	});
});

describe("logout", () => {
	it("writes the open carts before the session is dropped", async () => {
		const cart = useCartStore();
		const sessions = useCartSessionStore();
		await sessions.sync(true);
		cart.items = [line({ item_code: "BEFORE-LOGOUT" })];

		const auth = useAuthStore();
		const location = window.location;
		Object.defineProperty(window, "location", { configurable: true, value: { href: "" } });
		try {
			await auth.logout();
		} finally {
			Object.defineProperty(window, "location", { configurable: true, value: location });
		}
		const saved = await loadRecord(scopeKey());
		expect(saved?.sessions[0].snapshot.items[0].item_code).toBe("BEFORE-LOGOUT");
		expect(api.order.indexOf("call:logout")).toBeGreaterThanOrEqual(0);
		expect(api.order.indexOf("clearSessionData")).toBeGreaterThan(api.order.indexOf("call:logout"));
	});
});
