import { newInvoiceId } from "@/services/invoiceSubmission";
import { defineStore } from "pinia";
import { ref, computed, watch } from "vue";
import { call } from "@/services/api";
import { usePosStore } from "./posStore";
import { useSettingsStore } from "./settingsStore";
import { getCachedItemByCode, getCachedStockForItem } from "@/services/dbBridge";
import type {
	CartItem,
	POSItem,
	InvoiceData,
	InvoiceItem,
	InvoiceChangeLeg,
	InvoicePayment,
	POSOffer,
	POSCoupon,
	CalculatedTax,
	DeliveryCharge,
	ReceiptSnapshot,
	OpenTab,
} from "@/types/pos.types";
import __ from "@/lib/translate";
import {
	evaluateOffers,
	computeGrandTotalDiscountPct,
	type OfferEvaluationResult,
} from "@/services/offerEngine";
import {
	resolveCartPricing,
	refreshPricingRuleSnapshot,
	type PricingSource,
	type ResolvedCartPricing,
} from "@/services/pricingService";
import type { CartPricingLine, FreeItemLine } from "@/services/pricingEngine";
import { nowDate, toDateOrNow } from "@/utils/datetime";
import { debounce } from "@/utils";

let cartRowSeq = 0;

function nextRowId(): string {
	cartRowSeq += 1;
	return `row-${Date.now().toString(36)}-${cartRowSeq}`;
}

function parsePricingRules(value: unknown): string[] {
	if (!value) return [];
	if (Array.isArray(value)) return value.map(String);
	const raw = String(value).trim();
	if (!raw) return [];
	if (raw.startsWith("[")) {
		try {
			const parsed = JSON.parse(raw);
			return Array.isArray(parsed) ? parsed.map(String) : [];
		} catch {
			return [];
		}
	}
	return raw
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean);
}

function parseRuleName(value: unknown): string | undefined {
	return parsePricingRules(value)[0];
}

