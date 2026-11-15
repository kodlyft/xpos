<template>
	<div
		id="xpos-app"
		:class="[
			'h-dvh w-screen font-sans',
			'flex h-screen w-screen flex-col font-sans',
			isDark ? 'dark' : '',
			isAuthPage ? 'overflow-y-auto' : 'overflow-hidden',
			isRtl ? 'rtl' : 'ltr',
		]"
	>
		<SplashScreen :show="showSplash" />
		<AppStatusBanner />

		<template v-if="isAuthPage || isFullScreen">
			<router-view v-slot="{ Component }">
				<transition name="fade" mode="out-in">
					<component :is="Component" />
				</transition>
			</router-view>
		</template>

		<template v-else>
			<div v-if="posStore.isLoading" class="flex items-center justify-center h-full bg-background">
				<div class="text-center">
					<div class="relative w-16 h-16 mx-auto mb-4">
						<div class="absolute inset-0 rounded-full border-4 border-muted"></div>
						<div
							class="absolute inset-0 rounded-full border-4 border-primary border-t-transparent animate-spin"
						></div>
					</div>
					<h2 class="text-xl font-semibold text-foreground">Loading X POS</h2>
					<p class="text-muted-foreground mt-1">Preparing your workspace...</p>
				</div>
			</div>

			<OpeningDialog v-else-if="posStore.showOpeningDialog" />

			<DefaultLayout v-else-if="posStore.isReady">
				<router-view v-slot="{ Component }">
					<transition name="fade" mode="out-in">
						<component :is="Component" />
					</transition>
				</router-view>
			</DefaultLayout>

			<ClosingDialog v-if="posStore.showClosingDialog" />

			<PaymentDialog v-if="cartStore.showPaymentDialog" />

			<GiftCardIssuedDialog v-if="cartStore.issuedGiftCards.length" />

			<CustomerSelect v-if="customerStore.showCustomerDialog" />

			<LoyaltyDialog v-if="customerStore.showLoyaltyDialog" />

			<ItemDetailDialog v-if="itemStore.showItemDetail" />

			<CashMovementDialog v-if="paymentStore.showCashMovementDialog" />

			<DraftInvoiceDialog v-if="cartStore.showDraftDialog" />

			<KeyboardShortcutsDialog
				v-if="shortcutsSeen"
				:open="showShortcutsDialog"
				@close="showShortcutsDialog = false"
			/>
			<AboutDialog v-if="aboutSeen" :open="showAboutDialog" @close="showAboutDialog = false" />

			<ConfirmDialog
				:open="showClearCartConfirm"
				:title="__('Clear cart?')"
				:description="__('All items and order details for this order will be lost.')"
				:confirm-label="__('Clear Cart')"
				variant="destructive"
				:icon="Trash2"
				@confirm="confirmClearCart"
				@cancel="showClearCartConfirm = false"
			/>
		</template>

		<ToastHost />
	</div>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onMounted, onUnmounted, provide, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { ToastHost } from "@/components/ui/toast";
import { usePosStore } from "@/stores/posStore";
import { useCartStore } from "@/stores/cartStore";
import { useCartSessionStore } from "@/stores/cartSessionStore";
import { useCustomerStore } from "@/stores/customerStore";
import { useItemStore } from "@/stores/itemStore";
import { usePaymentStore } from "@/stores/paymentStore";
import { useAuthStore } from "@/stores/authStore";
import DefaultLayout from "@/layouts/DefaultLayout.vue";
import OpeningDialog from "@/components/dialogs/OpeningDialog.vue";
import ConfirmDialog from "@/components/dialogs/ConfirmDialog.vue";
import SplashScreen from "@/components/SplashScreen.vue";
import AppStatusBanner from "@/components/offline/AppStatusBanner.vue";
import { Trash2 } from "lucide-vue-next";
import { useOfflineStore } from "@/stores/offlineStore";
import { showError } from "@/services/api";
import __ from "@/lib/translate";
import { useKeyboardShortcuts } from "@/composables/useKeyboardShortcuts";
import { usePrintInvoice } from "@/composables/usePrintInvoice";
import { getCustomer } from "./utils";
import { onIdle } from "@/utils/idle";
import { useEverTrue } from "@/composables/useEverTrue";

