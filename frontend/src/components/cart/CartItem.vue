<template>
	<div
		class="group flex items-start gap-2 rounded-xl border-2 p-2 transition-all duration-200 scroll-mt-1 focus:outline-none"
		:class="
			isSelected
				? 'border-primary bg-primary/5 shadow-[0_0_0_1px_hsl(var(--primary)/0.18),0_10px_30px_-18px_hsl(var(--primary)/0.9)] dark:bg-primary/10'
				: 'border-transparent hover:bg-muted/50 dark:hover:bg-accent/50'
		"
		:data-cart-index="index"
		tabindex="0"
		@focusin="selectRow"
		@click="selectRow"
		@keydown.delete="handleDeleteKey"
		@keydown="handleRowKeydown"
	>
		<div class="w-9 h-9 rounded-md bg-muted overflow-hidden shrink-0 flex items-center justify-center">
			<img
				v-if="item.image"
				:src="item.image"
				:alt="item.item_name"
				class="w-full h-full object-cover"
			/>
			<Package v-else class="w-4 h-4 text-muted-foreground/40" />
		</div>

		<div class="flex-1 min-w-0">
			<p class="text-[11px] font-medium text-foreground leading-tight truncate">
				{{ item.item_name }}
				<span
					v-if="item.pos_is_free_item"
					class="ms-1 px-1 py-px rounded text-[9px] font-semibold bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-400"
				>
					{{ __("Free") }}
				</span>
				<span
					v-if="item.pos_price_unavailable && !item.pos_rate_overridden"
					role="status"
					class="ms-1 px-1 py-px rounded text-[9px] font-semibold bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300"
				>
					{{
						item.pos_price_state === "needs_connection"
							? __("Needs connection for price")
							: __("Price unavailable")
					}}
				</span>
				<span
					v-if="item.pos_repriced_from !== undefined"
					role="status"
					class="ms-1 px-1 py-px rounded text-[9px] font-semibold bg-sky-100 dark:bg-sky-900/40 text-sky-800 dark:text-sky-300"
				>
					{{ __("Price changed from {0}", [item.pos_repriced_from]) }}
				</span>
			</p>

			<div class="flex items-center gap-1 mt-0.5 flex-wrap">
				<template v-if="hasPermission('allow_change_price') && !item.pos_is_free_item">
					<span class="text-[11px] text-muted-foreground">{{ currencySymbol }}</span>
					<input
						ref="rateInput"
						:value="item.rate"
						type="number"
						min="0"
						:step="rateStep"
						class="w-16 h-5 text-[11px] font-medium text-foreground bg-transparent border-b border-dashed border-border focus:outline-none focus:border-primary dark:border-muted-foreground/40 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
						@change="onRateChange"
						@keydown.up.prevent="focusAdjacentItem(-1, 'rate')"
						@keydown.down.prevent="focusAdjacentItem(1, 'rate')"
						@keydown="blockInvalidNumericKeys"
					/>
				</template>
				<p v-else class="text-[11px] text-muted-foreground">
					{{ moneyRate(item.rate) }}
				</p>

				<span class="text-[11px] text-muted-foreground">/</span>
				<button
					v-if="hasMultipleUOMs"
					ref="uomToggleRef"
					@click="showUOMSelector = !showUOMSelector"
					@keydown.left.prevent="cycleUOM(-1)"
					@keydown.right.prevent="cycleUOM(1)"
					@keydown.space.prevent="showUOMSelector = !showUOMSelector"
					@keydown.enter.prevent="showUOMSelector = !showUOMSelector"
					@keydown.escape="showUOMSelector = false"
					class="text-[11px] text-primary hover:underline focus:outline-none"
					:title="'Left/Right to cycle · Enter to open · U to toggle'"
				>
					{{ item.uom || item.stock_uom }}
					<ChevronDown class="w-3 h-3 inline-block" />
				</button>
				<span v-else class="text-[11px] text-muted-foreground">
					{{ item.uom || item.stock_uom }}
				</span>
			</div>

			<div
				v-if="showUOMSelector && itemUOMs.length > 0"
				ref="uomContainerRef"
				class="mt-1 p-1.5 bg-muted rounded-md"
				@keydown="handleUOMContainerKeydown"
			>
				<div class="text-[9px] text-muted-foreground mb-1 ms-0.5">
					← → cycle &bull; 1–{{ itemUOMs.length }} select &bull; Esc close
				</div>
				<div class="flex flex-wrap gap-1">
					<button
						v-for="(u, i) in itemUOMs"
						:key="u.uom"
						:data-uom="u.uom"
						@click="selectUOM(u)"
						@keydown.left.prevent="focusUOMButton($event, -1)"
						@keydown.right.prevent="focusUOMButton($event, 1)"
						@keydown.enter.prevent="selectUOM(u)"
						class="px-2 py-0.5 rounded text-[10px] font-medium transition-all"
						:class="
							(item.uom || item.stock_uom) === u.uom
								? 'bg-primary text-primary-foreground'
								: 'bg-background border border-border hover:border-primary/40'
						"
					>
						<span class="text-[9px] opacity-50 me-0.5">{{ i + 1 }}.</span>
						{{ u.uom }}
						<span v-if="u.conversion_factor !== 1" class="text-[9px] opacity-70">
							(×{{ u.conversion_factor }})
						</span>
					</button>
				</div>
			</div>

			<div class="flex items-center gap-1 mt-1 flex-wrap">
				<template v-if="item.pos_is_free_item">
					<span class="text-[10px] font-semibold text-muted-foreground px-1">
						{{ __("Qty") }}: {{ qty(item.qty) }}
					</span>
				</template>
				<template v-else>
					<Button variant="secondary" size="icon-sm" class="w-5 h-5" @click="decrementQty">
						<Minus class="w-2.5 h-2.5" />
					</Button>
					<input
						ref="qtyInput"
						:value="item.qty"
						type="number"
						min="0"
						data-testid="cart-qty"
						class="w-9 h-5 text-center text-[10px] font-semibold text-foreground bg-muted/50 rounded border border-border focus:outline-none focus:ring-1 focus:ring-ring dark:bg-accent/50 dark:border-muted-foreground/30 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none px-1"
						@change="onQtyChange"
						@keydown.up.prevent="focusAdjacentItem(-1, 'qty')"
						@keydown.down.prevent="focusAdjacentItem(1, 'qty')"
						@keydown="blockInvalidNumericKeys"
					/>
					<Button
						variant="secondary"
						size="icon-sm"
						class="w-5 h-5 bg-primary/10 text-primary hover:bg-primary/20"
						@click="incrementQty"
					>
						<Plus class="w-2.5 h-2.5" />
					</Button>
				</template>

				<span
					v-if="isAutoDiscount"
					class="ms-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-sky-100 dark:bg-sky-900/30 text-sky-700 dark:text-sky-400 border border-sky-300 dark:border-sky-700"
					:title="autoDiscountTitle"
				>
					{{ __("Auto") }}
				</span>

				<template v-if="hasPermission('show_edit_discount_field') && !item.pos_is_free_item">
					<button
						@click="showDiscountInput = !showDiscountInput"
						class="ms-1 px-1.5 py-0.5 rounded text-[10px] font-medium transition-all"
						:class="
							hasItemDiscount
								? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 border border-emerald-300 dark:border-emerald-700'
								: 'bg-muted text-muted-foreground hover:bg-emerald-50 dark:hover:bg-emerald-900/20'
						"
					>
						<Percent class="w-3 h-3 inline-block" />
						{{ hasItemDiscount ? formatDiscount : "Disc" }}
					</button>
				</template>
			</div>

			<div
				v-if="showDiscountInput && hasPermission('show_edit_discount_field')"
				class="mt-1.5 p-2 bg-emerald-50 dark:bg-emerald-900/20 rounded-md border border-emerald-200 dark:border-emerald-800"
			>
				<div class="flex items-center gap-2">
					<button
						@click="discountType = 'percentage'"
						class="px-2 py-0.5 rounded text-[10px] font-medium transition-all"
						:class="
							discountType === 'percentage'
								? 'bg-emerald-600 text-white'
								: 'bg-white dark:bg-muted border border-emerald-300 dark:border-emerald-700'
						"
					>
						%
					</button>
					<button
						@click="discountType = 'amount'"
						class="px-2 py-0.5 rounded text-[10px] font-medium transition-all"
						:class="
							discountType === 'amount'
								? 'bg-emerald-600 text-white'
								: 'bg-white dark:bg-muted border border-emerald-300 dark:border-emerald-700'
						"
					>
						{{ currencySymbol }}
					</button>
					<input
						v-model.number="discountInput"
						type="number"
						min="0"
						:max="discountType === 'percentage' ? maxDiscount || 100 : undefined"
						step="0.5"
						placeholder="0"
						class="flex-1 h-6 text-center text-[11px] font-semibold text-emerald-700 dark:text-emerald-400 bg-white dark:bg-muted rounded border border-emerald-300 dark:border-emerald-700 focus:outline-none focus:ring-1 focus:ring-emerald-400 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
						@blur="applyDiscount"
						@keydown.enter="applyDiscount"
						@keydown="blockInvalidNumericKeys"
					/>
				</div>
			</div>
		</div>

		<div class="flex flex-col items-end gap-0.5 shrink-0">
			<span class="text-xs font-bold text-foreground tabular-nums" data-testid="cart-amount">
				{{ money(lineTotal) }}
			</span>
			<span v-if="hasItemDiscount" class="text-[9px] text-emerald-600 dark:text-emerald-400">
				-{{ money(discountAmount) }}
			</span>
			<Button
				variant="ghost"
				size="icon-sm"
				class="md:opacity-0 md:group-hover:opacity-100 w-5 h-5 md:w-4 md:h-4 text-muted-foreground hover:text-destructive transition-all"
				@click="$emit('remove', index)"
			>
				<Trash2 class="w-3.5 h-3.5" />
			</Button>
		</div>
	</div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, nextTick } from "vue";
