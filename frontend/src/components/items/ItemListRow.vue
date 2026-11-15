<template>
	<div
		class="group flex min-w-0 items-center gap-1 border-x border-b border-x-border border-b-border/70 pe-1.5 transition-colors duration-fast"
		:class="[
			highlighted ? 'bg-surface-selected' : 'bg-card hover:bg-surface-hover',
			isUnavailable && 'text-muted-foreground',
		]"
		:data-state="isUnavailable ? 'unavailable' : isTemplate ? 'template' : undefined"
	>
		<button
			type="button"
			class="flex min-w-0 flex-1 select-none items-center gap-3 rounded-lg py-1.5 ps-2 pe-1 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
			:class="[
				isUnavailable ? 'cursor-not-allowed' : 'cursor-pointer',
				layoutStore.device.density === 'compact'
					? 'min-h-10'
					: layoutStore.device.density === 'touch'
						? 'min-h-16'
						: 'min-h-12',
			]"
			:aria-label="actionLabel"
			:aria-disabled="isUnavailable || undefined"
			data-testid="item-add"
			@click="handleClick"
		>
			<span class="grid min-w-0 flex-1 items-center gap-3" :class="itemRowGrid(showThumbColumn)">
				<span
					v-if="showThumbColumn"
					class="relative flex size-9 items-center justify-center overflow-hidden rounded-md border border-border bg-surface-sunken"
					:class="isUnavailable && 'opacity-50 grayscale'"
					aria-hidden="true"
				>
					<img
						v-if="showImage"
						:src="item.image as string"
						alt=""
						width="36"
						height="36"
						loading="lazy"
						decoding="async"
						class="absolute inset-0 h-full w-full object-contain p-0.5"
						@error="imageFailed = true"
					/>
					<Package v-else class="size-4 text-muted-foreground/60" />
				</span>

				<span class="min-w-0">
					<span class="flex min-w-0 items-center gap-1.5">
						<span
							class="truncate text-sm font-semibold text-foreground"
							:title="item.item_name"
							dir="auto"
						>
							{{ item.item_name }}
						</span>
						<span
							v-if="isTemplate"
							class="inline-flex shrink-0 items-center gap-1 rounded border border-info/30 bg-info-soft px-1 text-[0.625rem] font-semibold leading-4 text-info-soft-foreground"
						>
							<Layers class="size-2.5" aria-hidden="true" />
							{{ __("Variants") }}
						</span>
					</span>
					<span
						v-if="showItemCode"
						class="block truncate font-mono text-[0.6875rem] leading-4 text-muted-foreground"
						:title="item.item_code"
					>
						{{ item.item_code }}
					</span>
				</span>

				<span class="hidden truncate text-xs text-muted-foreground xl:block" :title="item.item_group">
					{{ item.item_group ? __(item.item_group) : "" }}
				</span>

				<span class="justify-self-end">
					<span
						v-if="hasStockFigure"
						class="inline-flex rounded border px-1.5 py-0.5 text-[0.6875rem] font-semibold leading-none tabular-nums"
						:class="STOCK_TONE_CLASS[stockTone]"
					>
						{{ stockLabel }}
					</span>
				</span>

				<span class="text-end">
					<span
						v-if="priceMissing"
						class="text-xs font-semibold text-warning-soft-foreground"
						data-testid="price-missing"
					>
						{{ __("No price") }}
					</span>
					<span v-else class="text-sm font-bold text-foreground tabular-nums"
						>{{ money(item.rate)
						}}<span v-if="showUom" class="ms-1 text-xs font-normal text-muted-foreground"
							>/ {{ item.stock_uom }}</span
						></span
					>
				</span>
			</span>
			<span
				class="inline-flex size-7 shrink-0 items-center justify-center rounded-full"
				:class="isUnavailable ? 'invisible' : 'bg-primary text-primary-foreground'"
				aria-hidden="true"
			>
				<ChevronRight v-if="isTemplate" class="size-4 rtl:rotate-180" stroke-width="2.5" />
				<Plus v-else class="size-4" stroke-width="2.5" />
			</span>
		</button>

		<button
			type="button"
			class="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors duration-fast hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
			:aria-label="__('Details for {0}', [item.item_name])"
			data-testid="item-details"
			@click="$emit('showDetail', item)"
		>
			<Info class="size-4" />
		</button>
	</div>
</template>

<script setup lang="ts">
import { toRef } from "vue";
import { useMoney } from "@/composables/useMoney";
import { useLayoutStore } from "@/stores/layoutStore";
import { itemRowGrid, STOCK_TONE_CLASS, useItemTileState } from "@/composables/useItemTileState";
import { ChevronRight, Info, Layers, Package, Plus } from "lucide-vue-next";
import type { POSItem } from "@/types/pos.types";
import __ from "@/lib/translate";

const props = defineProps({
	item: { type: Object as () => POSItem, required: true },
	currencySymbol: { type: String, default: "$" },
	highlighted: { type: Boolean, default: false },
});

const emit = defineEmits(["click", "showDetail"]);

const { money } = useMoney();
const layoutStore = useLayoutStore();
const {
	showItemCode,
	hasStockFigure,
	isUnavailable,
	isTemplate,
	priceMissing,
	stockTone,
	stockLabel,
	imageFailed,
	showImage,
	showThumbColumn,
	showUom,
	actionLabel,
} = useItemTileState(toRef(props, "item"));

function handleClick() {
	if (isUnavailable.value) return;
	emit("click", props.item);
}
</script>
