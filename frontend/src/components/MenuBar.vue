<template>
	<div
		ref="menuBarRef"
		class="h-7 flex items-center bg-[#3c3c3c] dark:bg-[#1e1e1e] shrink-0 z-50 px-1 select-none border-b border-[#252526] dark:border-[#252526]"
		@click.self="closeAll"
	>
		<div v-for="(menu, menuIndex) in menus" :key="menu.label" class="relative">
			<button
				class="px-2.5 h-7 flex items-center text-[13px] rounded-sm transition-colors duration-75 outline-none"
				:class="
					activeMenu === menu.label
						? 'bg-[#094771] dark:bg-[#094771] text-white'
						: focusedMenuIndex === menuIndex && isMenuBarFocused && activeMenu === null
							? 'bg-[#505050] dark:bg-[#2a2d2e] text-white'
							: 'text-[#cccccc] hover:bg-[#505050] dark:hover:bg-[#2a2d2e] hover:text-white'
				"
				@click.stop="toggleMenu(menu.label, menuIndex)"
				@mouseenter="handleMenuHover(menu.label, menuIndex)"
			>
				{{ __(menu.label) }}
			</button>

			<Transition name="menu-drop">
				<div
					v-if="activeMenu === menu.label"
					class="absolute top-full start-0 min-w-[220px] bg-[#252526] dark:bg-[#252526] border border-[#454545] shadow-2xl py-1 z-[200]"
				>
					<template v-for="item in menu.items" :key="item.id">
						<template v-if="item.hidden?.()" />
						<div v-else-if="item.separator" class="h-px bg-[#3c3c3c] mx-0 my-1" />
						<button
							v-else
							class="w-full flex items-center justify-between px-4 py-1 text-[13px] transition-colors duration-75 outline-none"
							:class="
								item.disabled?.()
									? 'text-[#666666] cursor-default'
									: focusedItemId === item.id
										? 'bg-[#094771] text-white cursor-pointer'
										: 'text-[#cccccc] hover:bg-[#094771] hover:text-white cursor-pointer'
							"
							:disabled="item.disabled?.()"
							@click.stop="!item.disabled?.() && run(item)"
							@mouseenter="!item.disabled?.() && handleItemHover(item.id)"
						>
							<div class="flex items-center gap-2.5">
								<component
									:is="item.icon"
									v-if="item.icon"
									class="w-3.5 h-3.5 flex-shrink-0"
								/>
								<span>{{ __(item.label!) }}</span>
							</div>
							<span v-if="item.shortcut" class="ms-8 text-[11px] text-[#666666]">{{
								item.shortcut
							}}</span>
						</button>
					</template>
				</div>
			</Transition>
		</div>
	</div>

	<AboutDialog :open="showAboutDialog" @close="showAboutDialog = false" />
	<KeyboardShortcutsDialog :open="showShortcutsDialog" @close="showShortcutsDialog = false" />
</template>

<script setup lang="ts">
import { ref, computed, inject, onMounted, onUnmounted, type Ref } from "vue";
import { useRouter } from "vue-router";
import { usePosStore } from "@/stores/posStore";
import { useCartStore } from "@/stores/cartStore";
import { usePaymentStore } from "@/stores/paymentStore";
import { useCustomerStore } from "@/stores/customerStore";
import { useAuthStore } from "@/stores/authStore";
import { isElectron } from "@/services/electronBridge";
import { hasPermission } from "@/services/userRights";
import __ from "@/lib/translate";
import { get_full_url } from "@/utils";
import AboutDialog from "@/components/dialogs/AboutDialog.vue";
import KeyboardShortcutsDialog from "@/components/dialogs/KeyboardShortcutsDialog.vue";
import {
	ShoppingCart,
	Printer,
	LogOut,
	Monitor,
	Sun,
	Moon,
	Maximize2,
	Minimize2,
	LayoutGrid,
	ClipboardList,
	ArrowUpCircle,
	ArrowDownCircle,
	HelpCircle,
	Keyboard,
	Power,
	FileText,
	Receipt,
	PackageCheck,
	Barcode,
	Settings,
	Wallet,
	Landmark,
	RotateCcw,
	Repeat,
	CreditCard,
	Users,
	Pause,
	RefreshCw,
	Info,
	BarChart3,
	ShieldCheck,
} from "lucide-vue-next";

const router = useRouter();
const posStore = usePosStore();
const cartStore = useCartStore();
const paymentStore = usePaymentStore();
const customerStore = useCustomerStore();
const authStore = useAuthStore();
const toggleDarkMode = inject<() => void>("toggleDarkMode")!;
const theme = inject<Ref<"light" | "dark" | "system">>("theme")!;

