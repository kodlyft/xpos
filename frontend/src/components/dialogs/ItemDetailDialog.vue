<template>
	<Dialog
		:open="itemStore.showItemDetail"
		@update:open="
			(val: boolean) => {
				if (!val) close();
			}
		"
	>
		<DialogContent class="max-w-lg max-h-[80vh] flex flex-col p-0 gap-0">
			<DialogHeader class="shrink-0 px-5 pt-5 pb-3 border-b border-border">
				<DialogTitle class="text-base">{{ itemForDetail?.item_name }}</DialogTitle>
				<DialogDescription class="text-xs font-mono">{{
					itemForDetail?.item_code
				}}</DialogDescription>
			</DialogHeader>

			<div class="flex-1 overflow-y-auto p-5 space-y-4 xpos-scrollbar">
				<div v-if="itemStore.isLoadingDetail" class="flex items-center justify-center py-8">
					<Loader2 class="w-8 h-8 text-primary animate-spin" />
				</div>

				<template v-else-if="detail">
					<div v-if="!resolveLine && detail.uoms && detail.uoms.length > 0">
						<label class="text-sm font-semibold text-foreground mb-1.5 block"
							>Unit of Measure
							<span class="text-[10px] font-normal text-muted-foreground ms-2"
								>← → cycle &bull; 1–{{ detail.uoms.length }} select</span
							>
						</label>
						<div
							ref="uomContainerRef"
							class="flex flex-wrap gap-2"
							@keydown="handleUOMSectionKeydown"
						>
							<button
								v-for="(u, i) in detail.uoms"
								:key="u.uom"
								:data-uom-index="i"
								@click="selectUOM(u.uom, u.conversion_factor)"
								@keydown.left.prevent="focusUOMButton($event, -1)"
								@keydown.right.prevent="focusUOMButton($event, 1)"
								@keydown.enter.prevent="selectUOM(u.uom, u.conversion_factor)"
								class="px-3 py-1.5 rounded-lg border text-sm font-medium transition-all"
								:class="
									selectedUOM === u.uom
										? 'border-primary bg-primary/10 text-primary'
										: 'border-border text-muted-foreground hover:border-primary/40'
								"
							>
								<span class="text-[10px] opacity-40 me-1">{{ i + 1 }}</span>
								{{ u.uom }}
								<span
									v-if="u.conversion_factor !== 1"
									class="text-[10px] ms-1 text-muted-foreground"
								>
									(&times;{{ u.conversion_factor }})
								</span>
							</button>
						</div>
					</div>

					<div v-if="!resolveLine">
						<label class="text-sm font-semibold text-foreground mb-1.5 block">
							{{ __("Price") }}
						</label>
						<NumberInput
							v-if="hasPermission('allow_change_price')"
							v-model="priceInput"
							:min="0"
							:precision="ratePrecision"
							class="w-32"
						/>
						<span v-else class="text-base font-bold text-primary tabular-nums">
							{{ moneyRate(priceInput) }}
						</span>
					</div>

					<p
						v-if="resolveLine"
						class="rounded-xl border border-info/25 bg-info-soft px-3 py-2.5 text-sm text-info-soft-foreground"
						data-testid="resolve-line-note"
					>
						{{ resolveHint }}
					</p>

					<div v-if="showBatchPicker">
						<label class="text-sm font-semibold text-foreground mb-1.5 block">
							Batch
							<span class="font-normal text-muted-foreground"
								>({{ detail.batches.length }} available)</span
							>
						</label>
						<div class="space-y-1.5 max-h-40 overflow-y-auto xpos-scrollbar">
							<button
								v-for="batch in detail.batches"
								:key="batch.batch_no"
								@click="selectedBatch = batch.batch_no"
								class="w-full flex items-center justify-between p-2.5 rounded-lg border text-sm transition-all"
								:class="
									selectedBatch === batch.batch_no
										? 'border-primary bg-primary/10'
										: 'border-border hover:border-primary/40'
								"
							>
								<div>
									<span class="font-medium text-foreground">{{ batch.batch_no }}</span>
									<span
										v-if="batch.expiry_date"
										class="text-[11px] text-muted-foreground ms-2"
									>
										Exp: {{ batch.expiry_date }}
									</span>
								</div>
								<Badge
									:variant="batch.qty > 0 ? 'success' : 'destructive'"
									class="text-[10px]"
								>
									{{ qty(batch.qty) }} {{ selectedUOM || detail.stock_uom }}
								</Badge>
							</button>
						</div>
					</div>

					<div v-if="showSerialPicker">
						<label class="text-sm font-semibold text-foreground mb-1.5 block">
							Serial Number
							<span class="font-normal text-muted-foreground"
								>({{ detail.serial_numbers.length }} available)</span
							>
						</label>
						<div class="relative mb-2">
							<Search
								class="absolute inset-s-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground"
							/>
							<Input
								v-model="serialSearch"
								type="text"
								placeholder="Search serial numbers..."
								class="ps-9 text-sm"
							/>
						</div>
						<div class="space-y-1 max-h-40 overflow-y-auto xpos-scrollbar">
							<button
								v-for="sn in filteredSerials"
								:key="sn"
								@click="toggleSerial(sn)"
								class="w-full flex items-center gap-2 p-2 rounded-lg border text-sm transition-all"
								:class="
									selectedSerials.includes(sn)
										? 'border-primary bg-primary/10'
										: 'border-border hover:border-primary/40'
								"
							>
								<div
									class="w-4 h-4 rounded border flex items-center justify-center shrink-0"
									:class="
										selectedSerials.includes(sn)
											? 'bg-primary border-primary'
											: 'border-border'
									"
								>
									<Check
										v-if="selectedSerials.includes(sn)"
										class="w-3 h-3 text-primary-foreground"
									/>
								</div>
								<span class="text-foreground font-mono text-xs">{{ sn }}</span>
							</button>
						</div>
					</div>

					<div v-if="!resolveLine">
						<label class="text-sm font-semibold text-foreground mb-1.5 block">Quantity</label>
						<NumberInput
							ref="qtyInputRef"
							v-model="selectedQty"
							:min="1"
							:allow-decimal="false"
							class="w-32"
							@keydown.enter.prevent="addToCart"
						/>
					</div>
				</template>

				<div
					v-else
					class="flex flex-col items-center justify-center gap-2 py-10 text-center text-muted-foreground"
				>
					<AlertCircle class="w-8 h-8 opacity-50" />
					<p class="text-sm font-medium text-foreground">
						{{ itemForDetail?.item_name || __("Item details unavailable") }}
					</p>
					<p v-if="itemForDetail?.item_code" class="text-xs font-mono">
						{{ itemForDetail.item_code }}
					</p>
					<p class="text-xs">
						{{ __("Could not load details for this item. Check your connection and try again.") }}
					</p>
				</div>
			</div>

			<DialogFooter class="shrink-0 border-t border-border px-5 py-4">
				<Button variant="outline" class="flex-1" @click="close">Cancel</Button>
				<Button
					v-if="resolveLine"
					class="flex-1 font-bold"
					data-testid="resolve-line-apply"
					:disabled="!canResolve"
					@click="applyToLine"
				>
					<Check class="w-4 h-4" />
					{{ __("Apply to line") }}
				</Button>
				<Button v-else class="flex-1 font-bold" :disabled="!canAdd" @click="addToCart">
					<Plus class="w-4 h-4" />
					{{ __("Add to Cart") }}
				</Button>
			</DialogFooter>
		</DialogContent>
	</Dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from "vue";
