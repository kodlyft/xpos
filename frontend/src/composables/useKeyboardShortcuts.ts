import { ref } from "vue";
import { useRouter, type Router } from "vue-router";
import { clearCachedData } from "@/services/dbBridge";
import { isOnline } from "@/utils";
import { showError, showSuccess } from "@/services/api";
import { useSettingsStore } from "@/stores/settingsStore";
import { usePosStore } from "@/stores/posStore";
import { hasPermission } from "@/services/userRights";
import { useCartSessionStore } from "@/stores/cartSessionStore";
import {
	CART_ACTION_LABELS,
	CART_CTRL_ALTERNATES,
	cartKeys,
	comboOf,
	ctrlCombosSupported,
	lockTabKeys,
	type CartAction,
} from "@/services/cartShortcuts";

export const commandSearchRequested = ref(false);

export async function openCommandSearchOnPos(router: Router): Promise<void> {
	if (router.currentRoute.value.path === "/pos") {
		window.dispatchEvent(new CustomEvent("xpos:open-command-search"));
		return;
	}
	commandSearchRequested.value = true;
	await router.push("/pos");
}

export interface Shortcut {
	id: string;
	keys: string[];
	description: string;
	category: string;
	action: () => void | Promise<void>;
	global?: boolean;
	allowInInput?: boolean;
}

const showShortcutsDialog = ref(false);
const showAboutDialog = ref(false);

