import { useCacheStatus } from "./cacheStatus";
import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { call, isNetworkError } from "@/services/api";
import { isElectron } from "@/services/electronBridge";
import { usePosStore } from "@/stores/posStore";
import { useSettingsStore } from "@/stores/settingsStore";
import {
	cacheItems as idbCacheItems,
	getCachedItems as idbGetCachedItems,
	searchCachedItems as idbSearchCachedItems,
	cacheItemGroups as idbCacheGroups,
	getCachedItemGroups as idbGetCachedGroups,
	cacheStockForWarehouse,
	getCachedStock,
	getCachedItemByCode,
} from "@/services/dbBridge";
import type {
	POSItem,
	ItemGroup,
	ItemDetail,
	ItemVariant,
	ItemAttribute,
	StockAvailability,
	BundleComponent,
} from "@/types/pos.types";
import { isOnline } from "@/utils";

interface ItemGroupsResult {
	groups: ItemGroup[];
	parent_groups: ItemGroup[];
}

export const useItemStore = defineStore("items", () => {
	const items = ref<POSItem[]>([]);
	const isLoading = ref(false);
	const searchTerm = ref("");
	const selectedGroup = ref("All Item Groups");
	const currentPage = ref(0);
	const pageLength = ref(40);
	const hasMore = ref(true);
	const totalCount = ref(0);
	const itemGroups = ref<ItemGroup[]>([]);
	const parentGroups = ref<ItemGroup[]>([]);

	function offlineSearchConfig() {
		const settings = useSettingsStore();
		const limit = settings.itemSearchLimit;
		const capped = searchTerm.value && limit > 0 ? Math.min(pageLength.value, limit) : pageLength.value;
		return { fields: settings.itemSearchFields, limit: capped };
	}

	const showItemDetail = ref(false);
	const selectedItemDetail = ref<ItemDetail | null>(null);
	const selectedItemForDetail = ref<POSItem | null>(null);
	const isLoadingDetail = ref(false);

	const showVariantPicker = ref(false);
	const variants = ref<ItemVariant[]>([]);
	const variantAttributes = ref<ItemAttribute[]>([]);
	const isLoadingVariants = ref(false);

	async function cacheAllItems(posProfile: string): Promise<void> {
		if (isElectron() || !isOnline() || !usePosStore().useOfflineMode) return;
		const status = useCacheStatus();
		if (!status.begin("Products and stock", posProfile)) return;
		try {
			const limit = Math.max(0, Number(usePosStore().posProfile?.xpos_product_preload_limit || 0));
			const allItems: POSItem[] = [];
			let complete = false;
			while (true) {
				const size = limit ? Math.min(200, limit + 1 - allItems.length) : 200;
				const batch = await call<POSItem[]>("xpos.api.items.get_pos_items", {
					pos_profile: posProfile,
					search_term: "",
					item_group: "",
					start: allItems.length,
					page_length: size,
				});
				allItems.push(...batch);
				if (batch.length < size) {
					complete = true;
					break;
				}
				if (limit && allItems.length > limit) break;
			}
			const selected = (limit ? allItems.slice(0, limit) : allItems).map((item, rank) => ({
				...item,
				xpos_cache_rank: rank,
			}));
			// Catalog rows already contain fresh stock; do not fetch it all a second time.
			await idbCacheItems(selected);
			const warehouse = usePosStore().warehouse;
			if (warehouse)
				await cacheStockForWarehouse(
					warehouse,
					selected.map((item) => ({ item_code: item.item_code, actual_qty: item.actual_qty || 0 })),
				);
			status.finish("Products and stock", posProfile, selected.length, complete);
		} catch (error) {
			status.fail("Products and stock");
			console.warn("[XPOS Offline] Failed to cache items:", error);
		}
	}

	async function cacheAllStock(posProfile: string, warehouse: string, allItems?: POSItem[]): Promise<void> {
		if (isElectron()) return;
		if (!isOnline()) {
			console.warn("[XPOS Offline] Cannot cache stock - system is offline");
			return;
		}

		try {
			const itemsToCache = allItems || (await idbGetCachedItems());
			if (itemsToCache.length === 0) return;

			const itemCodes = itemsToCache.map((item) => item.item_code);

			const stockResult = await call<StockAvailability[]>("xpos.api.items.get_stock_availability", {
				items: JSON.stringify(itemCodes),
				warehouse,
				pos_profile: posProfile,
			});

			const stockEntries: { item_code: string; actual_qty: number }[] = [];

			if (stockResult && stockResult.length > 0) {
				const stockMap = new Map(stockResult.map((s) => [s.item_code, s.actual_qty || 0]));

				for (const item of itemsToCache) {
					stockEntries.push({
						item_code: item.item_code,
						actual_qty: stockMap.get(item.item_code) ?? 0,
					});
				}
			} else {
				for (const item of itemsToCache) {
					stockEntries.push({ item_code: item.item_code, actual_qty: 0 });
				}
			}

			await cacheStockForWarehouse(warehouse, stockEntries);
		} catch (error) {
			console.warn("[XPOS Offline] Failed to cache stock:", error);
		}
	}

	async function fetchItems(posProfile: string, append = false): Promise<void> {
		if (isLoading.value) return;
		isLoading.value = true;

		try {
			if (isElectron()) {
				const posStoreRef = usePosStore();
				const { fields, limit } = offlineSearchConfig();
				const results = (await window.electronAPI!.db.getItems({
					search: searchTerm.value || undefined,
					searchFields: fields,
					group: selectedGroup.value === "All Item Groups" ? undefined : selectedGroup.value,
					limit,
					offset: append ? items.value.length : undefined,
					priceList: posStoreRef.sellingPriceList || undefined,
					warehouse: posStoreRef.warehouse || undefined,
				})) as POSItem[];

				if (append) {
					items.value = [...items.value, ...results];
				} else {
					items.value = results;
					currentPage.value = 0;
				}
				hasMore.value = results.length === limit;
				return;
			}

			if (!isOnline() && usePosStore().useOfflineMode) {
				const filtered = await idbSearchCachedItems(
					searchTerm.value,
					selectedGroup.value,
					offlineSearchConfig().fields,
				);

				if (append) {
					const sliced = filtered.slice(items.value.length, items.value.length + pageLength.value);
					items.value = [...items.value, ...sliced];
					hasMore.value = items.value.length < filtered.length;
				} else {
					items.value = filtered.slice(0, pageLength.value);
					currentPage.value = 0;
					hasMore.value = filtered.length > pageLength.value;
				}

				const posStoreRef = usePosStore();
				if (posStoreRef.warehouse) {
					const stockData = await getCachedStock(posStoreRef.warehouse);
					const stockMap = new Map(stockData.map((s) => [s.item_code, s.actual_qty]));
					items.value = items.value.map((item) => ({
						...item,
						actual_qty: stockMap.get(item.item_code) ?? item.actual_qty,
					}));
				}

				return;
			}

			if (isOnline()) {
				const result = await call<POSItem[]>("xpos.api.items.get_pos_items", {
					pos_profile: posProfile,
					search_term: searchTerm.value,
					item_group: selectedGroup.value === "All Item Groups" ? "" : selectedGroup.value,
					start: append ? items.value.length : 0,
					page_length: pageLength.value,
				});

				if (append) {
					items.value = [...items.value, ...result];
				} else {
					items.value = result;
					currentPage.value = 0;
				}

				hasMore.value = result.length === pageLength.value;

				if (!searchTerm.value && !append && selectedGroup.value === "All Item Groups") {
					const posStoreRef = usePosStore();
					if (posStoreRef.useOfflineMode) {
						cacheAllItems(posProfile).catch(() => {});
					}
				}
			}
		} catch (error) {
			if (usePosStore().useOfflineMode) {
				try {
					const cached = await idbGetCachedItems();
					if (cached.length > 0) {
						const filtered = await idbSearchCachedItems(
							searchTerm.value,
							selectedGroup.value,
							offlineSearchConfig().fields,
						);
						items.value = filtered.slice(0, pageLength.value);
						hasMore.value = filtered.length > pageLength.value;
						console.log("[XPOS Offline] Serving items from idb cache after fetch failure");
						return;
					}
				} catch {
					/* ignore */
				}
			}
			console.error("Error fetching items:", error);
		} finally {
			isLoading.value = false;
		}
	}

	async function fetchItemGroups(): Promise<void> {
		try {
			if (isElectron()) {
				const all = (await window.electronAPI!.db.getItemGroups()) as unknown as ItemGroup[];
				itemGroups.value = all;
				parentGroups.value = all.filter((g) => !!g.is_group);
				return;
			}

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

	async function searchByBarcode(barcode: string, _posProfile?: string): Promise<POSItem | null> {
		try {
			if (isElectron()) {
				const lower = barcode.toLowerCase();
				const posStoreRef = usePosStore();
				const all = (await window.electronAPI!.db.getItems({
					search: barcode,
					priceList: posStoreRef.sellingPriceList || undefined,
					warehouse: posStoreRef.warehouse || undefined,
				})) as POSItem[];
				return (
					all.find(
						(i) =>
							(i.barcode && String(i.barcode).toLowerCase() === lower) ||
							i.item_code.toLowerCase() === lower,
					) || null
				);
			}

			if (!isOnline()) {
				const cached = await idbGetCachedItems();
				const lower = barcode.toLowerCase();
				return (
					cached.find(
						(i) =>
							(i.barcode && i.barcode.toLowerCase() === lower) ||
							i.item_code.toLowerCase() === lower,
					) || null
				);
			}

			const result = await call<POSItem | null>("xpos.api.items.search_barcode", {
				barcode: barcode,
				pos_profile: _posProfile || "",
			});
			return result;
		} catch (error) {
			try {
				const cached = await idbGetCachedItems();
				const lower = barcode.toLowerCase();
				return (
					cached.find(
						(i) =>
							(i.barcode && i.barcode.toLowerCase() === lower) ||
							i.item_code.toLowerCase() === lower,
					) || null
				);
			} catch {
				/* ignore */
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

	async function openItemDetail(item: POSItem, posProfile: string, warehouse?: string): Promise<void> {
		selectedItemForDetail.value = item;
		showItemDetail.value = true;
		await fetchItemDetail(item.item_code, posProfile, warehouse);
	}

	function closeItemDetail(): void {
		showItemDetail.value = false;
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
		searchTerm,
		selectedGroup,
		currentPage,
		hasMore,
		totalCount,
		itemGroups,
		parentGroups,
		showItemDetail,
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
		cacheAllStock,
		setSearchTerm,
		setSelectedGroup,
		loadMore,
		resetItems,
	};
});
