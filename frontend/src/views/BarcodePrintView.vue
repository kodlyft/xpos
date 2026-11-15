<template>
	<div class="flex h-full flex-col overflow-hidden">
		<div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 lg:flex-row lg:overflow-hidden">
			<section
				class="flex max-h-[70vh] min-w-0 flex-col overflow-hidden rounded-2xl border border-border bg-card/50 shadow-raised lg:max-h-none lg:w-120 lg:flex-none"
			>
				<div class="shrink-0 space-y-3 p-3 pb-2">
					<div
						class="relative flex h-12 items-center rounded-xl border border-border bg-card shadow-inset transition-[border-color,box-shadow] duration-fast focus-within:border-primary focus-within:ring-4 focus-within:ring-primary/12"
					>
						<Search
							class="pointer-events-none absolute inset-s-3.5 size-5 text-muted-foreground"
							aria-hidden="true"
						/>
						<input
							ref="searchInput"
							v-model="searchQuery"
							type="text"
							autocomplete="off"
							enterkeyhint="search"
							:placeholder="__('Search items by name, code, or barcode...')"
							:aria-label="__('Search items by name, code, or barcode...')"
							class="h-full w-full min-w-0 bg-transparent ps-11 pe-12 text-base text-foreground placeholder:text-muted-foreground focus:outline-none"
							@input="onSearch"
							@keydown.enter.prevent="onSearchEnter"
						/>
						<div class="absolute inset-e-1.5 flex items-center">
							<button
								v-if="searchQuery"
								type="button"
								class="inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
								:aria-label="__('Clear search')"
								@click="clearSearch"
							>
								<X class="size-4" />
							</button>
						</div>
					</div>

					<div
						class="space-y-3 rounded-2xl border border-border bg-surface-raised p-3 shadow-raised"
					>
						<div class="grid grid-cols-2 gap-2">
							<div>
								<label class="mb-1 block text-xs font-semibold text-muted-foreground">
									{{ __("Barcode Type") }}
								</label>
								<Select
									v-model="barcodeType"
									:items="barcodeTypeOptions"
									:aria-label="__('Barcode Type')"
								/>
							</div>
							<div>
								<label class="mb-1 block text-xs font-semibold text-muted-foreground">
									{{ __("Label Size") }}
								</label>
								<Select
									v-model="labelSize"
									:items="labelSizeOptions"
									:aria-label="__('Label Size')"
								/>
							</div>
						</div>

						<div v-if="labelSize === 'custom'" class="grid grid-cols-2 gap-2">
							<div>
								<label class="mb-1 block text-xs font-semibold text-muted-foreground">
									{{ __("Width (mm)") }}
								</label>
								<NumberInput
									:allow-decimal="false"
									v-model="customWidth"
									:min="10"
									:max="200"
									class="h-10 w-full rounded-lg border border-border bg-card px-2 text-sm shadow-inset focus:border-primary focus:outline-none focus:ring-4 focus:ring-primary/12"
								/>
							</div>
							<div>
								<label class="mb-1 block text-xs font-semibold text-muted-foreground">
									{{ __("Height (mm)") }}
								</label>
								<NumberInput
									:allow-decimal="false"
									v-model="customHeight"
									:min="10"
									:max="200"
									class="h-10 w-full rounded-lg border border-border bg-card px-2 text-sm shadow-inset focus:border-primary focus:outline-none focus:ring-4 focus:ring-primary/12"
								/>
							</div>
						</div>

						<div class="flex items-center gap-4">
							<label class="flex cursor-pointer items-center gap-2 text-sm">
								<Checkbox
									:checked="showPrice"
									@update:checked="showPrice = Boolean($event)"
									class="rounded"
								/>
								<span class="select-none">{{ __("Show Price") }}</span>
							</label>
							<label class="flex cursor-pointer items-center gap-2 text-sm">
								<Checkbox
									:checked="includeQR"
									@update:checked="includeQR = Boolean($event)"
									class="rounded"
								/>
								<span class="select-none">{{ __("Include QR Code") }}</span>
							</label>
						</div>
					</div>
				</div>

				<div class="min-h-40 flex-1 overflow-y-auto px-3 pb-3 xpos-scrollbar">
					<div v-if="isSearching" class="flex items-center justify-center py-8">
						<div
							class="size-6 animate-spin rounded-full border-2 border-primary border-t-transparent"
						></div>
					</div>
					<div
						v-else-if="searchResults.length === 0"
						class="flex flex-col items-center justify-center gap-2 py-10 text-center text-sm text-muted-foreground"
					>
						<Package class="size-8 opacity-40" aria-hidden="true" />
						{{
							searchQuery ? __("No items found") : __("Search for items to add barcode labels")
						}}
					</div>
					<div v-else class="overflow-hidden rounded-xl border-t border-border">
						<button
							v-for="item in searchResults"
							:key="item.item_code"
							type="button"
							class="group flex min-h-12 w-full min-w-0 items-center gap-3 border-x border-b border-x-border border-b-border/70 bg-card px-3 py-1.5 text-start transition-colors duration-fast hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
							@click="addItem(item)"
						>
							<span class="min-w-0 flex-1">
								<span class="block truncate text-sm font-semibold text-foreground" dir="auto">
									{{ item.item_name }}
								</span>
								<span
									class="block truncate font-mono text-[0.6875rem] leading-4 text-muted-foreground"
								>
									{{ item.item_code }}
								</span>
							</span>
							<span
								v-if="item.barcodes && item.barcodes.length === 1"
								class="shrink-0 font-mono text-xs text-muted-foreground"
							>
								{{ item.barcodes[0].barcode }}
							</span>
							<span
								v-else-if="item.barcodes && item.barcodes.length > 1"
								class="shrink-0 text-xs text-muted-foreground"
							>
								{{ item.barcodes.length }} {{ __("barcodes") }}
							</span>
							<Plus class="size-4 shrink-0 text-primary" aria-hidden="true" />
						</button>
					</div>
				</div>
			</section>

			<section
				class="flex min-h-80 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border bg-card/50 shadow-raised lg:min-h-0"
			>
				<div class="flex shrink-0 items-center justify-between gap-2 px-4 pt-3 pb-2">
					<h2 class="flex min-w-0 items-center gap-2 text-lg font-bold text-foreground">
						<Barcode class="size-5 shrink-0 text-primary" aria-hidden="true" />
						<span class="truncate">{{ __("Barcode Printer") }}</span>
					</h2>
					<span
						v-if="items.length"
						class="shrink-0 rounded-lg border border-border bg-surface-sunken px-2 py-0.5 text-xs font-semibold text-muted-foreground tabular-nums"
					>
						{{ items.length }} {{ __("item(s)") }} &middot; {{ totalLabels }} {{ __("label(s)") }}
					</span>
				</div>

				<div class="min-h-0 flex-1 overflow-y-auto px-3 pb-3 xpos-scrollbar">
					<div
						v-if="items.length === 0"
						class="flex h-full flex-col items-center justify-center text-muted-foreground"
					>
						<Barcode class="mb-4 size-16 opacity-30" aria-hidden="true" />
						<p class="text-base font-medium">{{ __("No items selected") }}</p>
						<p class="mt-1 text-sm">{{ __("Search and add items from the left panel") }}</p>
					</div>

					<div v-else class="overflow-hidden rounded-xl border-t border-border">
						<div
							v-for="(item, idx) in items"
							:key="idx"
							class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 border-x border-b border-x-border border-b-border/70 bg-card px-3 py-2 transition-colors duration-fast hover:bg-surface-hover"
						>
							<div class="min-w-40 flex-1">
								<div class="truncate text-sm font-semibold text-foreground" dir="auto">
									{{ item.item_name }}
								</div>
								<div
									class="truncate font-mono text-[0.6875rem] leading-4 text-muted-foreground"
								>
									{{ item.item_code }}
								</div>
							</div>
							<div class="w-full sm:w-52">
								<Select
									v-if="item.barcodes.length"
									:model-value="item.selectedBarcode || ITEM_CODE_VALUE"
									:items="barcodeOptions(item)"
									:aria-label="__('Barcode')"
									class="font-mono text-xs"
									@update:model-value="
										item.selectedBarcode =
											$event === ITEM_CODE_VALUE ? '' : ($event ?? '')
									"
								/>
								<span v-else class="font-mono text-xs text-muted-foreground">
									{{ item.item_code }}
								</span>
							</div>
							<div
								class="flex shrink-0 items-center gap-0.5 rounded-xl border border-border bg-surface-sunken p-0.5 shadow-inset"
							>
								<button
									type="button"
									class="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-card hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
									:aria-label="__('Decrease quantity')"
									@click="decrementQty(idx)"
								>
									<Minus class="size-3.5" />
								</button>
								<NumberInput
									:allow-decimal="false"
									v-model="item.qty"
									:min="1"
									class="h-8 w-12 bg-transparent text-center text-sm font-semibold tabular-nums focus:outline-none"
								/>
								<button
									type="button"
									class="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-card hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
									:aria-label="__('Increase quantity')"
									@click="incrementQty(idx)"
								>
									<Plus class="size-3.5" />
								</button>
							</div>
							<button
								type="button"
								class="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
								:aria-label="__('Remove')"
								@click="removeItem(idx)"
							>
								<X class="size-4" />
							</button>
						</div>
					</div>
				</div>

				<div class="flex shrink-0 items-center gap-2 border-t border-border p-3">
					<Button
						variant="outline"
						class="h-12 rounded-xl"
						:disabled="items.length === 0"
						@click="clearAll"
					>
						<Trash2 class="size-4" />
						{{ __("Clear All") }}
					</Button>
					<Button
						class="h-12 flex-1 rounded-xl text-base font-semibold shadow-primary"
						:disabled="items.length === 0 || isPrinting"
						@click="printLabels"
					>
						<Printer class="size-4.5" />
						{{ isPrinting ? __("Generating...") : __("Print Labels") }}
					</Button>
				</div>
			</section>
		</div>
		<div ref="printContainer" class="hidden"></div>
	</div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, nextTick } from "vue";
