<template>
	<div class="flex h-full flex-col overflow-hidden">
		<CartTabs v-if="!tabsInPanel && cartTabsPlacement === 'top'" class="pt-2" placement="top" />
		<div
			class="mx-3 mt-2 flex shrink-0 items-center gap-1 rounded-xl border border-border bg-surface-sunken p-1 shadow-inset lg:hidden"
			role="tablist"
			:aria-label="__('Point of sale')"
		>
			<button
				id="pos-tab-items"
				role="tab"
				aria-controls="pos-products"
				:aria-selected="activeTab === 'items'"
				:tabindex="activeTab === 'items' ? 0 : -1"
				class="flex h-10 flex-1 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
				:class="
					activeTab === 'items'
						? 'border border-border bg-card text-foreground shadow-raised'
						: 'text-muted-foreground'
				"
				@click="activeTab = 'items'"
				@keydown.left.prevent="switchTab"
				@keydown.right.prevent="switchTab"
			>
				<Package class="size-4" aria-hidden="true" />
				{{ __("Products") }}
			</button>
			<button
				id="pos-tab-cart"
				role="tab"
				aria-controls="pos-cart"
				:aria-selected="activeTab === 'cart'"
				:tabindex="activeTab === 'cart' ? 0 : -1"
				class="flex h-10 flex-1 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
				:class="
					activeTab === 'cart'
						? 'border border-border bg-card text-foreground shadow-raised'
						: 'text-muted-foreground'
				"
				@click="activeTab = 'cart'"
				@keydown.left.prevent="switchTab"
				@keydown.right.prevent="switchTab"
			>
				<ShoppingCart class="size-4" aria-hidden="true" />
				{{ __("Current sale") }}
				<span
					v-if="cartStore.itemCount > 0"
					class="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-bold text-primary-foreground tabular-nums"
				>
					{{ cartStore.itemCount }}
				</span>
			</button>
		</div>

		<div
			ref="rowRef"
			class="relative flex min-h-0 flex-1 overflow-hidden p-3 pt-2 lg:pt-3"
			:style="{ '--cart-w': `${cartWidth}px` }"
			:data-density="layoutStore.device.density"
			:data-cart-side="cartSide"
		>
			<section
				id="pos-products"
				ref="itemsPanelRef"
				aria-labelledby="pos-tab-items"
				:class="[
					'min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border bg-card/50 shadow-raised lg:flex',
					cartSide === 'left' ? 'lg:order-3' : 'lg:order-1',
					activeTab === 'items' ? 'flex' : 'hidden',
				]"
				@focusin="activeZone = 'items'"
				@click="activeZone = 'items'"
			>
				<CartTabs v-if="tabsInPanel" class="px-2 pt-2" placement="top" />
				<div class="shrink-0 space-y-1.5 p-3 pb-1.5">
					<div class="flex items-center gap-2">
						<SearchBar
							ref="searchBarRef"
							class="flex-1"
							@search="onSearch"
							@enter="onSearchEnter"
							@navigate="onNavigate"
							@scan="handleScanButton"
						/>
						<div
							class="hidden h-12 shrink-0 items-center gap-0.5 rounded-xl border border-border bg-surface-sunken p-1 shadow-inset sm:flex"
							role="group"
							:aria-label="__('View')"
						>
							<TooltipWrapper :content="__('Grid view')" shortcut="F5">
								<button
									type="button"
									class="inline-flex size-10 items-center justify-center rounded-lg transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
									:class="
										viewMode === 'grid'
											? 'border border-border bg-card text-foreground shadow-raised'
											: 'text-muted-foreground hover:text-foreground'
									"
									:aria-label="__('Grid view')"
									:aria-pressed="viewMode === 'grid'"
									@click="setViewMode('grid')"
								>
									<LayoutGrid class="size-4.5" />
								</button>
							</TooltipWrapper>
							<TooltipWrapper :content="__('List view')" shortcut="F5">
								<button
									type="button"
									class="inline-flex size-10 items-center justify-center rounded-lg transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
									:class="
										viewMode === 'list'
											? 'border border-border bg-card text-foreground shadow-raised'
											: 'text-muted-foreground hover:text-foreground'
									"
									:aria-label="__('List view')"
									:aria-pressed="viewMode === 'list'"
									@click="setViewMode('list')"
								>
									<List class="size-4.5" />
								</button>
							</TooltipWrapper>
						</div>
						<TooltipWrapper v-if="layoutStore.canCustomize" :content="__('Customize view')">
							<Button
								variant="outline"
								size="icon"
								class="size-12 shrink-0 rounded-xl"
								:class="layoutStore.customizing && 'border-primary text-primary'"
								:aria-label="__('Customize view')"
								:aria-pressed="layoutStore.customizing"
								data-testid="customize-open"
								@click="
									layoutStore.customizing
										? layoutStore.cancelCustomize()
										: startCustomizing()
								"
							>
								<SlidersHorizontal class="size-4.5" />
							</Button>
						</TooltipWrapper>
					</div>
					<CategoryBar
						:groups="itemStore.itemGroups"
						:parent-groups="itemStore.parentGroups"
						:selected="itemStore.selectedGroup"
						@select="selectGroup"
						@picked="searchBarRef?.focus()"
					/>
					<QuickAccess
						:favorites="layoutStore.shared.favoriteCategories"
						:pinned="layoutStore.pinnedItems"
						:selected="itemStore.selectedGroup"
						:groups="itemStore.itemGroups.map((group) => group.name)"
						@select-group="selectGroup"
						@add-item="handleAddItem"
					/>
				</div>

				<div ref="itemsScrollRef" class="min-h-0 flex-1 overflow-y-auto px-3 pb-3 xpos-scrollbar">
					<ItemGrid
						ref="itemGridRef"
						:scroll-element="itemsScrollRef"
						:items="itemStore.items"
						:is-loading="itemStore.isLoading"
						:load-error="itemStore.loadError"
						:has-filters="hasFilters"
						:hide-images="posStore.hideImages"
						:currency-symbol="posStore.currencySymbol"
						:view-mode="viewMode"
						:highlighted-index="highlightedIndex"
						@select-item="handleAddItem"
						@show-detail="handleShowDetail"
						@load-more="handleLoadMore"
						@retry="reloadItems"
						@clear-filters="clearFilters"
					/>
				</div>

				<div v-if="cartStore.itemCount > 0" class="shrink-0 border-t border-border p-2 lg:hidden">
					<button
						type="button"
						class="flex h-12 w-full items-center justify-between gap-3 rounded-xl bg-primary px-4 text-primary-foreground shadow-primary transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2"
						data-testid="checkout-bar"
						@click="showCart"
					>
						<span class="flex items-center gap-2 text-sm font-semibold">
							<ShoppingCart class="size-4.5" aria-hidden="true" />
							{{
								cartStore.itemCount === 1
									? __("1 item")
									: __("{0} items", [cartStore.itemCount])
							}}
						</span>
						<span class="flex items-center gap-2 text-base font-bold tabular-nums">
							{{ __("Review sale") }} · {{ mobileCartTotal }}
							<ChevronRight class="size-4.5 rtl:rotate-180" aria-hidden="true" />
						</span>
					</button>
				</div>
			</section>

			<PaneSplitter
				v-model="cartWidth"
				data-testid="cart-splitter"
				class="mx-0.5 hidden lg:order-2 lg:flex"
				:side="cartSide === 'left' ? 'start' : 'end'"
				:min="cartBounds.min"
				:max="cartBounds.max"
				:default-value="cartBounds.preferred"
				:label="__('Resize cart')"
				@commit="saveCartWidth"
			/>

			<section
				id="pos-cart"
				ref="cartPanelRef"
				tabindex="-1"
				aria-labelledby="pos-tab-cart"
				:class="[
					'min-w-0 flex-col overflow-hidden rounded-2xl border border-border bg-card/50 shadow-raised focus:outline-none lg:flex lg:w-(--cart-w) lg:flex-none',
					cartSide === 'left' ? 'lg:order-1' : 'lg:order-3',
					activeTab === 'cart' ? 'flex flex-1' : 'hidden',
				]"
				@focusin="activeZone = 'cart'"
				@click="activeZone = 'cart'"
			>
				<Cart />
			</section>

			<div
				v-if="layoutStore.customizing"
				class="absolute inset-y-3 z-30 flex max-sm:inset-x-3"
				:class="cartSide === 'left' ? 'inset-e-3' : 'inset-s-3'"
			>
				<CustomizePanel
					:current-cart-width="cartWidth"
					:wide="rowWidth >= 1024"
					@close="stopCustomizing"
				/>
			</div>

			<CameraBarcodeDialog
				v-if="cameraSeen"
				:open="showCameraScanner"
				@close="showCameraScanner = false"
				@scanned="onCameraScan"
			/>

			<CommandSearch
				ref="commandSearchRef"
				:pos-profile="posStore.profileName"
				:currency-symbol="posStore.currencySymbol"
				@select-item="handleAddItem"
			/>
		</div>
		<CartTabs v-if="!tabsInPanel && cartTabsPlacement === 'bottom'" class="pb-2" placement="bottom" />
	</div>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { usePosStore } from "@/stores/posStore";
