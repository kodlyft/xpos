import { defineStore } from "pinia";
import { ref, shallowRef } from "vue";
import { call, isNetworkError } from "@/services/api";
import __ from "@/lib/translate";
import { usePosStore } from "@/stores/posStore";
import { useSettingsStore } from "@/stores/settingsStore";
import {
	cacheItems as idbCacheItems,
	searchCachedItemsPage as idbSearchCachedItemsPage,
	warmCatalogIndex,
	getCachedStockForItems,
	findCachedScan,
	cacheItemGroups as idbCacheGroups,
	getCachedItemGroups as idbGetCachedGroups,
	getCachedItemByCode,
} from "@/services/dbBridge";
import { getCatalogStatus, syncCatalog } from "@/services/catalogSync";
import type {
	POSItem,
	ItemGroup,
	ItemDetail,
	ItemVariant,
	ItemAttribute,
	BundleComponent,
	StockAvailability,
} from "@/types/pos.types";
import { isOnline } from "@/utils";
import { onIdle } from "@/utils/idle";

interface ItemGroupsResult {
	groups: ItemGroup[];
	parent_groups: ItemGroup[];
}

/** A scan the till refuses with a reason the cashier can act on. */
export class BarcodeScanError extends Error {}

export const useItemStore = defineStore("items", () => {
	const items = shallowRef<POSItem[]>([]);
	const isLoading = ref(false);
	/** Set when the last catalogue fetch failed and no offline cache stood in for it. */
	const loadError = ref<string | null>(null);
	const searchTerm = ref("");
	const selectedGroup = ref("All Item Groups");
	const currentPage = ref(0);
	const pageLength = ref(40);
	const hasMore = ref(true);
	const totalCount = ref(0);
	const itemGroups = ref<ItemGroup[]>([]);
	const parentGroups = ref<ItemGroup[]>([]);

	function offlineSearchFields(): string[] {
		return useSettingsStore().itemSearchFields;
	}

	const showItemDetail = ref(false);
	const resolveLineUid = ref<string | null>(null);
	const selectedItemDetail = ref<ItemDetail | null>(null);
	const selectedItemForDetail = ref<POSItem | null>(null);
	const isLoadingDetail = ref(false);

	const showVariantPicker = ref(false);
	const variants = ref<ItemVariant[]>([]);
	const variantAttributes = ref<ItemAttribute[]>([]);
	const isLoadingVariants = ref(false);

	let cacheRun: Promise<void> | null = null;
	const CACHE_FRESH_MS = 60 * 1000;

	function cacheAllItems(posProfile: string): Promise<void> {
		if (!usePosStore().useOfflineMode) return Promise.resolve();
		if (cacheRun) return cacheRun;

		const run = refreshCatalogue(posProfile).finally(() => {
			if (cacheRun === run) cacheRun = null;
		});
		cacheRun = run;
		return run;
	}

	async function refreshCatalogue(posProfile: string): Promise<void> {
		try {
			const status = await getCatalogStatus();
			if (
				status.status === "complete" &&
				status.scopeMatches &&
				(status.ageMs ?? Infinity) < CACHE_FRESH_MS
			) {
				onIdle(() => void warmCatalogIndex(offlineSearchFields()).catch(() => {}));
				return;
			}
		} catch {
			/* no readable state: sync */
		}
		try {
			await syncCatalog(posProfile);
			warmCatalogIndex(offlineSearchFields()).catch(() => {});
		} catch (error) {
			console.warn("[XPOS Offline] Failed to sync catalogue:", error);
		}
	}

	let queryGeneration = 0;
	let loadMoreQueued = false;

	async function offlinePage(
		start: number,
	): Promise<{ rows: POSItem[]; hasMore: boolean; cached: boolean }> {
		const page = await idbSearchCachedItemsPage(
			searchTerm.value,
			selectedGroup.value,
			offlineSearchFields(),
			start,
			pageLength.value,
		);
		const warehouse = usePosStore().warehouse;
		let rows = page.items;
		if (warehouse && rows.length > 0) {
			const stock = await getCachedStockForItems(
				warehouse,
				rows.map((item) => item.item_code),
			);
			rows = rows.map((item) => ({
				...item,
				actual_qty: stock.get(item.item_code) ?? item.actual_qty,
			}));
		}
		return { rows, hasMore: page.hasMore, cached: page.total > 0 };
	}

	function showPage(rows: POSItem[], hasMoreRows: boolean, append: boolean): void {
		items.value = append ? items.value.concat(rows) : rows;
		if (!append) currentPage.value = 0;
		hasMore.value = hasMoreRows;
	}

	async function fetchItems(posProfile: string, append = false): Promise<void> {
		if (append) {
			if (isLoading.value) {
				loadMoreQueued = true;
				return;
			}
		} else {
			queryGeneration++;
			loadMoreQueued = false;
		}
		const generation = queryGeneration;
		isLoading.value = true;
		loadError.value = null;

		try {
			const start = append ? items.value.length : 0;

			if (!isOnline() && usePosStore().useOfflineMode) {
				const page = await offlinePage(start);
				if (generation !== queryGeneration) return;
				showPage(page.rows, page.hasMore, append);
				return;
			}

			if (isOnline()) {
				const result = await call<POSItem[]>("xpos.api.items.get_pos_items", {
					pos_profile: posProfile,
					search_term: searchTerm.value,
					item_group: selectedGroup.value === "All Item Groups" ? "" : selectedGroup.value,
					start,
					page_length: pageLength.value,
				});
				if (generation !== queryGeneration) return;

				showPage(result, result.length === pageLength.value, append);

				if (!searchTerm.value && !append && selectedGroup.value === "All Item Groups") {
					if (usePosStore().useOfflineMode) {
						cacheAllItems(posProfile).catch(() => {});
					}
				}
			}
		} catch (error) {
			if (generation !== queryGeneration) return;
			if (usePosStore().useOfflineMode) {
				try {
					const page = await offlinePage(0);
					if (generation !== queryGeneration) return;
					if (page.cached) {
						showPage(page.rows, page.hasMore, false);
						console.log("[XPOS Offline] Serving items from idb cache after fetch failure");
						return;
					}
				} catch {
					/* ignore */
				}
			}
			console.error("Error fetching items:", error);
			loadError.value = error instanceof Error ? error.message : String(error);
		} finally {
			if (generation === queryGeneration) {
				isLoading.value = false;
				if (loadMoreQueued) {
					loadMoreQueued = false;
					if (hasMore.value) void fetchItems(posProfile, true);
				}
			}
		}
	}

	async function fetchItemGroups(): Promise<void> {
		try {
			if (!isOnline() && usePosStore().useOfflineMode) {
				const cached = await idbGetCachedGroups();
				itemGroups.value = cached.groups;
				parentGroups.value = cached.parentGroups;
				return;
			}

			if (isOnline()) {
				const result = await call<ItemGroupsResult>("xpos.api.items.get_item_groups", {
					pos_profile: usePosStore().profileName,
				});
				itemGroups.value = result.groups || [];
				parentGroups.value = result.parent_groups || [];

				if (usePosStore().useOfflineMode) {
					idbCacheGroups(itemGroups.value, parentGroups.value).catch(() => {});
				}
			}
		} catch (error) {
			if (usePosStore().useOfflineMode) {
				try {
					const cached = await idbGetCachedGroups();
					if (cached.groups.length > 0) {
						itemGroups.value = cached.groups;
						parentGroups.value = cached.parentGroups;
						return;
					}
				} catch {
					/* ignore */
				}
			}
			console.error("Error fetching item groups:", error);
		}
	}

	/** The offline answer for a scan: same item, UOM, factor and rate the server would give. */
	async function scanFromCache(barcode: string): Promise<POSItem | null> {
		const hit = await findCachedScan(barcode);
		if (!hit) return null;
		if (hit.kind === "ambiguous") {
			throw new BarcodeScanError(
				__("Barcode {0} matches more than one item: {1}.", [barcode, hit.codes.join(", ")]),
			);
		}
		if (!hit.conversion_factor) {
			throw new BarcodeScanError(
				__("Barcode {0} is set to UOM {1}, which has no conversion factor on item {2}.", [
					barcode,
					hit.uom,
					hit.item.item_code,
				]),
			);
		}
		return {
			...hit.item,
			barcode: hit.barcode,
			uom: hit.uom,
			conversion_factor: hit.conversion_factor,
			rate: hit.rate,
		} as POSItem;
	}

	async function searchByBarcode(barcode: string, _posProfile?: string): Promise<POSItem | null> {
		if (!isOnline()) return scanFromCache(barcode);
		try {
			return await call<POSItem | null>("xpos.api.items.search_barcode", {
				barcode: barcode,
				pos_profile: _posProfile || "",
			});
		} catch (error) {
			// the server answered and refused (for example an unconvertible UOM): that is final
			if (!isNetworkError(error) && error instanceof Error && error.message) {
				throw new BarcodeScanError(error.message);
			}
			try {
				return await scanFromCache(barcode);
			} catch (cacheError) {
				if (cacheError instanceof BarcodeScanError) throw cacheError;
			}
			console.error("Error searching barcode:", error);
			return null;
		}
	}

	async function fetchItemDetail(
		itemCode: string,
		posProfile: string,
		warehouse?: string,
	): Promise<ItemDetail | null> {
		isLoadingDetail.value = true;
		try {
			const result = await call<ItemDetail>("xpos.api.items.get_item_detail", {
				item_code: itemCode,
				pos_profile: posProfile,
				warehouse: warehouse || "",
			});
			selectedItemDetail.value = result;
			return result;
		} catch (error) {
			if (!isNetworkError(error)) {
				console.error("Error fetching item detail:", error);
			}
			try {
				const cached = await getCachedItemByCode(itemCode);
				if (cached) {
					const basicDetail = {
						item_code: cached.item_code,
						item_name: cached.item_name,
						local_item_name: cached.local_item_name,
						description: cached.description || "",
						stock_uom: cached.stock_uom || "Nos",
						image: cached.image || "",
						item_group: cached.item_group || "",
						rate: cached.rate || 0,
						actual_qty: cached.actual_qty || 0,
					} as unknown as ItemDetail;
					selectedItemDetail.value = basicDetail;
					return basicDetail;
				}
			} catch {
				/* ignore cache errors */
			}
			return null;
		} finally {
			isLoadingDetail.value = false;
		}
	}

	async function openItemDetail(
		item: POSItem,
		posProfile: string,
		warehouse?: string,
		lineUid?: string,
	): Promise<void> {
		selectedItemForDetail.value = item;
		resolveLineUid.value = lineUid || null;
		showItemDetail.value = true;
		await fetchItemDetail(item.item_code, posProfile, warehouse);
	}

	function closeItemDetail(): void {
		showItemDetail.value = false;
		resolveLineUid.value = null;
		selectedItemDetail.value = null;
		selectedItemForDetail.value = null;
	}

	async function fetchItemVariants(itemCode: string, posProfile?: string): Promise<ItemVariant[]> {
		isLoadingVariants.value = true;
		try {
			const result = await call<ItemVariant[]>("xpos.api.items.get_item_variants", {
				item_code: itemCode,
				pos_profile: posProfile || "",
			});
			variants.value = result || [];
			return variants.value;
		} catch (error) {
			console.error("Error fetching variants:", error);
			return [];
		} finally {
			isLoadingVariants.value = false;
		}
	}

	async function fetchItemAttributes(itemCode: string): Promise<ItemAttribute[]> {
		try {
			const result = await call<ItemAttribute[]>("xpos.api.items.get_item_attributes", {
				item_code: itemCode,
			});
			variantAttributes.value = result || [];
			return variantAttributes.value;
		} catch (error) {
			console.error("Error fetching attributes:", error);
			return [];
		}
	}

	async function openVariantPicker(item: POSItem, posProfile?: string): Promise<void> {
		selectedItemForDetail.value = item;
		showVariantPicker.value = true;
		await Promise.all([
			fetchItemVariants(item.item_code, posProfile),
			fetchItemAttributes(item.item_code),
		]);
	}

	function closeVariantPicker(): void {
		showVariantPicker.value = false;
		variants.value = [];
		variantAttributes.value = [];
	}

	async function fetchStockAvailability(
		itemCodes: string[],
		warehouse: string,
	): Promise<StockAvailability[]> {
		try {
			const posStoreRef = usePosStore();
			const result = await call<StockAvailability[]>("xpos.api.items.get_stock_availability", {
				items: JSON.stringify(itemCodes),
				warehouse,
				pos_profile: posStoreRef.profileName || undefined,
			});
			return result || [];
		} catch (error) {
			console.error("Error fetching stock:", error);
			return [];
		}
	}

	async function fetchPriceForUOM(itemCode: string, uom: string, posProfile: string): Promise<number> {
		try {
			const result = await call<{ rate: number }>("xpos.api.items.get_price_for_uom", {
				item_code: itemCode,
				uom,
				pos_profile: posProfile,
			});
			return result?.rate || 0;
		} catch (error) {
			console.error("Error fetching UOM price:", error);
			return 0;
		}
	}

	async function fetchBundleComponents(itemCode: string): Promise<BundleComponent[]> {
		try {
			const result = await call<BundleComponent[]>("xpos.api.bundles.get_bundle_components", {
				item_code: itemCode,
			});
			return result || [];
		} catch (error) {
			console.error("Error fetching bundle components:", error);
			return [];
		}
	}

	function setSearchTerm(term: string): void {
		searchTerm.value = term;
	}

	function setSelectedGroup(group: string): void {
		selectedGroup.value = group;
	}

	function loadMore(posProfile: string): void {
		if (hasMore.value && !isLoading.value) {
			fetchItems(posProfile, true);
		}
	}

	function resetItems(): void {
		items.value = [];
		searchTerm.value = "";
		selectedGroup.value = "All Item Groups";
		currentPage.value = 0;
		hasMore.value = true;
	}

	return {
		items,
		isLoading,
		loadError,
		searchTerm,
		selectedGroup,
		currentPage,
		hasMore,
		totalCount,
		itemGroups,
		parentGroups,
		showItemDetail,
		resolveLineUid,
		selectedItemDetail,
		selectedItemForDetail,
		isLoadingDetail,
		showVariantPicker,
		variants,
		variantAttributes,
		isLoadingVariants,
		fetchItems,
		fetchItemGroups,
		searchByBarcode,
		fetchItemDetail,
		openItemDetail,
		closeItemDetail,
		fetchItemVariants,
		fetchItemAttributes,
		openVariantPicker,
		closeVariantPicker,
		fetchStockAvailability,
		fetchPriceForUOM,
		fetchBundleComponents,
		cacheAllItems,
		setSearchTerm,
		setSelectedGroup,
		loadMore,
		resetItems,
	};
});
