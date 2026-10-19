<template>
	<div class="flex flex-col h-full overflow-hidden">
		<div
			class="md:hidden shrink-0 flex items-center bg-muted/60 border-b border-border mx-3 mt-2 mb-0 rounded-xl overflow-hidden"
		>
			<button
				@click="activeTab = 'items'"
				class="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold transition-all rounded-xl"
				:class="
					activeTab === 'items'
						? 'bg-background text-foreground shadow-sm'
						: 'text-muted-foreground'
				"
			>
				<Package class="w-4 h-4" />
				{{ __("Items") }}
			</button>
			<button
				@click="activeTab = 'cart'"
				class="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold transition-all rounded-xl"
				:class="
					activeTab === 'cart' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'
				"
			>
				<ShoppingCart class="w-4 h-4" />
				{{ __("Cart") }}
				<span
					v-if="cartStore.itemCount > 0"
					class="inline-flex items-center justify-center min-w-5 h-5 px-1.5 text-[10px] font-bold rounded-full"
					:class="
						activeTab === 'cart'
							? 'bg-primary text-primary-foreground'
							: 'bg-primary/80 text-primary-foreground'
					"
				>
					{{ cartStore.itemCount }}
				</span>
				<span
					v-if="cartStore.itemCount > 0"
					class="text-[10px] font-medium leading-none"
					:class="activeTab === 'cart' ? 'text-primary' : 'text-muted-foreground'"
				>
					{{ mobileCartTotal }}
				</span>
			</button>
		</div>

		<div class="flex flex-1 overflow-hidden">
			<div
				ref="itemsPanelRef"
				:class="[
					'flex flex-col min-w-0 border-e border-border bg-background',
					'md:flex md:flex-1 md:max-w-[calc(100%-560px)] xl:max-w-[calc(100%-520px)]',
					activeTab === 'items' ? 'flex flex-1' : 'hidden',
				]"
				@focusin="activeZone = 'items'"
				@click="activeZone = 'items'"
			>
				<div class="shrink-0 p-3 sm:p-4 pb-1.5 sm:pb-2 space-y-2">
					<div class="flex items-center gap-2">
						<div class="flex-1 min-w-0">
							<SearchBar
								ref="searchBarRef"
								@search="onSearch"
								@enter="onSearchEnter"
								@navigate="onNavigate"
							/>
						</div>
						<div class="hidden sm:block w-52 shrink-0">
							<BarcodeScanner ref="barcodeScannerRef" @scanned="onBarcodeScan" />
						</div>
						<button
							class="sm:hidden shrink-0 flex items-center justify-center w-10 h-10 rounded-xl bg-primary/10 text-primary active:bg-primary/20 transition-colors"
							@click="showCameraScanner = true"
						>
							<ScanLine class="w-5 h-5" />
						</button>
						<div class="hidden sm:flex items-center gap-1 border rounded-lg p-1">
							<Button
								:variant="viewMode === 'grid' ? 'default' : 'ghost'"
								size="icon"
								class="h-8 w-8"
								@click="viewMode = 'grid'"
							>
								<LayoutGrid class="h-4 w-4" />
							</Button>
							<Button
								:variant="viewMode === 'list' ? 'default' : 'ghost'"
								size="icon"
								class="h-8 w-8"
								@click="viewMode = 'list'"
							>
								<List class="h-4 w-4" />
							</Button>
						</div>
					</div>
					<div class="flex items-center gap-2 overflow-x-auto pb-1 xpos-scrollbar">
						<Autocomplete
							:model-value="itemStore.selectedGroup"
							:options="groupAutocompleteOptions"
							:placeholder="__('Search item groups...')"
							:show-search-icon="true"
							:max-visible="12"
							:empty-text="__('No groups found')"
							class="w-40 sm:w-52 shrink-0 mt-2"
							@update:model-value="selectGroup($event)"
						/>
						<Button
							:variant="itemStore.selectedGroup === 'All Item Groups' ? 'default' : 'outline'"
							size="sm"
							class="rounded-full shrink-0 mt-2"
							@click="selectGroup('All Item Groups')"
						>
							{{ __("All Groups") }}
						</Button>
						<Button
							v-for="group in topGroups"
							:key="group.name"
							:variant="itemStore.selectedGroup === group.name ? 'default' : 'outline'"
							size="sm"
							class="rounded-full shrink-0 mt-2"
							@click="selectGroup(group.name)"
						>
							{{ __(group.name) }}
						</Button>
					</div>
				</div>

				<div class="flex-1 overflow-y-auto p-2 sm:p-4 pt-1 sm:pt-2 xpos-scrollbar">
					<ItemGrid
						:items="itemStore.items"
						:is-loading="itemStore.isLoading"
						:currency-symbol="posStore.currencySymbol"
						:view-mode="viewMode"
						:highlighted-index="highlightedIndex"
						@select-item="handleAddItem"
						@show-detail="handleShowDetail"
						@load-more="handleLoadMore"
					/>
				</div>
			</div>
			<div
				ref="cartPanelRef"
				class="hidden md:flex w-140 xl:w-130 flex-col bg-background dark:bg-card shrink-0"
				@focusin="activeZone = 'cart'"
				@click="activeZone = 'cart'"
			>
				<Cart />
			</div>

			<div
				ref="mobileCartPanelRef"
				:class="[
					'md:hidden flex flex-col flex-1 bg-background dark:bg-card overflow-hidden',
					activeTab === 'cart' ? 'flex' : 'hidden',
				]"
				@focusin="activeZone = 'cart'"
				@click="activeZone = 'cart'"
			>
				<Cart />
			</div>

			<CameraBarcodeDialog
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
	</div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { usePosStore } from "@/stores/posStore";