import { useMoney } from "@/composables/useMoney";
import { BarcodeScanError, useItemStore } from "@/stores/itemStore";
import { useCartStore } from "@/stores/cartStore";
import { useCartSessionStore } from "@/stores/cartSessionStore";
import { useOfferStore } from "@/stores/offerStore";
import { call, showError, isNetworkError } from "@/services/api";
import { cacheItemTax, getCachedItemTax } from "@/services/dbBridge";
import SearchBar from "@/components/items/SearchBar.vue";
import ItemGrid from "@/components/items/ItemGrid.vue";
import CommandSearch from "@/components/items/CommandSearch.vue";
import CategoryBar from "@/components/items/CategoryBar.vue";
import Cart from "@/components/cart/Cart.vue";
import PaneSplitter from "@/components/core/PaneSplitter.vue";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip";
import { ALL_GROUPS } from "@/composables/useCategoryTree";
import { ChevronRight, LayoutGrid, List, ShoppingCart, Package, SlidersHorizontal } from "lucide-vue-next";
import QuickAccess from "@/components/items/QuickAccess.vue";
import CustomizePanel from "@/components/layout/CustomizePanel.vue";
import { useLayoutStore } from "@/stores/layoutStore";
import { useAuthStore } from "@/stores/authStore";
import { deviceClassFor } from "@/services/posLayout";
import CartTabs from "@/components/cart/CartTabs.vue";