import { call } from "@/services/api";
import { Button } from "@/components/ui/button";
import { __ } from "@/lib/translate";
import { Search, Plus, Minus, X, Printer, Trash2, Barcode, Package } from "lucide-vue-next";
import Checkbox from "@/components/ui/checkbox/Checkbox.vue";
import { Select } from "@/components/ui/select";
import { NumberInput } from "@/components/ui/number-input";
import { usePosStore } from "@/stores/posStore";
import { formatWithSymbol } from "@/composables/useCurrency";

interface ItemBarcode {
	barcode: string;
	barcode_type?: string;
	uom?: string;
}

interface BarcodeItem {
	item_code: string;
	item_name: string;
	barcodes: ItemBarcode[];
	selectedBarcode: string;
	qty: number;
}

interface SearchResult {
	item_code: string;
	item_name: string;
	barcodes?: ItemBarcode[];
}

interface LabelData {
	item_code: string;
	item_name: string;
	barcode_value: string;
	barcode_uri: string;
	qrcode_uri: string;
	price: number;
	currency: string;
	uom: string;
}

const ITEM_CODE_VALUE = "__item_code__";

const barcodeTypeOptions = [
	{ label: "CODE 128", value: "code128" },
	{ label: "CODE 39", value: "code39" },
	{ label: "EAN-13", value: "ean13" },
	{ label: "EAN-8", value: "ean8" },
	{ label: "UPC-A", value: "upca" },
	{ label: "ITF", value: "itf" },
];