import { useItemStore } from "@/stores/itemStore";
import { useCartStore } from "@/stores/cartStore";
import { usePosStore } from "@/stores/posStore";
import { useMoney } from "@/composables/useMoney";
import { hasPermission } from "@/services/userRights";
import { showError } from "@/services/api";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Badge } from "@/components/ui/badge";
import { Loader2, Search, Check, Plus, AlertCircle } from "lucide-vue-next";
import __ from "@/lib/translate";

const itemStore = useItemStore();
const { moneyRate, ratePrecision, qty } = useMoney();
const cartStore = useCartStore();
const posStore = usePosStore();

const selectedUOM = ref("");
const selectedBatch = ref("");
const selectedSerials = ref<string[]>([]);
const selectedQty = ref(1);
const serialSearch = ref("");
const uomConversionFactor = ref(1);
const uomRate = ref<number | null>(null);
const priceInput = ref(0);
const uomContainerRef = ref<HTMLDivElement | null>(null);
const qtyInputRef = ref<InstanceType<typeof NumberInput> | null>(null);

const itemForDetail = computed(() => itemStore.selectedItemForDetail);
const detail = computed(() => itemStore.selectedItemDetail);

const itemForCart = computed(() => {
	if (!itemForDetail.value) return null;
	if (!detail.value) return itemForDetail.value;
	const detailQty = detail.value.actual_qty;
	return {
		...itemForDetail.value,
		actual_qty: detailQty === undefined ? itemForDetail.value.actual_qty : Number(detailQty),
		batches: detail.value.batches,
	};
});