import { usePosStore } from "@/stores/posStore";
import { hasPermission } from "@/services/userRights";
import { useCartStore } from "@/stores/cartStore";
import { useItemStore } from "@/stores/itemStore";
import { Button } from "@/components/ui/button";
import { Package, Minus, Plus, Trash2, Percent, ChevronDown } from "lucide-vue-next";
import type { ItemUOM } from "@/types/pos.types";
import __ from "@/lib/translate";
import { useMoney } from "@/composables/useMoney";

const props = defineProps({
	item: { type: Object, required: true },
	index: { type: Number, required: true },
	currencySymbol: { type: String, default: "$" },
});

const emit = defineEmits(["update-qty", "update-rate", "update-discount", "update-uom", "remove"]);

const posStore = usePosStore();
const cartStore = useCartStore();
const { money, moneyRate, percent, qty } = useMoney();
const itemStore = useItemStore();

const qtyInput = ref<HTMLInputElement | null>(null);
const uomToggleRef = ref<HTMLButtonElement | null>(null);
const uomContainerRef = ref<HTMLDivElement | null>(null);

const showUOMSelector = ref(false);
const showDiscountInput = ref(false);
const discountType = ref<"percentage" | "amount">("percentage");
const discountInput = ref(0);
const itemUOMs = ref<ItemUOM[]>([]);

