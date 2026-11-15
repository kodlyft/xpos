<template>
	<div :aria-busy="isLoading || undefined">
		<template v-if="isLoading && items.length === 0">
			<div v-if="viewMode === 'grid'" :class="gridClass" data-testid="items-loading">
				<div v-for="i in 12" :key="i" class="rounded-2xl border border-border bg-card p-2">
					<Skeleton class="aspect-4/3 w-full rounded-xl" />
					<Skeleton class="mt-2.5 h-4 w-4/5" />
					<Skeleton class="mt-1.5 h-4 w-1/2" />
					<Skeleton class="mt-4 h-5 w-1/3" />
				</div>
			</div>
			<div v-else data-testid="items-loading">
				<div
					v-for="i in 10"
					:key="i"
					class="flex h-12 items-center gap-3 border-b border-border/70 px-2"
				>
					<Skeleton v-if="showThumb" class="size-9 rounded-md" />
					<Skeleton class="h-4 flex-1" />
					<Skeleton class="h-4 w-16" />
				</div>
			</div>
		</template>

		<ErrorState
			v-else-if="loadError && items.length === 0"
			:title="__('Products could not be loaded')"
			:description="__('Check the connection and try again.')"
			retryable
			:retrying="isLoading"
			data-testid="items-error"
			@retry="$emit('retry')"
		/>

		<EmptyState
			v-else-if="items.length === 0 && hasFilters"
			:icon="PackageSearch"
			:title="__('No products match')"
			:description="__('Try another search term or category.')"
			data-testid="items-empty"
		>
			<Button variant="outline" @click="$emit('clearFilters')">
				<X />
				{{ __("Clear filters") }}
			</Button>
		</EmptyState>

		<EmptyState
			v-else-if="items.length === 0"
			:icon="PackageSearch"
			:title="__('No products available')"
			:description="__('This POS Profile has no sellable items yet.')"
			data-testid="items-empty"
		/>

		<div v-else data-testid="items-box">
			<div
				v-if="viewMode === 'list'"
				class="sticky top-0 z-10 flex items-center gap-1 border border-border bg-surface-sunken ring-1 ring-inset ring-border pe-1.5 text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground"
				aria-hidden="true"
			>
				<div class="flex min-w-0 flex-1 items-center gap-3 py-1.5 ps-2 pe-1">
					<div class="grid min-w-0 flex-1 items-center gap-3" :class="itemRowGrid(showThumb)">
						<span v-if="showThumb" />
						<span>{{ __("Item") }}</span>
						<span class="hidden xl:block">{{ __("Group") }}</span>
						<span class="justify-self-end">{{ __("Stock") }}</span>
						<span class="text-end">{{ __("Price") }}</span>
					</div>
					<span class="w-7 shrink-0" />
				</div>
				<span class="w-8 shrink-0" />
			</div>
			<div
				v-if="viewMode === 'grid'"
				ref="probe"
				:class="gridClass"
				class="h-0 overflow-hidden"
				aria-hidden="true"
			>
				<div />
			</div>

			<div
				ref="listEl"
				role="list"
				:aria-label="__('Products')"
				class="relative w-full"
				:style="{ height: `${virtualizer.getTotalSize()}px` }"
			>
				<div
					v-for="row in virtualizer.getVirtualItems()"
					:key="`${viewMode}-${row.index}`"
					:ref="measureRow"
					:data-index="row.index"
					class="absolute inset-x-0 top-0"
					:class="viewMode === 'grid' && gridClass"
					:style="{ transform: `translateY(${row.start - virtualizer.options.scrollMargin}px)` }"
				>
					<template v-for="index in rowIndexes(row.index)" :key="items[index].item_code">
						<ItemCard
							v-if="viewMode === 'grid'"
							role="listitem"
							:aria-setsize="items.length"
							:aria-posinset="index + 1"
							:item="items[index]"
							:currency-symbol="currencySymbol"
							:highlighted="index === highlightedIndex"
							:data-item-index="index"
							@click="$emit('selectItem', items[index])"
							@show-detail="$emit('showDetail', items[index])"
						/>
						<ItemListRow
							v-else
							role="listitem"
							:aria-setsize="items.length"
							:aria-posinset="index + 1"
							:item="items[index]"
							:currency-symbol="currencySymbol"
							:highlighted="index === highlightedIndex"
							:data-item-index="index"
							@click="$emit('selectItem', items[index])"
							@show-detail="$emit('showDetail', items[index])"
						/>
					</template>
				</div>
			</div>
			<div
				v-if="viewMode === 'list'"
				class="h-2 border border-t-0 border-border bg-card"
				aria-hidden="true"
			/>
		</div>

		<div v-if="isLoading && items.length > 0" class="flex justify-center py-6" role="status">
			<Loader2 class="size-6 animate-spin text-primary" aria-hidden="true" />
			<span class="sr-only">{{ __("Loading more products") }}</span>
		</div>

		<ErrorState
			v-else-if="loadError && items.length > 0"
			compact
			:title="__('More products could not be loaded')"
			retryable
			@retry="$emit('loadMore')"
		/>
	</div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useVirtualizer } from "@tanstack/vue-virtual";