const labelSizeOptions = [
	{ label: __("Small (38x25mm)"), value: "small" },
	{ label: __("Medium (50x30mm)"), value: "medium" },
	{ label: __("Large (60x40mm)"), value: "large" },
	{ label: __("Custom"), value: "custom" },
];

function barcodeOptions(item: BarcodeItem) {
	return [
		...item.barcodes.map((bc) => ({
			label: bc.barcode_type ? `${bc.barcode} (${bc.barcode_type})` : bc.barcode,
			value: bc.barcode,
		})),
		{ label: `${item.item_code} (${__("Item Code")})`, value: ITEM_CODE_VALUE },
	];
}

const searchInput = ref<HTMLInputElement | null>(null);
const printContainer = ref<HTMLDivElement | null>(null);
const searchQuery = ref("");
const searchResults = ref<SearchResult[]>([]);
const isSearching = ref(false);
const isPrinting = ref(false);

const items = ref<BarcodeItem[]>([]);
const barcodeType = ref("code128");
const labelSize = ref("medium");
const customWidth = ref(50);
const customHeight = ref(30);
const showPrice = ref(true);
const includeQR = ref(false);

let searchTimeout: ReturnType<typeof setTimeout> | null = null;

const totalLabels = computed(() => items.value.reduce((sum, item) => sum + (item.qty || 1), 0));