watch(detail, (d) => {
	if (d) {
		selectedUOM.value = d.uom || d.stock_uom;
		uomConversionFactor.value = d.conversion_factor || 1;
		uomRate.value = null;
		priceInput.value = d.price_list_rate || itemForDetail.value?.rate || 0;
		selectedBatch.value = "";
		selectedSerials.value = [];
		selectedQty.value = 1;
		if (posStore.autoSetBatch && d.batches?.length > 0) {
			selectedBatch.value = d.batches[0].batch_no;
		}
		nextTick(() => {
			const el = qtyInputRef.value?.$el?.querySelector("input") ?? qtyInputRef.value?.$el;
			if (el && typeof el.focus === "function") el.focus();
		});
	}
});

const resolveLine = computed(() =>
	itemStore.resolveLineUid ? cartStore.items.find((i) => i.uid === itemStore.resolveLineUid) || null : null,
);
const resolveQty = computed(() => Math.abs(Number(resolveLine.value?.qty) || 0));
const resolveNeedsSerial = computed(
	() => !!resolveLine.value?.has_serial_no && !resolveLine.value?.serial_no,
);
const resolveNeedsBatch = computed(() => !!resolveLine.value?.has_batch_no && !resolveLine.value?.batch_no);

const showBatchPicker = computed(
	() =>
		!!detail.value?.has_batch_no &&
		detail.value.batches.length > 0 &&
		(!resolveLine.value || resolveNeedsBatch.value),
);
const showSerialPicker = computed(
	() =>
		!!detail.value?.has_serial_no &&
		detail.value.serial_numbers.length > 0 &&
		(!resolveLine.value || resolveNeedsSerial.value),
);

const resolveHint = computed(() => {
	if (resolveNeedsSerial.value) {
		return resolveQty.value === 1
			? __("Choose the serial number for this line.")
			: __("Choose {0} serial numbers for this line.", [String(resolveQty.value)]);
	}
	return __("Choose the batch for this line.");
});

const canResolve = computed(() => {
	if (!resolveLine.value || !detail.value) return false;
	if (resolveNeedsBatch.value && showBatchPicker.value && !selectedBatch.value) return false;
	if (resolveNeedsSerial.value && selectedSerials.value.length !== resolveQty.value) return false;
	return resolveNeedsBatch.value || resolveNeedsSerial.value;
});

const filteredSerials = computed(() => {
	if (!detail.value?.serial_numbers) return [];
	// a serial already on another cart line cannot be sold twice
	const inCart = new Set(cartStore.items.map((i) => i.serial_no).filter(Boolean));
	const available = resolveLine.value
		? detail.value.serial_numbers.filter((sn) => !inCart.has(sn) && !cartStore.serialCartElsewhere(sn))
		: detail.value.serial_numbers.filter((sn) => !cartStore.serialCartElsewhere(sn));
	const term = serialSearch.value.toLowerCase();
	if (!term) return available;
	return available.filter((sn) => sn.toLowerCase().includes(term));
});

function applyToLine(): void {
	if (!canResolve.value || !resolveLine.value) return;
	const index = cartStore.items.indexOf(resolveLine.value);
	const result = cartStore.resolveLineTracking(index, {
		serials: resolveNeedsSerial.value ? [...selectedSerials.value] : undefined,
		batch: resolveNeedsBatch.value ? selectedBatch.value || undefined : undefined,
		batches: detail.value?.batches,
	});
	if (!result.success) {
		showError(result.message || __("Could not update the line"));
		return;
	}
	close();
}