const route = useRoute();
const posStore = usePosStore();
const { openInvoicePrintView } = usePrintInvoice();
const cartStore = useCartStore();
const cartSessions = useCartSessionStore();
const customerStore = useCustomerStore();
const itemStore = useItemStore();
const paymentStore = usePaymentStore();
const authStore = useAuthStore();
const offlineStore = useOfflineStore();
const isRtl = computed(() => document.documentElement.dir === "rtl");

const keyboardShortcuts = useKeyboardShortcuts();
const {
	showShortcutsDialog,
	showAboutDialog,
	init: initKeyboardShortcuts,
	destroy: destroyKeyboardShortcuts,
} = keyboardShortcuts;

const importPaymentDialog = () => import("@/components/dialogs/PaymentDialog.vue");
const importItemDetailDialog = () => import("@/components/dialogs/ItemDetailDialog.vue");
const importCustomerSelect = () => import("@/components/customer/CustomerSelect.vue");
const ClosingDialog = defineAsyncComponent(() => import("@/components/dialogs/ClosingDialog.vue"));
const PaymentDialog = defineAsyncComponent(importPaymentDialog);
const GiftCardIssuedDialog = defineAsyncComponent(
	() => import("@/components/dialogs/GiftCardIssuedDialog.vue"),
);
const CustomerSelect = defineAsyncComponent(importCustomerSelect);
const LoyaltyDialog = defineAsyncComponent(() => import("@/components/dialogs/LoyaltyDialog.vue"));
const ItemDetailDialog = defineAsyncComponent(importItemDetailDialog);
const CashMovementDialog = defineAsyncComponent(() => import("@/components/dialogs/CashMovementDialog.vue"));
const DraftInvoiceDialog = defineAsyncComponent(() => import("@/components/dialogs/DraftInvoiceDialog.vue"));
const KeyboardShortcutsDialog = defineAsyncComponent(
	() => import("@/components/dialogs/KeyboardShortcutsDialog.vue"),
);
const AboutDialog = defineAsyncComponent(() => import("@/components/dialogs/AboutDialog.vue"));

const shortcutsSeen = useEverTrue(showShortcutsDialog);
const aboutSeen = useEverTrue(showAboutDialog);

const isAuthPage = computed(() => route.meta.isAuthPage === true);
const isFullScreen = computed(() => route.meta.fullScreen === true);

const showClearCartConfirm = ref(false);

function handleClearCart() {
	const allowed = cartSessions.canDiscard(cartSessions.activeId);
	if (!allowed.ok) {
		showError(allowed.reason || "");
		return;
	}
	if (!cartStore.isEmpty) {
		showClearCartConfirm.value = true;
		return;
	}
	doClearCart();
}

function confirmClearCart() {
	showClearCartConfirm.value = false;
	doClearCart();
}

async function doClearCart() {
	cartStore.clearCart();
	if (!cartStore.customer && posStore.defaultCustomer) {
		const customer = await getCustomer(posStore.defaultCustomer);
		cartStore.setCustomer(customer as any);
	}
}

function handleProcessPayment() {
	if (!window.dispatchEvent(new CustomEvent("xpos:checkout", { cancelable: true }))) return;
	if (cartStore.items.length > 0 && posStore.isShiftOpen) {
		const opened = cartStore.openPaymentDialog();
		if (!opened.success) showError(opened.message);
	}
}

function handleSelectCustomer() {
	customerStore.showCustomerDialog = true;
}

function handleShowDrafts() {
	cartStore.showDraftDialog = true;
}

function handleHoldInvoice() {
	if (!window.dispatchEvent(new CustomEvent("xpos:hold-sale", { cancelable: true }))) return;
	if (cartStore.items.length > 0) {
		cartStore.openDraftDialog();
	}
}