const labelDims = computed(() => {
	switch (labelSize.value) {
		case "small":
			return { w: "38mm", h: "25mm", bw: "34mm", bh: "10mm" };
		case "large":
			return { w: "60mm", h: "40mm", bw: "54mm", bh: "16mm" };
		case "custom": {
			const w = Math.max(Number(customWidth.value) || 0, 10);
			const h = Math.max(Number(customHeight.value) || 0, 10);
			const bw = Math.max(w - 6, 8);
			const bh = Math.max(Math.round(h * 0.4), 6);
			return { w: `${w}mm`, h: `${h}mm`, bw: `${bw}mm`, bh: `${bh}mm` };
		}
		default:
			return { w: "50mm", h: "30mm", bw: "44mm", bh: "12mm" };
	}
});

onMounted(() => {
	nextTick(() => searchInput.value?.focus());
});

function onSearch() {
	if (searchTimeout) clearTimeout(searchTimeout);
	searchTimeout = setTimeout(() => doSearch(), 300);
}

function onSearchEnter() {
	if (searchTimeout) clearTimeout(searchTimeout);
	doSearch();
}

async function doSearch() {
	const query = searchQuery.value.trim();
	if (!query) {
		searchResults.value = [];
		return;
	}
	isSearching.value = true;
	try {
		const result = await call<{ items: SearchResult[] }>(
			"xpos.x_pos.api.barcode_generator.search_items_for_barcode",
			{ query },
		);
		searchResults.value = result?.items || [];
	} catch {
		searchResults.value = [];
	} finally {
		isSearching.value = false;
	}
}

function addItem(item: SearchResult) {
	const existing = items.value.find((i) => i.item_code === item.item_code);
	if (existing) {
		existing.qty += 1;
		return;
	}
	const barcodes = item.barcodes || [];
	items.value.push({
		item_code: item.item_code,
		item_name: item.item_name,
		barcodes,
		selectedBarcode: barcodes.length ? barcodes[0].barcode : "",
		qty: 1,
	});
}

function selectedBarcodeType(item: BarcodeItem): string | undefined {
	const match = item.barcodes.find((b) => b.barcode === item.selectedBarcode);
	return match?.barcode_type || undefined;
}

function clearSearch() {
	searchQuery.value = "";
	searchResults.value = [];
	searchInput.value?.focus();
}

function removeItem(idx: number) {
	items.value.splice(idx, 1);
}

function incrementQty(idx: number) {
	items.value[idx].qty = Math.max(1, (items.value[idx].qty || 1) + 1);
}

function decrementQty(idx: number) {
	items.value[idx].qty = Math.max(1, (items.value[idx].qty || 1) - 1);
}

function clearAll() {
	items.value = [];
}

