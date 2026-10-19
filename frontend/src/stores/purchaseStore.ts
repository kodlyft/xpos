import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { call, showSuccess, showError } from "@/services/api";
import { usePosStore } from "@/stores/posStore";
import {
	cacheSuppliers,
	searchCachedSuppliers,
	addCachedSupplier,
	addPendingPurchase,
	getAllPendingPurchases,
	updatePendingPurchase,
	deletePendingPurchase,
	countPendingPurchases,
} from "@/services/dbBridge";
import type { CachedSupplier, PendingPurchase } from "@/services/idbService";
import type {
	Supplier,
	PurchaseOrder,
	PurchaseOrderData,
	PurchaseOrderResult,
	SearchItem,
	NewItemData,
	PendingReceiptOrder,
	ReceiveStockItem,
	ReceiveStockResult,
	InTransitEntry,
	ReceiveTransitItem,
	ReceiveTransitResult,
	ReturnShortageItem,
	ReturnShortageResult,
} from "@/types/pos.types";
import { isOnline } from "@/utils";
import __ from "@/lib/translate";

export interface PurchaseCartItem {
	item_code: string;
	item_name: string;
	qty: number;
	rate: number;
	uom: string;
	stock_uom: string;
	conversion_factor: number;
	warehouse?: string;
	received_qty?: number;
	stock_in_hand?: number;
	transit_stock?: number;
	required_packs?: number;
	item_group?: string;
	class?: string;
	pack_units?: number;
	discount_percent?: number;
	item_packing?: string;
	item_uoms?: Array<{ uom: string; conversion_factor: number }>;
	custom_alias?: string;
	custom_stock_in_hand?: number;
	custom_transit_stock?: number;
	custom_required_loose?: number;
	custom_required_packs?: number;
	custom_generic_item?: string;
	custom_category?: string;
	custom_class?: string;
	custom_item_packing?: string;
	custom_pack_units?: number;
	taxes?: Record<string, number>;
}

