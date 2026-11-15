import { computed, ref, watch, type Ref } from "vue";
import { usePosStore } from "@/stores/posStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { formatQty } from "@/utils/numberFormat";
import type { POSItem } from "@/types/pos.types";
import __ from "@/lib/translate";

/**
 * Display state shared by the catalogue card and list row.
 *
 * Presentation only: whether an item can actually be sold is still decided by
 * `handleAddItem` / the cart store. `isUnavailable` mirrors the rule the tiles always used.
 */
export function useItemTileState(item: Ref<POSItem>) {
	const posStore = usePosStore();
	const layoutStore = useLayoutStore();
	/** Personal choices only ever hide extras; profile settings still decide what may show. */
	const shows = (field: string) => layoutStore.shared.productDisplay.includes(field);

	const showItemCode = computed(() => posStore.displayItemCode && shows("item_code"));
	const showUom = computed(() => shows("uom") && !!item.value.stock_uom);
	const allowNegativeStock = computed(() => !!posStore.stockSettings?.allow_negative_stock);

	const isNonStockItem = computed(() => Number(item.value.is_stock_item) === 0);
	const isOutOfStock = computed(() => {
		if (isNonStockItem.value) return false;
		const qty = item.value.actual_qty;
		return qty !== undefined && qty <= 0;
	});

	/** Out-of-stock is never hidden: it is why a tile cannot be sold. */
	const hasStockFigure = computed(
		() =>
			!isNonStockItem.value &&
			item.value.actual_qty !== undefined &&
			(shows("stock") || isOutOfStock.value),
	);

	const isUnavailable = computed(() => isOutOfStock.value && !allowNegativeStock.value);

	/** Matches handleAddItem: a template opens the variant picker unless variants are hidden. */
	const isTemplate = computed(() => !!item.value.has_variants && !posStore.hideVariantsItems);

	const priceMissing = computed(() => !Number(item.value.rate) && !posStore.allowZeroRatedItems);

	const stockTone = computed<"destructive" | "warning" | "success">(() => {
		const qty = item.value.actual_qty || 0;
		if (qty <= 0) return isUnavailable.value ? "destructive" : "warning";
		if (qty <= 5) return "warning";
		return "success";
	});

	const stockLabel = computed(() => {
		const stock = item.value.actual_qty || 0;
		if (stock <= 0) return __("Out of stock");
		return __("In stock: {0}", [stock > 999 ? "999+" : formatQty(stock)]);
	});

	const imageFailed = ref(false);
	watch(
		() => item.value.image,
		() => (imageFailed.value = false),
	);
	const showImage = computed(
		() => !!item.value.image && !posStore.hideImages && shows("image") && !imageFailed.value,
	);
	const showThumbColumn = computed(() => !posStore.hideImages && shows("image"));

	const actionLabel = computed(() =>
		isTemplate.value
			? __("Choose variant of {0}", [item.value.item_name])
			: __("Add {0}", [item.value.item_name]),
	);

	return {
		showItemCode,
		showUom,
		isNonStockItem,
		hasStockFigure,
		isOutOfStock,
		isUnavailable,
		isTemplate,
		priceMissing,
		stockTone,
		stockLabel,
		imageFailed,
		showImage,
		showThumbColumn,
		actionLabel,
	};
}

export const STOCK_TONE_CLASS = {
	destructive: "border-destructive/30 bg-destructive-soft text-destructive-soft-foreground",
	warning: "border-warning/30 bg-warning-soft text-warning-soft-foreground",
	success: "border-success/25 bg-success-soft text-success-soft-foreground",
} as const;

/** Column template shared by the dense list rows and their header. */
export function itemRowGrid(withThumb: boolean): string {
	return withThumb
		? "grid-cols-[2.25rem_minmax(0,1fr)_7.5rem_6.5rem] xl:grid-cols-[2.25rem_minmax(0,1fr)_minmax(0,12rem)_7.5rem_7rem]"
		: "grid-cols-[minmax(0,1fr)_7.5rem_6.5rem] xl:grid-cols-[minmax(0,1fr)_minmax(0,12rem)_7.5rem_7rem]";
}