function handleRemoveLastItem() {
	if (cartStore.items.length === 0) return;

	const activeEl = document.activeElement as HTMLElement | null;
	const focusedRow = activeEl?.closest("[data-cart-index]") as HTMLElement | null;
	const focusedIndexRaw = focusedRow?.getAttribute("data-cart-index") || "";
	const focusedIndex = Number.parseInt(focusedIndexRaw, 10);
	const selectedIndex = cartStore.selectedCartIndex;

	const indexToRemove =
		!Number.isNaN(focusedIndex) && focusedIndex >= 0
			? focusedIndex
			: selectedIndex >= 0
				? selectedIndex
				: cartStore.items.length - 1;

	cartStore.removeItem(indexToRemove);

	nextTick(() => {
		const nextIndex = cartStore.selectedCartIndex;
		if (nextIndex < 0) return;
		const nextRow = document.querySelector(`[data-cart-index="${nextIndex}"]`) as HTMLElement | null;
		nextRow?.focus();
		nextRow?.scrollIntoView({ block: "nearest", behavior: "smooth" });
	});
}

function handleCloseShift() {
	if (posStore.isShiftOpen) {
		posStore.showClosingDialog = true;
		posStore.fetchClosingData();
	}
}

function handleCashExpense() {
	if (posStore.allowPosExpense && posStore.isShiftOpen) {
		paymentStore.openCashMovement("expense");
	}
}

function handleCashDeposit() {
	if (posStore.allowCashDeposit && posStore.isShiftOpen) {
		paymentStore.openCashMovement("deposit");
	}
}

function handlePrintLast() {
	const name = posStore.lastInvoiceName;
	if (!name) return;
	void openInvoicePrintView(name);
}

function handleShowShortcutsDialog() {
	showShortcutsDialog.value = true;
}

function handleShowAboutDialog() {
	showAboutDialog.value = true;
}

const theme = ref<"light" | "dark" | "system">("system");
const systemPrefersDark = ref(window.matchMedia("(prefers-color-scheme: dark)").matches);

const isDark = computed(() => {
	if (theme.value === "system") {
		return systemPrefersDark.value;
	}
	return theme.value === "dark";
});

function applyThemeToDocument(dark: boolean) {
	const html = document.documentElement;
	const themeColor = document.querySelector('meta[name="theme-color"]');
	if (themeColor) themeColor.setAttribute("content", dark ? "#0b1220" : "#e8ecf2");
	if (dark) {
		html.classList.add("dark");
		html.classList.remove("light");
	} else {
		html.classList.add("light");
		html.classList.remove("dark");
	}
}

watch(
	isDark,
	(dark) => {
		applyThemeToDocument(dark);
	},
	{ immediate: true },
);

function toggleDarkMode() {
	if (theme.value === "light") {
		theme.value = "dark";
	} else if (theme.value === "dark") {
		theme.value = "system";
	} else {
		theme.value = "light";
	}
	localStorage.setItem("xpos-theme", theme.value);
}

provide("isDark", isDark);
provide("theme", theme);
provide("toggleDarkMode", toggleDarkMode);

const showSplash = ref(false);

let mediaQuery: MediaQueryList | null = null;
function handleSystemThemeChange(e: MediaQueryListEvent) {
	systemPrefersDark.value = e.matches;
}

function guardUnsavedCart(event: BeforeUnloadEvent) {
	if (cartSessions.unfinishedCount() === 0) return;
	event.preventDefault();
	event.returnValue = "";
}