import ItemCard from "./ItemCard.vue";
import ItemListRow from "./ItemListRow.vue";
import { Loader2, PackageSearch, X } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/state";
import { Skeleton } from "@/components/ui/skeleton";
import { itemRowGrid } from "@/composables/useItemTileState";
import { useLayoutStore } from "@/stores/layoutStore";
import type { POSItem } from "@/types/pos.types";
import __ from "@/lib/translate";

const GRID_CLASS = {
	compact: "grid grid-cols-3 gap-2 sm:grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))]",
	comfortable: "grid grid-cols-2 gap-2.5 sm:grid-cols-[repeat(auto-fill,minmax(10.5rem,1fr))] sm:gap-3",
	touch: "grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] sm:gap-4",
} as const;
const GRID_ROW = { compact: 224, comfortable: 268, touch: 304 } as const;
const LIST_ROW = { compact: 41, comfortable: 49, touch: 64 } as const;

const layoutStore = useLayoutStore();
const density = computed(() => layoutStore.device.density);
const showThumb = computed(() => !props.hideImages && layoutStore.shared.productDisplay.includes("image"));
const gridClass = computed(() => GRID_CLASS[density.value]);

const props = defineProps({
	items: { type: Array as () => POSItem[], default: () => [] },
	isLoading: { type: Boolean, default: false },
	loadError: { type: String as () => string | null, default: null },
	hasFilters: { type: Boolean, default: false },
	hideImages: { type: Boolean, default: false },
	currencySymbol: { type: String, default: "$" },
	viewMode: { type: String as () => "grid" | "list", default: "grid" },
	highlightedIndex: { type: Number, default: -1 },
	scrollElement: { type: Object as () => HTMLElement | null, default: null },
});

const emit = defineEmits(["selectItem", "showDetail", "loadMore", "retry", "clearFilters"]);

const probe = ref<HTMLElement | null>(null);
const listEl = ref<HTMLElement | null>(null);
const columns = ref(4);
const rowGap = ref(12);
const scrollMargin = ref(0);

const perRow = computed(() => (props.viewMode === "grid" ? columns.value : 1));
const rowCount = computed(() => Math.ceil(props.items.length / perRow.value));

const virtualizer = useVirtualizer(
	computed(() => ({
		count: rowCount.value,
		getScrollElement: () => props.scrollElement,
		estimateSize: () => (props.viewMode === "grid" ? GRID_ROW[density.value] : LIST_ROW[density.value]),
		gap: props.viewMode === "grid" ? rowGap.value : 0,
		overscan: 3,
		useAnimationFrameWithResizeObserver: true,
		scrollMargin: scrollMargin.value,
	})),
);

function rowIndexes(row: number): number[] {
	const first = row * perRow.value;
	const last = Math.min(props.items.length, first + perRow.value);
	return Array.from({ length: Math.max(0, last - first) }, (_, i) => first + i);
}

function measureRow(el: unknown): void {
	if (el instanceof HTMLElement) virtualizer.value.measureElement(el);
}

function measureLayout(): void {
	if (probe.value) {
		const style = getComputedStyle(probe.value);
		columns.value = Math.max(1, style.gridTemplateColumns.split(" ").filter(Boolean).length);
		rowGap.value = parseFloat(style.rowGap) || 12;
	}
	const scroller = props.scrollElement;
	if (scroller && listEl.value) {
		scrollMargin.value = Math.round(
			listEl.value.getBoundingClientRect().top -
				scroller.getBoundingClientRect().top +
				scroller.scrollTop,
		);
	}
}

function scrollToIndex(index: number): void {
	if (index < 0 || index >= props.items.length) return;
	virtualizer.value.scrollToIndex(Math.floor(index / perRow.value), { align: "auto" });
}

defineExpose({ scrollToIndex });

let layoutObserver: ResizeObserver | null = null;
let layoutFrame = 0;

function scheduleMeasure(): void {
	if (layoutFrame) return;
	layoutFrame = requestAnimationFrame(() => {
		layoutFrame = 0;
		measureLayout();
	});
}

onMounted(() => {
	measureLayout();
	if (typeof ResizeObserver !== "undefined") {
		layoutObserver = new ResizeObserver(scheduleMeasure);
		if (probe.value) layoutObserver.observe(probe.value);
		if (props.scrollElement) layoutObserver.observe(props.scrollElement);
	}
});

onUnmounted(() => {
	layoutObserver?.disconnect();
	if (layoutFrame) cancelAnimationFrame(layoutFrame);
});

watch(
	() => [props.viewMode, props.scrollElement, showThumb.value, density.value] as const,
	async () => {
		await nextTick();
		measureLayout();
		layoutObserver?.disconnect();
		if (probe.value) layoutObserver?.observe(probe.value);
		if (props.scrollElement) layoutObserver?.observe(props.scrollElement);
		virtualizer.value.measure();
	},
);

watch(
	() => [virtualizer.value.getVirtualItems().at(-1)?.index ?? -1, rowCount.value, props.isLoading] as const,
	([last, rows, loading]) => {
		if (loading || props.loadError || props.items.length === 0) return;
		if (last >= rows - 2) emit("loadMore");
	},
	{ flush: "post", immediate: true },
);
</script>