async function printLabels() {
	if (items.value.length === 0) return;
	isPrinting.value = true;

	try {
		const payload = items.value.map((i) => ({
			item_code: i.item_code,
			barcode: i.selectedBarcode || undefined,
			barcode_type: selectedBarcodeType(i),
			qty: i.qty,
		}));

		const labels = await call<LabelData[]>("xpos.x_pos.api.barcode_generator.get_item_barcode_labels", {
			items: JSON.stringify(payload),
			barcode_type: barcodeType.value,
			include_qr: includeQR.value ? 1 : 0,
			pos_profile: usePosStore().profileName,
		});

		if (!labels || labels.length === 0) return;

		const dims = labelDims.value;
		let html = `<!DOCTYPE html>
                <html>
                <head>
                <meta charset="utf-8" />
                <title>Barcode Labels</title>
                <style>
                @page {
                    size: ${dims.w} ${dims.h};
                    margin: 0;
                }
                * { margin: 0; padding: 0; box-sizing: border-box; }
                body {
                    font-family: Arial, Helvetica, sans-serif;
                    -webkit-print-color-adjust: exact;
                    print-color-adjust: exact;
                }
                .label {
                    width: ${dims.w};
                    height: ${dims.h};
                    padding: 1.5mm;
                    text-align: center;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    page-break-after: always;
                    overflow: hidden;
                }
                .label:last-child { page-break-after: auto; }
                .label-name {
                    font-size: 8px;
                    font-weight: 700;
                    text-transform: uppercase;
                    letter-spacing: 0.3px;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    max-width: calc(${dims.w} - 4mm);
                    margin-bottom: 1mm;
                }
                .label-barcode img {
                    max-width: ${dims.bw};
                    height: ${dims.bh};
                    object-fit: contain;
                }
                .label-barcode-text {
                    font-size: 7px;
                    font-family: ui-monospace, 'SF Mono', 'JetBrains Mono', 'Roboto Mono', 'Cascadia Code', Menlo, Consolas, monospace;
                    font-variant-numeric: tabular-nums;
                    letter-spacing: 0.8px;
                    margin-top: 0.5mm;
                }
                .label-price {
                    font-size: 9px;
                    font-weight: 900;
                    margin-top: 0.5mm;
                }
                .label-qr img {
                    width: 10mm;
                    height: 10mm;
                    margin-top: 0.5mm;
                }
                @media print {
                    body { margin: 0; }
                }
                </style>
                </head>
                <body>
        `;

		for (const label of labels) {
			html += `<div class="label">`;
			html += `<div class="label-name">${escapeHtml(label.item_name)}</div>`;
			if (label.barcode_uri) {
				html += `<div class="label-barcode"><img src="${
					label.barcode_uri
				}" alt="${escapeHtml(label.barcode_value)}" /></div>`;
			}
			if (label.item_code && label.item_code !== label.barcode_value) {
				html += `<div class="label-barcode-text">${escapeHtml(label.item_code)}</div>`;
			}
			if (showPrice.value && label.price != null) {
				html += `<div class="label-price">${formatWithSymbol(
					label.currency,
					Number(label.price),
				)}</div>`;
			}
			if (includeQR.value && label.qrcode_uri) {
				html += `<div class="label-qr"><img src="${label.qrcode_uri}" alt="QR" /></div>`;
			}
			html += `</div>`;
		}

		html += `</body></html>`;

		const printWin = window.open("", "_blank", "width=400,height=600");
		if (printWin) {
			printWin.document.write(html);
			printWin.document.close();

			printWin.onload = () => {
				setTimeout(() => {
					printWin.print();
					printWin.close();
				}, 500);
			};
			setTimeout(() => {
				try {
					printWin.print();
					printWin.close();
				} catch {
					/* already closed */
				}
			}, 3000);
		}
	} catch (err) {
		console.error("Failed to generate barcode labels:", err);
	} finally {
		isPrinting.value = false;
	}
}

function escapeHtml(str: string): string {
	const div = document.createElement("div");
	div.textContent = str;
	return div.innerHTML;
}
</script>