export const usePurchaseStore = defineStore("purchase", () => {
	const suppliers = ref<Supplier[]>([]);
	const isLoadingSuppliers = ref(false);
	const selectedSupplier = ref<Supplier | null>(null);
	const showSupplierDialog = ref(false);
	const showNewSupplierForm = ref(false);
	const supplierSearchTerm = ref("");
	const purchaseItems = ref<SearchItem[]>([]);
	const isLoadingItems = ref(false);
	const itemSearchTerm = ref("");
	const showItemDialog = ref(false);
	const showNewItemForm = ref(false);
	const cartItems = ref<PurchaseCartItem[]>([]);
	const receiveImmediately = ref(false);
	const createInvoice = ref(false);
	const selectedWarehouse = ref("");
	const showPurchaseDialog = ref(false);
	const isProcessing = ref(false);
	const purchaseOrders = ref<PurchaseOrder[]>([]);
	const isLoadingOrders = ref(false);
	const pendingPurchases = ref<PendingPurchase[]>([]);
	const pendingCount = ref(0);
	const isSyncing = ref(false);
	const pendingReceipts = ref<PendingReceiptOrder[]>([]);
	const isLoadingReceipts = ref(false);
	const selectedReceipt = ref<PendingReceiptOrder | null>(null);
	const isReceiving = ref(false);
	const inTransitEntries = ref<InTransitEntry[]>([]);
	const isLoadingTransits = ref(false);
	const selectedTransit = ref<InTransitEntry | null>(null);
	const isReceivingTransit = ref(false);
	const isReturningShortage = ref(false);

	// XPOS PO header custom fields
	const poAliasName = ref("");
	const poCategory = ref("");
	const poType = ref("");
	const poDepartment = ref("");
	const poRemarks = ref("");
	const poZeroQty = ref("No");

	// Draft management
	const currentDraftName = ref<string | null>(null);
	const isDraftSaving = ref(false);
	const isFetchingCategoryItems = ref(false);

	const cartTotal = computed(() =>
		cartItems.value.reduce((sum, item) => {
			const gross = item.qty * item.rate;
			const disc = item.discount_percent || 0;
			return sum + gross * (1 - disc / 100);
		}, 0),
	);

	const cartItemCount = computed(() => cartItems.value.reduce((sum, item) => sum + item.qty, 0));

	const isEmpty = computed(() => cartItems.value.length === 0);

	const canCreateOrder = computed(() => !!selectedSupplier.value && cartItems.value.length > 0);

	const selectedSupplierName = computed({
		get: () => selectedSupplier.value?.name ?? "",
		set: (name: string) => {
			if (!name) {
				selectedSupplier.value = null;
			} else if (selectedSupplier.value?.name !== name) {
				selectedSupplier.value = { name, supplier_name: name } as Supplier;
			}
		},
	});

	const hasPendingPurchases = computed(() => pendingCount.value > 0);

	let supplierSearchAbort: AbortController | null = null;

	async function searchSuppliers(term = ""): Promise<void> {
		if (supplierSearchAbort) {
			supplierSearchAbort.abort();
		}
		supplierSearchAbort = new AbortController();

		isLoadingSuppliers.value = true;
		const searchText = term !== undefined ? term : supplierSearchTerm.value;

		try {
			if (!isOnline()) {
				const cached = await searchCachedSuppliers(searchText);
				suppliers.value = cached.map((s) => ({
					name: s.name,
					supplier_name: s.supplier_name,
					supplier_group: s.supplier_group,
					supplier_type: s.supplier_type,
					default_currency: s.default_currency,
					mobile_no: s.mobile_no,
					email_id: s.email_id,
				}));
				return;
			}
			const result = await call<Supplier[]>("xpos.x_pos.api.purchase_orders.search_suppliers", {
				search_text: searchText,
				limit: 50,
			});
			suppliers.value = result || [];

			if (suppliers.value.length > 0) {
				try {
					const toCache: CachedSupplier[] = suppliers.value.map((s) => ({
						name: s.name,
						supplier_name: s.supplier_name,
						supplier_group: s.supplier_group,
						supplier_type: s.supplier_type,
						default_currency: s.default_currency,
						mobile_no: s.mobile_no,
						email_id: s.email_id,
					}));
					await cacheSuppliers(toCache);
				} catch (err) {
					console.warn("[XPOS Purchase] Failed to cache suppliers:", err);
				}
			}
		} catch (error) {
			console.error("Error searching suppliers:", error);
			try {
				const cached = await searchCachedSuppliers(term || supplierSearchTerm.value);
				if (cached.length > 0) {
					suppliers.value = cached.map((s) => ({
						name: s.name,
						supplier_name: s.supplier_name,
						supplier_group: s.supplier_group,
						supplier_type: s.supplier_type,
						default_currency: s.default_currency,
					}));
				}
			} catch {
				suppliers.value = [];
			}
		} finally {
			isLoadingSuppliers.value = false;
		}
	}

	async function createSupplier(data: {
		supplier_name: string;
		supplier_group?: string;
		supplier_type?: string;
		mobile_no?: string;
		email_id?: string;
		tax_id?: string;
	}): Promise<Supplier | null> {
		try {
			const posStore = usePosStore();
			const result = await call<Supplier>("xpos.x_pos.api.purchase_orders.create_supplier", {
				data: JSON.stringify({
					...data,
					pos_profile: posStore.profileName,
				}),
			});

			showNewSupplierForm.value = false;
			showSuccess(`Supplier "${result.supplier_name}" created`);

			await addCachedSupplier({
				name: result.name,
				supplier_name: result.supplier_name,
				supplier_group: result.supplier_group,
				supplier_type: result.supplier_type,
				default_currency: result.default_currency,
			});

			await searchSuppliers();
			selectedSupplier.value = result;

			return result;
		} catch (error) {
			console.error("Error creating supplier:", error);
			showError(error instanceof Error ? error.message : "Failed to create supplier");
			return null;
		}
	}

	function selectSupplier(supplier: Supplier): void {
		selectedSupplier.value = supplier;
		showSupplierDialog.value = false;
	}

	function clearSupplier(): void {
		selectedSupplier.value = null;
	}

	let itemSearchAbort: AbortController | null = null;

	async function searchItems(term = ""): Promise<void> {
		if (itemSearchAbort) {
			itemSearchAbort.abort();
		}
		itemSearchAbort = new AbortController();

		isLoadingItems.value = true;
		const searchText = term !== undefined ? term : itemSearchTerm.value;

		try {
			const result = await call<SearchItem[]>("xpos.x_pos.api.purchase_orders.search_items", {
				search_text: searchText,
				limit: 50,
			});
			purchaseItems.value = result || [];
		} catch (error: unknown) {
			if (error instanceof Error && (error.name === "AbortError" || error.message === "AbortError")) {
				return;
			}
			console.error("Error searching items:", error);
			purchaseItems.value = [];
		} finally {
			isLoadingItems.value = false;
		}
	}

	async function createItem(data: NewItemData): Promise<SearchItem | null> {
		try {
			const posStore = usePosStore();
			const result = await call<{
				item: SearchItem;
				selling_price_list?: string;
				buying_price_list?: string;
			}>("xpos.x_pos.api.purchase_orders.create_purchase_item", {
				data: JSON.stringify({
					...data,
					pos_profile: posStore.profileName,
				}),
			});

			showNewItemForm.value = false;
			showSuccess(`Item "${result.item.item_name}" created`);

			await searchItems();

			return result.item;
		} catch (error) {
			console.error("Error creating item:", error);
			showError(error instanceof Error ? error.message : "Failed to create item");
			return null;
		}
	}

	const lastAddedIndex = ref(-1);

	function defaultPurchaseUom(item: SearchItem): { uom: string; conversion_factor: number } {
		const uoms = item.item_uoms || [];
		for (const candidate of [usePosStore().posProfile?.default_purchase_uom, item.purchase_uom]) {
			const row = candidate
				? uoms.find((u) => u.uom === candidate && Number(u.conversion_factor) > 0)
				: undefined;
			if (row) return { uom: row.uom, conversion_factor: Number(row.conversion_factor) };
		}
		return { uom: item.stock_uom, conversion_factor: 1 };
	}

	function addToCart(item: SearchItem, qty = 1): void {
		const existingIndex = cartItems.value.findIndex((i) => i.item_code === item.item_code);

		if (existingIndex >= 0) {
			cartItems.value[existingIndex].qty += qty;
			lastAddedIndex.value = existingIndex;
		} else {
			const posStore = usePosStore();
			const lineUom = defaultPurchaseUom(item);
			cartItems.value.push({
				item_code: item.item_code,
				item_name: item.item_name,
				qty,
				rate: (item.standard_rate || 0) * lineUom.conversion_factor,
				uom: lineUom.uom,
				stock_uom: item.stock_uom,
				conversion_factor: lineUom.conversion_factor,
				warehouse: posStore.warehouse,
				stock_in_hand: 0,
				transit_stock: 0,
				required_packs: 0,
				item_group: item.item_group || "",
				class: item.custom_class || "",
				pack_units: item.custom_pack_units || 0,
				discount_percent: 0,
				item_packing: item.custom_item_packing || "",
				item_uoms: item.item_uoms || [{ uom: item.stock_uom, conversion_factor: 1 }],
				taxes: {} as Record<string, number>,
			});
			lastAddedIndex.value = cartItems.value.length - 1;
			// Fetch stock data for newly added item
			fetchStockForItems([item.item_code]);
		}
	}

	async function fetchStockForItems(itemCodes: string[]): Promise<void> {
		if (!itemCodes.length) return;
		try {
			const posStore = usePosStore();
			const result = await call<Record<string, { stock_in_hand: number; transit_stock: number }>>(
				"xpos.x_pos.api.purchase_orders.get_stock_and_transit",
				{
					item_codes: JSON.stringify(itemCodes),
					warehouse: posStore.warehouse,
				},
			);
			if (result) {
				for (const item of cartItems.value) {
					if (result[item.item_code]) {
						item.stock_in_hand = result[item.item_code].stock_in_hand;
						item.transit_stock = result[item.item_code].transit_stock;
					}
				}
			}
		} catch (error) {
			console.warn("[XPOS Purchase] Failed to fetch stock data:", error);
		}
	}

	async function refreshAllStock(): Promise<void> {
		const codes = cartItems.value.map((i) => i.item_code);
		if (codes.length) await fetchStockForItems(codes);
	}

	function updateCartItemQty(index: number, qty: number): void {
		if (qty <= 0) {
			removeFromCart(index);
			return;
		}
		cartItems.value[index].qty = qty;
	}

	function updateCartItemRate(index: number, rate: number): void {
		cartItems.value[index].rate = rate;
	}

	function updateCartItemUOM(index: number, uom: string, conversionFactor: number): void {
		cartItems.value[index].uom = uom;
		cartItems.value[index].conversion_factor = conversionFactor;
	}

	function updateCartItemPacks(index: number, packs: number): void {
		const item = cartItems.value[index];
		item.required_packs = packs;
		recalcQtyFromPacks(index);
	}

	function updateCartItemLoose(index: number, loose: number): void {
		cartItems.value[index].custom_required_loose = loose;
	}

	function recalcQtyFromPacks(index: number): void {
		const item = cartItems.value[index];
		const packs = item.required_packs || 0;
		const packUnits = item.pack_units || 1;
		item.qty = packs * packUnits;
	}

	function updateCartItemDiscount(index: number, discount: number): void {
		cartItems.value[index].discount_percent = discount;
	}

	function updateCartItemTax(index: number, taxType: string, percent: number): void {
		const item = cartItems.value[index];
		if (!item) return;
		if (!item.taxes) {
			item.taxes = { [taxType]: percent };
		} else {
			item.taxes[taxType] = percent;
		}
	}

	function updateCartItemField(index: number, field: keyof PurchaseCartItem, value: unknown): void {
		(cartItems.value[index] as Record<string, unknown>)[field] = value;
	}

	function removeFromCart(index: number): void {
		cartItems.value.splice(index, 1);
	}

	function clearCart(): void {
		cartItems.value = [];
	}

	async function createPurchaseOrder(): Promise<PurchaseOrderResult | null> {
		if (!canCreateOrder.value) {
			showError(__("Please select a supplier and add items"));
			return null;
		}

		isProcessing.value = true;

		try {
			const posStore = usePosStore();

			const orderData: PurchaseOrderData = {
				pos_profile: posStore.profileName,
				supplier: selectedSupplier.value?.name ?? "",
				company: posStore.companyName,
				warehouse: selectedWarehouse.value || posStore.warehouse,
				receive: receiveImmediately.value,
				create_invoice: createInvoice.value,
				items: cartItems.value.map((item) => ({
					item_code: item.item_code,
					item_name: item.item_name,
					qty: item.qty,
					rate: item.rate,
					uom: item.uom,
					stock_uom: item.stock_uom,
					conversion_factor: item.conversion_factor,
					warehouse: item.warehouse,
					stock_in_hand: item.stock_in_hand,
					transit_stock: item.transit_stock,
					required_packs: item.required_packs,
					class: item.class,
					pack_units: item.pack_units,
					taxes: item.taxes || {},
				})),
				submit: true,
				custom_po_category: poCategory.value || undefined,
				custom_po_type: poType.value || undefined,
				custom_po_remarks: poRemarks.value || undefined,
				custom_zero_qty: poZeroQty.value || undefined,
			};

			if (!isOnline()) {
				await saveOfflinePurchase(orderData);
				showSuccess(__("Purchase order saved offline. Will sync when online."));
				clearAfterOrder();
				return null;
			}

			const result = await call<PurchaseOrderResult>(
				"xpos.x_pos.api.purchase_orders.create_purchase_order",
				{ data: JSON.stringify(orderData) },
			);

			showSuccess(__("Purchase Order {0} created", [result.purchase_order ?? ""]));

			// Delete the draft from Frappe if one was active
			const draftName = currentDraftName.value;
			if (draftName) {
				try {
					await call("xpos.x_pos.api.purchase_orders.delete_po_draft", { name: draftName });
				} catch (e) {
					console.warn("[XPOS Purchase] Failed to delete draft after submission:", e);
				}
			}

			clearAfterOrder();
			return result;
		} catch (error) {
			console.error("Error creating purchase order:", error);
			showError(error instanceof Error ? error.message : "Failed to create purchase order");
			return null;
		} finally {
			isProcessing.value = false;
		}
	}

	function clearAfterOrder(): void {
		clearCart();
		clearSupplier();
		poAliasName.value = "";
		poCategory.value = "";
		poType.value = "";
		poDepartment.value = "";
		poRemarks.value = "";
		poZeroQty.value = "No";
		currentDraftName.value = null;
		showPurchaseDialog.value = false;
	}

	async function fetchPurchaseOrders(filters?: {
		status?: string;
		supplier?: string;
		from_date?: string;
		to_date?: string;
	}): Promise<void> {
		isLoadingOrders.value = true;

		try {
			const result = await call<PurchaseOrder[]>("frappe.client.get_list", {
				doctype: "Purchase Order",
				fields: [
					"name",
					"supplier",
					"supplier_name",
					"company",
					"transaction_date",
					"grand_total",
					"status",
					"docstatus",
					"per_received",
					"per_billed",
				],
				filters: {
					docstatus: 1,
					...(filters?.status && { status: filters.status }),
					...(filters?.supplier && { supplier: filters.supplier }),
					...(filters?.from_date && { transaction_date: [">=", filters.from_date] }),
					...(filters?.to_date && { transaction_date: ["<=", filters.to_date] }),
				},
				order_by: "transaction_date desc",
				limit_page_length: 50,
			});
			purchaseOrders.value = result || [];
		} catch (error) {
			console.error("Error fetching purchase orders:", error);
			purchaseOrders.value = [];
		} finally {
			isLoadingOrders.value = false;
		}
	}

	async function saveOfflinePurchase(data: PurchaseOrderData): Promise<number> {
		const record = {
			type: "purchase_order" as const,
			data,
			supplier_name: selectedSupplier.value?.supplier_name ?? "",
			grand_total: cartTotal.value,
		};

		const result = await addPendingPurchase(record);
		await refreshPendingCount();
		return (result as any).id ?? result;
	}

	async function refreshPendingCount(): Promise<void> {
		try {
			pendingCount.value = await countPendingPurchases();
		} catch {
			pendingCount.value = 0;
		}
	}

	async function loadPendingPurchases(): Promise<void> {
		try {
			pendingPurchases.value = await getAllPendingPurchases();
			pendingCount.value = pendingPurchases.value.length;
		} catch {
			pendingPurchases.value = [];
			pendingCount.value = 0;
		}
	}

	async function syncPendingPurchases(): Promise<void> {
		if (isSyncing.value || !isOnline()) return;

		isSyncing.value = true;

		try {
			const pending = await getAllPendingPurchases();
			if (pending.length === 0) {
				isSyncing.value = false;
				return;
			}

			let synced = 0;
			let failed = 0;

			for (const purchase of pending) {
				if (!isOnline()) break;

				try {
					purchase.status = "syncing";
					if (purchase.id) await updatePendingPurchase(purchase.id, { status: "syncing" });

					await call<PurchaseOrderResult>("xpos.x_pos.api.purchase_orders.create_purchase_order", {
						data: JSON.stringify(purchase.data),
					});

					if (purchase.id) await deletePendingPurchase(purchase.id);
					synced++;
				} catch (error) {
					failed++;
					purchase.status = "failed";
					purchase.retry_count = (purchase.retry_count || 0) + 1;
					purchase.error = error instanceof Error ? error.message : String(error);
					if (purchase.id)
						await updatePendingPurchase(purchase.id, {
							status: "failed",
							retry_count: purchase.retry_count,
							error: purchase.error,
						});
				}
			}

			await refreshPendingCount();
			await loadPendingPurchases();

			if (synced > 0) {
				showSuccess(`Synced ${synced} purchase order${synced > 1 ? "s" : ""}`);
			}
			if (failed > 0) {
				showError(`Failed to sync ${failed} purchase order${failed > 1 ? "s" : ""}`);
			}
		} catch (error) {
			console.error("Sync error:", error);
		} finally {
			isSyncing.value = false;
		}
	}

	async function retryPendingPurchase(id: number): Promise<boolean> {
		if (!isOnline()) {
			showError(__("Cannot sync while offline"));
			return false;
		}

		const pending = await getAllPendingPurchases();
		const purchase = pending.find((p) => p.id === id);
		if (!purchase) return false;

		try {
			purchase.status = "syncing";
			if (purchase.id) await updatePendingPurchase(purchase.id, { status: "syncing" });

			await call<PurchaseOrderResult>("xpos.x_pos.api.purchase_orders.create_purchase_order", {
				data: JSON.stringify(purchase.data),
			});

			await deletePendingPurchase(id);
			await refreshPendingCount();
			await loadPendingPurchases();
			showSuccess(__("Purchase order synced successfully"));
			return true;
		} catch (error) {
			purchase.status = "failed";
			purchase.retry_count = (purchase.retry_count || 0) + 1;
			purchase.error = error instanceof Error ? error.message : String(error);
			if (purchase.id)
				await updatePendingPurchase(purchase.id, {
					status: "failed",
					retry_count: purchase.retry_count,
					error: purchase.error,
				});
			await loadPendingPurchases();
			showError("Sync failed: " + purchase.error);
			return false;
		}
	}

	async function deletePending(id: number): Promise<void> {
		await deletePendingPurchase(id);
		await refreshPendingCount();
		await loadPendingPurchases();
	}

	function init(): void {
		refreshPendingCount();
	}

	async function searchByBarcode(barcode: string): Promise<SearchItem | null> {
		if (!barcode) return null;

		try {
			const result = await call<SearchItem | null>(
				"xpos.x_pos.api.purchase_orders.search_item_by_barcode",
				{ barcode },
			);
			return result || null;
		} catch (error) {
			console.error("Error searching barcode:", error);
			return null;
		}
	}

	async function fetchItemByCode(itemCode: string): Promise<SearchItem | null> {
		if (!itemCode) return null;
		try {
			const result = await call<SearchItem[]>("xpos.x_pos.api.purchase_orders.search_items", {
				search_text: itemCode,
				limit: 5,
			});
			if (result && result.length > 0) {
				return result.find((i) => i.item_code === itemCode) || result[0];
			}
			return null;
		} catch (error) {
			console.error("Error fetching item by code:", error);
			return null;
		}
	}

	async function fetchPendingReceipts(): Promise<void> {
		isLoadingReceipts.value = true;
		try {
			const posStore = usePosStore();
			const result = await call<PendingReceiptOrder[]>(
				"xpos.x_pos.api.purchase_orders.get_pending_receipts",
				{ warehouse: posStore.warehouse, limit: 50 },
			);
			pendingReceipts.value = result || [];
		} catch (error) {
			console.error("Error fetching pending receipts:", error);
			pendingReceipts.value = [];
		} finally {
			isLoadingReceipts.value = false;
		}
	}

	async function fetchReceiptDetail(poName: string): Promise<PendingReceiptOrder | null> {
		try {
			const result = await call<PendingReceiptOrder>(
				"xpos.x_pos.api.purchase_orders.get_purchase_order_detail",
				{ purchase_order: poName },
			);
			selectedReceipt.value = result || null;
			return result || null;
		} catch (error) {
			console.error("Error fetching PO detail:", error);
			return null;
		}
	}

	async function receiveStock(
		poName: string,
		items: ReceiveStockItem[],
		remarks = "",
	): Promise<ReceiveStockResult | null> {
		isReceiving.value = true;
		try {
			const posStore = usePosStore();
			const result = await call<ReceiveStockResult>("xpos.x_pos.api.purchase_orders.receive_stock", {
				data: JSON.stringify({
					purchase_order: poName,
					warehouse: posStore.warehouse,
					items,
					remarks,
				}),
			});

			let message = `Receipt ${result.purchase_receipt} created`;
			if (result.has_rejections) {
				message += " (with rejections)";
			}
			showSuccess(message);

			await fetchPendingReceipts();
			selectedReceipt.value = null;

			return result;
		} catch (error) {
			console.error("Error receiving stock:", error);
			showError(error instanceof Error ? error.message : "Failed to receive stock");
			return null;
		} finally {
			isReceiving.value = false;
		}
	}

	function clearSelectedReceipt(): void {
		selectedReceipt.value = null;
	}

	async function fetchInTransitTransfers(): Promise<void> {
		isLoadingTransits.value = true;
		try {
			const posStore = usePosStore();
			const result = await call<InTransitEntry[]>(
				"xpos.x_pos.api.stock_transfer.get_in_transit_transfers",
				{ warehouse: posStore.warehouse, limit: 50 },
			);
			inTransitEntries.value = result || [];
		} catch (error) {
			console.error("Error fetching in-transit transfers:", error);
			inTransitEntries.value = [];
		} finally {
			isLoadingTransits.value = false;
		}
	}

	async function fetchTransitDetail(stockEntry: string): Promise<InTransitEntry | null> {
		try {
			const result = await call<InTransitEntry>("xpos.x_pos.api.stock_transfer.get_transfer_detail", {
				stock_entry: stockEntry,
			});
			selectedTransit.value = result || null;
			return result || null;
		} catch (error) {
			console.error("Error fetching transit detail:", error);
			return null;
		}
	}

	async function receiveTransitStock(
		outgoingEntry: string,
		items: ReceiveTransitItem[],
		remarks = "",
	): Promise<ReceiveTransitResult | null> {
		isReceivingTransit.value = true;
		try {
			const posStore = usePosStore();
			const result = await call<ReceiveTransitResult>(
				"xpos.x_pos.api.stock_transfer.receive_transit_stock",
				{
					data: JSON.stringify({
						outgoing_stock_entry: outgoingEntry,
						target_warehouse: posStore.warehouse,
						items,
						remarks,
					}),
				},
			);

			let message = `Stock Entry ${result.stock_entry} created`;
			if (result.has_shortage) {
				message += ` (shortage: ${result.total_shortage_qty})`;
			}
			showSuccess(message);

			await fetchInTransitTransfers();

			return result;
		} catch (error) {
			console.error("Error receiving transit stock:", error);
			showError(error instanceof Error ? error.message : "Failed to receive transit stock");
			return null;
		} finally {
			isReceivingTransit.value = false;
		}
	}

	async function returnShortageToSource(
		outgoingEntry: string,
		items: ReturnShortageItem[],
		remarks = "",
	): Promise<ReturnShortageResult | null> {
		isReturningShortage.value = true;
		try {
			const result = await call<ReturnShortageResult>(
				"xpos.x_pos.api.stock_transfer.return_shortage_to_source",
				{
					data: JSON.stringify({
						outgoing_stock_entry: outgoingEntry,
						items,
						remarks,
					}),
				},
			);

			showSuccess(
				`Return ${result.stock_entry} created - ${result.total_returned_qty} items returned to source`,
			);

			await fetchInTransitTransfers();

			return result;
		} catch (error) {
			console.error("Error returning shortage:", error);
			showError(error instanceof Error ? error.message : "Failed to return shortage");
			return null;
		} finally {
			isReturningShortage.value = false;
		}
	}

	function clearSelectedTransit(): void {
		selectedTransit.value = null;
	}

	async function getAllDrafts(): Promise<
		Array<{
			name: string;
			supplier: string;
			supplier_name: string;
			transaction_date: string;
			creation: string;
			modified: string;
			items_count: number;
		}>
	> {
		try {
			const result = await call<
				Array<{
					name: string;
					supplier: string;
					supplier_name: string;
					transaction_date: string;
					creation: string;
					modified: string;
					items_count: number;
				}>
			>("xpos.x_pos.api.purchase_orders.list_po_drafts", { limit: 50 });
			return result || [];
		} catch (e) {
			console.warn("[XPOS Purchase] Failed to load drafts:", e);
			return [];
		}
	}

	async function saveDraft(): Promise<string | null> {
		if (!selectedSupplier.value) {
			showError(__("Please select a supplier before saving a draft."));
			return null;
		}
		isDraftSaving.value = true;
		try {
			const posStore = usePosStore();
			const payload = {
				draft_name: currentDraftName.value || undefined,
				supplier: selectedSupplier.value?.name ?? "",
				company: posStore.companyName,
				warehouse: posStore.warehouse,
				items: cartItems.value.map((item) => ({
					item_code: item.item_code,
					item_name: item.item_name,
					qty: item.qty,
					rate: item.rate,
					uom: item.uom,
					stock_uom: item.stock_uom,
					conversion_factor: item.conversion_factor,
					warehouse: item.warehouse,
					stock_in_hand: item.stock_in_hand,
					transit_stock: item.transit_stock,
					required_packs: item.required_packs,
					pack_units: item.pack_units,
					class: item.class,
					item_packing: item.item_packing,
					taxes: item.taxes || {},
				})),
				custom_po_category: poCategory.value || undefined,
				custom_po_type: poType.value || undefined,
				custom_po_remarks: poRemarks.value || undefined,
				custom_zero_qty: poZeroQty.value || undefined,
			};
			const result = await call<{ draft_name: string }>(
				"xpos.x_pos.api.purchase_orders.save_po_draft",
				{ data: JSON.stringify(payload), pos_profile: posStore.profileName },
			);
			currentDraftName.value = result.draft_name;
			showSuccess(__("Draft saved successfully"));
			return result.draft_name;
		} catch (error) {
			showError(error instanceof Error ? error.message : "Failed to save draft");
			return null;
		} finally {
			isDraftSaving.value = false;
		}
	}

	async function loadDraft(name: string): Promise<boolean> {
		try {
			const result = await call<{
				draft_name: string;
				supplier: string;
				items: PurchaseCartItem[];
				po_category?: string;
				po_type?: string;
				po_remarks?: string;
				po_zero_qty?: string;
			}>("xpos.x_pos.api.purchase_orders.load_po_draft", { name });
			clearCart();
			clearSupplier();
			currentDraftName.value = result.draft_name;
			selectedSupplier.value = result.supplier
				? ({ name: result.supplier, supplier_name: result.supplier } as Supplier)
				: null;
			cartItems.value = (result.items || []).map((item) => ({
				...item,
				taxes: (item.taxes && typeof item.taxes === "object" ? item.taxes : {}) as Record<
					string,
					number
				>,
			}));
			poCategory.value = result.po_category || "";
			poType.value = result.po_type || "";
			poRemarks.value = result.po_remarks || "";
			poZeroQty.value = result.po_zero_qty || "No";
			if (cartItems.value.length > 0) {
				const codes = cartItems.value.map((i) => i.item_code);
				fetchStockForItems(codes);
			}
			return true;
		} catch (error) {
			showError(error instanceof Error ? error.message : "Failed to load draft");
			return false;
		}
	}

	async function deleteDraft(name: string): Promise<void> {
		try {
			await call("xpos.x_pos.api.purchase_orders.delete_po_draft", { name });
			if (currentDraftName.value === name) {
				currentDraftName.value = null;
			}
		} catch (error) {
			showError(error instanceof Error ? error.message : "Failed to delete draft");
		}
	}

	function loadFromOrder(order: PurchaseOrder): void {
		clearCart();
		clearSupplier();
		currentDraftName.value = null;

		selectedSupplier.value = order.supplier
			? ({ name: order.supplier, supplier_name: order.supplier } as Supplier)
			: null;

		for (const item of order.items || []) {
			cartItems.value.push({
				item_code: item.item_code,
				item_name: item.item_name,
				qty: item.qty,
				rate: item.rate,
				uom: item.uom || item.stock_uom || "Nos",
				stock_uom: item.stock_uom || "Nos",
				conversion_factor: item.conversion_factor || 1,
				warehouse: item.warehouse,
				stock_in_hand: item.custom_stock_in_hand || 0,
				transit_stock: item.custom_transit_stock || 0,
				required_packs: item.custom_required_packs || 0,
				item_group: "",
				class: item.custom_class || "",
				pack_units: item.custom_pack_units || 0,
				discount_percent: 0,
				item_packing: item.custom_item_packing || "",
				taxes: {} as Record<string, number>,
			});
		}

		if (cartItems.value.length > 0) {
			const codes = cartItems.value.map((i) => i.item_code);
			fetchStockForItems(codes);
		}
	}

	async function fetchCategoryItems(fromDate?: string, toDate?: string): Promise<void> {
		if (!poCategory.value || !selectedSupplier.value) {
			showError(__("Please select a supplier and PO Category first"));
			return;
		}

		isFetchingCategoryItems.value = true;

		try {
			const posStore = usePosStore();
			const params: Record<string, unknown> = {
				supplier: selectedSupplier.value?.name ?? "",
				po_category: poCategory.value,
				warehouse: posStore.warehouse,
			};
			if (fromDate) params.from_date = fromDate;
			if (toDate) params.to_date = toDate;

			const result = await call<Array<SearchItem & { qty?: number }>>(
				"xpos.x_pos.api.purchase_orders.get_category_items",
				params,
			);

			if (!result || result.length === 0) {
				showError(__("No items found for this category and supplier"));
				return;
			}

			cartItems.value = [];
			for (const item of result) {
				addToCart(item, item.qty || 1);
			}

			showSuccess(__("{0} items added", [result.length]));
		} catch (error) {
			console.error("Error fetching category items:", error);
			showError(error instanceof Error ? error.message : "Failed to fetch items");
		} finally {
			isFetchingCategoryItems.value = false;
		}
	}

	return {
		suppliers,
		isLoadingSuppliers,
		selectedSupplier,
		selectedSupplierName,
		showSupplierDialog,
		showNewSupplierForm,
		supplierSearchTerm,
		purchaseItems,
		isLoadingItems,
		itemSearchTerm,
		showItemDialog,
		showNewItemForm,
		cartItems,
		receiveImmediately,
		createInvoice,
		selectedWarehouse,
		showPurchaseDialog,
		isProcessing,
		purchaseOrders,
		isLoadingOrders,
		pendingPurchases,
		pendingCount,
		isSyncing,
		pendingReceipts,
		isLoadingReceipts,
		selectedReceipt,
		isReceiving,
		inTransitEntries,
		isLoadingTransits,
		selectedTransit,
		isReceivingTransit,
		isReturningShortage,
		poAliasName,
		poCategory,
		poType,
		poDepartment,
		poRemarks,
		poZeroQty,
		currentDraftName,
		isDraftSaving,
		isFetchingCategoryItems,
		cartTotal,
		cartItemCount,
		isEmpty,
		canCreateOrder,
		hasPendingPurchases,
		lastAddedIndex,

		searchSuppliers,
		createSupplier,
		selectSupplier,
		clearSupplier,
		searchItems,
		createItem,
		searchByBarcode,
		fetchItemByCode,
		addToCart,
		defaultPurchaseUom,
		updateCartItemQty,
		updateCartItemRate,
		updateCartItemUOM,
		updateCartItemPacks,
		updateCartItemLoose,
		updateCartItemDiscount,
		updateCartItemTax,
		updateCartItemField,
		fetchStockForItems,
		refreshAllStock,
		removeFromCart,
		clearCart,
		createPurchaseOrder,
		fetchPurchaseOrders,
		fetchPendingReceipts,
		fetchReceiptDetail,
		receiveStock,
		clearSelectedReceipt,
		fetchInTransitTransfers,
		fetchTransitDetail,
		receiveTransitStock,
		returnShortageToSource,
		clearSelectedTransit,
		refreshPendingCount,
		loadPendingPurchases,
		syncPendingPurchases,
		retryPendingPurchase,
		deletePending,
		init,
		// Draft management
		getAllDrafts,
		saveDraft,
		loadDraft,
		deleteDraft,
		loadFromOrder,
		fetchCategoryItems,
	};
});