export function useKeyboardShortcuts() {
	const router = useRouter();
	const settingsStore = useSettingsStore();
	const cartSessions = useCartSessionStore();

	function cartAction(action: CartAction): void {
		if (router.currentRoute.value.path !== "/pos") return;
		if (action === "close-cart") {
			window.dispatchEvent(new CustomEvent("xpos:close-cart"));
			return;
		}
		const result =
			action === "new-cart"
				? cartSessions.create()
				: action === "next-cart"
					? cartSessions.next()
					: cartSessions.prev();
		if (!result.ok && result.reason) showError(result.reason);
	}

	function cartShortcut(action: CartAction, keys: string[], suffix = ""): Shortcut {
		return {
			id: `${action}${suffix}`,
			keys,
			description: CART_ACTION_LABELS[action],
			category: "Carts",
			allowInInput: true,
			action: () => cartAction(action),
		};
	}

	async function handleClearCachedData(): Promise<void> {
		const confirmed = window.confirm("Clear cached data? Pending invoices and purchases will be kept.");

		if (!confirmed) return;

		try {
			if (usePosStore().posProfile?.use_offline_mode) {
				await clearCachedData();
			}

			settingsStore.reset();

			showSuccess("Cached data cleared. Pending invoices and purchases were kept.");
			window.dispatchEvent(new CustomEvent("xpos:cached-data-cleared"));

			if (isOnline()) {
				void Promise.allSettled([settingsStore.fetchSettings()]);
			}
			window.location.reload();
		} catch (error) {
			console.error("Failed to clear cached data:", error);
			showError("Failed to clear cached data");
		}
	}

	const shortcuts: Shortcut[] = [
		{
			id: "new-sale",
			keys: ["ctrl", "n"],
			description: "New Sale / Clear Cart",
			category: "General",
			global: true,
			action: () => {
				window.dispatchEvent(new CustomEvent("xpos:clear-cart"));
				router.push("/pos");
			},
		},
		{
			id: "command-search",
			keys: ["ctrl", "k"],
			description: "Search Items, Pages and Actions",
			category: "General",
			global: true,
			action: () => {
				if (router.currentRoute.value.path === "/pos") {
					window.dispatchEvent(new CustomEvent("xpos:toggle-command-search"));
					return;
				}
				void openCommandSearchOnPos(router);
			},
		},
		{
			id: "show-shortcuts",
			keys: ["ctrl", "/"],
			description: "Show Keyboard Shortcuts",
			category: "General",
			global: true,
			action: () => {
				showShortcutsDialog.value = true;
			},
		},
		{
			id: "fullscreen",
			keys: ["f11"],
			description: "Toggle Full Screen",
			category: "General",
			global: true,
			action: () => {
				if (!document.fullscreenElement) {
					document.documentElement.requestFullscreen().catch(() => {});
				} else {
					document.exitFullscreen().catch(() => {});
				}
			},
		},
		{
			id: "goto-pos",
			keys: ["alt", "1"],
			description: "Go to POS",
			category: "Navigation",
			global: true,
			action: () => {
				router.push("/pos");
			},
		},
		{
			id: "goto-orders",
			keys: ["alt", "2"],
			description: "Go to Orders",
			category: "Navigation",
			global: true,
			action: () => {
				router.push("/orders");
			},
		},
		{
			id: "goto-purchase-order",
			keys: ["alt", "3"],
			description: "Go to Purchase Order",
			category: "Navigation",
			global: true,
			action: () => {
				router.push("/purchase-order");
			},
		},
		{
			id: "goto-purchase-invoice",
			keys: ["alt", "4"],
			description: "Go to Purchase Invoice",
			category: "Navigation",
			global: true,
			action: () => {
				router.push("/purchase-invoices");
			},
		},
		{
			id: "goto-stock-receiving",
			keys: ["alt", "5"],
			description: "Go to Stock Receiving",
			category: "Navigation",
			global: true,
			action: () => {
				router.push("/stock-receiving");
			},
		},
		{
			id: "goto-expenses",
			keys: ["alt", "6"],
			description: "Go to Expenses",
			category: "Navigation",
			global: true,
			action: () => {
				router.push("/expenses");
			},
		},
		{
			id: "goto-bank-drops",
			keys: ["alt", "7"],
			description: "Go to Bank Drops",
			category: "Navigation",
			global: true,
			action: () => {
				router.push("/bank-drops");
			},
		},
		{
			id: "goto-barcode-print",
			keys: ["alt", "8"],
			description: "Go to Barcode Printer",
			category: "Navigation",
			global: true,
			action: () => {
				router.push("/barcode-print");
			},
		},
		{
			id: "goto-reports",
			keys: ["alt", "9"],
			description: "Go to Reports",
			category: "Navigation",
			global: true,
			action: () => {
				router.push("/reports");
			},
		},
		{
			id: "goto-cashier",
			keys: ["alt", "0"],
			description: "Go to Cashier",
			category: "Navigation",
			global: true,
			action: () => {
				router.push("/cashier");
			},
		},
		{
			id: "focus-cart",
			keys: ["f3"],
			description: "Focus Cart (First Item Qty)",
			category: "POS",
			global: true,
			action: () => {
				window.dispatchEvent(new CustomEvent("xpos:focus-cart-item"));
			},
		},
		{
			id: "payment",
			keys: ["f4"],
			description: "Process Payment",
			category: "POS",
			global: true,
			action: () => {
				window.dispatchEvent(new CustomEvent("xpos:process-payment"));
			},
		},
		{
			id: "toggle-view",
			keys: ["f5"],
			description: "Toggle Item View (Grid/List)",
			category: "POS",
			global: true,
			action: () => {
				window.dispatchEvent(new CustomEvent("xpos:toggle-view"));
			},
		},
		{
			id: "select-customer",
			keys: ["f6"],
			description: "Select Customer",
			category: "POS",
			global: true,
			action: () => {
				window.dispatchEvent(new CustomEvent("xpos:select-customer"));
			},
		},
		{
			id: "held-invoices",
			keys: ["f8"],
			description: "Toggle Held/Draft Invoices",
			category: "POS",
			global: true,
			action: () => {
				window.dispatchEvent(new CustomEvent("xpos:show-drafts"));
			},
		},
		{
			id: "repeat-invoice",
			keys: ["ctrl", "g"],
			description: "Repeat Last Invoice",
			category: "POS",
			action: () => {
				window.dispatchEvent(new CustomEvent("xpos:show-repeat-dialog"));
			},
		},
		{
			id: "return-invoice",
			keys: ["ctrl", "r"],
			description: "Return Invoice",
			category: "POS",
			action: () => {
				window.dispatchEvent(new CustomEvent("xpos:show-return-dialog"));
			},
		},
		{
			id: "print-last",
			keys: ["ctrl", "p"],
			description: "Print Last Receipt",
			category: "POS",
			action: () => {
				if (!hasPermission("allow_reprint_invoice")) return;
				window.dispatchEvent(new CustomEvent("xpos:print-last"));
			},
		},
		{
			id: "apply-discount",
			keys: ["ctrl", "d"],
			description: "Apply Discount",
			category: "POS",
			action: () => {
				window.dispatchEvent(new CustomEvent("xpos:focus-discount"));
			},
		},
		{
			id: "hold-invoice",
			keys: ["ctrl", "h"],
			description: "Hold / Park Invoice",
			category: "POS",
			action: () => {
				window.dispatchEvent(new CustomEvent("xpos:hold-invoice"));
			},
		},
		{
			id: "clear-cart",
			keys: ["ctrl", "delete"],
			description: "Clear All Items from Cart",
			category: "Cart",
			action: () => {
				window.dispatchEvent(new CustomEvent("xpos:clear-cart"));
			},
		},
		{
			id: "remove-last-item",
			keys: ["delete"],
			description: "Remove Selected Item from Cart",
			category: "Cart",
			action: () => {
				window.dispatchEvent(new CustomEvent("xpos:remove-last-item"));
			},
		},
		{
			id: "close-shift",
			keys: ["ctrl", "shift", "o"],
			description: "Close Shift",
			category: "Shift",
			action: () => {
				if (!hasPermission("close_shift")) return;
				window.dispatchEvent(new CustomEvent("xpos:close-shift"));
			},
		},
		{
			id: "cash-expense",
			keys: ["ctrl", "e"],
			description: "Cash Expense",
			category: "Shift",
			action: () => {
				window.dispatchEvent(new CustomEvent("xpos:cash-expense"));
			},
		},
		{
			id: "cash-deposit",
			keys: ["ctrl", "shift", "d"],
			description: "Cash Deposit",
			category: "Shift",
			action: () => {
				window.dispatchEvent(new CustomEvent("xpos:cash-deposit"));
			},
		},
		{
			id: "clear-cached-data",
			keys: ["ctrl", "shift", "r"],
			description: "Clear Cached Data",
			category: "Sync",
			global: true,
			action: () => handleClearCachedData(),
		},
	];

	// Ctrl+T / Ctrl+Tab only where the browser lets the page have them.
	const ctrlCarts = ctrlCombosSupported();
	if (ctrlCarts) {
		for (const action of Object.keys(CART_CTRL_ALTERNATES) as CartAction[]) {
			shortcuts.push(cartShortcut(action, CART_CTRL_ALTERNATES[action]!, "-ctrl"));
		}
	}

	for (const action of ["new-cart", "next-cart", "prev-cart", "close-cart"] as CartAction[]) {
		shortcuts.push(cartShortcut(action, cartKeys(action)));
	}

	/** The keys a shortcut answers to now: a cashier's own choice for the cart actions. */
	function effectiveKeys(shortcut: Shortcut): string[] {
		const id = shortcut.id.replace(/-ctrl$/, "") as CartAction;
		return shortcut.id.endsWith("-ctrl") || !(id in CART_ACTION_LABELS) ? shortcut.keys : cartKeys(id);
	}

	/** Every combination in use, to refuse a clash. Maps combination to its description. */
	function takenCombos(): Map<string, string> {
		const taken = new Map<string, string>();
		for (const s of shortcuts) taken.set(comboOf(effectiveKeys(s)), s.id);
		return taken;
	}

	function normalizeKey(key: string): string {
		return key.toLowerCase().replace("control", "ctrl").replace("meta", "ctrl");
	}

	function matchShortcut(e: KeyboardEvent, shortcut: Shortcut): boolean {
		const keys = effectiveKeys(shortcut).map((k) => k.toLowerCase());

		const hasCtrl = keys.includes("ctrl");
		const hasAlt = keys.includes("alt");
		const hasShift = keys.includes("shift");

		if (hasCtrl !== (e.ctrlKey || e.metaKey)) return false;
		if (hasAlt !== e.altKey) return false;
		if (hasShift !== e.shiftKey) return false;

		const mainKey = keys.find((k) => !["ctrl", "alt", "shift", "meta"].includes(k));
		if (!mainKey) return false;

		const pressedKey = normalizeKey(e.key);

		if (mainKey === "delete" && (pressedKey === "delete" || pressedKey === "backspace")) return true;
		if (mainKey === "/" && (pressedKey === "/" || e.code === "Slash")) return true;
		if (mainKey === "," && (pressedKey === "," || e.code === "Comma")) return true;

		return (
			pressedKey === mainKey ||
			e.code.toLowerCase() === `key${mainKey}` ||
			e.code.toLowerCase() === `digit${mainKey}` ||
			e.code.toLowerCase() === mainKey
		);
	}

	function handleKeyDown(e: KeyboardEvent): void {
		// An input method is mid-word: the keys belong to it.
		if (e.isComposing || e.keyCode === 229) return;
		const tag = (document.activeElement?.tagName ?? "").toLowerCase();
		const isInput = tag === "input" || tag === "textarea" || tag === "select";
		const isInDialog = !!document.activeElement?.closest("[role='dialog']");

		if (e.key === "Escape") {
			if (showShortcutsDialog.value) {
				e.preventDefault();
				showShortcutsDialog.value = false;
				return;
			}
			if (showAboutDialog.value) {
				e.preventDefault();
				showAboutDialog.value = false;
				return;
			}
			return;
		}

		if (e.key === "Alt" && !e.ctrlKey && !e.shiftKey && !e.metaKey) {
			e.preventDefault();
			window.dispatchEvent(new CustomEvent("xpos:focus-menubar"));
			return;
		}

		for (const shortcut of shortcuts) {
			if (matchShortcut(e, shortcut)) {
				if (isInDialog) {
					if (!shortcut.global) continue;
				} else if (!shortcut.global && !shortcut.allowInInput && isInput) continue;
				// A held key must not open a new cart on every repeat.
				if (e.repeat && shortcut.id.startsWith("new-cart")) {
					e.preventDefault();
					return;
				}
				if (
					shortcut.category === "Carts" &&
					document.querySelector("[role='dialog'][data-state='open']")
				) {
					continue;
				}

				e.preventDefault();
				e.stopPropagation();
				const result = shortcut.action();
				if (result instanceof Promise) {
					void result;
				}
				return;
			}
		}
	}

	function init(): void {
		document.addEventListener("keydown", handleKeyDown, true);
		if (ctrlCarts) void lockTabKeys();
	}

	function destroy(): void {
		document.removeEventListener("keydown", handleKeyDown, true);
	}

	function formatShortcut(keys: string[]): string {
		return keys
			.map((k) => {
				if (k === "ctrl") return "Ctrl";
				if (k === "alt") return "Alt";
				if (k === "shift") return "Shift";
				if (k === "delete") return "Del";
				if (k === "arrowright") return "→";
				if (k === "arrowleft") return "←";
				return k.charAt(0).toUpperCase() + k.slice(1);
			})
			.join(" + ");
	}

	return {
		shortcuts,
		takenCombos,
		ctrlCarts,
		showShortcutsDialog,
		showAboutDialog,
		init,
		destroy,
		formatShortcut,
	};
}

export { showShortcutsDialog, showAboutDialog };