import { useEverTrue } from "@/composables/useEverTrue";
import type { POSItem } from "@/types/pos.types";
import __ from "@/lib/translate";

const CameraBarcodeDialog = defineAsyncComponent(
	() => import("@/components/dialogs/CameraBarcodeDialog.vue"),
);

const posStore = usePosStore();
const { money } = useMoney();
const itemStore = useItemStore();
const cartStore = useCartStore();
const cartSessions = useCartSessionStore();
const offerStore = useOfferStore();
const layoutStore = useLayoutStore();
const authStore = useAuthStore();

const viewMode = ref<"grid" | "list">("grid");
const activeTab = ref<"items" | "cart">("items");
const showCameraScanner = ref(false);
const cameraSeen = useEverTrue(showCameraScanner);
const mobileCartTotal = computed(() => money(Math.abs(cartStore.grandTotal)));

// The saved layout (personal, else the profile default) decides the view; F5 and the toggle
// only change it for this session, or the draft while customizing.
watch(
	() => layoutStore.shared.view,
	(view) => {
		viewMode.value = view;
	},
	{ immediate: true },
);

const searchBarRef = ref<InstanceType<typeof SearchBar> | null>(null);
const commandSearchRef = ref<InstanceType<typeof CommandSearch> | null>(null);
const itemsPanelRef = ref<HTMLElement | null>(null);
const itemsScrollRef = ref<HTMLElement | null>(null);
const itemGridRef = ref<InstanceType<typeof ItemGrid> | null>(null);
const cartPanelRef = ref<HTMLElement | null>(null);
const rowRef = ref<HTMLElement | null>(null);
const activeZone = ref<"items" | "cart">("items");
const highlightedIndex = ref(-1);