export const useCartStore = defineStore("cart", () => {
	const items = ref<CartItem[]>([]);
	const selectedCartIndex = ref(-1);
	const customer = ref<{
		name: string;
		customer_name?: string;
		image?: string;
		mobile_no?: string;
		email_id?: string;
		customer_group?: string;
		territory?: string;
	} | null>(null);
	const discountPercentage = ref(0);
	const discountAmount = ref(0);
	const showPaymentDialog = ref(false);
	const posStore = usePosStore();
	const isReturnMode = ref(false);
	const returnAgainst = ref("");
	const returnItemCodes = ref<string[]>([]);
	const orderNotes = ref("");
	const deliveryDate = ref("");
	const postingDate = ref(nowDate());
	const writeOffAmount = ref(0);
	const salesPerson = ref("");
	const redeemLoyaltyPoints = ref(false);
	const loyaltyPoints = ref(0);
	const loyaltyAmount = ref(0);
	const appliedOffers = ref<POSOffer[]>([]);
	const appliedCoupon = ref<POSCoupon | null>(null);
	const couponCode = ref("");
	const payments = ref<InvoicePayment[]>([]);
	const changeLegs = ref<InvoiceChangeLeg[]>([]);
	const changeAmount = ref(0);
	const currentDraftName = ref("");
	const currentDraftModified = ref("");
	const isSavingDraft = ref(false);
	const showDraftDialog = ref(false);
	const isLoadingDrafts = ref(false);
	const currency = ref("");
	const conversionRate = ref(1);
	const selectedDeliveryCharge = ref<DeliveryCharge | null>(null);
	const settingsStore = useSettingsStore();

	const ruleDiscountPercentage = ref(0);
	const ruleDiscountAmount = ref(0);
	const applyDiscountOn = ref("Grand Total");
	const isPricingCart = ref(false);
	const pricingSource = ref<PricingSource>("server");

	const itemRatePrecision = computed(() => {
		const val = parseInt(String(settingsStore.currencyPrecision?.float_precision || ""), 10);
		return Number.isFinite(val) && val >= 0 ? val : 3;
	});

	function normalizeItemRate(rate: number | string): number {
		const parsed = Number(rate || 0);
		if (!Number.isFinite(parsed)) {
			return 0;
		}
		const p = itemRatePrecision.value;
		return Math.round((parsed + Number.EPSILON) * 10 ** p) / 10 ** p;
	}

	const offerEvaluation = computed<OfferEvaluationResult>(() => {
		return evaluateOffers(appliedOffers.value, items.value);
	});

	const offerItemDiscountTotal = computed(() => {
		const eval_ = offerEvaluation.value;
		if (!eval_.itemDiscounts.length) return 0;

		let total = 0;
		for (const disc of eval_.itemDiscounts) {
			const item = items.value.find((i) => i.item_code === disc.item_code);
			if (!item) continue;
			const lineAmt = Math.abs(item.qty) * item.rate;
			if (disc.fixed_rate !== null) {
				total += Math.max(0, lineAmt - Math.abs(item.qty) * disc.fixed_rate);
			} else if (disc.discount_percentage > 0) {
				total += (lineAmt * disc.discount_percentage) / 100;
			} else if (disc.discount_amount > 0) {
				total += disc.discount_amount * Math.abs(item.qty);
			}
		}
		return Math.round(total * 100) / 100;
	});

	const offerGrandTotalDiscountPct = computed(() =>
		computeGrandTotalDiscountPct(offerEvaluation.value.grandTotalDiscounts),
	);

	const itemCount = computed(() =>
		items.value.reduce((sum: number, item: CartItem) => sum + Math.abs(item.qty), 0),
	);

	const subtotal = computed(() =>
		items.value.reduce((sum: number, item: CartItem) => {
			const itemTotal = item.qty * item.rate;
			let discount = 0;
			if (item.discount_percentage) {
				discount = (itemTotal * item.discount_percentage) / 100;
			} else if (item.discount_amount) {
				discount = item.qty < 0 ? -item.discount_amount : item.discount_amount;
			}
			return sum + (itemTotal - discount);
		}, 0),
	);

	const calculatedTaxes = computed(() => {
		const posStore = usePosStore();
		const taxDetails = posStore.taxes || [];
		const taxInclusive = posStore.taxInclusiveMode;

		const itemNets: { net: number; taxMap: Record<string, number> | undefined }[] = [];
		for (const item of items.value) {
			const itemTotal = item.qty * item.rate;
			let discount = 0;
			if (item.discount_percentage) {
				discount = (itemTotal * item.discount_percentage) / 100;
			} else if (item.discount_amount) {
				discount = item.qty < 0 ? -item.discount_amount : item.discount_amount;
			}
			itemNets.push({
				net: itemTotal - discount,
				taxMap: item.item_tax_map,
			});
		}

		if (itemNets.length === 0) return [];

		const result: CalculatedTax[] = [];

		for (const tax of taxDetails) {
			const isIncluded = tax.included_in_print_rate === 1;
			let totalTaxAmount = 0;

			for (const { net, taxMap } of itemNets) {
				let effectiveRate = tax.rate;
				if (taxMap && tax.account_head in taxMap) {
					effectiveRate = taxMap[tax.account_head];
				}

				if (tax.charge_type === "On Net Total") {
					if (taxInclusive && isIncluded) {
						totalTaxAmount += (net * effectiveRate) / (100 + effectiveRate);
					} else if (!isIncluded) {
						totalTaxAmount += (net * effectiveRate) / 100;
					}
				}
			}

			if (tax.charge_type === "Actual") {
				totalTaxAmount = tax.rate;
			}

			if (totalTaxAmount !== 0) {
				result.push({
					description: tax.description || "Tax",
					rate: tax.rate,
					amount: Math.round(totalTaxAmount * 100) / 100,
					included_in_print_rate: isIncluded,
				});
			}
		}

		const profileAccountHeads = new Set(taxDetails.map((t) => t.account_head));
		const extraTaxAccounts: Map<string, number> = new Map();

		for (const { net, taxMap } of itemNets) {
			if (!taxMap) continue;
			for (const [accountHead, rate] of Object.entries(taxMap)) {
				if (profileAccountHeads.has(accountHead)) continue;
				const taxAmount = (net * rate) / 100;
				extraTaxAccounts.set(accountHead, (extraTaxAccounts.get(accountHead) || 0) + taxAmount);
			}
		}

		for (const [accountHead, amount] of extraTaxAccounts) {
			if (amount !== 0) {
				const desc = accountHead.split(" - ")[0] || "Tax";
				result.push({
					description: desc,
					rate: 0,
					amount: Math.round(amount * 100) / 100,
					included_in_print_rate: false,
				});
			}
		}

		return result;
	});

	const taxAmount = computed(() => {
		return calculatedTaxes.value
			.filter((t) => !t.included_in_print_rate)
			.reduce((sum, t) => sum + t.amount, 0);
	});

	const includedTaxAmount = computed(() => {
		return calculatedTaxes.value
			.filter((t) => t.included_in_print_rate)
			.reduce((sum, t) => sum + t.amount, 0);
	});

	const totalTaxAmount = computed(() => {
		return calculatedTaxes.value.reduce((sum, t) => sum + t.amount, 0);
	});

	const grandTotal = computed(() => {
		const posStore = usePosStore();
		let total = subtotal.value + taxAmount.value;

		// Apply offer item-level discounts
		if (offerItemDiscountTotal.value > 0) {
			total -= offerItemDiscountTotal.value;
		}

		// Apply offer grand total discounts
		if (offerGrandTotalDiscountPct.value > 0) {
			total -= (total * offerGrandTotalDiscountPct.value) / 100;
		}

		if (discountPercentage.value > 0) {
			const base = applyDiscountOn.value === "Net Total" ? subtotal.value : total;
			total -= (base * discountPercentage.value) / 100;
		} else if (discountAmount.value > 0) {
			total -= discountAmount.value;
		}
		if (!isReturnMode.value && redeemLoyaltyPoints.value && loyaltyAmount.value > 0) {
			total -= loyaltyAmount.value;
		}
		if (!isReturnMode.value && writeOffAmount.value > 0) {
			total -= writeOffAmount.value;
		}
		if (!isReturnMode.value && selectedDeliveryCharge.value) {
			total += selectedDeliveryCharge.value.rate || 0;
		}
		total = isReturnMode.value ? total : Math.max(0, total);
		if (!posStore.disableRoundedTotal && total !== 0) {
			total = Math.round(total);
		}
		return total;
	});

	const isEmpty = computed(() => items.value.length === 0);

	const customerName = computed(() => {
		if (!customer.value) return "Walk-in Customer";
		return customer.value.customer_name || customer.value.name;
	});

	const totalPayments = computed(() => payments.value.reduce((sum, p) => sum + (p.amount || 0), 0));

	const remainingPayment = computed(() => Math.max(0, grandTotal.value - totalPayments.value));

	const hasOffers = computed(() => appliedOffers.value.length > 0 || !!appliedCoupon.value);

	function stockQtyOf(row: { qty: number; conversion_factor?: number }): number {
		return row.qty * (row.conversion_factor || 1);
	}

	function getStockReservations(): { item_code: string; stock_qty: number }[] {
		const totals = new Map<string, number>();

		for (const row of items.value) {
			if (Number(row.is_stock_item) === 0) continue;
			totals.set(row.item_code, (totals.get(row.item_code) || 0) + stockQtyOf(row));
		}

		return [...totals.entries()]
			.filter(([, stock_qty]) => stock_qty !== 0)
			.map(([item_code, stock_qty]) => ({ item_code, stock_qty }));
	}

	function committedStockQty(itemCode: string, batchNo?: string): number {
		return items.value
			.filter((i: CartItem) => {
				if (i.item_code !== itemCode) return false;
				return batchNo ? i.batch_no === batchNo : true;
			})
			.reduce((sum: number, i: CartItem) => sum + stockQtyOf(i), 0);
	}

	function checkAvailability(
		item: POSItem,
		requestedQty: number,
		conversionFactor = 1,
		batchNo?: string,
		replacesRowQty = 0,
	): { allowed: boolean; message?: string } {
		const posStore = usePosStore();

		if (posStore.stockSettings?.allow_negative_stock) {
			return { allowed: true };
		}
		if (!posStore.blockSaleBeyondAvailableQty) {
			return { allowed: true };
		}
		if (Number(item.is_stock_item) === 0) {
			return { allowed: true };
		}

		const uomLabel = item.uom || item.stock_uom;
		const actualQty = item.actual_qty ?? 0;
		if (actualQty <= 0) {
			return { allowed: false, message: __("{0} is out of stock", [item.item_name]) };
		}

		const requestedStockQty = requestedQty * (conversionFactor || 1);

		if (batchNo) {
			const batchQty = getBatchQty(item, batchNo);
			if (batchQty !== undefined) {
				const committedInBatch = committedStockQty(item.item_code, batchNo) - replacesRowQty;
				if (committedInBatch + requestedStockQty > batchQty) {
					return {
						allowed: false,
						message: __("Only {0} of batch {1} available", [String(batchQty), batchNo]),
					};
				}
			}
		}

		const committed = committedStockQty(item.item_code) - replacesRowQty;
		if (committed + requestedStockQty > actualQty) {
			return {
				allowed: false,
				message: __("Only {0} {1} of {2} available", [String(actualQty), uomLabel, item.item_name]),
			};
		}

		return { allowed: true };
	}

	function getBatchQty(item: POSItem, batchNo: string): number | undefined {
		const batches = item.batches as { batch_no: string; qty: number }[] | undefined;
		return batches?.find((b) => b.batch_no === batchNo)?.qty;
	}

	function canAddItem(item: POSItem): { allowed: boolean; message?: string } {
		return checkAvailability(item, 1, (item as CartItem).conversion_factor || 1, item.batch_no);
	}

	async function revalidateStock(): Promise<{ valid: boolean; messages: string[] }> {
		const posStore = usePosStore();

		if (posStore.stockSettings?.allow_negative_stock || !posStore.blockSaleBeyondAvailableQty) {
			return { valid: true, messages: [] };
		}
		if (isReturnMode.value) {
			return { valid: true, messages: [] };
		}

		const stockItems = items.value.filter((i: CartItem) => Number(i.is_stock_item) !== 0);
		if (stockItems.length === 0) {
			return { valid: true, messages: [] };
		}

		const warehouse = posStore.warehouse;
		if (!warehouse) {
			return { valid: true, messages: [] };
		}

		const itemCodes = [...new Set(stockItems.map((i: CartItem) => i.item_code))];
		const freshMap = await fetchAvailability(itemCodes, warehouse, posStore.profileName);

		if (freshMap.size === 0) {
			return { valid: true, messages: [] };
		}

		for (const row of items.value) {
			const qty = freshMap.get(row.item_code);
			if (qty !== undefined) row.actual_qty = qty;
		}

		const messages: string[] = [];
		for (const [itemCode, available] of freshMap) {
			const required = committedStockQty(itemCode);
			if (required > available) {
				const row = stockItems.find((i: CartItem) => i.item_code === itemCode);
				messages.push(
					__("Only {0} {1} of {2} available", [
						String(available),
						row?.stock_uom || "",
						row?.item_name || itemCode,
					]),
				);
			}
		}

		return { valid: messages.length === 0, messages };
	}

	async function fetchAvailability(
		itemCodes: string[],
		warehouse: string,
		posProfile: string,
	): Promise<Map<string, number>> {
		try {
			const fresh = await call<{ item_code: string; actual_qty: number }[]>(
				"xpos.api.items.get_stock_availability",
				{
					items: JSON.stringify(itemCodes),
					warehouse,
					pos_profile: posProfile || undefined,
				},
			);
			if (fresh?.length) {
				return new Map(fresh.map((s) => [s.item_code, s.actual_qty || 0]));
			}
		} catch {}

		const cached = new Map<string, number>();
		for (const itemCode of itemCodes) {
			try {
				const entry = await getCachedStockForItem(warehouse, itemCode);
				if (entry) cached.set(itemCode, entry.actual_qty);
			} catch {}
		}
		return cached;
	}

	function addItem(item: POSItem): { success: boolean; message?: string } {
		if (
			isReturnMode.value &&
			returnItemCodes.value.length > 0 &&
			!returnItemCodes.value.includes(item.item_code)
		) {
			return { success: false, message: __("This item is not in the original invoice") };
		}

		const stockCheck = canAddItem(item);
		if (!stockCheck.allowed && !isReturnMode.value) {
			return { success: false, message: stockCheck.message };
		}

		const existing = items.value.find(
			(i: CartItem) => i.item_code === item.item_code && !i.serial_no && !i.batch_no,
		);

		if (existing) {
			existing.qty += isReturnMode.value ? -1 : 1;
		} else {
			items.value.push({
				uid: nextRowId(),
				item_code: item.item_code,
				item_name: item.item_name,
				local_item_name: item.local_item_name,
				rate: normalizeItemRate(item.rate || 0),
				qty: isReturnMode.value ? -1 : 1,
				uom: item.uom || item.stock_uom,
				stock_uom: item.stock_uom,
				image: item.image,
				discount_percentage: 0,
				discount_amount: 0,
				serial_no: item.serial_no || "",
				batch_no: item.batch_no || "",
				actual_qty: item.actual_qty || 0,
				is_stock_item: item.is_stock_item,
				has_serial_no: item.has_serial_no,
				has_batch_no: item.has_batch_no,
				conversion_factor: (item as CartItem).conversion_factor || 1,
				item_group: item.item_group,
				brand: item.brand,
				variant_of: item.variant_of,
			});
		}

		return { success: true };
	}

	function canAddItemWithDetails(
		item: POSItem,
		qty: number,
		batchNo?: string,
		conversionFactor = 1,
	): { allowed: boolean; message?: string } {
		return checkAvailability(item, qty, conversionFactor, batchNo);
	}

	function addItemWithDetails(
		item: POSItem,
		qty: number,
		rate: number,
		uom?: string,
		serialNo?: string,
		batchNo?: string,
		conversionFactor?: number,
	): { success: boolean; message?: string } {
		if (
			isReturnMode.value &&
			returnItemCodes.value.length > 0 &&
			!returnItemCodes.value.includes(item.item_code)
		) {
			return { success: false, message: __("This item is not in the original invoice") };
		}

		if (!isReturnMode.value) {
			const stockCheck = canAddItemWithDetails(item, qty, batchNo, conversionFactor || 1);
			if (!stockCheck.allowed) {
				return { success: false, message: stockCheck.message };
			}
		}

		if (!serialNo) {
			const existing = items.value.find(
				(i: CartItem) =>
					i.item_code === item.item_code &&
					!i.serial_no &&
					i.uom === (uom || item.uom || item.stock_uom) &&
					i.batch_no === (batchNo || ""),
			);
			if (existing) {
				const addQty = isReturnMode.value ? -Math.abs(qty) : qty;
				existing.qty += addQty;
				if (rate) existing.rate = normalizeItemRate(rate);
				return { success: true };
			}
		}

		items.value.push({
			uid: nextRowId(),
			item_code: item.item_code,
			item_name: item.item_name,
			local_item_name: item.local_item_name,
			rate: normalizeItemRate(rate),
			qty: isReturnMode.value ? -Math.abs(qty) : qty,
			uom: uom || item.uom || item.stock_uom,
			stock_uom: item.stock_uom,
			image: item.image,
			discount_percentage: 0,
			discount_amount: 0,
			serial_no: serialNo || "",
			batch_no: batchNo || "",
			actual_qty: item.actual_qty || 0,
			is_stock_item: item.is_stock_item,
			has_serial_no: item.has_serial_no,
			has_batch_no: item.has_batch_no,
			conversion_factor: conversionFactor || 1,
			item_group: item.item_group,
			brand: item.brand,
			variant_of: item.variant_of,
		});

		return { success: true };
	}

	function removeItem(index: number): void {
		if (index < 0 || index >= items.value.length) return;
		items.value.splice(index, 1);
		if (items.value.length === 0) {
			selectedCartIndex.value = -1;
		} else if (selectedCartIndex.value > index) {
			selectedCartIndex.value -= 1;
		} else if (selectedCartIndex.value === index) {
			selectedCartIndex.value = Math.min(index, items.value.length - 1);
		}
		syncFreeItems();
	}

	function setSelectedCartIndex(index: number): void {
		selectedCartIndex.value = index;
	}

	function updateItemQty(index: number, qty: number): { success: boolean; message?: string } {
		if (qty === 0) {
			removeItem(index);
			return { success: true };
		}

		const item = items.value[index];
		if (!item) return { success: false, message: __("Item not found") };

		if (!isReturnMode.value && qty > item.qty) {
			const stockCheck = checkAvailability(
				item,
				qty,
				item.conversion_factor || 1,
				item.batch_no || undefined,
				stockQtyOf(item),
			);
			if (!stockCheck.allowed) {
				return { success: false, message: stockCheck.message };
			}
		}

		items.value[index].qty = qty;
		syncFreeItems();
		return { success: true };
	}

	function updateItemRate(index: number, rate: number): void {
		items.value[index].rate = normalizeItemRate(rate);
		items.value[index].pos_rate_overridden = true;
	}

	function updateItemDiscount(index: number, type: "percentage" | "amount", value: number): void {
		if (type === "percentage") {
			items.value[index].discount_percentage = value;
			items.value[index].discount_amount = 0;
		} else {
			items.value[index].discount_amount = value;
			items.value[index].discount_percentage = 0;
		}
		items.value[index].pos_pricing_rules = [];
	}

	function updateItemUOM(index: number, uom: string, rate: number, conversionFactor: number): void {
		items.value[index].uom = uom;
		items.value[index].rate = normalizeItemRate(rate);
		items.value[index].conversion_factor = conversionFactor;
	}

	function updateItemNotes(index: number, notes: string): void {
		items.value[index].pos_notes = notes;
	}

	function updateItemDeliveryDate(index: number, date: string): void {
		items.value[index].pos_delivery_date = date;
	}

	function setCustomer(
		cust: {
			name: string;
			customer_name?: string;
			image?: string;
			mobile_no?: string;
			email_id?: string;
			customer_group?: string;
			territory?: string;
		} | null,
	): void {
		customer.value = cust;
	}

	function setItemTax(itemCode: string, taxTemplate: string, taxMap: Record<string, number>): void {
		const item = items.value.find((i: CartItem) => i.item_code === itemCode);
		if (item) {
			item.item_tax_template = taxTemplate;
			item.item_tax_map = taxMap;
		}
	}

	function setDiscount(type: "percentage" | "amount", value: number): void {
		if (type === "percentage") {
			discountPercentage.value = value;
			discountAmount.value = 0;
		} else {
			discountAmount.value = value;
			discountPercentage.value = 0;
		}
		ruleDiscountPercentage.value = 0;
		ruleDiscountAmount.value = 0;
	}

	function enterReturnMode(invoiceName: string, allowedItemCodes?: string[]): void {
		isReturnMode.value = true;
		returnAgainst.value = invoiceName;
		returnItemCodes.value = allowedItemCodes || items.value.map((i) => i.item_code);
	}

	function exitReturnMode(): void {
		isReturnMode.value = false;
		returnAgainst.value = "";
		returnItemCodes.value = [];
		clearCart();
	}

	function setLoyalty(points: number, amount: number): void {
		redeemLoyaltyPoints.value = true;
		loyaltyPoints.value = points;
		loyaltyAmount.value = amount;
	}

	function clearLoyalty(): void {
		redeemLoyaltyPoints.value = false;
		loyaltyPoints.value = 0;
		loyaltyAmount.value = 0;
	}

	function applyOffer(offer: POSOffer): void {
		if (!appliedOffers.value.find((o) => o.name === offer.name)) {
			appliedOffers.value.push(offer);
		}
		syncFreeItems();
	}

	function removeOffer(offerName: string): void {
		appliedOffers.value = appliedOffers.value.filter((o) => o.name !== offerName);
		syncFreeItems();
	}

	function applyCoupon(coupon: POSCoupon): void {
		appliedCoupon.value = coupon;
		couponCode.value = coupon.coupon_code || "";
		const linkedOffer = (coupon as Record<string, unknown>)._offer as POSOffer | undefined;
		if (linkedOffer && !appliedOffers.value.find((o) => o.name === linkedOffer.name)) {
			appliedOffers.value.push(linkedOffer);
			syncFreeItems();
		}
	}

	function removeCoupon(): void {
		if (appliedCoupon.value) {
			const linkedOfferName = (appliedCoupon.value as Record<string, unknown>).pos_offer as string;
			if (linkedOfferName) {
				appliedOffers.value = appliedOffers.value.filter((o) => o.name !== linkedOfferName);
			}
		}
		appliedCoupon.value = null;
		couponCode.value = "";
		syncFreeItems();
	}

	function syncFreeItems(): void {
		const eval_ = offerEvaluation.value;

		items.value = items.value.filter((i) => !i.pos_is_offer);

		for (const free of eval_.freeItems) {
			if (!free.item_code) continue;
			items.value.push({
				uid: nextRowId(),
				item_code: free.item_code,
				item_name: free.item_name,
				rate: normalizeItemRate(free.rate),
				qty: free.qty,
				uom: "",
				stock_uom: "",
				image: "",
				discount_percentage: free.rate === 0 ? 100 : 0,
				discount_amount: 0,
				serial_no: "",
				batch_no: "",
				actual_qty: 0,
				has_serial_no: false,
				has_batch_no: false,
				conversion_factor: 1,
				pos_is_offer: true,
				pos_is_replace: free.is_replace,
				pos_offers: free.offer_name,
				pos_offer_applied: true,
			} as CartItem);
		}
	}

	/**
	 * Replace the free lines a Product pricing rule generated.
	 *
	 * Kept separate from POS Offer free items (`pos_is_offer`), which are a
	 * different feature with its own lifecycle.
	 */
	function syncPricingRuleFreeItems(freeLines: FreeItemLine[]): void {
		const current = items.value
			.filter((i) => i.pos_is_free_item)
			.map((i) => `${i.item_code}:${i.qty}:${i.rate}:${i.pos_free_item_rule}`)
			.join("|");
		const incoming = freeLines
			.map((f) => `${f.item_code}:${f.qty}:${normalizeItemRate(f.rate)}:${f.pricing_rules}`)
			.join("|");
		if (current === incoming) return;

		items.value = items.value.filter((i) => !i.pos_is_free_item);

		for (const free of freeLines) {
			if (!free.item_code) continue;
			items.value.push({
				uid: nextRowId(),
				item_code: free.item_code,
				item_name: free.item_name || free.item_code,
				rate: normalizeItemRate(free.rate),
				qty: free.qty,
				uom: free.uom || free.stock_uom || "",
				stock_uom: free.stock_uom || free.uom || "",
				image: "",
				discount_percentage: 0,
				discount_amount: 0,
				serial_no: "",
				batch_no: "",
				actual_qty: 0,
				has_serial_no: false,
				has_batch_no: false,
				conversion_factor: free.conversion_factor || 1,
				pos_is_free_item: true,
				pos_free_item_rule: free.pricing_rules,
			} as CartItem);
		}
	}

	function buildPricingLines(): CartPricingLine[] {
		for (const item of items.value) {
			if (!item.uid) item.uid = nextRowId();
		}

		return items.value
			.filter((item) => !item.pos_is_free_item && !item.pos_is_offer && item.qty !== 0)
			.map((item) => ({
				row_id: item.uid as string,
				item_code: item.item_code,
				item_group: item.item_group,
				brand: item.brand as string | undefined,
				variant_of: item.variant_of,
				qty: item.qty,
				uom: item.uom || item.stock_uom,
				conversion_factor: item.conversion_factor || 1,
				rate: item.rate,
				price_list_rate: item.rate,
				warehouse: posStore.warehouse,
				pricing_rules: item.pos_pricing_rules?.length
					? JSON.stringify(item.pos_pricing_rules)
					: undefined,
			}));
	}

	let lastSnapshotRefresh = 0;
	const SNAPSHOT_TTL_MS = 5 * 60 * 1000;

	/**
	 * Cache the rule snapshot the offline engine needs. Called on POS boot and
	 * opportunistically after a server reconcile, so the cache is warm before the
	 * network drops. Throttled - rules change far slower than carts do.
	 */
	async function refreshPricingSnapshot(force = false): Promise<void> {
		if (!force && Date.now() - lastSnapshotRefresh < SNAPSHOT_TTL_MS) return;
		lastSnapshotRefresh = Date.now();
		await refreshPricingRuleSnapshot({
			pos_profile: posStore.profileName,
			company: posStore.companyName,
			price_list: posStore.sellingPriceList,
			currency: currency.value || posStore.currency,
		});
	}

	function applyPricingResult(result: ResolvedCartPricing): void {
		const byRow = new Map(result.updates.map((u) => [u.row_id, u]));

		for (const item of items.value) {
			if (item.pos_is_free_item || item.pos_is_offer) continue;
			const update = item.uid ? byRow.get(item.uid) : undefined;

			if (update && update.pricing_rules.length) {
				if (!item.pos_rate_overridden && update.price_list_rate) {
					item.rate = normalizeItemRate(update.price_list_rate);
				}
				item.discount_percentage = update.discount_percentage;
				item.discount_amount = update.discount_percentage ? 0 : update.discount_amount;
				item.pos_pricing_rules = update.pricing_rules;
			} else if (item.pos_pricing_rules?.length) {
				item.discount_percentage = 0;
				item.discount_amount = 0;
				item.pos_pricing_rules = [];
			}
		}

		syncPricingRuleFreeItems(result.free_lines);
		applyTransactionDiscount(result.invoice_updates);
		pricingSource.value = result.source;
	}

	function applyTransactionDiscount(update: ResolvedCartPricing["invoice_updates"]): void {
		applyDiscountOn.value = update.apply_discount_on || "Grand Total";

		if (update.from_pricing_rule) {
			discountPercentage.value = update.additional_discount_percentage;
			discountAmount.value = update.discount_amount;
			ruleDiscountPercentage.value = update.additional_discount_percentage;
			ruleDiscountAmount.value = update.discount_amount;
			return;
		}

		const ownsPercentage =
			ruleDiscountPercentage.value > 0 && discountPercentage.value === ruleDiscountPercentage.value;
		const ownsAmount = ruleDiscountAmount.value > 0 && discountAmount.value === ruleDiscountAmount.value;
		if (ownsPercentage || ownsAmount) {
			discountPercentage.value = 0;
			discountAmount.value = 0;
		}
		ruleDiscountPercentage.value = 0;
		ruleDiscountAmount.value = 0;
	}

	let pricingRequestId = 0;

	/**
	 * Re-price the cart against the Pricing Rules.
	 *
	 * Debounced by the watcher below; safe to call directly (e.g. after loading a
	 * draft). Responses are tagged with a request id so a slow reply cannot
	 * overwrite a newer one.
	 */
	async function applyPricingRules(): Promise<void> {
		if (isReturnMode.value) return;

		const lines = buildPricingLines();
		if (!lines.length) {
			syncPricingRuleFreeItems([]);
			applyTransactionDiscount({
				additional_discount_percentage: 0,
				discount_amount: 0,
				apply_discount_on: "Grand Total",
				from_pricing_rule: false,
			});
			return;
		}

		const requestId = ++pricingRequestId;
		isPricingCart.value = true;
		try {
			const result = await resolveCartPricing({
				lines,
				context: {
					pos_profile: posStore.profileName,
					company: posStore.companyName,
					customer: customer.value?.name,
					customer_group: customer.value?.customer_group,
					territory: customer.value?.territory,
					price_list: posStore.sellingPriceList,
					currency: currency.value || posStore.currency,
					conversion_rate: conversionRate.value,
					warehouse: posStore.warehouse,
					coupon_code: couponCode.value,
					posting_date: postingDate.value,
				},
			});

			if (requestId !== pricingRequestId) return; // superseded
			if (result.source === "unavailable") return; // leave prices as they are

			applyPricingResult(result);

			if (result.source === "server") {
				refreshPricingSnapshot().catch(() => {});
			}
		} finally {
			if (requestId === pricingRequestId) isPricingCart.value = false;
		}
	}

	const schedulePricingRules = debounce(() => {
		applyPricingRules().catch((error) => {
			console.error("Pricing rule reconciliation failed:", error);
		});
	}, 250);

	watch(
		() =>
			[
				customer.value?.name || "",
				couponCode.value,
				postingDate.value,
				posStore.sellingPriceList,
				items.value
					.filter((i) => !i.pos_is_free_item && !i.pos_is_offer)
					.map(
						(i) =>
							`${i.uid}:${i.item_code}:${i.qty}:${i.uom}:${i.rate}:${i.batch_no}:${i.serial_no}`,
					)
					.join("|"),
			].join("~"),
		() => schedulePricingRules(),
	);

	function clearAllDiscounts(): void {
		discountPercentage.value = 0;
		discountAmount.value = 0;
		ruleDiscountPercentage.value = 0;
		ruleDiscountAmount.value = 0;
		for (const item of items.value) {
			if (!item.pos_is_offer) {
				item.discount_percentage = 0;
				item.discount_amount = 0;
				item.pos_pricing_rules = [];
			}
		}
		appliedCoupon.value = null;
		couponCode.value = "";
		appliedOffers.value = [];
		items.value = items.value.filter((i) => !i.pos_is_offer && !i.pos_is_free_item);
	}

	function addPayment(modeOfPayment: string, amount: number): void {
		const existing = payments.value.find((p) => p.mode_of_payment === modeOfPayment);
		if (existing) {
			existing.amount += amount;
		} else {
			payments.value.push({ mode_of_payment: modeOfPayment, amount });
		}
	}

	function setPayments(paymentList: InvoicePayment[]): void {
		payments.value = paymentList;
	}

	function clearPayments(): void {
		payments.value = [];
		changeLegs.value = [];
		changeAmount.value = 0;
	}

	function setChangeLegs(legs: InvoiceChangeLeg[]): void {
		changeLegs.value = legs;
	}

	function setChangeAmount(amount: number): void {
		changeAmount.value = amount;
	}

	function setCurrency(curr: string, rate: number): void {
		currency.value = curr;
		conversionRate.value = rate;
	}

	function clearCart(): void {
		invoiceLocalId = "";
		items.value = [];
		selectedCartIndex.value = -1;
		discountPercentage.value = 0;
		discountAmount.value = 0;
		ruleDiscountPercentage.value = 0;
		ruleDiscountAmount.value = 0;
		applyDiscountOn.value = "Grand Total";
		pricingSource.value = "server";
		clearLoyalty();
		appliedOffers.value = [];
		appliedCoupon.value = null;
		couponCode.value = "";
		writeOffAmount.value = 0;
		orderNotes.value = "";
		deliveryDate.value = "";
		postingDate.value = nowDate();
		salesPerson.value = "";
		payments.value = [];
		changeLegs.value = [];
		changeAmount.value = 0;
		currentDraftName.value = "";
		currentDraftModified.value = "";
		currency.value = "";
		conversionRate.value = 1;
		selectedDeliveryCharge.value = null;
	}

	function clearAll(): void {
		clearCart();
		customer.value = null;
		showPaymentDialog.value = false;
		isReturnMode.value = false;
		returnAgainst.value = "";
		returnItemCodes.value = [];
		const posStore = usePosStore();
		if (posStore.defaultCustomer) {
			const name = String(posStore.defaultCustomer);
			customer.value = {
				name,
				customer_name: name,
			};
		}
	}

	function openPaymentDialog(): void {
		showPaymentDialog.value = true;
	}

	function closePaymentDialog(): void {
		showPaymentDialog.value = false;
	}

	async function fetchDraftInvoices(scope: "shift" | "profile" = "shift"): Promise<OpenTab[]> {
		try {
			isLoadingDrafts.value = true;
			const result = await call<OpenTab[]>("xpos.api.invoices.get_draft_invoices", {
				pos_opening_shift: posStore.posOpeningShift?.name || "",
				scope,
			});
			return result || [];
		} catch (error) {
			console.error("Error fetching draft invoices:", error);
			return [];
		} finally {
			isLoadingDrafts.value = false;
		}
	}

	async function loadDraftInvoice(draftName: string): Promise<boolean> {
		try {
			const result = await call<any>("xpos.api.invoices.get_invoice_details", {
				invoice_name: draftName,
			});

			if (!result) {
				return false;
			}

			clearCart();

			postingDate.value = posStore.allowChangePostingDate
				? toDateOrNow(result.posting_date)
				: nowDate();

			if (result.customer) {
				customer.value = {
					name: result.customer,
					customer_name: result.customer_name || result.customer,
				};
			}

			if (result.items && Array.isArray(result.items)) {
				const posStore = usePosStore();
				const warehouse = posStore.warehouse || "";

				const { useItemStore } = await import("@/stores/itemStore");
				const itemStore = useItemStore();
				const inMemoryMap = new Map<string, number>(
					itemStore.items.map((i: POSItem) => [i.item_code, i.actual_qty ?? 0]),
				);

				for (const item of result.items) {
					let actualQty: number = inMemoryMap.get(item.item_code) ?? -1;

					if (actualQty < 0) {
						if (warehouse) {
							const stockEntry = await getCachedStockForItem(warehouse, item.item_code);
							if (stockEntry) {
								actualQty = stockEntry.actual_qty;
							}
						}

						if (actualQty < 0) {
							const cachedItem = await getCachedItemByCode(item.item_code);
							actualQty = cachedItem?.actual_qty ?? 0;
						}
					}

					items.value.push({
						uid: nextRowId(),
						item_code: item.item_code,
						item_name: item.item_name,
						local_item_name: item.local_item_name,
						rate: normalizeItemRate(item.price_list_rate || item.rate || 0),
						qty: item.qty || 1,
						uom: item.uom || item.stock_uom || "",
						stock_uom: item.stock_uom || item.uom || "",
						image: "",
						discount_percentage: item.discount_percentage || 0,
						discount_amount: item.discount_amount || 0,
						serial_no: item.serial_no || "",
						batch_no: item.batch_no || "",
						actual_qty: actualQty,
						is_stock_item: item.is_stock_item,
						has_serial_no: item.has_serial_no || false,
						has_batch_no: item.has_batch_no || false,
						conversion_factor: 1,
						pos_notes: item.additional_notes || "",
						pos_delivery_date: item.delivery_date || "",
						pos_is_free_item: !!item.is_free_item,
						pos_free_item_rule: item.is_free_item ? parseRuleName(item.pricing_rules) : undefined,
						pos_pricing_rules: parsePricingRules(item.pricing_rules),
					} as CartItem);
				}
			}

			if (result.additional_discount_percentage) {
				discountPercentage.value = result.additional_discount_percentage;
			}
			if (result.discount_amount) {
				discountAmount.value = result.discount_amount;
			}
			if (result.pos_notes) {
				orderNotes.value = result.pos_notes;
			}
			if (result.pos_delivery_date) {
				deliveryDate.value = result.pos_delivery_date;
			}
			if (result.sales_person) {
				salesPerson.value = result.sales_person;
			}
			if (result.pos_delivery_charges) {
				selectedDeliveryCharge.value = {
					name: result.pos_delivery_charges,
					label: result.pos_delivery_charges_label || result.pos_delivery_charges,
					rate: Number(result.pos_delivery_charges_rate || 0),
					default_rate: Number(result.pos_delivery_charges_rate || 0),
				};
			}
			currentDraftName.value = draftName;
			currentDraftModified.value = result.modified || "";

			return true;
		} catch (error) {
			console.error("Error loading draft invoice:", error);
			return false;
		}
	}

	function openDraftDialog(): void {
		showDraftDialog.value = true;
	}

	function closeDraftDialog(): void {
		showDraftDialog.value = false;
	}

	function loadFromInvoice(invoiceData: {
		customer: string;
		customer_name: string;
		items: Array<{
			item_code: string;
			item_name: string;
			local_item_name?: string;
			qty: number;
			rate: number;
			price_list_rate?: number;
			uom: string;
			stock_uom?: string;
			discount_percentage?: number;
			discount_amount?: number;
			serial_no?: string;
			batch_no?: string;
		}>;
	}): void {
		clearCart();
		customer.value = {
			name: invoiceData.customer,
			customer_name: invoiceData.customer_name,
		};
		for (const item of invoiceData.items) {
			items.value.push({
				uid: nextRowId(),
				item_code: item.item_code,
				item_name: item.item_name,
				local_item_name: item.local_item_name,
				rate: normalizeItemRate(item.price_list_rate || item.rate || 0),
				qty: item.qty || 1,
				uom: item.uom || item.stock_uom || "",
				stock_uom: item.stock_uom || item.uom || "",
				image: "",
				discount_percentage: item.discount_percentage || 0,
				discount_amount: item.discount_amount || 0,
				serial_no: item.serial_no || "",
				batch_no: item.batch_no || "",
				actual_qty: 0,
				has_serial_no: false,
				has_batch_no: false,
				conversion_factor: 1,
			} as CartItem);
		}
	}

	let invoiceLocalId = "";
	function getInvoiceData(posProfile: string, posOpeningShift: string): InvoiceData {
		const data: InvoiceData = {
			local_id: invoiceLocalId || (invoiceLocalId = newInvoiceId()),
			pos_profile: posProfile,
			customer: customer.value?.name || "",
			items: items.value.map(
				(item: CartItem): InvoiceItem => ({
					item_code: item.item_code,
					item_name: item.item_name,
					local_item_name: item.local_item_name,
					qty: item.qty,
					rate: normalizeItemRate(item.rate),
					price_list_rate: normalizeItemRate(item.rate),
					uom: item.uom || item.stock_uom,
					discount_percentage: item.discount_percentage,
					discount_amount: item.discount_amount,
					serial_no: item.serial_no,
					batch_no: item.batch_no,
					item_tax_template: item.item_tax_template,
					additional_notes: item.pos_notes,
					delivery_date: item.pos_delivery_date,
					offers: item.pos_offers,
					is_offer: item.pos_is_offer,
					is_replace: item.pos_is_replace,
					is_free_item: item.pos_is_free_item ? 1 : undefined,
					pricing_rules: item.pos_free_item_rule,
				}),
			),
			pos_opening_shift: posOpeningShift,
			posting_date: posStore.allowChangePostingDate ? postingDate.value || nowDate() : nowDate(),
			additional_discount_percentage: discountPercentage.value,
			discount_amount: discountAmount.value,
			apply_discount_on: applyDiscountOn.value,
		};

		const _hasOfferDisc = offerItemDiscountTotal.value > 0 || offerGrandTotalDiscountPct.value > 0;
		if (_hasOfferDisc) {
			let totalDisc = offerItemDiscountTotal.value;
			let remaining = subtotal.value + taxAmount.value - totalDisc;

			if (offerGrandTotalDiscountPct.value > 0) {
				const gtAmt = (remaining * offerGrandTotalDiscountPct.value) / 100;
				totalDisc += gtAmt;
				remaining -= gtAmt;
			}

			if (discountPercentage.value > 0) {
				totalDisc += (remaining * discountPercentage.value) / 100;
			} else if (discountAmount.value > 0) {
				totalDisc += discountAmount.value;
			}

			data.discount_amount = Math.round(totalDisc * 100) / 100;
			data.additional_discount_percentage = 0;
		}

		if (currentDraftName.value) {
			data.name = currentDraftName.value;
			if (currentDraftModified.value) {
				data.modified = currentDraftModified.value;
			}
		}

		if (payments.value.length > 0) {
			data.payments = payments.value;
		}

		if (changeAmount.value > 0) {
			data.change_amount = changeAmount.value;
		}

		if (changeLegs.value.length > 0) {
			data.pos_change_legs = changeLegs.value;
		}

		if (orderNotes.value) data.pos_notes = orderNotes.value;
		if (deliveryDate.value) data.pos_delivery_date = deliveryDate.value;
		if (salesPerson.value) data.sales_person = salesPerson.value;

		if (redeemLoyaltyPoints.value) {
			data.redeem_loyalty_points = true;
			data.loyalty_points = loyaltyPoints.value;
			data.loyalty_amount = loyaltyAmount.value;
		}

		if (isReturnMode.value && returnAgainst.value) {
			data.is_return = true;
			data.return_against = returnAgainst.value;
		}

		if (writeOffAmount.value > 0) {
			data.write_off_amount = writeOffAmount.value;
		}

		if (currency.value && conversionRate.value !== 1) {
			data.currency = currency.value;
			data.conversion_rate = conversionRate.value;
		}

		if (appliedCoupon.value) {
			data.coupons = JSON.stringify([appliedCoupon.value.name]);
			data.coupons_detail = [
				{
					coupon: appliedCoupon.value.name,
					coupon_code: appliedCoupon.value.coupon_code || couponCode.value,
					type: (appliedCoupon.value as Record<string, unknown>).coupon_type || "Promotional",
					pos_offer: (appliedCoupon.value as Record<string, unknown>).pos_offer || "",
					applied: 1,
					customer: customer.value?.name || "",
				},
			];
		}

		if (appliedOffers.value.length > 0) {
			data.offers = JSON.stringify(appliedOffers.value.map((o) => o.name));
			data.offers_detail = appliedOffers.value.map((o) => ({
				offer_name: o.name,
				offer:
					(o as Record<string, unknown>).offer || (o as Record<string, unknown>).offer_type || "",
				apply_on: o.apply_on || "",
				offer_applied: 1,
				coupon_based: (o as Record<string, unknown>).coupon_based ? 1 : 0,
			}));
		}

		if (selectedDeliveryCharge.value) {
			data.pos_delivery_charges = selectedDeliveryCharge.value.name;
			data.pos_delivery_charges_rate = selectedDeliveryCharge.value.rate;
		}

		return data;
	}

	function getReceiptSnapshot(invoiceName: string, cashier = ""): ReceiptSnapshot {
		const snapshotItems = items.value.map((item: CartItem) => {
			const gross = item.qty * item.rate;
			let discount = 0;
			if (item.discount_percentage) {
				discount = (gross * item.discount_percentage) / 100;
			} else if (item.discount_amount) {
				discount = item.qty < 0 ? -item.discount_amount : item.discount_amount;
			}
			return {
				item_code: item.item_code,
				item_name: item.local_item_name || item.item_name,
				qty: item.qty,
				rate: item.rate,
				amount: Math.round(gross * 100) / 100,
				uom: item.uom || item.stock_uom,
				discount_percentage: item.discount_percentage,
				discount_amount: Math.round(discount * 100) / 100,
				price_list_rate: item.rate,
				serial_no: item.serial_no,
				batch_no: item.batch_no,
				pos_notes: item.pos_notes,
			};
		});

		const itemDiscountTotal = snapshotItems.reduce((sum, it) => sum + (it.discount_amount || 0), 0);
		const totalDiscount = Math.round((itemDiscountTotal + (discountAmount.value || 0)) * 100) / 100;
		const totalQty = items.value.reduce((sum: number, item: CartItem) => sum + item.qty, 0);
		const paid = totalPayments.value;
		const change = paid - grandTotal.value;

		return {
			name: invoiceName,
			posting_date: postingDate.value || nowDate(),
			posting_time: new Date().toTimeString().slice(0, 8),
			is_return: isReturnMode.value,
			cashier,
			customer_name: customerName.value,
			items: snapshotItems,
			taxes: calculatedTaxes.value.map((t) => ({
				description: t.description,
				rate: t.rate,
				amount: t.amount,
				included_in_print_rate: !!t.included_in_print_rate,
			})),
			payments: payments.value
				.filter((p) => p.amount)
				.map((p) => ({
					mode_of_payment: p.mode_of_payment,
					amount: p.amount,
					...(p.pos_tender_currency
						? {
								currency: p.pos_tender_currency,
								native_amount: p.pos_tender_amount,
								exchange_rate: p.pos_exchange_rate,
								rate_date: posStore.tenderModeFor(p.mode_of_payment)?.rate_date || "",
							}
						: {}),
				})),
			subtotal: Math.round(subtotal.value * 100) / 100,
			total_discount: totalDiscount,
			net_total: Math.round((subtotal.value + includedTaxAmount.value) * 100) / 100,
			grand_total: grandTotal.value,
			total_qty: totalQty,
			change: change > 0.01 && !isReturnMode.value ? Math.round(change * 100) / 100 : 0,
			change_legs: changeLegs.value.length ? changeLegs.value : undefined,
			currency: currency.value || posStore.currency || undefined,
			notes: orderNotes.value || undefined,
		};
	}

	function setDeliveryCharge(charge: DeliveryCharge | null): void {
		selectedDeliveryCharge.value = charge;
	}

	return {
		items,
		customer,
		discountPercentage,
		discountAmount,
		showPaymentDialog,
		isReturnMode,
		returnAgainst,
		returnItemCodes,
		orderNotes,
		deliveryDate,
		postingDate,
		writeOffAmount,
		salesPerson,
		redeemLoyaltyPoints,
		loyaltyPoints,
		loyaltyAmount,
		appliedOffers,
		appliedCoupon,
		couponCode,
		payments,
		changeLegs,
		changeAmount,
		selectedCartIndex,
		currentDraftName,
		currentDraftModified,
		isSavingDraft,
		showDraftDialog,
		isLoadingDrafts,
		currency,
		conversionRate,
		selectedDeliveryCharge,
		applyDiscountOn,
		isPricingCart,
		pricingSource,
		offerEvaluation,
		offerItemDiscountTotal,
		offerGrandTotalDiscountPct,
		itemCount,
		subtotal,
		calculatedTaxes,
		taxAmount,
		includedTaxAmount,
		totalTaxAmount,
		grandTotal,
		isEmpty,
		customerName,
		totalPayments,
		remainingPayment,
		hasOffers,
		canAddItem,
		revalidateStock,
		getStockReservations,
		canAddItemWithDetails,
		addItem,
		addItemWithDetails,
		removeItem,
		setSelectedCartIndex,
		updateItemQty,
		updateItemRate,
		updateItemDiscount,
		updateItemUOM,
		updateItemNotes,
		updateItemDeliveryDate,
		setCustomer,
		setDiscount,
		setItemTax,
		enterReturnMode,
		exitReturnMode,
		setLoyalty,
		clearLoyalty,
		applyOffer,
		removeOffer,
		applyCoupon,
		removeCoupon,
		syncFreeItems,
		applyPricingRules,
		refreshPricingSnapshot,
		clearAllDiscounts,
		addPayment,
		setPayments,
		clearPayments,
		setChangeLegs,
		setChangeAmount,
		setCurrency,
		clearCart,
		clearAll,
		openPaymentDialog,
		closePaymentDialog,
		getInvoiceData,
		getReceiptSnapshot,
		loadFromInvoice,
		fetchDraftInvoices,
		loadDraftInvoice,
		openDraftDialog,
		closeDraftDialog,
		setDeliveryCharge,
		itemRatePrecision,
	};
});
