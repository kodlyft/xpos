<script setup lang="ts">
import { ref, onMounted, computed } from "vue";
import { useRouter } from "vue-router";
import { usePurchaseStore, type PurchaseCartItem } from "@/stores/purchaseStore";
import { Select } from "@/components/ui/select";
import { usePosStore } from "@/stores/posStore";
import { useMoney } from "@/composables/useMoney";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table } from "@/components/ui/table";
import type { TableColumn, TableRow } from "@/components/ui/table/types";
import type { AutocompleteOption } from "@/components/ui/autocomplete";
import {
	Plus,
	RefreshCw,
	X,
	ShoppingCart,
	ScanBarcode,
	Loader2,
	FileText,
	Download,
	List,
	Send,
} from "lucide-vue-next";
import type { SearchItem } from "@/types/pos.types";
import { showError } from "@/services/api";
import __ from "@/lib/translate";
import { Autocomplete } from "@/components/ui/autocomplete";
import { DateTimePicker } from "@/components/ui/datetime-picker";
import { CreateItemDialog, CreateSupplierDialog } from "@/components/purchase";

const router = useRouter();
const purchaseStore = usePurchaseStore();
const posStore = usePosStore();
const { money, qty } = useMoney();

const barcodeValue = ref("");
const isBarcodeScan = ref(false);
const barcodeFlash = ref<"" | "success" | "error">("");
let barcodeFlashTimer: ReturnType<typeof setTimeout> | null = null;

const showNewItemDialog = ref(false);
const showNewSupplierDialog = ref(false);

const poCategories = ["Projection Period", "Reorder Level"];

const grandTotal = computed(() => {
	return purchaseStore.cartItems.reduce((sum, item) => {
		const gross = item.qty * item.rate;
		const disc = item.discount_percent || 0;
		return sum + gross * (1 - disc / 100);
	}, 0);
});

const grossTotal = computed(() => {
	return purchaseStore.cartItems.reduce((sum, item) => sum + item.qty * item.rate, 0);
});

const totalDiscount = computed(() => {
	return grossTotal.value - grandTotal.value;
});

const projectionFromDate = ref("");
const projectionToDate = ref("");

const showCategoryButton = computed(() => {
	return purchaseStore.poCategory && purchaseStore.selectedSupplier;
});

function formatCurrency(value: number): string {
	return money(value);
}

function getItemAmount(item: PurchaseCartItem): number {
	const gross = item.qty * item.rate;
	const disc = item.discount_percent || 0;
	return gross * (1 - disc / 100);
}

async function onBarcodeScan(): Promise<void> {
	const code = barcodeValue.value.trim();
	if (!code) return;
	isBarcodeScan.value = true;
	try {
		const result = await purchaseStore.searchByBarcode(code);
		if (result) {
			purchaseStore.addToCart(result, 1);
			barcodeFlash.value = "success";
			barcodeValue.value = "";
		} else {
			showError(`${__("Item not found for barcode")}: ${code}`);
			barcodeFlash.value = "error";
		}
	} catch {
		barcodeFlash.value = "error";
	} finally {
		isBarcodeScan.value = false;
		if (barcodeFlashTimer) clearTimeout(barcodeFlashTimer);
		barcodeFlashTimer = setTimeout(() => {
			barcodeFlash.value = "";
		}, 600);
	}
}

function onBarcodePaste(): void {
	setTimeout(() => {
		const code = barcodeValue.value.trim();
		if (code) onBarcodeScan();
	}, 50);
}

function addEmptyRow(): void {
	purchaseStore.cartItems.push({
		item_code: "",
		item_name: "",
		qty: 0,
		rate: 0,
		uom: "",
		stock_uom: "",
		conversion_factor: 1,
		warehouse: posStore.warehouse,
		stock_in_hand: 0,
		transit_stock: 0,
		required_packs: 0,
		item_group: "",
		class: "",
		pack_units: 0,
		discount_percent: 0,
		item_packing: "",
		item_uoms: [],
	});
}