const hasFilters = computed(() => !!itemStore.searchTerm || itemStore.selectedGroup !== ALL_GROUPS);

/**
 * Cart width on wide screens. The saved layout supplies the preferred width; dragging the
 * splitter is a session-only change, or edits the draft while customizing. What is shown is
 * clamped so the catalogue keeps at least 32rem.
 */
const rowWidth = ref(0);
const dragCartWidth = ref<number | null>(null);
const cartBounds = computed(() => {
	const row = rowWidth.value || 1280;
	// Below ~27rem the cart's own rows (customer, line stepper) start to collide.
	const min = 432;
	const max = Math.max(min, Math.min(640, row * 0.45, row - 512 - 16));
	const preferred = Math.round(Math.min(max, Math.max(min, Math.min(520, row * 0.34))));
	return { min, max, preferred };
});
const cartWidth = computed({
	get: () => {
		const { min, max, preferred } = cartBounds.value;
		const wanted = dragCartWidth.value ?? layoutStore.device.cartWidth ?? preferred;
		return Math.round(Math.min(max, Math.max(min, wanted)));
	},
	set: (value: number) => {
		dragCartWidth.value = value;
	},
});
const cartSide = computed(() => layoutStore.device.cartSide);

const tabsInPanel = computed(() => layoutStore.deviceClass === "desktop");
const cartTabsPlacement = computed(() =>
	layoutStore.deviceClass === "phone" ? "top" : layoutStore.device.cartTabs,
);

let rowObserver: ResizeObserver | null = null;

function saveCartWidth(value: number) {
	if (layoutStore.customizing && layoutStore.draft) {
		layoutStore.draft.device[layoutStore.deviceClass].cartWidth = Math.round(value);
		dragCartWidth.value = null;
	}
}

function syncDeviceClass() {
	layoutStore.setDeviceClass(deviceClassFor(window.innerWidth));
}

function startCustomizing() {
	activeTab.value = "items";
	layoutStore.startCustomize();
}

watch(
	() => layoutStore.customizing,
	(now, before) => {
		if (before && !now) stopCustomizing();
	},
);

function stopCustomizing() {
	dragCartWidth.value = null;
	nextTick(() => searchBarRef.value?.focus());
}

const layoutScope = computed(() => ({
	user: authStore.userName,
	company: posStore.companyName,
	profile: posStore.profileName,
}));

watch(
	() =>
		[
			posStore.isReady,
			layoutScope.value.user,
			layoutScope.value.company,
			layoutScope.value.profile,
		] as const,
	([ready, user, company, profile]) => {
		if (ready && user && company && profile) void layoutStore.load({ user, company, profile });
	},
	{ immediate: true },
);

watch(
	() => layoutStore.customizing,
	(on) => {
		if (!on) dragCartWidth.value = null;
	},
);

// Pinned items preview live while editing; the saved list is reloaded after save/cancel in the store.
watch(
	() => layoutStore.draft?.shared.pinnedItems.join("|"),
	() => {
		if (layoutStore.customizing) void layoutStore.resolvePinned();
	},
);

function switchTab() {
	activeTab.value = activeTab.value === "items" ? "cart" : "items";
	nextTick(() => document.getElementById(`pos-tab-${activeTab.value}`)?.focus());
}

function showCart() {
	activeTab.value = "cart";
	nextTick(() => cartPanelRef.value?.focus());
}

function setViewMode(mode: "grid" | "list") {
	if (layoutStore.customizing && layoutStore.draft) layoutStore.draft.shared.view = mode;
	viewMode.value = mode;
	scrollHighlightedIntoView();
}

function scrollHighlightedIntoView() {
	if (highlightedIndex.value < 0) return;
	nextTick(() => itemGridRef.value?.scrollToIndex(highlightedIndex.value));
}

