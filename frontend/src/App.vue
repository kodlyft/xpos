<template>
	<div
		id="xpos-app"
		:class="[
			'h-screen w-screen font-sans',
			isDark ? 'dark' : '',
			isAuthPage ? 'overflow-y-auto' : 'overflow-hidden',
			isRtl ? 'rtl' : 'ltr',
		]"
	>
		<SplashScreen :show="showSplash" />

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

			<CustomerSelect v-if="customerStore.showCustomerDialog" />

			<LoyaltyDialog v-if="customerStore.showLoyaltyDialog" />

			<ItemDetailDialog v-if="itemStore.showItemDetail" />

			<CashMovementDialog v-if="paymentStore.showCashMovementDialog" />

			<DraftInvoiceDialog v-if="cartStore.showDraftDialog" />

			<KeyboardShortcutsDialog :open="showShortcutsDialog" @close="showShortcutsDialog = false" />
			<AboutDialog :open="showAboutDialog" @close="showAboutDialog = false" />

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

		<Toaster
			:theme="isDark ? 'dark' : 'light'"
			:position="isRtl ? 'bottom-left' : 'bottom-right'"
			:duration="4000"
			:expand="true"
			rich-colors
			close-button
			:dir="isRtl ? 'rtl' : 'ltr'"
		/>
		<ErrorInspector v-model:open="showErrorInspector" />
		<Transition name="fade">
			<button
				v-if="!isAuthPage && errorCount > 0 && !showErrorInspector"
				type="button"
				class="fixed bottom-3 end-3 z-50 flex items-center gap-1.5 rounded-full bg-destructive px-3 py-1 text-xs font-medium text-destructive-foreground shadow-md select-none cursor-pointer"
				:title="__('Open Error Inspector')"
				@click="showErrorInspector = true"
			>
				<AlertTriangle class="w-3.5 h-3.5" />
				<span>{{ errorCount }}</span>
			</button>
		</Transition>

		<Transition name="fade">
			<TooltipWrapper
				v-if="!isAuthPage && isElectronEnv"
				:content="
					offlineStore.deadLetterCount > 0
						? offlineStore.deadLetterCount + ' invoice(s) failed to sync. Click to review'
						: syncStatus.lastError.value ||
							(syncStatus.lastSyncTime.value
								? 'Last sync: ' + syncStatus.lastSyncTime.value
								: 'Not synced yet')
				"
				side="right"
			>
				<button
					type="button"
					class="fixed bottom-3 start-3 z-50 flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium shadow-md select-none cursor-pointer"
					:class="
						syncStatus.isSyncing.value
							? 'bg-blue-600 text-white'
							: offlineStore.deadLetterCount > 0 || syncStatus.lastError.value
								? 'bg-destructive text-destructive-foreground'
								: 'bg-muted text-muted-foreground'
					"
					@click="handleOpenOfflinePanel"
				>
					<span
						v-if="syncStatus.isSyncing.value"
						class="w-2 h-2 rounded-full bg-white animate-ping"
					/>
					<span
						v-else
						class="w-2 h-2 rounded-full"
						:class="
							offlineStore.deadLetterCount > 0 || syncStatus.lastError.value
								? 'bg-white'
								: 'bg-green-400'
						"
					/>
					<span>
						<template v-if="syncStatus.isSyncing.value">
							Syncing{{
								syncStatus.syncTable.value ? ": " + syncStatus.syncTable.value : "..."
							}}
						</template>
						<template v-else-if="offlineStore.deadLetterCount > 0"
							>{{ offlineStore.deadLetterCount }} need attention</template
						>
						<template v-else-if="syncStatus.lastError.value">Sync error</template>
						<template v-else-if="syncStatus.lastSyncTime.value"
							>Synced {{ syncStatus.lastSyncTime.value }}</template
						>
						<template v-else>Sync pending</template>
					</span>
				</button>
			</TooltipWrapper>
		</Transition>
	</div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, provide, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { Toaster } from "vue-sonner";
import { usePosStore } from "@/stores/posStore";
import { useCartStore } from "@/stores/cartStore";
import { useCustomerStore } from "@/stores/customerStore";
import { useItemStore } from "@/stores/itemStore";
import { usePaymentStore } from "@/stores/paymentStore";
import { useAuthStore } from "@/stores/authStore";
import DefaultLayout from "@/layouts/DefaultLayout.vue";
import OpeningDialog from "@/components/dialogs/OpeningDialog.vue";
import ClosingDialog from "@/components/dialogs/ClosingDialog.vue";
import PaymentDialog from "@/components/dialogs/PaymentDialog.vue";
import CustomerSelect from "@/components/customer/CustomerSelect.vue";
import LoyaltyDialog from "@/components/dialogs/LoyaltyDialog.vue";
import ItemDetailDialog from "@/components/dialogs/ItemDetailDialog.vue";
import CashMovementDialog from "@/components/dialogs/CashMovementDialog.vue";
import DraftInvoiceDialog from "@/components/dialogs/DraftInvoiceDialog.vue";
import KeyboardShortcutsDialog from "@/components/dialogs/KeyboardShortcutsDialog.vue";
import AboutDialog from "@/components/dialogs/AboutDialog.vue";
import ConfirmDialog from "@/components/dialogs/ConfirmDialog.vue";
import SplashScreen from "@/components/SplashScreen.vue";
import { useBranding } from "@/composables/useBranding";
import { TooltipWrapper } from "@/components/ui/tooltip";
import { AlertTriangle, Trash2 } from "lucide-vue-next";
import { useOfflineStore } from "@/stores/offlineStore";
import { initSyncListeners } from "@/services/syncIpcHandler";
import { showError } from "@/services/api";
import __ from "@/lib/translate";
import { useSyncStatus } from "@/composables/useSyncStatus";
import { useKeyboardShortcuts } from "@/composables/useKeyboardShortcuts";
import { isElectron } from "@/services/electronBridge";
import ErrorInspector from "@/components/errors/ErrorInspector.vue";
import { unseenCount as errorUnseenCount } from "@/services/errorLog";
import { get_full_url } from "@/utils";
import { getCustomer } from "./utils";