const menuBarRef = ref<HTMLElement | null>(null);
const activeMenu = ref<string | null>(null);
const focusedMenuIndex = ref<number>(-1);
const focusedItemId = ref<string | null>(null);
const isMenuBarFocused = ref(false);
const isFullscreen = ref(false);
const showAboutDialog = ref(false);
const showShortcutsDialog = ref(false);

const activeMenuIdx = computed(() => {
	if (!activeMenu.value) return -1;
	return menus.value.findIndex((m) => m.label === activeMenu.value);
});

function getNavigableItems(): MenuItem[] {
	const idx = activeMenuIdx.value;
	if (idx < 0) return [];
	return menus.value[idx].items.filter((item) => !item.separator && !item.hidden?.() && !item.disabled?.());
}

function toggleMenu(label: string, menuIndex: number) {
	if (activeMenu.value === label) {
		activeMenu.value = null;
		focusedItemId.value = null;
		focusedMenuIndex.value = menuIndex;
		isMenuBarFocused.value = true;
	} else {
		activeMenu.value = label;
		focusedMenuIndex.value = menuIndex;
		focusedItemId.value = null;
		isMenuBarFocused.value = true;
	}
}

function handleMenuHover(label: string, menuIndex: number) {
	focusedMenuIndex.value = menuIndex;
	if (activeMenu.value !== null && activeMenu.value !== label) {
		activeMenu.value = label;
		focusedItemId.value = null;
	}
}

function handleItemHover(itemId: string) {
	focusedItemId.value = itemId;
}

function closeAll() {
	activeMenu.value = null;
	focusedMenuIndex.value = -1;
	focusedItemId.value = null;
	isMenuBarFocused.value = false;
}

function run(item: MenuItem) {
	closeAll();
	item.action?.();
}

function navigateMenus(delta: number) {
	const total = menus.value.length;
	const current =
		activeMenuIdx.value >= 0
			? activeMenuIdx.value
			: focusedMenuIndex.value >= 0
				? focusedMenuIndex.value
				: 0;
	const next = (((current + delta) % total) + total) % total;
	focusedMenuIndex.value = next;
	isMenuBarFocused.value = true;
	if (activeMenu.value !== null) {
		activeMenu.value = menus.value[next].label;
		focusedItemId.value = null;
	}
}

function navigateItems(delta: number) {
	if (!activeMenu.value) {
		const idx = focusedMenuIndex.value >= 0 ? focusedMenuIndex.value : 0;
		activeMenu.value = menus.value[idx]?.label ?? null;
		focusedMenuIndex.value = idx;
		isMenuBarFocused.value = true;
		const items = getNavigableItems();
		focusedItemId.value =
			items.length > 0 ? (delta > 0 ? items[0].id : items[items.length - 1].id) : null;
		return;
	}
	const items = getNavigableItems();
	if (items.length === 0) return;
	const currentIdx = focusedItemId.value ? items.findIndex((i) => i.id === focusedItemId.value) : -1;
	let next = currentIdx + delta;
	if (next < 0) next = items.length - 1;
	if (next >= items.length) next = 0;
	focusedItemId.value = items[next].id;
}

function handleKeyDown(e: KeyboardEvent) {
	if (!isMenuBarFocused.value && !activeMenu.value) return;

	const target = e.target as HTMLElement;
	if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;

	switch (e.key) {
		case "ArrowLeft":
			e.preventDefault();
			e.stopImmediatePropagation();
			navigateMenus(-1);
			break;
		case "ArrowRight":
			e.preventDefault();
			e.stopImmediatePropagation();
			navigateMenus(1);
			break;
		case "ArrowDown":
			e.preventDefault();
			e.stopImmediatePropagation();
			navigateItems(1);
			break;
		case "ArrowUp":
			e.preventDefault();
			e.stopImmediatePropagation();
			navigateItems(-1);
			break;
		case "Enter":
		case " ":
			if (activeMenu.value && focusedItemId.value) {
				const item = getNavigableItems().find((i) => i.id === focusedItemId.value);
				if (item) {
					e.preventDefault();
					e.stopImmediatePropagation();
					run(item);
				}
			} else if (!activeMenu.value && isMenuBarFocused.value && focusedMenuIndex.value >= 0) {
				e.preventDefault();
				e.stopImmediatePropagation();
				activeMenu.value = menus.value[focusedMenuIndex.value]?.label ?? null;
				focusedItemId.value = null;
			}
			break;
		case "Escape":
			e.preventDefault();
			e.stopImmediatePropagation();
			if (activeMenu.value) {
				activeMenu.value = null;
				focusedItemId.value = null;
			} else {
				closeAll();
			}
			break;
		case "Tab":
			closeAll();
			break;
	}
}