function reloadItems() {
	itemStore.fetchItems(posStore.profileName);
}

function clearFilters() {
	searchBarRef.value?.clear();
	itemStore.setSearchTerm("");
	itemStore.setSelectedGroup(ALL_GROUPS);
	itemStore.fetchItems(posStore.profileName);
	nextTick(() => searchBarRef.value?.focus());
}

onMounted(() => {
	syncDeviceClass();
	window.addEventListener("resize", syncDeviceClass);
	window.addEventListener("online", layoutStore.syncPending);
	if (rowRef.value && typeof ResizeObserver !== "undefined") {
		rowObserver = new ResizeObserver(([entry]) => (rowWidth.value = entry.contentRect.width));
		rowObserver.observe(rowRef.value);
	}
	if (posStore.isReady) {
		loadInitialData();
	}
	document.addEventListener("keydown", handleGlobalKeydown);
	window.addEventListener("xpos:toggle-view", handleToggleView as EventListener);
	window.addEventListener("xpos:focus-barcode", handleFocusBarcode as EventListener);
	window.addEventListener("xpos:focus-search", handleFocusSearch as EventListener);
	window.addEventListener("xpos:open-command-search", handleOpenCommandSearch as EventListener);
	nextTick(() => searchBarRef.value?.focus());
});

onUnmounted(() => {
	window.removeEventListener("resize", syncDeviceClass);
	window.removeEventListener("online", layoutStore.syncPending);
	rowObserver?.disconnect();
	document.removeEventListener("keydown", handleGlobalKeydown);
	window.removeEventListener("xpos:toggle-view", handleToggleView as EventListener);
	window.removeEventListener("xpos:focus-barcode", handleFocusBarcode as EventListener);
	window.removeEventListener("xpos:focus-search", handleFocusSearch as EventListener);
	window.removeEventListener("xpos:open-command-search", handleOpenCommandSearch as EventListener);
});

function handleToggleView() {
	setViewMode(viewMode.value === "grid" ? "list" : "grid");
}

function handleFocusBarcode() {
	searchBarRef.value?.select();
}

/** Touch devices open the camera scanner; with a pointer the field itself takes hardware scans. */
function handleScanButton() {
	if (window.matchMedia?.("(pointer: coarse)").matches) {
		showCameraScanner.value = true;
		return;
	}
	searchBarRef.value?.select();
}

function handleFocusSearch() {
	searchBarRef.value?.focus();
}

function handleOpenCommandSearch() {
	commandSearchRef.value?.open();
}

watch(
	() => posStore.isReady,
	(ready) => {
		if (ready) loadInitialData();
	},
);

watch(
	() => itemStore.items,
	(items, previous) => {
		const appended =
			previous?.length > 0 &&
			items.length >= previous.length &&
			items[0] === previous[0] &&
			items[previous.length - 1] === previous[previous.length - 1];
		if (!appended) highlightedIndex.value = -1;
	},
);

// Item dialogs hand focus back to search so the next scan lands there.
watch(
	() => [itemStore.showItemDetail, itemStore.showVariantPicker, showCameraScanner.value],
	(open, wasOpen) => {
		if (open.some(Boolean) || !wasOpen?.some(Boolean)) return;
		nextTick(() => {
			if (document.activeElement?.closest("[role='dialog']")) return;
			searchBarRef.value?.focus();
			scrollHighlightedIntoView();
		});
	},
);

watch(
	() => cartStore.showPaymentDialog,
	(open) => {
		if (!open) {
			highlightedIndex.value = -1;
		}
	},
);

async function loadInitialData() {
	await Promise.all([itemStore.fetchItems(posStore.profileName), itemStore.fetchItemGroups()]);

	cartStore.refreshPricingSnapshot(true).catch(() => {});

	nextTick(() => searchBarRef.value?.focus());
}

function onSearch(term: string) {
	itemStore.setSearchTerm(term);
	itemStore.fetchItems(posStore.profileName);
}

