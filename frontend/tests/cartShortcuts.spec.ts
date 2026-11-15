/**
 * @vitest-environment jsdom
 *
 * Alt+T / Alt+Arrows work in an ordinary browser tab; Ctrl+T / Ctrl+Tab only where the page can
 * really have them. None of it may touch typing, scanning, dialogs or an input method.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const route = vi.hoisted(() => ({ path: "/pos" }));
vi.mock("vue-router", () => ({
	useRouter: () => ({ currentRoute: { value: route }, push: vi.fn() }),
}));
vi.mock("@/services/api", () => ({
	call: vi.fn(),
	showError: vi.fn(),
	showSuccess: vi.fn(),
	showInfo: vi.fn(),
}));
vi.mock("@/stores/posStore", async () => {
	const kit = await import("./cartTestKit");
	return { usePosStore: () => kit.posState };
});
vi.mock("@/stores/settingsStore", () => ({
	useSettingsStore: () => ({ reset: vi.fn(), fetchSettings: vi.fn() }),
}));
vi.mock("@/services/userRights", () => ({ hasPermission: () => true }));
vi.mock("@/services/pricingService", () => ({
	resolveCartPricing: vi.fn(async () => ({ source: "unavailable" })),
	refreshPricingRuleSnapshot: vi.fn(async () => {}),
}));

import { useKeyboardShortcuts } from "@/composables/useKeyboardShortcuts";
import { useCartStore } from "@/stores/cartStore";
import { useCartSessionStore } from "@/stores/cartSessionStore";
import {
	CART_DEFAULTS,
	cartKeys,
	ctrlCombosSupported,
	isBrowserReserved,
	resetCartShortcut,
	setCartShortcut,
	validateCartKeys,
} from "@/services/cartShortcuts";
import { line, resetPos } from "./cartTestKit";

let destroy: () => void;

function press(init: KeyboardEventInit & { key: string }, target: EventTarget = document.body) {
	const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
	target.dispatchEvent(event);
	return event;
}

function boot(display: string[] = []) {
	setActivePinia(createPinia());
	resetPos();
	window.matchMedia = ((query: string) => ({
		matches: display.some((mode) => query.includes(mode)),
		media: query,
		addEventListener: () => {},
		removeEventListener: () => {},
	})) as never;
	const cart = useCartStore();
	const sessions = useCartSessionStore();
	const keys = useKeyboardShortcuts();
	keys.init();
	destroy = keys.destroy;
	return { cart, sessions, keys };
}

beforeEach(() => {
	route.path = "/pos";
	document.body.innerHTML = "";
	localStorage.clear();
	for (const action of Object.keys(CART_DEFAULTS) as (keyof typeof CART_DEFAULTS)[])
		resetCartShortcut(action);
});
afterEach(() => destroy?.());

describe("browser-safe defaults", () => {
	it("Alt+T opens a cart, Alt+Right and Alt+Left move between them", () => {
		const { cart, sessions } = boot();
		const first = cart.cartId;
		const opened = press({ key: "t", code: "KeyT", altKey: true });
		expect(opened.defaultPrevented).toBe(true);
		expect(sessions.count).toBe(2);
		const second = cart.cartId;
		expect(second).not.toBe(first);

		press({ key: "ArrowLeft", code: "ArrowLeft", altKey: true });
		expect(cart.cartId).toBe(first);
		press({ key: "ArrowRight", code: "ArrowRight", altKey: true });
		expect(cart.cartId).toBe(second);
	});

	it("does not clash with any existing XPOS shortcut", () => {
		const { keys } = boot();
		const combos = keys.shortcuts.map((s) => [...s.keys].sort().join("+"));
		expect(new Set(combos).size).toBe(combos.length);
		for (const action of Object.keys(CART_DEFAULTS) as (keyof typeof CART_DEFAULTS)[]) {
			expect(combos.filter((c) => c === [...CART_DEFAULTS[action]].sort().join("+"))).toHaveLength(1);
		}
	});

	it("opens one cart for a held key, not a stream of them", () => {
		const { sessions } = boot();
		press({ key: "t", code: "KeyT", altKey: true });
		press({ key: "t", code: "KeyT", altKey: true, repeat: true });
		press({ key: "t", code: "KeyT", altKey: true, repeat: true });
		expect(sessions.count).toBe(2);
	});

	it("only acts on the POS screen", () => {
		const { sessions } = boot();
		route.path = "/orders";
		press({ key: "t", code: "KeyT", altKey: true });
		expect(sessions.count).toBe(1);
	});
});

describe("closing a cart from the keyboard", () => {
	it("Alt+W asks the tab strip to close the cart on screen", () => {
		boot();
		const heard = vi.fn();
		window.addEventListener("xpos:close-cart", heard);
		const event = press({ key: "w", code: "KeyW", altKey: true });
		window.removeEventListener("xpos:close-cart", heard);
		expect(event.defaultPrevented).toBe(true);
		expect(heard).toHaveBeenCalledTimes(1);
	});

	it("never offers Ctrl+W, which would close the window", () => {
		const { keys } = boot(["standalone"]);
		expect(keys.shortcuts.some((s) => s.id === "close-cart-ctrl")).toBe(false);
		const event = press({ key: "w", code: "KeyW", ctrlKey: true });
		expect(event.defaultPrevented).toBe(false);
	});
});

describe("Ctrl combinations", () => {
	it("are left to the browser in a normal tab", () => {
		const { sessions, keys } = boot();
		expect(ctrlCombosSupported()).toBe(false);
		expect(keys.ctrlCarts).toBe(false);
		const event = press({ key: "t", code: "KeyT", ctrlKey: true });
		expect(event.defaultPrevented).toBe(false);
		expect(sessions.count).toBe(1);
		expect(press({ key: "Tab", code: "Tab", ctrlKey: true }).defaultPrevented).toBe(false);
	});

	it("work in an installed app window", () => {
		const { sessions, cart, keys } = boot(["standalone"]);
		expect(keys.ctrlCarts).toBe(true);
		const first = cart.cartId;
		press({ key: "t", code: "KeyT", ctrlKey: true });
		expect(sessions.count).toBe(2);
		press({ key: "Tab", code: "Tab", ctrlKey: true, shiftKey: true });
		expect(cart.cartId).toBe(first);
		press({ key: "Tab", code: "Tab", ctrlKey: true });
		expect(cart.cartId).not.toBe(first);
	});
});

describe("typing, scanning and dialogs", () => {
	it("leaves a barcode scan alone", () => {
		const { sessions } = boot();
		const search = document.createElement("input");
		document.body.append(search);
		search.focus();
		const events = [..."5449000000996", "Enter"].map((key) =>
			press({ key, code: key === "Enter" ? "Enter" : `Digit${key}` }, search),
		);
		expect(events.some((e) => e.defaultPrevented)).toBe(false);
		expect(sessions.count).toBe(1);
	});

	it("still opens a cart from the search box, where the scanner focus lives", () => {
		const { sessions } = boot();
		const search = document.createElement("input");
		document.body.append(search);
		search.focus();
		press({ key: "t", code: "KeyT", altKey: true }, search);
		expect(sessions.count).toBe(2);
	});

	it("ignores keys while an input method is composing", () => {
		const { sessions } = boot();
		const event = press({ key: "t", code: "KeyT", altKey: true, isComposing: true });
		expect(event.defaultPrevented).toBe(false);
		press({ key: "Process", code: "KeyT", altKey: true, keyCode: 229 });
		expect(sessions.count).toBe(1);
	});

	it("does nothing behind an open dialog or inside one", () => {
		const { sessions } = boot();
		const dialog = document.createElement("div");
		dialog.setAttribute("role", "dialog");
		dialog.dataset.state = "open";
		const field = document.createElement("input");
		dialog.append(field);
		document.body.append(dialog);

		press({ key: "t", code: "KeyT", altKey: true }); // focus elsewhere, dialog open
		field.focus();
		press({ key: "t", code: "KeyT", altKey: true }, field); // focus inside it
		expect(sessions.count).toBe(1);
	});

	it("does not move carts while a payment is open", () => {
		const { cart, sessions } = boot();
		cart.items = [line()];
		sessions.create();
		cart.showPaymentDialog = true;
		const before = cart.cartId;
		press({ key: "ArrowLeft", code: "ArrowLeft", altKey: true });
		expect(cart.cartId).toBe(before);
	});
});

describe("choosing other keys", () => {
	it("follows a cashier's own choice", () => {
		const { sessions } = boot();
		setCartShortcut("new-cart", ["alt", "n"]);
		expect(cartKeys("new-cart")).toEqual(["alt", "n"]);
		press({ key: "t", code: "KeyT", altKey: true });
		expect(sessions.count).toBe(1);
		press({ key: "n", code: "KeyN", altKey: true });
		expect(sessions.count).toBe(2);
	});

	it("refuses keys another action uses, reserved ones, and bare keys", () => {
		const { keys } = boot();
		const taken = keys.takenCombos();
		expect(validateCartKeys("new-cart", ["alt", "1"], taken)).toMatchObject({ ok: false });
		expect(validateCartKeys("new-cart", ["alt", "1"], taken).reason).toContain("goto-pos");
		expect(validateCartKeys("new-cart", ["ctrl", "w"], taken)).toMatchObject({ ok: false });
		expect(validateCartKeys("new-cart", ["ctrl", "w"], taken).reason).toContain("browser");
		expect(validateCartKeys("new-cart", ["t"], taken)).toMatchObject({ ok: false });
		expect(validateCartKeys("new-cart", ["shift", "t"], taken)).toMatchObject({ ok: false });
		expect(validateCartKeys("new-cart", ["alt", "t"], taken)).toEqual({ ok: true }); // its own keys
		expect(validateCartKeys("new-cart", ["alt", "j"], taken)).toEqual({ ok: true });
	});

	it("knows which combinations a browser keeps", () => {
		expect(isBrowserReserved(["ctrl", "t"])).toBe(true);
		expect(isBrowserReserved(["ctrl", "shift", "tab"])).toBe(true);
		expect(isBrowserReserved(["alt", "t"])).toBe(false);
	});
});
