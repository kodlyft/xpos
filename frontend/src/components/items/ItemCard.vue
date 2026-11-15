<template>
	<article
		class="group relative flex min-w-0 flex-col rounded-2xl border bg-card transition-[border-color,box-shadow] duration-fast ease-standard"
		:class="[
			isUnavailable
				? 'border-border'
				: highlighted
					? 'border-primary shadow-raised-hover ring-2 ring-primary/40'
					: 'border-border shadow-raised hover:border-border-strong hover:shadow-raised-hover',
		]"
		:data-state="isUnavailable ? 'unavailable' : isTemplate ? 'template' : undefined"
	>
		<button
			type="button"
			class="flex min-w-0 flex-1 select-none flex-col rounded-2xl p-2 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-background"
			:class="isUnavailable ? 'cursor-not-allowed' : 'cursor-pointer motion-safe:active:scale-[0.99]'"
			:aria-label="actionLabel"
			:aria-disabled="isUnavailable || undefined"
			data-testid="item-add"
			@click="handleClick"
		>
			<span
				class="relative block aspect-4/3 w-full overflow-hidden rounded-xl bg-surface-sunken"
				:class="isUnavailable && 'opacity-50 grayscale'"
			>
				<img
					v-if="showImage"
					:src="item.image as string"
					alt=""
					width="160"
					height="120"
					loading="lazy"
					decoding="async"
					class="absolute inset-0 h-full w-full object-contain p-1.5"
					@error="imageFailed = true"
				/>
				<span v-else class="absolute inset-0 flex items-center justify-center" aria-hidden="true">
					<Package class="size-8 text-muted-foreground/50" />
				</span>
				<span
					v-if="isTemplate"
					class="absolute inset-s-1.5 top-1.5 inline-flex items-center gap-1 rounded-md border border-info/30 bg-info-soft px-1.5 py-0.5 text-[0.6875rem] font-semibold text-info-soft-foreground"
				>
					<Layers class="size-3" aria-hidden="true" />
					{{ __("Variants") }}
				</span>
			</span>

			<span class="mt-2 flex min-w-0 flex-1 flex-col px-0.5">
				<span
					class="line-clamp-2 min-h-10 text-sm font-semibold leading-5 text-foreground"
					:class="isUnavailable && 'text-muted-foreground'"
					:title="item.item_name"
					dir="auto"
				>
					{{ item.item_name }}
				</span>
				<span
					v-if="showItemCode"
					class="mt-0.5 truncate font-mono text-[0.6875rem] text-muted-foreground"
					:title="item.item_code"
				>
					{{ item.item_code }}
				</span>
				<span class="mt-auto flex items-end justify-between gap-2 pt-2">
					<span class="min-w-0">
						<span
							v-if="priceMissing"
							class="block text-sm font-semibold text-warning-soft-foreground"
							data-testid="price-missing"
						>
							{{ __("No price") }}
						</span>
						<span
							v-else
							class="block truncate text-base font-bold leading-tight text-foreground tabular-nums"
						>
							{{ money(item.rate) }}
							<span v-if="showUom" class="ms-1 text-xs font-normal text-muted-foreground"
								>/ {{ item.stock_uom }}</span
							>
						</span>
						<span
							v-if="hasStockFigure"
							class="mt-1.5 inline-flex rounded-md border px-1.5 py-0.5 text-[0.6875rem] font-semibold leading-none tabular-nums"
							:class="STOCK_TONE_CLASS[stockTone]"
						>
							{{ stockLabel }}
						</span>
					</span>
					<span
						v-if="!isUnavailable"
						class="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-primary transition-colors group-hover:bg-primary/90"
						aria-hidden="true"
					>
						<ChevronRight v-if="isTemplate" class="size-4 rtl:rotate-180" stroke-width="2.5" />
						<Plus v-else class="size-4" stroke-width="2.5" />
					</span>
				</span>
			</span>
		</button>

		<button
			type="button"
			class="absolute inset-e-3.5 top-3.5 inline-flex size-8 items-center justify-center rounded-full border border-border bg-card/90 text-foreground shadow-raised backdrop-blur-sm transition-colors duration-fast hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
			:aria-label="__('Details for {0}', [item.item_name])"
			data-testid="item-details"
			@click="$emit('showDetail', item)"
		>
			<Info class="size-4" />
		</button>
	</article>
</template>

<script setup lang="ts">
import { toRef } from "vue";
import { useMoney } from "@/composables/useMoney";
import { STOCK_TONE_CLASS, useItemTileState } from "@/composables/useItemTileState";
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
	showUom,
	actionLabel,
} = useItemTileState(toRef(props, "item"));

function handleClick() {
	if (isUnavailable.value) return;
	emit("click", props.item);
}
</script>
