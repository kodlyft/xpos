<script setup lang="ts">
import { Package, Plus } from "@lucide/vue";
import type { CatalogItem } from "@mobile/ports";
import { formatMinor } from "@mobile/domain/money";

// Mirrors frontend/src/components/items/ItemCard.vue (the catalog feed carries no images yet).
defineProps<{ item: CatalogItem; minorDigits: number; currency: string }>();
defineEmits<{ pick: [item: CatalogItem] }>();
</script>

<template>
	<article
		class="group relative flex min-w-0 flex-col rounded-2xl border border-border bg-card shadow-raised transition-[border-color,box-shadow] duration-fast ease-standard"
	>
		<button
			type="button"
			class="flex min-w-0 flex-1 select-none cursor-pointer flex-col rounded-2xl p-2 text-start motion-safe:active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-background"
			:aria-label="
				item.priced
					? `Add ${item.name}, ${currency} ${formatMinor(item.priceMinor, minorDigits)}`
					: `${item.name}: no price in the price list, cannot be sold`
			"
			@click="$emit('pick', item)"
		>
			<span class="relative block aspect-4/3 w-full overflow-hidden rounded-xl bg-surface-sunken">
				<span class="absolute inset-0 flex items-center justify-center" aria-hidden="true"
					><Package class="size-8 text-muted-foreground/50"
				/></span>
			</span>
			<span class="mt-2 flex min-w-0 flex-1 flex-col px-0.5">
				<span
					class="line-clamp-2 min-h-10 text-sm font-semibold leading-5 text-foreground"
					:title="item.name"
					>{{ item.name }}</span
				>
				<span
					class="mt-0.5 truncate font-mono text-[0.6875rem] text-muted-foreground"
					:title="item.itemCode"
					>{{ item.itemCode }}</span
				>
				<span class="mt-auto flex items-end justify-between gap-2 pt-2">
					<span
						class="block min-w-0 truncate text-base font-bold leading-tight text-foreground tabular-nums"
						><template v-if="item.priced"
							>{{ formatMinor(item.priceMinor, minorDigits)
							}}<span class="ms-1 text-xs font-normal text-muted-foreground"
								>/ {{ item.uom }}</span
							></template
						><span v-else class="text-sm font-semibold text-warning-soft-foreground"
							>No price</span
						></span
					>
					<span
						v-if="item.priced"
						class="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-primary"
						aria-hidden="true"
						><Plus class="size-4" stroke-width="2.5"
					/></span>
				</span>
			</span>
		</button>
	</article>
</template>