async function onSearchEnter(val: string) {
	// The highlight belongs to the search that produced it; new text (e.g. a scan) is looked up instead.
	const highlightIsCurrent = val === (itemStore.searchTerm || "").trim();
	if (
		highlightIsCurrent &&
		highlightedIndex.value >= 0 &&
		highlightedIndex.value < itemStore.items.length
	) {
		handleShowDetail(itemStore.items[highlightedIndex.value]);
		return;
	}

	if (!val) return;

	// One field for both: a matching barcode adds the item. Text stays a search; a barcode-shaped
	// value (6+ digits) that matches nothing still reports "not found", as the scanner field did.
	await onBarcodeScan(val, !/^\d{6,}$/.test(val));
}

async function onCameraScan(barcode: string) {
	showCameraScanner.value = false;
	await onBarcodeScan(barcode);
}

async function onBarcodeScan(barcode: string, fallbackToSearch = false) {
	if (!barcode) return;

	searchBarRef.value?.setScanning(true);
	const token = cartStore.captureCart();
	try {
		const result = await itemStore.searchByBarcode(barcode, posStore.profileName);
		if (!cartStore.isCurrentCart(token)) {
			// The cashier moved to another cart while the lookup ran; it must not land there.
			showError(__("Scan ignored because the cart changed. Scan it again."));
			return;
		}
		if (result && result.item_code) {
			const item = {
				item_code: result.item_code,
				item_name: result.item_name,
				rate: result.rate || 0,
				stock_uom: result.stock_uom || result.uom,
				uom: result.uom,
				conversion_factor: (result as { conversion_factor?: number }).conversion_factor || 1,
				image: result.image,
				has_batch_no: result.has_batch_no,
				has_serial_no: result.has_serial_no,
				actual_qty: result.actual_qty ?? 9999,
				batch_no: result.batch_no,
				serial_no: result.serial_no,
			} as POSItem;

			const scaleQty = Number(result.qty) || 0;
			if (result.is_scale_barcode && scaleQty > 0) {
				addScaleItem(item, scaleQty);
			} else {
				handleAddItem(item);
			}
			searchBarRef.value?.showSuccess();
			if (itemStore.searchTerm) onSearch("");
		} else if (fallbackToSearch) {
			onSearch(barcode);
		} else {
			showError(__(`Item not found for barcode: ${barcode}`));
			searchBarRef.value?.showError();
		}
	} catch (err) {
		if (err instanceof BarcodeScanError) {
			showError(err.message);
			searchBarRef.value?.showError();
		} else if (fallbackToSearch) {
			onSearch(barcode);
		} else {
			showError(__("Barcode lookup failed"));
			searchBarRef.value?.showError();
		}
	} finally {
		searchBarRef.value?.setScanning(false);
	}
}

function onNavigate(direction: "up" | "down") {
	const items = itemStore.items;
	if (items.length === 0) return;

	if (direction === "down") {
		highlightedIndex.value = Math.min(highlightedIndex.value + 1, items.length - 1);
	} else {
		highlightedIndex.value = Math.max(highlightedIndex.value - 1, -1);
		if (highlightedIndex.value === -1) {
			searchBarRef.value?.focus();
		}
	}

	nextTick(() => itemGridRef.value?.scrollToIndex(highlightedIndex.value));
}

function handleGlobalKeydown(e: KeyboardEvent) {
	const tag = (document.activeElement?.tagName || "").toLowerCase();
	const isInput = tag === "input" || tag === "textarea" || tag === "select";
	const isInDialog = document.activeElement?.closest("[role='dialog']");

	if (e.key === "F1" || e.key === "F2") {
		e.preventDefault();
		activeZone.value = "items";
		searchBarRef.value?.select();
		return;
	}
	if (e.key === "F5") {
		e.preventDefault();
		handleToggleView();
		return;
	}

	if (isInput) return;
	if (isInDialog) return;

	if (activeZone.value === "cart") {
		if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter") return;
	}

	if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
		e.preventDefault();
		activeZone.value = "items";
		searchBarRef.value?.setValue(e.key);
		searchBarRef.value?.focus();
		itemStore.setSearchTerm(e.key);
		itemStore.fetchItems(posStore.profileName);
		return;
	}

	if (e.key === "ArrowDown") {
		e.preventDefault();
		onNavigate("down");
	}
	if (e.key === "ArrowUp") {
		e.preventDefault();
		onNavigate("up");
	}

	if (e.key === "Enter" && highlightedIndex.value >= 0) {
		e.preventDefault();
		const item = itemStore.items[highlightedIndex.value];
		if (item) {
			handleShowDetail(item);
		}
	}
}