const route = useRoute();
const posStore = usePosStore();
const cartStore = useCartStore();
const customerStore = useCustomerStore();
const itemStore = useItemStore();
const paymentStore = usePaymentStore();
const authStore = useAuthStore();
const offlineStore = useOfflineStore();
const syncStatus = useSyncStatus();
const isElectronEnv = isElectron();
const showErrorInspector = ref(false);
const errorCount = errorUnseenCount;
const isRtl = computed(() => document.documentElement.dir === "rtl");

const keyboardShortcuts = useKeyboardShortcuts();
const {
	showShortcutsDialog,
	showAboutDialog,
	init: initKeyboardShortcuts,
	destroy: destroyKeyboardShortcuts,
} = keyboardShortcuts;

const isAuthPage = computed(() => route.meta.isAuthPage === true || route.meta.isSetupPage === true);
const isFullScreen = computed(() => route.meta.fullScreen === true);

const showClearCartConfirm = ref(false);

function handleClearCart() {
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
	if (cartStore.items.length > 0 && posStore.isShiftOpen) {
		cartStore.showPaymentDialog = true;
	}
}

function handleSelectCustomer() {
	customerStore.showCustomerDialog = true;
}

function handleShowDrafts() {
	cartStore.showDraftDialog = true;
}

function handleHoldInvoice() {
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
	window.open(
		get_full_url(
			`/printview?doctype=${posStore.invoiceType}&name=${name}&format=${posStore.defaultPrintFormat}&no_letterhead=0&trigger_print=1`,
		),
		"_blank",
	);
}

function handleShowShortcutsDialog() {
	showShortcutsDialog.value = true;
}

function handleShowAboutDialog() {
	showAboutDialog.value = true;
}

function handleToggleErrorInspector() {
	showErrorInspector.value = !showErrorInspector.value;
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

const { initBranding, enableSplash } = useBranding();
const showSplash = ref(false);

let mediaQuery: MediaQueryList | null = null;
let cleanupSyncListeners: (() => void) | null = null;
function handleSystemThemeChange(e: MediaQueryListEvent) {
	systemPrefersDark.value = e.matches;
}

onMounted(() => {
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

	const brandingReady = initBranding();
	showSplash.value = enableSplash.value;
	brandingReady.finally(() => {
		window.setTimeout(() => {
			showSplash.value = false;
		}, 700);
	});

	mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
	mediaQuery.addEventListener("change", handleSystemThemeChange);

	if (!isAuthPage.value) {
		posStore.checkExistingShift();
	}

	offlineStore.init();
	cleanupSyncListeners = initSyncListeners();
	initKeyboardShortcuts();

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
	window.addEventListener("xpos:toggle-error-inspector", handleToggleErrorInspector as EventListener);
});

watch(
	() => syncStatus.deadLetters.value.length,
	(count, prev) => {
		if (count > (prev ?? 0)) {
			offlineStore.refreshDeadLetterCount();
			const latest = syncStatus.deadLetters.value[0];
			showError(
				__(
					"Invoice {0} failed to sync and needs attention. Open the offline invoices panel to review.",
					[latest?.localId ?? ""],
				),
			);
		}
	},
);

function handleOpenOfflinePanel() {
	window.dispatchEvent(new CustomEvent("xpos:open-offline-panel"));
}

watch(isAuthPage, (isAuth, wasAuth) => {
	if (wasAuth && !isAuth && authStore.isAuthenticated) {
		posStore.checkExistingShift();
	}
});

watch(
	() => posStore.isReady,
	async (ready, wasReady) => {
		if (wasReady && !ready) {
			cartStore.clearAll();
		}
		if (ready && !wasReady) {
			if (!cartStore.customer && posStore.defaultCustomer) {
				const customer = await getCustomer(posStore.defaultCustomer);
				cartStore.setCustomer(customer as any);
			}
		}
	},
);

onUnmounted(() => {
	if (mediaQuery) {
		mediaQuery.removeEventListener("change", handleSystemThemeChange);
	}
	if (cleanupSyncListeners) {
		cleanupSyncListeners();
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
	window.removeEventListener("xpos:toggle-error-inspector", handleToggleErrorInspector as EventListener);
});
</script>