function handleDocumentClick(e: MouseEvent) {
	if (menuBarRef.value && !menuBarRef.value.contains(e.target as Node)) {
		closeAll();
	}
}

function focusMenuBar() {
	if (activeMenu.value || isMenuBarFocused.value) {
		closeAll();
	} else {
		isMenuBarFocused.value = true;
		focusedMenuIndex.value = 0;
	}
}

onMounted(() => {
	window.addEventListener("xpos:focus-menubar", focusMenuBar);
	window.addEventListener("keydown", handleKeyDown);
	document.addEventListener("click", handleDocumentClick);
});

onUnmounted(() => {
	window.removeEventListener("xpos:focus-menubar", focusMenuBar);
	window.removeEventListener("keydown", handleKeyDown);
	document.removeEventListener("click", handleDocumentClick);
});

async function toggleFullscreen() {
	if (!document.fullscreenElement) {
		await document.documentElement.requestFullscreen();
		isFullscreen.value = true;
	} else {
		await document.exitFullscreen();
		isFullscreen.value = false;
	}
}

async function triggerSync() {
	if (isElectron() && window.electronAPI?.triggerSync) {
		await window.electronAPI.triggerSync();
	}
}

interface MenuItem {
	id: string;
	label?: string;
	icon?: object;
	shortcut?: string;
	separator?: boolean;
	disabled?: () => boolean;
	hidden?: () => boolean;
	action?: () => void;
}

interface Menu {
	label: string;
	items: MenuItem[];
}