const canAdd = computed(() => {
	if (!detail.value) return false;
	if (detail.value.has_batch_no && !selectedBatch.value) return false;
	if (detail.value.has_serial_no && selectedSerials.value.length === 0) return false;
	return selectedQty.value > 0;
});

function handleUOMSectionKeydown(event: KeyboardEvent): void {
	const uoms = detail.value?.uoms;
	if (!uoms?.length) return;

	if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
		event.preventDefault();
		const currentIdx = uoms.findIndex((u) => u.uom === selectedUOM.value);
		const nextIdx =
			event.key === "ArrowRight"
				? (currentIdx + 1) % uoms.length
				: (currentIdx - 1 + uoms.length) % uoms.length;
		selectUOM(uoms[nextIdx].uom, uoms[nextIdx].conversion_factor);
		nextTick(() => {
			const btn = uomContainerRef.value?.querySelector(
				`[data-uom-index="${nextIdx}"]`,
			) as HTMLButtonElement | null;
			btn?.focus();
		});
		return;
	}
	const num = parseInt(event.key);
	if (!isNaN(num) && num >= 1 && num <= uoms.length) {
		event.preventDefault();
		selectUOM(uoms[num - 1].uom, uoms[num - 1].conversion_factor);
		nextTick(() => {
			const btn = uomContainerRef.value?.querySelector(
				`[data-uom-index="${num - 1}"]`,
			) as HTMLButtonElement | null;
			btn?.focus();
		});
	}
}

function focusUOMButton(event: KeyboardEvent, direction: number): void {
	const container = uomContainerRef.value;
	if (!container) return;
	const buttons = Array.from(container.querySelectorAll("button[data-uom-index]")) as HTMLButtonElement[];
	const idx = buttons.indexOf(event.target as HTMLButtonElement);
	if (idx < 0) return;
	const next = (idx + direction + buttons.length) % buttons.length;
	buttons[next]?.focus();
}

async function selectUOM(uom: string, cf: number): Promise<void> {
	selectedUOM.value = uom;
	uomConversionFactor.value = cf;
	uomRate.value = null;
	if (itemForDetail.value) {
		const fetched = await itemStore.fetchPriceForUOM(
			itemForDetail.value.item_code,
			uom,
			posStore.profileName,
		);
		uomRate.value = fetched > 0 ? fetched : null;
	}
	const baseRate = detail.value?.price_list_rate || itemForDetail.value?.rate || 0;
	priceInput.value = uomRate.value !== null ? uomRate.value : baseRate * cf;
}

function toggleSerial(sn: string): void {
	const idx = selectedSerials.value.indexOf(sn);
	if (idx >= 0) {
		selectedSerials.value.splice(idx, 1);
	} else if (!resolveLine.value || selectedSerials.value.length < resolveQty.value) {
		selectedSerials.value.push(sn);
	}
	if (selectedSerials.value.length > 0) {
		selectedQty.value = selectedSerials.value.length;
	}
}

function addToCart(): void {
	if (!itemForDetail.value || !itemForCart.value || !canAdd.value) return;

	const rate = priceInput.value;

	if (detail.value?.has_serial_no && selectedSerials.value.length > 0) {
		for (const sn of selectedSerials.value) {
			const result = cartStore.addItemWithDetails(
				itemForCart.value,
				1,
				rate,
				selectedUOM.value,
				sn,
				selectedBatch.value,
				uomConversionFactor.value,
			);
			if (!result.success) {
				showError(result.message || "Cannot add item to cart");
				return;
			}
		}
	} else {
		const result = cartStore.addItemWithDetails(
			itemForCart.value,
			selectedQty.value,
			rate,
			selectedUOM.value,
			"",
			selectedBatch.value,
			uomConversionFactor.value,
		);
		if (!result.success) {
			showError(result.message || "Cannot add item to cart");
			return;
		}
	}

	close();
}

function close() {
	itemStore.closeItemDetail();
}
</script>