onMounted(() => {
	window.addEventListener("beforeunload", guardUnsavedCart);
	const saved = localStorage.getItem("xpos-theme") as "light" | "dark" | "system" | null;
	if (saved && ["light", "dark", "system"].includes(saved)) {
		theme.value = saved;
	} else {
		const oldSaved = localStorage.getItem("xpos-dark-mode");
		if (oldSaved === "1") {
			theme.value = "dark";
		} else if (oldSaved === "0") {
			theme.value = "light";
		}
		localStorage.setItem("xpos-theme", theme.value);
	}

	applyThemeToDocument(isDark.value);

	showSplash.value = true;
	window.setTimeout(() => {
		showSplash.value = false;
	}, 700);

	mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
	mediaQuery.addEventListener("change", handleSystemThemeChange);

	if (!isAuthPage.value) {
		posStore.checkExistingShift();
	}

	offlineStore.init();
	initKeyboardShortcuts();

	onIdle(() => {
		void importPaymentDialog();
		void importItemDetailDialog();
		void importCustomerSelect();
	});

	window.addEventListener("xpos:clear-cart", handleClearCart as EventListener);
	window.addEventListener("xpos:process-payment", handleProcessPayment as EventListener);
	window.addEventListener("xpos:select-customer", handleSelectCustomer as EventListener);
	window.addEventListener("xpos:show-drafts", handleShowDrafts as EventListener);
	window.addEventListener("xpos:hold-invoice", handleHoldInvoice as EventListener);
	window.addEventListener("xpos:remove-last-item", handleRemoveLastItem as EventListener);
	window.addEventListener("xpos:close-shift", handleCloseShift as EventListener);
	window.addEventListener("xpos:cash-expense", handleCashExpense as EventListener);
	window.addEventListener("xpos:cash-deposit", handleCashDeposit as EventListener);
	window.addEventListener("xpos:print-last", handlePrintLast as EventListener);
	window.addEventListener("xpos:show-shortcuts-dialog", handleShowShortcutsDialog as EventListener);
	window.addEventListener("xpos:show-about-dialog", handleShowAboutDialog as EventListener);
});

watch(isAuthPage, (isAuth, wasAuth) => {
	if (wasAuth && !isAuth && authStore.isAuthenticated) {
		posStore.checkExistingShift();
	}
});

watch(
	() => posStore.isReady,
	async (ready, wasReady) => {
		if (wasReady && !ready) {
			const saved = cartSessions.onShiftEnded();
			cartStore.clearAll();
			await saved;
		}
		if (ready && !wasReady) {
			await cartSessions.sync(true);
			if (!cartStore.customer && posStore.defaultCustomer) {
				const customer = await getCustomer(posStore.defaultCustomer);
				cartStore.setCustomer(customer as any);
			}
		}
	},
);

watch(
	() => [posStore.profileName, authStore.userName, posStore.posOpeningShift?.name],
	() => {
		if (posStore.isReady) void cartSessions.sync(true);
	},
);

onUnmounted(() => {
	window.removeEventListener("beforeunload", guardUnsavedCart);
	if (mediaQuery) {
		mediaQuery.removeEventListener("change", handleSystemThemeChange);
	}
	offlineStore.destroy();
	destroyKeyboardShortcuts();

	window.removeEventListener("xpos:clear-cart", handleClearCart as EventListener);
	window.removeEventListener("xpos:process-payment", handleProcessPayment as EventListener);
	window.removeEventListener("xpos:select-customer", handleSelectCustomer as EventListener);
	window.removeEventListener("xpos:show-drafts", handleShowDrafts as EventListener);
	window.removeEventListener("xpos:hold-invoice", handleHoldInvoice as EventListener);
	window.removeEventListener("xpos:remove-last-item", handleRemoveLastItem as EventListener);
	window.removeEventListener("xpos:close-shift", handleCloseShift as EventListener);
	window.removeEventListener("xpos:cash-expense", handleCashExpense as EventListener);
	window.removeEventListener("xpos:cash-deposit", handleCashDeposit as EventListener);
	window.removeEventListener("xpos:print-last", handlePrintLast as EventListener);
	window.removeEventListener("xpos:show-shortcuts-dialog", handleShowShortcutsDialog as EventListener);
	window.removeEventListener("xpos:show-about-dialog", handleShowAboutDialog as EventListener);
});
</script>
