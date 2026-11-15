/**
 * @vitest-environment jsdom
 *
 * The strip of open carts: tab semantics, keyboard, touch-sized controls, the compact switcher,
 * and honest states (saving, unconfirmed, not saved, another window).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";

vi.mock("@/services/api", () => ({ call: vi.fn(), showError: vi.fn(), showInfo: vi.fn() }));
vi.mock("@/stores/posStore", async () => {
	const kit = await import("./cartTestKit");
	return { usePosStore: () => kit.posState };
});
vi.mock("@/services/pricingService", () => ({
	resolveCartPricing: vi.fn(async () => ({ source: "unavailable" })),
	refreshPricingRuleSnapshot: vi.fn(async () => {}),
}));

import CartTabs from "@/components/cart/CartTabs.vue";
import { useCartStore } from "@/stores/cartStore";
import { MAX_CARTS, useCartSessionStore } from "@/stores/cartSessionStore";
import { showError } from "@/services/api";
import { line, resetPos } from "./cartTestKit";

let wrapper: VueWrapper | null = null;

function render(placement: "top" | "bottom" = "top") {
	setActivePinia(createPinia());
	resetPos();
	const cart = useCartStore();
	const sessions = useCartSessionStore();
	wrapper = mount(CartTabs, { props: { placement }, attachTo: document.body });
	return { cart, sessions };
}

const tabs = () => [...document.querySelectorAll<HTMLElement>("[role='tab']")];

beforeEach(() => {
	document.body.innerHTML = "";
	vi.clearAllMocks();
});
afterEach(() => {
	wrapper?.unmount();
	wrapper = null;
});

describe("tab semantics", () => {
	it("is a tablist of tabs with one selected and a roving tab stop", async () => {
		const { cart, sessions } = render();
		cart.customer = { name: "CUST-A", customer_name: "Alice" };
		sessions.create();
		await nextTick();

		expect(document.querySelector("[role='tablist']")?.getAttribute("aria-label")).toBe("Open carts");
		const all = tabs();
		expect(all).toHaveLength(2);
		expect(all.map((t) => t.getAttribute("aria-selected"))).toEqual(["false", "true"]);
		expect(all.map((t) => t.getAttribute("tabindex"))).toEqual(["-1", "0"]);
		expect(all[0].textContent).toContain("Alice");
		expect(all[1].textContent).toContain("Cart 2");
	});

	it("shows the item count and names the state for assistive technology", async () => {
		const { cart, sessions } = render();
		cart.items = [line({ qty: 3 })];
		sessions.beginSubmit(cart.cartId);
		await nextTick();
		const first = tabs()[0];
		expect(first.textContent).toContain("3");
		expect(first.querySelector(".sr-only")?.textContent).toBe("Payment is being saved");
		expect(first.querySelector(".animate-spin")).not.toBeNull();

		sessions.endSubmit(cart.cartId, "uncertain");
		await nextTick();
		expect(tabs()[0].querySelector(".sr-only")?.textContent).toBe("Payment not confirmed");
		expect(tabs()[0].querySelector("svg.text-warning")).not.toBeNull();
	});

	it("marks where it sits", () => {
		render("bottom");
		expect(document.querySelector("[data-testid=cart-tabs]")?.getAttribute("data-placement")).toBe(
			"bottom",
		);
	});
});

describe("making and switching carts", () => {
	it("opens a new cart from the always-visible button", async () => {
		const { sessions } = render();
		const button = document.querySelector<HTMLButtonElement>("[data-testid=new-cart]")!;
		expect(button.getAttribute("aria-label")).toBe("New cart");
		button.click();
		await nextTick();
		expect(sessions.count).toBe(2);
	});

	it("stops at the limit and says why", async () => {
		const { cart, sessions } = render();
		for (let i = 1; i < MAX_CARTS; i++) {
			cart.items = [line()];
			sessions.create();
		}
		await nextTick();
		const button = document.querySelector<HTMLButtonElement>("[data-testid=new-cart]")!;
		expect(button.disabled).toBe(true);
		expect(document.querySelector("[data-testid=cart-limit]")?.textContent).toContain(String(MAX_CARTS));
		expect(sessions.count).toBe(MAX_CARTS);
	});

	it("switches on click and says when it cannot", async () => {
		const { cart, sessions } = render();
		const first = cart.cartId;
		cart.items = [line()];
		sessions.create();
		await nextTick();
		tabs()[0].click();
		await nextTick();
		expect(cart.cartId).toBe(first);

		sessions.beginSubmit(first);
		tabs()[1].click();
		await nextTick();
		expect(cart.cartId).toBe(first);
		expect(showError).toHaveBeenCalled();
	});

	it("moves with the arrow keys, keeping focus on the strip", async () => {
		const { cart, sessions } = render();
		const first = cart.cartId;
		sessions.create();
		sessions.create();
		await nextTick();
		tabs()[2].focus();
		tabs()[2].dispatchEvent(
			new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }),
		);
		await flushPromises();
		expect(cart.cartId).toBe(tabs()[1].dataset.cartId);
		expect(document.activeElement).toBe(tabs()[1]);

		tabs()[1].dispatchEvent(
			new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }),
		);
		await flushPromises();
		expect(cart.cartId).toBe(first);
		expect(document.activeElement).toBe(tabs()[0]);
	});

	it("leaves Alt+Arrow to the global shortcut", async () => {
		const { cart, sessions } = render();
		sessions.create();
		await nextTick();
		const before = cart.cartId;
		tabs()[1].dispatchEvent(
			new KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true, bubbles: true, cancelable: true }),
		);
		expect(cart.cartId).toBe(before);
	});
});

describe("closing", () => {
	it("closes an empty cart straight away, with an accessible name", async () => {
		const { sessions } = render();
		sessions.create();
		await nextTick();
		const close = document.querySelector<HTMLButtonElement>("button[aria-label='Close Cart 1']");
		expect(close).not.toBeNull();
		close!.click();
		await nextTick();
		expect(sessions.count).toBe(1);
	});

	it("asks before closing a cart with items, and can be cancelled", async () => {
		const { cart, sessions } = render();
		cart.items = [line()];
		sessions.create();
		await nextTick();
		document.querySelector<HTMLButtonElement>("button[aria-label='Close Cart 1']")!.click();
		await flushPromises();
		expect(document.body.textContent).toContain("Close this cart?");
		expect(sessions.count).toBe(2);

		const cancel = [...document.querySelectorAll("button")].find(
			(b) => b.textContent?.trim() === "Cancel",
		)!;
		cancel.click();
		await flushPromises();
		expect(sessions.count).toBe(2);

		document.querySelector<HTMLButtonElement>("button[aria-label='Close Cart 1']")!.click();
		await flushPromises();
		[...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Close cart")!.click();
		await flushPromises();
		expect(sessions.count).toBe(1);
	});

	it("closes the focused tab with Delete", async () => {
		const { sessions } = render();
		sessions.create();
		await nextTick();
		tabs()[0].focus();
		tabs()[0].dispatchEvent(
			new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }),
		);
		await nextTick();
		expect(sessions.count).toBe(1);
	});

	it("closes the cart on screen when the close shortcut is used, asking first if it has items", async () => {
		const { cart, sessions } = render();
		cart.items = [line()];
		sessions.create();
		await nextTick();
		window.dispatchEvent(new CustomEvent("xpos:close-cart")); // the empty cart on screen: no question
		await nextTick();
		expect(sessions.count).toBe(1);
		window.dispatchEvent(new CustomEvent("xpos:close-cart")); // the last cart, with items: asks
		await flushPromises();
		expect(document.body.textContent).toContain("Close this cart?");
	});

	it("refuses to close a cart whose payment is unconfirmed", async () => {
		const { cart, sessions } = render();
		cart.items = [line()];
		sessions.create();
		sessions.endSubmit(sessions.tabs[0].id, "uncertain");
		await nextTick();
		document.querySelector<HTMLButtonElement>("button[aria-label='Close Cart 1']")!.click();
		await flushPromises();
		expect(sessions.count).toBe(2);
		expect(showError).toHaveBeenCalledWith(expect.stringMatching(/not confirmed/i));
	});
});

describe("narrow screens", () => {
	it("has a compact switcher showing which cart of how many", async () => {
		const { sessions } = render();
		sessions.create();
		sessions.create();
		await nextTick();
		const trigger = document.querySelector<HTMLButtonElement>("[data-testid=cart-switcher]")!;
		expect(trigger.textContent).toContain("3 of 3");
		expect(trigger.getAttribute("aria-label")).toBe("Switch cart");
		// shown below md only, while the new-cart button stays in view on every size
		expect(trigger.className).toContain("md:hidden");
		expect(document.querySelector("[data-testid=new-cart]")?.className).not.toContain("hidden ");
	});

	it("lists every cart and switches from the list", async () => {
		const { cart, sessions } = render();
		const first = cart.cartId;
		sessions.create();
		await nextTick();
		document.querySelector<HTMLButtonElement>("[data-testid=cart-switcher]")!.click();
		await flushPromises();
		const choice = document.querySelector<HTMLButtonElement>(`[data-testid='switch-${first}']`);
		expect(choice).not.toBeNull();
		choice!.click();
		await flushPromises();
		expect(cart.cartId).toBe(first);
	});

	it("adds an all-carts menu when the strip would crowd", async () => {
		const { sessions } = render();
		expect(document.querySelector("[data-testid=cart-overflow]")).toBeNull();
		for (let i = 0; i < 4; i++) sessions.create();
		await nextTick();
		expect(document.querySelector("[data-testid=cart-overflow]")).not.toBeNull();
	});
});

describe("honest states", () => {
	it("says when carts are not being saved", async () => {
		const { sessions } = render();
		expect(document.querySelector("[data-testid=cart-persist-error]")).toBeNull();
		sessions.persistError = "disk full";
		await nextTick();
		const banner = document.querySelector("[data-testid=cart-persist-error]");
		expect(banner?.getAttribute("role")).toBe("alert");
		expect(banner?.textContent).toContain("not being saved");
	});

	it("tells a second window and offers to take the carts over", async () => {
		const { sessions } = render();
		sessions.ownership = "other";
		const takeOver = vi.spyOn(sessions, "takeOver").mockResolvedValue();
		await nextTick();
		expect(document.querySelector("[data-testid=cart-owner-banner]")?.textContent).toContain(
			"another window",
		);
		document.querySelector<HTMLButtonElement>("[data-testid=cart-take-over]")!.click();
		expect(takeOver).toHaveBeenCalled();
	});

	it("asks what to do with carts from an earlier shift, and cannot be dismissed", async () => {
		const { sessions } = render();
		const snapshot = (await import("@/services/cartPersistence")).emptySnapshot("old");
		snapshot.items = [line()];
		sessions.pendingRecovery = {
			v: 1,
			shift: "OLD",
			activeId: "old",
			savedAt: "",
			sessions: [{ id: "old", seq: 1, status: "idle", snapshot }],
		};
		await flushPromises();
		expect(document.querySelector("[data-testid=cart-recovery]")?.textContent).toContain("1 cart(s)");
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		await flushPromises();
		expect(document.querySelector("[data-testid=cart-recovery]")).not.toBeNull();
	});
});