const maxDiscount = computed(() => posStore.maxDiscountAllowed);

const isSelected = computed(() => cartStore.selectedCartIndex === props.index);

const hasMultipleUOMs = computed(() => itemUOMs.value.length > 1);

const hasItemDiscount = computed(
	() => (props.item.discount_percentage || 0) > 0 || (props.item.discount_amount || 0) > 0,
);

const isAutoDiscount = computed(() => (props.item.pos_pricing_rules?.length || 0) > 0);

const autoDiscountTitle = computed(() =>
	isAutoDiscount.value ? __("Applied by pricing rule: {0}", [props.item.pos_pricing_rules.join(", ")]) : "",
);

const formatDiscount = computed(() => {
	if (props.item.discount_percentage > 0) {
		return percent(props.item.discount_percentage);
	}
	if (props.item.discount_amount > 0) {
		return money(props.item.discount_amount);
	}
	return "";
});

const discountAmount = computed(() => {
	const total = props.item.qty * props.item.rate;
	if (props.item.discount_percentage > 0) {
		return (total * props.item.discount_percentage) / 100;
	}
	const amt = props.item.discount_amount || 0;
	return props.item.qty < 0 ? -amt : amt;
});

const lineTotal = computed(() => {
	const total = props.item.qty * props.item.rate;
	return Math.round((total - discountAmount.value + Number.EPSILON) * 100) / 100;
});