import { useMoney } from "@/composables/useMoney";
import { useItemStore } from "@/stores/itemStore";
import { useCartStore } from "@/stores/cartStore";
import { useOfferStore } from "@/stores/offerStore";
import { call, showError, isNetworkError } from "@/services/api";
import { cacheItemTax, getCachedItemTax } from "@/services/dbBridge";
import SearchBar from "@/components/items/SearchBar.vue";
import BarcodeScanner from "@/components/items/BarcodeScanner.vue";
import ItemGrid from "@/components/items/ItemGrid.vue";
import CommandSearch from "@/components/items/CommandSearch.vue";
import Cart from "@/components/cart/Cart.vue";
import { Button } from "@/components/ui/button";
import { Autocomplete } from "@/components/ui/autocomplete";
import { LayoutGrid, List, Search, ShoppingCart, Package, ScanLine } from "lucide-vue-next";

import CameraBarcodeDialog from "@/components/dialogs/CameraBarcodeDialog.vue";
import type { POSItem } from "@/types/pos.types";
import __ from "@/lib/translate";

const posStore = usePosStore();
const { money } = useMoney();
const itemStore = useItemStore();
const cartStore = useCartStore();
const offerStore = useOfferStore();

const viewMode = ref<"grid" | "list">("grid");
const activeTab = ref<"items" | "cart">("items");
const showCameraScanner = ref(false);
const mobileCartTotal = computed(() => money(Math.abs(cartStore.grandTotal)));

watch(
	() => posStore.defaultView,
	(defaultView) => {
		if (defaultView) {
			viewMode.value = defaultView.toLowerCase() === "list" ? "list" : "grid";
		}
	},
	{ immediate: true },
);

const searchBarRef = ref<InstanceType<typeof SearchBar> | null>(null);
const barcodeScannerRef = ref<InstanceType<typeof BarcodeScanner> | null>(null);
const commandSearchRef = ref<InstanceType<typeof CommandSearch> | null>(null);
const itemsPanelRef = ref<HTMLDivElement | null>(null);
const cartPanelRef = ref<HTMLDivElement | null>(null);
const mobileCartPanelRef = ref<HTMLDivElement | null>(null);
const activeZone = ref<"items" | "cart">("items");
const highlightedIndex = ref(-1);

const topGroups = computed(() => {
	const groups = itemStore.parentGroups.filter((g) => g.name !== "All Item Groups");
	return groups.slice(0, 12);
});

const groupAutocompleteOptions = computed(() => {
	const allOption = { label: __("All Groups"), value: "All Item Groups" };
	const groupOptions = itemStore.parentGroups
		.filter((g) => g.name !== "All Item Groups")
		.map((g) => ({ label: __(g.name), value: g.name }));
	return [allOption, ...groupOptions];
});

