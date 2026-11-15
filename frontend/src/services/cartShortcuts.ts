import { ref } from "vue";

/**
 * Shortcuts for working with several carts.
 *
 * Ctrl+T, Ctrl+Tab and Ctrl+Shift+Tab are what cashiers would expect, but a normal browser tab
 * keeps them for itself (new tab, next tab, previous tab) and a page cannot take them. So the
 * defaults are Alt combinations the page does receive, and the Ctrl ones are switched on only in
 * an installed app window or fullscreen, where the browser's tab strip is not in the way.
 */
export type CartAction = "new-cart" | "next-cart" | "prev-cart" | "close-cart";

export const CART_DEFAULTS: Record<CartAction, string[]> = {
	"new-cart": ["alt", "t"],
	"next-cart": ["alt", "arrowright"],
	"prev-cart": ["alt", "arrowleft"],
	"close-cart": ["alt", "w"],
};

export const CART_ACTION_LABELS: Record<CartAction, string> = {
	"new-cart": "New Cart",
	"next-cart": "Next Cart",
	"prev-cart": "Previous Cart",
	"close-cart": "Close Cart",
};

/** What the preferred Ctrl combinations do where they work. */
export const CART_CTRL_ALTERNATES: Partial<Record<CartAction, string[]>> = {
	"new-cart": ["ctrl", "t"],
	"next-cart": ["ctrl", "tab"],
	"prev-cart": ["ctrl", "shift", "tab"],
};

/** Combinations a browser keeps for itself, so a page cannot be given them. */
const BROWSER_RESERVED = new Set(
	[
		"ctrl+t",
		"ctrl+w",
		"ctrl+n",
		"ctrl+tab",
		"ctrl+shift+tab",
		"ctrl+shift+t",
		"ctrl+shift+n",
		"ctrl+shift+w",
		"ctrl+pageup",
		"ctrl+pagedown",
		"ctrl+l",
		"ctrl+r",
		"ctrl+shift+r",
		"alt+f4",
		"alt+home",
		"f5",
		"f11",
		"f12",
	].map((k) => k.toLowerCase()),
);

export function comboOf(keys: string[]): string {
	const order = ["ctrl", "alt", "shift"];
	const lower = keys.map((k) => k.toLowerCase());
	const mods = order.filter((m) => lower.includes(m));
	const rest = lower.filter((k) => !order.includes(k)).sort();
	return [...mods, ...rest].join("+");
}

export function isBrowserReserved(keys: string[]): boolean {
	return BROWSER_RESERVED.has(comboOf(keys));
}

/** True when the page really receives Ctrl+T / Ctrl+Tab: an app window or fullscreen. */
export function ctrlCombosSupported(): boolean {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
	const modes = ["standalone", "window-controls-overlay", "minimal-ui", "fullscreen"];
	return modes.some((mode) => window.matchMedia(`(display-mode: ${mode})`).matches);
}

/** In fullscreen Chromium lets a page ask for keys it would not normally get. Best effort. */
export async function lockTabKeys(): Promise<boolean> {
	const keyboard = (navigator as Navigator & { keyboard?: { lock?: (codes: string[]) => Promise<void> } })
		.keyboard;
	if (!keyboard?.lock) return false;
	try {
		await keyboard.lock(["KeyT", "Tab"]);
		return true;
	} catch {
		return false;
	}
}

const STORAGE_KEY = "xpos_cart_shortcuts";

function readOverrides(): Partial<Record<CartAction, string[]>> {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		const parsed = raw ? JSON.parse(raw) : {};
		const out: Partial<Record<CartAction, string[]>> = {};
		for (const action of Object.keys(CART_DEFAULTS) as CartAction[]) {
			const keys = parsed?.[action];
			if (Array.isArray(keys) && keys.every((k) => typeof k === "string") && keys.length > 0) {
				out[action] = keys.map((k: string) => k.toLowerCase());
			}
		}
		return out;
	} catch {
		return {};
	}
}

export const cartShortcutOverrides = ref<Partial<Record<CartAction, string[]>>>(readOverrides());

export function cartKeys(action: CartAction): string[] {
	return cartShortcutOverrides.value[action] ?? CART_DEFAULTS[action];
}

function persist(): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(cartShortcutOverrides.value));
	} catch {
		/* a private window or full storage: the choice lasts until reload */
	}
}

export function setCartShortcut(action: CartAction, keys: string[]): void {
	cartShortcutOverrides.value = {
		...cartShortcutOverrides.value,
		[action]: keys.map((k) => k.toLowerCase()),
	};
	persist();
}

export function resetCartShortcut(action: CartAction): void {
	const next = { ...cartShortcutOverrides.value };
	delete next[action];
	cartShortcutOverrides.value = next;
	persist();
}

/** Another action already using these keys; `taken` is every other combo in use. */
export function findConflict(keys: string[], taken: Map<string, string>, ownId?: string): string {
	const owner = taken.get(comboOf(keys));
	return owner && owner !== ownId ? owner : "";
}

export interface ChosenKeys {
	ok: boolean;
	reason?: string;
}

/** Whether keys may be used for a cart action. */
export function validateCartKeys(action: CartAction, keys: string[], taken: Map<string, string>): ChosenKeys {
	const lower = keys.map((k) => k.toLowerCase());
	const main = lower.filter((k) => !["ctrl", "alt", "shift", "meta"].includes(k));
	if (main.length !== 1) return { ok: false, reason: "Press one key together with Ctrl, Alt or Shift." };
	if (!lower.some((k) => k === "ctrl" || k === "alt")) {
		return { ok: false, reason: "Use Ctrl or Alt so typing and barcode scanners are not affected." };
	}
	if (isBrowserReserved(lower) && !ctrlCombosSupported()) {
		return {
			ok: false,
			reason: "The browser keeps this combination for itself, so the page never sees it.",
		};
	}
	const clash = findConflict(lower, taken, action);
	if (clash) return { ok: false, reason: `Already used by ${clash}.` };
	return { ok: true };
}