async function onItemLinkSelect(payload: {
	rowIndex: number;
	fieldname: string;
	option: AutocompleteOption;
}): Promise<void> {
	const { rowIndex, option } = payload;
	const itemCode = option.value as string;

	const item = await purchaseStore.fetchItemByCode(itemCode);
	if (!item) return;

	const row = purchaseStore.cartItems[rowIndex];
	if (!row) return;

	const lineUom = purchaseStore.defaultPurchaseUom(item);
	row.item_code = item.item_code;
	row.item_name = item.item_name;
	row.rate = (item.standard_rate || 0) * lineUom.conversion_factor;
	row.uom = lineUom.uom;
	row.stock_uom = item.stock_uom;
	row.conversion_factor = lineUom.conversion_factor;
	row.qty = row.qty || 1;
	row.item_group = item.item_group || "";
	row.class = item.custom_class || "";
	row.pack_units = item.custom_pack_units || 0;
	row.item_packing = item.custom_item_packing || "";
	row.item_uoms = item.item_uoms || [{ uom: item.stock_uom, conversion_factor: 1 }];

	purchaseStore.fetchStockForItems([item.item_code]);
}

function onPOCellChange(payload: { rowIndex: number; fieldname: string; value: any }): void {
	const { rowIndex, fieldname, value } = payload;
	switch (fieldname) {
		case "item_code": {
			const item = purchaseStore.cartItems[rowIndex];
			if (!item) break;

			if (!value) {
				item.item_code = "";
				item.item_name = "";
				item.qty = 0;
				item.rate = 0;
				item.uom = "";
				item.stock_uom = "";
				item.conversion_factor = 1;
				item.stock_in_hand = 0;
				item.transit_stock = 0;
				item.required_packs = 0;
				item.item_group = "";
				item.class = "";
				item.pack_units = 0;
				item.discount_percent = 0;
				item.item_packing = "";
				item.item_uoms = [];
			} else {
				item.item_code = value;
			}
			break;
		}
		case "required_packs":
			purchaseStore.updateCartItemPacks(rowIndex, value);
			break;
		case "rate":
			purchaseStore.updateCartItemRate(rowIndex, value);
			break;
		case "discount_percent":
			purchaseStore.updateCartItemDiscount(rowIndex, value);
			break;
		case "uom": {
			const item = purchaseStore.cartItems[rowIndex];
			const uomData = item?.item_uoms?.find((u) => u.uom === value);
			const cf = uomData?.conversion_factor || 1;
			purchaseStore.updateCartItemUOM(rowIndex, value, cf);
			break;
		}
		default: {
			const item = purchaseStore.cartItems[rowIndex];
			if (item) {
				(item as any)[fieldname] = value;
			}
		}
	}
}

function getUOMOptions(item: PurchaseCartItem): Array<{ uom: string; conversion_factor: number }> {
	if (item.item_uoms && item.item_uoms.length > 0) {
		return item.item_uoms;
	}
	return [{ uom: item.stock_uom, conversion_factor: 1 }];
}