onMounted(() => {
	if (posStore.isReady) {
		loadInitialData();
	}
	document.addEventListener("keydown", handleGlobalKeydown);
	window.addEventListener("xpos:toggle-view", handleToggleView as EventListener);
	window.addEventListener("xpos:focus-barcode", handleFocusBarcode as EventListener);
	window.addEventListener("xpos:focus-search", handleFocusSearch as EventListener);
	window.addEventListener("xpos:open-command-search", handleOpenCommandSearch as EventListener);
	nextTick(() => barcodeScannerRef.value?.focus());
});

onUnmounted(() => {
	document.removeEventListener("keydown", handleGlobalKeydown);
	window.removeEventListener("xpos:toggle-view", handleToggleView as EventListener);
	window.removeEventListener("xpos:focus-barcode", handleFocusBarcode as EventListener);
	window.removeEventListener("xpos:focus-search", handleFocusSearch as EventListener);
	window.removeEventListener("xpos:open-command-search", handleOpenCommandSearch as EventListener);
});

function handleToggleView() {
	viewMode.value = viewMode.value === "grid" ? "list" : "grid";
}

function handleFocusBarcode() {
	barcodeScannerRef.value?.focus();
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
	() => {
		highlightedIndex.value = -1;
	},
);

watch(
	() => itemStore.showItemDetail,
	(open) => {
		if (!open && highlightedIndex.value >= 0) {
			nextTick(() => {
				searchBarRef.value?.focus();
				const el = document.querySelector(`[data-item-index="${highlightedIndex.value}"]`);
				el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
			});
		}
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

	nextTick(() => barcodeScannerRef.value?.focus());
}

function onSearch(term: string) {
	itemStore.setSearchTerm(term);
	itemStore.fetchItems(posStore.profileName);
}

async function onSearchEnter(val: string) {
	if (highlightedIndex.value >= 0 && highlightedIndex.value < itemStore.items.length) {
		handleShowDetail(itemStore.items[highlightedIndex.value]);
		return;
	}

	if (!val) return;

	onSearch(val);
}

async function onCameraScan(barcode: string) {
	showCameraScanner.value = false;
	await onBarcodeScan(barcode);
}

async function onBarcodeScan(barcode: string) {
	if (!barcode) return;

	barcodeScannerRef.value?.setScanning(true);
	try {
		const result = await itemStore.searchByBarcode(barcode, posStore.profileName);
		if (result && result.item_code) {
			const item = {
				item_code: result.item_code,
				item_name: result.item_name,
				rate: result.rate || 0,
				stock_uom: result.stock_uom || result.uom,
				uom: result.uom,
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
			barcodeScannerRef.value?.showSuccess();
		} else {
			showError(__(`Item not found for barcode: ${barcode}`));
			barcodeScannerRef.value?.showError();
		}
	} catch (err) {
		showError(__("Barcode lookup failed"));
		barcodeScannerRef.value?.showError();
	} finally {
		barcodeScannerRef.value?.setScanning(false);
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

	nextTick(() => {
		const el = document.querySelector(`[data-item-index="${highlightedIndex.value}"]`);
		el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
	});
}

function handleGlobalKeydown(e: KeyboardEvent) {
	const tag = (document.activeElement?.tagName || "").toLowerCase();
	const isInput = tag === "input" || tag === "textarea" || tag === "select";
	const isInDialog = document.activeElement?.closest("[role='dialog']");

	if (e.key === "F1") {
		e.preventDefault();
		activeZone.value = "items";
		barcodeScannerRef.value?.focus();
		return;
	}
	if (e.key === "F2") {
		e.preventDefault();
		activeZone.value = "items";
		searchBarRef.value?.focus();
		return;
	}
	if (e.key === "F5") {
		e.preventDefault();
		viewMode.value = viewMode.value === "grid" ? "list" : "grid";
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
	fetchAndApplyItemTax(item);

	if (posStore.fetchCoupon) {
		offerStore
			.fetchOffers(
				posStore.profileName,
				cartStore.items.map((i) => i.item_code),
				cartStore.customer?.name || "",
			)
			.then((offers) => {
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

async function fetchAndApplyItemTax(item: POSItem) {
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
			cartStore.setItemTax(item.item_code, taxData.item_tax_template, taxData.item_tax_map || {});

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
					cartStore.setItemTax(item.item_code, cached.item_tax_template, cached.item_tax_map || {});
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