onMounted(async () => {
	await loadItemUOMs();
	if (props.item.discount_percentage > 0) {
		discountType.value = "percentage";
		discountInput.value = props.item.discount_percentage;
	} else if (props.item.discount_amount > 0) {
		discountType.value = "amount";
		discountInput.value = props.item.discount_amount;
	}
});

watch(
	() => props.item.item_code,
	async () => {
		await loadItemUOMs();
	},
);

async function loadItemUOMs() {
	try {
		const detail = await itemStore.fetchItemDetail(
			props.item.item_code,
			posStore.profileName,
			posStore.warehouse,
		);
		if (detail?.uoms) {
			itemUOMs.value = detail.uoms;
		} else {
			itemUOMs.value = [{ uom: props.item.stock_uom || props.item.uom, conversion_factor: 1 }];
		}
	} catch {
		itemUOMs.value = [{ uom: props.item.stock_uom || props.item.uom, conversion_factor: 1 }];
	}
}

// Focus the currently-selected UOM button when popup opens
watch(showUOMSelector, (open) => {
	if (open) {
		nextTick(() => {
			const current = props.item.uom || props.item.stock_uom;
			const btn = uomContainerRef.value?.querySelector(
				`[data-uom="${current}"]`,
			) as HTMLButtonElement | null;
			btn?.focus();
		});
	} else {
		uomToggleRef.value?.focus();
	}
});

function cycleUOM(direction: number) {
	if (itemUOMs.value.length <= 1) return;
	const current = props.item.uom || props.item.stock_uom;
	const idx = itemUOMs.value.findIndex((u) => u.uom === current);
	const next = (idx + direction + itemUOMs.value.length) % itemUOMs.value.length;
	selectUOM(itemUOMs.value[next]);
}

function handleUOMContainerKeydown(event: KeyboardEvent) {
	if (event.key === "Escape") {
		showUOMSelector.value = false;
		return;
	}
	const num = parseInt(event.key);
	if (!isNaN(num) && num >= 1 && num <= itemUOMs.value.length) {
		event.preventDefault();
		selectUOM(itemUOMs.value[num - 1]);
	}
}

function focusUOMButton(event: KeyboardEvent, direction: number) {
	const container = uomContainerRef.value;
	if (!container) return;
	const buttons = Array.from(container.querySelectorAll("button[data-uom]")) as HTMLButtonElement[];
	const idx = buttons.indexOf(event.target as HTMLButtonElement);
	if (idx < 0) return;
	const next = (idx + direction + buttons.length) % buttons.length;
	buttons[next]?.focus();
}

function selectUOM(u: ItemUOM) {
	const baseRate = props.item.rate / (props.item.conversion_factor || 1);
	const newRate = roundRate(baseRate * u.conversion_factor);
	emit("update-uom", props.index, u.uom, newRate, u.conversion_factor);
	showUOMSelector.value = false;
}

function incrementQty() {
	emit("update-qty", props.index, props.item.qty + 1);
}