const poColumns = computed<TableColumn[]>(() => [
	{
		fieldname: "item_code",
		label: "Item",
		type: "link" as const,
		width: "min-w-[180px]",
		align: "left" as const,
		alwaysVisible: true,
		frozen: "left" as const,
		frozenWidth: 220,
		link: {
			doctype: "Item",
			labelField: "item_name",
		},
		placeholder: "Select item...",
	},
	{
		fieldname: "stock_in_hand",
		label: "Stock",
		type: "readonly" as const,
		width: "w-[70px]",
		align: "right" as const,
		editable: false,
		format: (val: any) => qty(val || 0, 0),
	},
	{
		fieldname: "transit_stock",
		label: "Transit",
		type: "readonly" as const,
		width: "w-[70px]",
		align: "right" as const,
		editable: false,
		format: (val: any) => qty(val || 0, 0),
	},
	{
		fieldname: "qty",
		label: "Qty",
		type: "number" as const,
		width: "w-[80px]",
		align: "center" as const,
		min: 0,
		precision: 0,
	},
	{
		fieldname: "uom",
		label: "UOM",
		type: "select" as const,
		width: "w-[100px]",
		align: "left" as const,
		options: (row: TableRow) => {
			const item = row as unknown as PurchaseCartItem;
			return getUOMOptions(item).map((u) => ({
				label: u.uom,
				value: u.uom,
			}));
		},
	},
	{
		fieldname: "pack_units",
		label: "Units",
		type: "readonly" as const,
		width: "w-[55px]",
		align: "right" as const,
		editable: false,
		format: (val: any) => qty(val || 0, 0),
	},
	{
		fieldname: "rate",
		label: "Price",
		type: "number" as const,
		width: "w-[90px]",
		align: "center" as const,
		min: 0,
		precision: 2,
	},
	{
		fieldname: "discount_percent",
		label: "Disc%",
		type: "number" as const,
		width: "w-[70px]",
		align: "center" as const,
		min: 0,
		max: 100,
		precision: 1,
	},
	{
		fieldname: "item_group",
		label: "Item Group",
		type: "readonly" as const,
		width: "w-[100px]",
		align: "left" as const,
		editable: false,
		format: (val: any) => val || "-",
	},
	{
		fieldname: "amount",
		label: "Amount",
		type: "readonly" as const,
		width: "w-[100px]",
		align: "right" as const,
		editable: false,
		cellClass: "text-green-600 font-medium",
		format: (_: any, row: any) => formatCurrency(getItemAmount(row as PurchaseCartItem)),
	},
]);

function onItemCreated(item: SearchItem, buyingPrice: number): void {
	purchaseStore.addToCart({ ...item, standard_rate: buyingPrice }, 1);
}

async function fetchCategoryItems(): Promise<void> {
	if (purchaseStore.poCategory === "Projection Period") {
		if (!projectionFromDate.value || !projectionToDate.value) {
			return;
		}
	}
	await purchaseStore.fetchCategoryItems(projectionFromDate.value, projectionToDate.value);
}

async function saveDraft(): Promise<void> {
	await purchaseStore.saveDraft();
}

async function createOrder(): Promise<void> {
	await purchaseStore.createPurchaseOrder();
}

function clearForm(): void {
	purchaseStore.clearCart();
	purchaseStore.clearSupplier();
	purchaseStore.poCategory = "";
	purchaseStore.poType = "";
	purchaseStore.poDepartment = "";
	purchaseStore.poZeroQty = "No";
	purchaseStore.currentDraftName = null;
	projectionFromDate.value = "";
	projectionToDate.value = "";
}

function goToList(): void {
	router.push("/purchase-orders");
}

onMounted(() => {
	purchaseStore.init();
	purchaseStore.searchSuppliers();
});
</script>