function selectGroup(group: string) {
	itemStore.setSelectedGroup(group);
	itemStore.fetchItems(posStore.profileName);
}

function addScaleItem(item: POSItem, qty: number) {
	if (!cartStore.customer) {
		showError(__("Please select a customer before adding items to the cart"));
		return;
	}

	const result = cartStore.addItemWithDetails(item, qty, item.rate || 0, item.uom || item.stock_uom);
	if (!result.success) {
		showError(result.message || __("Could not add item to cart"));
	}
}

function handleAddItem(item: POSItem) {
	if (!cartStore.customer) {
		showError(__("Please select a customer before adding items to the cart"));
		return;
	}

	if (item.has_variants && !posStore.hideVariantsItems) {
		itemStore.openVariantPicker(item, posStore.profileName);
		return;
	}

	if (posStore.inputQty) {
		handleShowDetail(item);
		return;
	}

	const result = cartStore.addItem(item);
	if (!result.success) {
		showError(result.message || __("Cannot add item to cart"));
		return;
	}
	const token = cartStore.captureCart();
	fetchAndApplyItemTax(item, token.cartId);

	if (posStore.fetchCoupon) {
		offerStore
			.fetchOffers(
				posStore.profileName,
				cartStore.items.map((i) => i.item_code),
				cartStore.customer?.name || "",
			)
			.then((offers) => {
				if (!cartStore.isCurrentCart(token)) return;
				if (offers && offers.length > 0) {
					for (const offer of offers) {
						if ((offer as Record<string, unknown>).auto) {
							cartStore.applyOffer(offer);
						}
					}
				}
			})
			.catch(() => {
				/* ignore */
			});
	}
}

/** Tax lands on the cart the item was added to, even if the cashier has since switched. */
function setTaxOn(cartId: string, itemCode: string, template: string, map: Record<string, number>) {
	if (cartStore.cartId === cartId) {
		cartStore.setItemTax(itemCode, template, map);
		return;
	}
	cartSessions.applyToCart(cartId, (snapshot) => {
		const line = snapshot.items.find((i) => i.item_code === itemCode);
		if (line) {
			line.item_tax_template = template;
			line.item_tax_map = map;
		}
	});
}

async function fetchAndApplyItemTax(item: POSItem, cartId: string = cartStore.cartId) {
	try {
		const taxData = await call<{
			item_tax_template: string | null;
			item_tax_map: Record<string, number>;
		}>("xpos.api.taxes.get_item_tax_template", {
			item_code: item.item_code,
			company: posStore.companyName,
			tax_category: "",
		});
		if (taxData && taxData.item_tax_template) {
			setTaxOn(cartId, item.item_code, taxData.item_tax_template, taxData.item_tax_map || {});

			cacheItemTax(item.item_code, posStore.companyName, {
				item_tax_template: taxData.item_tax_template,
				item_tax_map: taxData.item_tax_map || {},
			}).catch(() => {});
		}
	} catch (e) {
		if (isNetworkError(e)) {
			try {
				const cached = await getCachedItemTax(item.item_code, posStore.companyName);
				if (cached && cached.item_tax_template) {
					setTaxOn(cartId, item.item_code, cached.item_tax_template, cached.item_tax_map || {});
					return;
				}
			} catch {
				/* ignore cache errors */
			}
		}
		console.warn("Failed to fetch item tax template for", item.item_code, e);
	}
}

function handleShowDetail(item: POSItem) {
	itemStore.openItemDetail(item, posStore.profileName);
}

function handleLoadMore() {
	itemStore.loadMore(posStore.profileName);
}
</script>