const menus = computed<Menu[]>(() => [
	{
		label: "File",
		items: [
			{
				id: "new-sale",
				label: "New Sale",
				icon: ShoppingCart,
				shortcut: "Ctrl+N",
				action: () => {
					window.dispatchEvent(new CustomEvent("xpos:clear-cart"));
					router.push("/pos");
				},
			},
			{
				id: "repeat-invoice",
				label: "Repeat Invoice",
				icon: Repeat,
				shortcut: "Ctrl+G",
				action: () => {
					window.dispatchEvent(new CustomEvent("xpos:show-repeat-dialog"));
				},
			},
			{
				id: "return-invoice",
				label: "Return Invoice",
				icon: RotateCcw,
				shortcut: "Ctrl+R",
				hidden: () => !hasPermission("sale_return"),
				disabled: () => !posStore.allowReturn,
				action: () => {
					window.dispatchEvent(new CustomEvent("xpos:show-return-dialog"));
				},
			},
			{ id: "sep-f0", separator: true },
			{
				id: "print-last",
				label: "Print Last Receipt",
				icon: Printer,
				shortcut: "Ctrl+P",
				hidden: () => !hasPermission("allow_reprint_invoice"),
				disabled: () => !posStore.lastInvoiceName,
				action: () => {
					const name = posStore.lastInvoiceName;
					if (!name) return;
					window.open(
						get_full_url(
							`/printview?doctype=${posStore.invoiceType}&name=${name}&format=${posStore.defaultPrintFormat}&no_letterhead=0&trigger_print=1`,
						),
						"_blank",
					);
				},
			},
			{ id: "sep-f1", separator: true },
			{
				id: "settings",
				label: "Settings",
				icon: Settings,
				shortcut: "Ctrl+,",
				action: () => router.push("/settings"),
			},
			{
				id: "role-permissions",
				label: "Role Permissions",
				icon: ShieldCheck,
				hidden: () => isElectron() || !authStore.canManagePermissions,
				action: () => router.push("/role-permissions"),
			},
			{ id: "sep-f2", separator: true },
			{
				id: "signout",
				label: "Sign Out",
				icon: LogOut,
				action: () => authStore.logout(),
			},
			...(isElectron()
				? [
						{ id: "sep-f3", separator: true },
						{
							id: "exit",
							label: "Exit",
							icon: Power,
							shortcut: "Alt+F4",
							action: () => window.close(),
						},
					]
				: []),
		],
	},
	{
		label: "Sales",
		items: [
			{
				id: "goto-pos",
				label: "Point of Sale",
				icon: LayoutGrid,
				shortcut: "Alt+1",
				action: () => router.push("/pos"),
			},
			{
				id: "goto-orders",
				label: "Orders",
				icon: FileText,
				shortcut: "Alt+2",
				action: () => router.push("/orders"),
			},
			{ id: "sep-sales1", separator: true },
			{
				id: "process-payment",
				label: "Process Payment",
				icon: CreditCard,
				shortcut: "F4",
				disabled: () => cartStore.items.length === 0 || !posStore.isShiftOpen,
				action: () => {
					if (cartStore.items.length > 0 && posStore.isShiftOpen) {
						cartStore.showPaymentDialog = true;
					}
				},
			},
			{
				id: "select-customer",
				label: "Select Customer",
				icon: Users,
				shortcut: "F6",
				action: () => {
					customerStore.showCustomerDialog = true;
				},
			},
			{
				id: "held-invoices",
				label: "Held Invoices",
				icon: Pause,
				shortcut: "F8",
				action: () => {
					cartStore.showDraftDialog = true;
				},
			},
		],
	},
	{
		label: "Reports",
		items: [
			{
				id: "goto-reports",
				label: "Report Catalog",
				icon: BarChart3,
				shortcut: "Alt+8",
				action: () => router.push("/reports"),
			},
		],
	},
	{
		label: "Purchasing",
		items: [
			{
				id: "goto-purchase-order",
				label: "Purchase Order",
				icon: ClipboardList,
				shortcut: "Alt+3",
				action: () => router.push("/purchase-order"),
			},
			{
				id: "goto-purchase-invoice",
				label: "Purchase Invoice",
				icon: Receipt,
				shortcut: "Alt+4",
				action: () => router.push("/purchase-invoices"),
			},
			{
				id: "goto-stock-receiving",
				label: "Stock Receiving",
				icon: PackageCheck,
				shortcut: "Alt+5",
				action: () => router.push("/stock-receiving"),
			},
		],
	},
	{
		label: "Finance",
		items: [
			{
				id: "goto-expenses",
				label: "Expenses",
				icon: Wallet,
				shortcut: "Alt+6",
				action: () => router.push("/expenses"),
			},
			{
				id: "goto-bank-drops",
				label: "Bank Drops",
				icon: Landmark,
				shortcut: "Alt+7",
				action: () => router.push("/bank-drops"),
			},
		],
	},
	{
		label: "View",
		items: [
			{
				id: "fullscreen",
				label: isFullscreen.value ? "Exit Full Screen" : "Toggle Full Screen",
				icon: isFullscreen.value ? Minimize2 : Maximize2,
				shortcut: "F11",
				action: toggleFullscreen,
			},
			{
				id: "theme",
				label:
					theme.value === "dark"
						? "Switch to Light"
						: theme.value === "light"
							? "Switch to System"
							: "Switch to Dark",
				icon: theme.value === "dark" ? Sun : theme.value === "light" ? Monitor : Moon,
				action: () => toggleDarkMode(),
			},
			{ id: "sep-v1", separator: true },
			{
				id: "goto-barcode-print",
				label: "Barcode Printer",
				icon: Barcode,
				shortcut: "Alt+8",
				action: () => router.push("/barcode-print"),
			},
		],
	},
	{
		label: "Shift",
		items: [
			{
				id: "close-shift",
				label: "Close Shift",
				icon: LogOut,
				shortcut: "Ctrl+Shift+O",
				hidden: () => !hasPermission("close_shift"),
				disabled: () => !posStore.isShiftOpen,
				action: () => {
					posStore.showClosingDialog = true;
					posStore.fetchClosingData();
				},
			},
			{ id: "sep-s1", separator: true },
			{
				id: "cash-deposit",
				label: "Cash Deposit",
				icon: ArrowUpCircle,
				shortcut: "Ctrl+Shift+D",
				disabled: () => !posStore.allowCashDeposit || !posStore.isShiftOpen,
				action: () => paymentStore.openCashMovement("deposit"),
			},
			{
				id: "expense",
				label: "Cash Expense",
				icon: ArrowDownCircle,
				shortcut: "Ctrl+E",
				disabled: () => !posStore.allowPosExpense || !posStore.isShiftOpen,
				action: () => paymentStore.openCashMovement("expense"),
			},
			...(isElectron()
				? [
						{ id: "sep-s2", separator: true },
						{
							id: "sync-now",
							label: "Sync Now",
							icon: RefreshCw,
							shortcut: "Ctrl+Shift+S",
							action: () => triggerSync(),
						},
					]
				: []),
		],
	},
	{
		label: "Help",
		items: [
			{
				id: "shortcuts",
				label: "Keyboard Shortcuts",
				icon: Keyboard,
				shortcut: "Ctrl+/",
				action: () => {
					showShortcutsDialog.value = true;
				},
			},
			{ id: "sep-h1", separator: true },
			{
				id: "about",
				label: "About X POS",
				icon: Info,
				action: () => {
					showAboutDialog.value = true;
				},
			},
		],
	},
]);
</script>

<style scoped>
.menu-drop-enter-active,
.menu-drop-leave-active {
	transition:
		opacity 0.08s ease,
		transform 0.08s ease;
}

.menu-drop-enter-from,
.menu-drop-leave-to {
	opacity: 0;
	transform: translateY(-3px);
}
</style>