<template>
	<div class="h-full flex flex-col bg-background overflow-y-auto md:overflow-hidden">
		<header class="bg-card border-b border-border px-3 py-3 shrink-0 sm:px-4">
			<div class="flex items-center justify-between gap-3">
				<div class="flex items-center gap-3 min-w-0">
					<ShoppingCart class="w-6 h-6 text-primary shrink-0" />
					<h1 class="text-xl font-semibold text-foreground truncate">
						{{ __("Purchase Order") }}
					</h1>
					<Badge v-if="purchaseStore.currentDraftName" variant="secondary" class="text-xs shrink-0">
						{{ __("Draft") }}
					</Badge>
				</div>
				<Button @click="goToList" variant="outline" size="sm" class="shrink-0">
					<List class="w-4 h-4 me-1" />
					{{ __("View Orders") }}
				</Button>
			</div>
		</header>

		<div class="bg-card border-b border-border px-3 py-3 shrink-0 sm:px-4">
			<div class="flex flex-wrap gap-3">
				<div class="w-full sm:w-auto sm:min-w-55 sm:flex-1">
					<label class="text-xs text-muted-foreground mb-1 block">{{ __("Supplier") }} *</label>
					<div class="flex gap-1">
						<div class="flex-1">
							<Autocomplete
								v-model="purchaseStore.selectedSupplierName"
								doctype="Supplier"
								class="h-8 text-sm"
							/>
						</div>
						<Button
							@click="showNewSupplierDialog = true"
							variant="outline"
							size="icon"
							class="h-8 w-8 shrink-0"
						>
							<Plus class="w-3.5 h-3.5" />
						</Button>
					</div>
				</div>
				<div class="w-full sm:w-45">
					<label class="text-xs text-muted-foreground mb-1 block">{{ __("P/O Category") }}</label>
					<Select
						v-model="purchaseStore.poCategory"
						:items="poCategories.map((c) => ({ label: c, value: c }))"
						placeholder="P/O Category"
						class="h-8 w-full"
					/>
				</div>
				<template
					v-if="purchaseStore.poCategory === 'Projection Period' && purchaseStore.selectedSupplier"
				>
					<div class="w-[calc(50%-6px)] sm:w-37.5">
						<label class="text-xs text-muted-foreground mb-1 block">{{ __("From Date") }}</label>
						<DateTimePicker
							v-model="projectionFromDate"
							mode="date"
							:placeholder="__('From')"
							class="h-8"
						/>
					</div>
					<div class="w-[calc(50%-6px)] sm:w-37.5">
						<label class="text-xs text-muted-foreground mb-1 block">{{ __("To Date") }}</label>
						<DateTimePicker
							v-model="projectionToDate"
							mode="date"
							:placeholder="__('To')"
							class="h-8"
						/>
					</div>
					<div class="w-full sm:w-auto">
						<label class="text-xs text-muted-foreground mb-1 block sm:invisible">&nbsp;</label>
						<Button
							@click="fetchCategoryItems"
							variant="secondary"
							size="sm"
							class="w-full h-8 sm:w-auto"
							:disabled="
								purchaseStore.isFetchingCategoryItems ||
								!projectionFromDate ||
								!projectionToDate
							"
						>
							<Download
								v-if="!purchaseStore.isFetchingCategoryItems"
								class="w-3.5 h-3.5 me-1"
							/>
							<Loader2 v-else class="w-3.5 h-3.5 me-1 animate-spin" />
							{{ __("Get Items") }}
						</Button>
					</div>
				</template>
				<template v-else-if="showCategoryButton">
					<div class="w-full sm:w-auto">
						<label class="text-xs text-muted-foreground mb-1 block sm:invisible">&nbsp;</label>
						<Button
							@click="fetchCategoryItems"
							variant="secondary"
							size="sm"
							class="w-full h-8 sm:w-auto"
							:disabled="purchaseStore.isFetchingCategoryItems"
						>
							<Download
								v-if="!purchaseStore.isFetchingCategoryItems"
								class="w-3.5 h-3.5 me-1"
							/>
							<Loader2 v-else class="w-3.5 h-3.5 me-1 animate-spin" />
							{{ __("Get Items") }}
						</Button>
					</div>
				</template>
				<div
					v-if="!showCategoryButton || purchaseStore.poCategory !== 'Projection Period'"
					class="w-full sm:w-30"
				>
					<label class="text-xs text-muted-foreground mb-1 block">{{ __("Zero Qty") }}</label>
					<Select
						v-model="purchaseStore.poZeroQty"
						:items="[
							{ label: __('No'), value: 'No' },
							{ label: __('Yes'), value: 'Yes' },
						]"
						:placeholder="__('Zero Qty')"
						class="h-8 w-full"
					/>
				</div>
			</div>
		</div>

		<div class="flex-1 flex flex-col min-h-[50vh] md:min-h-0 overflow-hidden">
			<div class="flex-1 flex flex-col min-h-0 overflow-hidden">
				<Table
					:rows="purchaseStore.cartItems"
					:columns="poColumns"
					label="Items"
					min-width="1200px"
					:show-add-row="true"
					:show-checkboxes="true"
					:show-row-numbers="true"
					:show-delete-button="true"
					:keyboard-navigation="true"
					:allow-reorder="true"
					:allow-duplicate="true"
					:show-column-settings="true"
					:highlight-new-rows="true"
					:tab-to-add-row="true"
					:show-edit-row="true"
					empty-message="No items added"
					empty-description="Add a row and search for items using the Item column"
					@add-row="addEmptyRow"
					@cell-change="onPOCellChange"
					@link-select="onItemLinkSelect"
					class="flex-1 min-h-0 flex flex-col"
				>
					<template #toolbar>
						<div class="flex w-full flex-wrap items-center gap-1.5 sm:w-auto">
							<div class="relative w-full sm:w-auto">
								<ScanBarcode
									class="absolute inset-s-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground"
								/>
								<Input
									v-model="barcodeValue"
									class="ps-7 h-7 w-full text-xs sm:w-40"
									:class="{
										'ring-2 ring-green-500/50 border-green-500':
											barcodeFlash === 'success',
										'ring-2 ring-red-500/50 border-red-500': barcodeFlash === 'error',
									}"
									:placeholder="__('Scan barcode...')"
									@keydown.enter.prevent="onBarcodeScan"
									@paste="onBarcodePaste"
								/>
								<Loader2
									v-if="isBarcodeScan"
									class="absolute inset-e-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 animate-spin"
								/>
							</div>
							<Button
								@click="showNewItemDialog = true"
								variant="outline"
								size="sm"
								class="h-7 w-full text-xs sm:w-auto"
							>
								<Plus class="w-3.5 h-3.5 me-1" />
								{{ __("New Item") }}
							</Button>
							<Button
								v-if="purchaseStore.cartItems.length > 0"
								@click="purchaseStore.refreshAllStock()"
								variant="outline"
								size="sm"
								class="h-7 w-full text-xs sm:w-auto"
							>
								<RefreshCw class="w-3.5 h-3.5 me-1" />
								{{ __("Refresh Stock") }}
							</Button>
						</div>
					</template>
				</Table>

				<div class="px-3 py-3 border-t border-border bg-muted shrink-0 sm:px-4">
					<div class="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
						<div class="flex flex-wrap items-center gap-3 text-sm sm:gap-6">
							<span class="text-muted-foreground"
								>{{ __("Items") }}:
								<strong>{{ purchaseStore.cartItems.length }}</strong></span
							>
							<span class="text-muted-foreground"
								>{{ __("Total Qty") }}:
								<strong>{{ purchaseStore.cartItemCount }}</strong></span
							>
							<span v-if="totalDiscount > 0" class="text-muted-foreground"
								>{{ __("Discount") }}:
								<strong class="text-orange-500"
									>-{{ formatCurrency(totalDiscount) }}</strong
								></span
							>
						</div>
						<div
							class="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between lg:justify-end"
						>
							<div class="text-start sm:text-end">
								<span class="text-sm text-muted-foreground">{{ __("Grand Total") }}</span>
								<div class="text-xl font-bold text-green-600">
									{{ formatCurrency(grandTotal) }}
								</div>
							</div>
							<div class="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
								<Button @click="clearForm" variant="outline" class="w-full sm:w-auto">
									<X class="w-4 h-4 me-1" />
									{{ __("Clear") }}
								</Button>
								<Button
									@click="saveDraft"
									variant="secondary"
									class="w-full sm:w-auto"
									:disabled="
										purchaseStore.cartItems.length === 0 || purchaseStore.isDraftSaving
									"
								>
									<FileText class="w-4 h-4 me-1" />
									{{ purchaseStore.isDraftSaving ? __("Saving...") : __("Save Draft") }}
								</Button>
								<Button
									@click="createOrder()"
									class="w-full sm:w-auto"
									:disabled="!purchaseStore.canCreateOrder || purchaseStore.isProcessing"
								>
									<Send class="w-4 h-4 me-1" />
									{{ purchaseStore.isProcessing ? __("Creating...") : __("Submit") }}
								</Button>
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>

		<CreateItemDialog v-model:open="showNewItemDialog" initial-name="" @created="onItemCreated" />

		<CreateSupplierDialog v-model:open="showNewSupplierDialog" initial-name="" />
	</div>
</template>