function decrementQty() {
	emit("update-qty", props.index, props.item.qty - 1);
}

function onQtyChange(e: Event) {
	const val = parseFloat((e.target as HTMLInputElement).value) || 0;
	emit("update-qty", props.index, val);
}

function onRateChange(e: Event) {
	const val = parseFloat((e.target as HTMLInputElement).value) || 0;
	emit("update-rate", props.index, roundRate(val));
}

function applyDiscount() {
	let val = discountInput.value || 0;
	if (discountType.value === "percentage") {
		const max = maxDiscount.value || 100;
		val = Math.min(val, max);
	}
	emit("update-discount", props.index, discountType.value, val);
}

function focusAdjacentItem(direction: number, field: "qty" | "rate") {
	const targetIndex = props.index + direction;
	const container = qtyInput.value?.closest("[data-cart-index]")?.parentElement;
	if (!container) return;

	const targetEl = container.querySelector(`[data-cart-index="${targetIndex}"]`);
	if (!targetEl) return;

	if (field === "qty") {
		const inputs = targetEl.querySelectorAll('input[type="number"]');
		const qtyEl = inputs.length > 1 ? inputs[1] : inputs[0];
		if (qtyEl) {
			(qtyEl as HTMLInputElement).focus();
			(qtyEl as HTMLInputElement).select();
		}
	} else {
		const rateEl = targetEl.querySelector('input[type="number"]');
		if (rateEl) {
			(rateEl as HTMLInputElement).focus();
			(rateEl as HTMLInputElement).select();
		}
	}
}

const ratePrecision = computed(() => cartStore.itemRatePrecision);

const rateStep = computed(() => {
	const p = ratePrecision.value;
	return p > 0 ? (1 / 10 ** p).toFixed(p) : "1";
});

function roundRate(value: number) {
	const p = ratePrecision.value;
	return Math.round((value + Number.EPSILON) * 10 ** p) / 10 ** p;
}

function blockInvalidNumericKeys(event: KeyboardEvent) {
	if (["e", "E", "+", "-"].includes(event.key)) {
		event.preventDefault();
	}
}

function selectRow() {
	cartStore.setSelectedCartIndex(props.index);
}

function handleDeleteKey(event: KeyboardEvent) {
	if (event.target !== event.currentTarget) return;
	event.preventDefault();
	event.stopPropagation();
	selectRow();
	emit("remove", props.index);
}

function handleRowKeydown(event: KeyboardEvent) {
	const targetIsRow = event.target === event.currentTarget;
	const tag = (event.target as HTMLElement)?.tagName?.toLowerCase();
	const isInputLike = tag === "input" || tag === "textarea";

	if (targetIsRow && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
		event.preventDefault();
		focusAdjacentRow(event.key === "ArrowDown" ? 1 : -1);
		return;
	}

	if (targetIsRow && event.key === "Enter") {
		event.preventDefault();
		qtyInput.value?.focus();
		qtyInput.value?.select();
		return;
	}

	if (isInputLike) return;

	if ((event.key === "u" || event.key === "U") && hasMultipleUOMs.value) {
		event.preventDefault();
		showUOMSelector.value = !showUOMSelector.value;
		return;
	}
	if (!showUOMSelector.value && hasMultipleUOMs.value) {
		const num = parseInt(event.key);
		if (!isNaN(num) && num >= 1 && num <= itemUOMs.value.length) {
			event.preventDefault();
			selectUOM(itemUOMs.value[num - 1]);
		}
	}
}

function focusAdjacentRow(direction: number) {
	const targetIndex = props.index + direction;
	const currentEl = document.querySelector(`[data-cart-index="${props.index}"]`) as HTMLElement | null;
	const container = currentEl?.parentElement;
	if (!container) return;
	const targetEl = container.querySelector(`[data-cart-index="${targetIndex}"]`) as HTMLElement | null;
	if (targetEl) {
		targetEl.focus();
		targetEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
	}
}
</script>
