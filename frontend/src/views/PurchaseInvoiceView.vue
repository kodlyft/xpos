<script setup lang="ts">
import { ref, onMounted, computed, reactive, watch } from "vue";
import { useRouter } from "vue-router";
import { usePurchaseStore } from "@/stores/purchaseStore";
import { usePosStore } from "@/stores/posStore";
import { useMoney } from "@/composables/useMoney";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table } from "@/components/ui/table";
import { Autocomplete, type AutocompleteOption } from "@/components/ui/autocomplete";
import type { TableColumn } from "@/components/ui/table/types";
import {
	Plus,
	Save,
	X,
	Receipt,
	ScanBarcode,
	Loader2,
	List,
	FileDown,
	FileUp,
	Send,
	Trash2,
	Edit3,
	ShoppingCart,
} from "lucide-vue-next";
import type { SearchItem } from "@/types/pos.types";
import { showError, showSuccess, showInfo, call } from "@/services/api";
import __ from "@/lib/translate";
import { CreateItemDialog, CreateSupplierDialog } from "@/components/purchase";
import { DateTimePicker } from "@/components/ui/datetime-picker";

const router = useRouter();
const purchaseStore = usePurchaseStore();
const posStore = usePosStore();
const { money, qty, percent, decimal } = useMoney();

function today(): string {
	return new Date().toISOString().split("T")[0];
}

interface InvoiceItem {
	item_code: string;
	item_name: string;
	qty: number;
	rate: number;
	uom: string;
	stock_uom: string;
	conversion_factor: number;
	discount_percent: number;
	discount_amount: number;
	gst_percent: number;
	taxes?: Record<string, number>;
	sale_price: number;
	warehouse: string;
	batch_no: string;
	item_uoms: Array<{ uom: string; conversion_factor: number }>;
	purchase_order?: string;
	po_detail?: string;
	[key: string]: any;
}

const invoiceHeader = reactive({
	posting_date: today(),
	supplier_invoice_no: "",
	supplier_invoice_date: "",
	remarks: "",
});

const additionalDiscountPercent = ref(0);
const additionalDiscountAmount = ref(0);

// ─── Payment mode ──────────────────────────────────────────────────────────
const selectedPaymentMode = ref(posStore.cashModeOfPayment || "Cash");

const invoiceItems = ref<InvoiceItem[]>([]);

const currentDraftName = ref<string | null>(null);
const isDraftSaving = ref(false);
const isDraftLoading = ref(false);
const showDraftPanel = ref(false);
const draftList = ref<
	Array<{
		name: string;
		supplier: string;
		supplier_name: string;
		posting_date: string;
		grand_total: number;
		bill_no: string;
		creation: string;
		modified: string;
		items_count: number;
	}>
>([]);

const showPOPanel = ref(false);
const purchaseOrders = ref<any[]>([]);
const isLoadingPOs = ref(false);

const barcodeValue = ref("");
const isBarcodeScan = ref(false);
const barcodeFlash = ref<"" | "success" | "error">("");
let barcodeFlashTimer: ReturnType<typeof setTimeout> | null = null;

const purchaseTaxTemplate = ref("");
const defaultTaxRate = ref(0);

const purchaseTaxes = computed(() => posStore.purchaseTaxes);

const showNewItemDialog = ref(false);
const showNewSupplierDialog = ref(false);
const isProcessing = ref(false);
const itemSearchTerm = ref("");

function getGrossAmount(item: InvoiceItem): number {
	return item.qty * item.rate;
}

function getDiscountValue(item: InvoiceItem): number {
	if (item.discount_amount > 0) return item.discount_amount;
	return (getGrossAmount(item) * (item.discount_percent || 0)) / 100;
}

function getNetAmount(item: InvoiceItem): number {
	return getGrossAmount(item) - getDiscountValue(item);
}

function getTaxAmount(item: InvoiceItem): number {
	const net = getNetAmount(item);
	if (purchaseTaxes.value.length > 0) {
		return purchaseTaxes.value.reduce((sum: any, t: any) => {
			const percent = (item.taxes || {})[t.tax_type] || 0;
			return sum + (net * percent) / 100;
		}, 0);
	}
	return (net * (item.gst_percent || 0)) / 100;
}

function getTotalAmount(item: InvoiceItem): number {
	return getNetAmount(item) + getTaxAmount(item);
}

function getMarginPercent(item: InvoiceItem): number {
	if (!item.rate || item.rate === 0) return 0;
	const costPerUnit = item.rate * (1 - (item.discount_percent || 0) / 100);
	if (costPerUnit === 0) return 0;
	return ((item.sale_price - costPerUnit) / costPerUnit) * 100;
}

const totalQty = computed(() => invoiceItems.value.reduce((sum, item) => sum + item.qty, 0));

const grossTotal = computed(() => invoiceItems.value.reduce((sum, item) => sum + getGrossAmount(item), 0));

const totalDiscount = computed(() =>
	invoiceItems.value.reduce((sum, item) => sum + getDiscountValue(item), 0),
);

const netTotal = computed(() => invoiceItems.value.reduce((sum, item) => sum + getNetAmount(item), 0));

const totalTax = computed(() => invoiceItems.value.reduce((sum, item) => sum + getTaxAmount(item), 0));

const subtotalWithTax = computed(() => netTotal.value + totalTax.value);

const invoiceLevelDiscount = computed(() => {
	if (additionalDiscountAmount.value > 0) return additionalDiscountAmount.value;
	if (additionalDiscountPercent.value > 0)
		return (subtotalWithTax.value * additionalDiscountPercent.value) / 100;
	return 0;
});

const grandTotal = computed(() => subtotalWithTax.value - invoiceLevelDiscount.value);

function formatCurrency(value: number): string {
	return money(value);
}

async function onBarcodeScan(): Promise<void> {
	const code = barcodeValue.value.trim();
	if (!code) return;
	isBarcodeScan.value = true;
	try {
		const result = await purchaseStore.searchByBarcode(code);
		if (result) {
			addItemToInvoice(result);
			barcodeFlash.value = "success";
			barcodeValue.value = "";
		} else {
			showError(`${__("Item not found for barcode")}: ${code}`);
			barcodeFlash.value = "error";
		}
	} catch {
		barcodeFlash.value = "error";
	} finally {
		isBarcodeScan.value = false;
		if (barcodeFlashTimer) clearTimeout(barcodeFlashTimer);
		barcodeFlashTimer = setTimeout(() => {
			barcodeFlash.value = "";
		}, 600);
	}
}

function onBarcodePaste(): void {
	setTimeout(() => {
		const code = barcodeValue.value.trim();
		if (code) onBarcodeScan();
	}, 50);
}

function addEmptyRow(): void {
	invoiceItems.value.push({
		item_code: "",
		item_name: "",
		qty: 0,
		rate: 0,
		uom: "",
		stock_uom: "",
		conversion_factor: 1,
		discount_percent: 0,
		discount_amount: 0,
		gst_percent: defaultTaxRate.value,
		sale_price: 0,
		warehouse: posStore.warehouse,
		batch_no: "",
		item_uoms: [],
	});
}

async function addItemToInvoice(item: SearchItem): Promise<void> {
	const existing = invoiceItems.value.find((i) => i.item_code === item.item_code);
	if (existing) {
		existing.qty += 1;
		return;
	}

	try {
		const details = await call<any>("xpos.x_pos.api.purchase_orders.get_item_purchase_details", {
			item_code: item.item_code,
			pos_profile: posStore.profileName,
		});
		if (details) {
			if (details.purchase_uom_note) showInfo(details.purchase_uom_note);
			invoiceItems.value.push({
				item_code: details.item_code,
				item_name: details.item_name,
				qty: 1,
				rate: details.buying_rate || item.standard_rate || 0,
				uom: details.purchase_uom || details.stock_uom,
				stock_uom: details.stock_uom,
				conversion_factor: details.purchase_cf || 1,
				discount_percent: 0,
				discount_amount: 0,
				gst_percent: details.tax_rate || defaultTaxRate.value,
				sale_price: details.selling_rate || 0,
				warehouse: posStore.warehouse,
				batch_no: "",
				item_uoms: details.item_uoms || [{ uom: details.stock_uom, conversion_factor: 1 }],
			});
			return;
		}
	} catch {
		// fallback to basic item info
	}

	invoiceItems.value.push({
		item_code: item.item_code,
		item_name: item.item_name,
		qty: 1,
		rate: item.standard_rate || 0,
		uom: item.stock_uom,
		stock_uom: item.stock_uom,
		conversion_factor: 1,
		discount_percent: 0,
		discount_amount: 0,
		gst_percent: defaultTaxRate.value,
		sale_price: item.selling_price || 0,
		warehouse: posStore.warehouse,
		batch_no: "",
		item_uoms: item.item_uoms || [{ uom: item.stock_uom, conversion_factor: 1 }],
	});
}

async function onItemLinkSelect(payload: {
	rowIndex: number;
	fieldname: string;
	option: AutocompleteOption;
}): Promise<void> {
	const { rowIndex, option } = payload;
	const itemCode = option.value as string;

	const row = invoiceItems.value[rowIndex];
	if (!row) return;

	try {
		const details = await call<any>("xpos.x_pos.api.purchase_orders.get_item_purchase_details", {
			item_code: itemCode,
			pos_profile: posStore.profileName,
		});
		if (details) {
			if (details.purchase_uom_note) showInfo(details.purchase_uom_note);
			row.item_code = details.item_code;
			row.item_name = details.item_name;
			row.rate = details.buying_rate || 0;
			row.uom = details.purchase_uom || details.stock_uom;
			row.stock_uom = details.stock_uom;
			row.conversion_factor = details.purchase_cf || 1;
			row.qty = row.qty || 1;
			row.sale_price = details.selling_rate || 0;
			row.gst_percent = details.tax_rate || defaultTaxRate.value;
			row.item_uoms = details.item_uoms || [{ uom: details.stock_uom, conversion_factor: 1 }];
			return;
		}
	} catch {
		// fallback to basic store search
	}

	const item = await purchaseStore.fetchItemByCode(itemCode);
	if (!item) return;

	row.item_code = item.item_code;
	row.item_name = item.item_name;
	row.rate = item.standard_rate || 0;
	row.uom = item.stock_uom;
	row.stock_uom = item.stock_uom;
	row.conversion_factor = 1;
	row.qty = row.qty || 1;
	row.sale_price = item.selling_price || 0;
	row.gst_percent = defaultTaxRate.value;
	row.item_uoms = item.item_uoms || [{ uom: item.stock_uom, conversion_factor: 1 }];
}

function onCellChange(payload: { rowIndex: number; fieldname: string; value: any }): void {
	const { rowIndex, fieldname, value } = payload;
	const item = invoiceItems.value[rowIndex];
	if (!item) return;

	switch (fieldname) {
		case "item_code": {
			if (!value) {
				item.item_code = "";
				item.item_name = "";
				item.qty = 0;
				item.rate = 0;
				item.uom = "";
				item.stock_uom = "";
				item.conversion_factor = 1;
				item.discount_percent = 0;
				item.discount_amount = 0;
				item.gst_percent = 0;
				item.sale_price = 0;
				item.item_uoms = [];
			} else {
				item.item_code = value;
			}
			break;
		}
		case "uom": {
			const uomData = item.item_uoms?.find((u) => u.uom === value);
			item.uom = value;
			item.conversion_factor = uomData?.conversion_factor || 1;
			break;
		}
		case "discount_percent": {
			item.discount_percent = value;
			item.discount_amount = 0;
			break;
		}
		case "discount_amount": {
			item.discount_amount = value;
			item.discount_percent = 0;
			break;
		}
		default: {
			if (fieldname.startsWith("tax__")) {
				const taxType = fieldname.slice(5);
				if (!item.taxes) item.taxes = {};
				item.taxes[taxType] = value;
			} else {
				(item as any)[fieldname] = value;
			}
		}
	}
}

const invoiceColumns = computed<TableColumn[]>(() => {
	// Fixed columns before tax
	const cols: TableColumn[] = [
		{
			fieldname: "item_code",
			label: __("Item"),
			type: "link" as const,
			width: "min-w-[260px]",
			align: "left" as const,
			alwaysVisible: true,
			frozen: "left" as const,
			frozenWidth: 260,
			link: {
				doctype: "Item",
				labelField: "item_name",
			},
			placeholder: __("Select item..."),
		},
		{
			fieldname: "qty",
			label: __("Qty"),
			type: "number" as const,
			width: "min-w-[70px]",
			align: "center" as const,
			min: 0,
			precision: 0,
		},
		{
			fieldname: "uom",
			label: __("UOM"),
			type: "select" as const,
			width: "w-[90px]",
			align: "center" as const,
			options: (row: any) => {
				const uoms = row.item_uoms || [];
				return uoms.map((u: any) => ({ label: u.uom, value: u.uom }));
			},
		},
		{
			fieldname: "conversion_factor",
			label: __("CF"),
			type: "readonly" as const,
			width: "w-[50px]",
			align: "center" as const,
			editable: false,
			format: (val: any) => qty(Number(val || 1), 0),
		},
		{
			fieldname: "rate",
			label: __("Rate"),
			type: "number" as const,
			width: "min-w-[85px]",
			align: "right" as const,
			min: 0,
			precision: 2,
		},
		{
			fieldname: "gross_amount",
			label: __("Gross"),
			type: "readonly" as const,
			width: "w-[85px]",
			align: "right" as const,
			editable: false,
			format: (_: any, row: any) => formatCurrency(getGrossAmount(row)),
		},
		{
			fieldname: "discount_percent",
			label: __("Disc%"),
			type: "number" as const,
			width: "w-[60px]",
			align: "right" as const,
			min: 0,
			max: 100,
			precision: 1,
		},
		{
			fieldname: "discount_amount",
			label: __("Disc Amt"),
			type: "number" as const,
			width: "w-[75px]",
			align: "right" as const,
			min: 0,
			precision: 2,
		},
		{
			fieldname: "net_amount",
			label: __("Net"),
			type: "readonly" as const,
			width: "w-[85px]",
			align: "right" as const,
			editable: false,
			format: (_: any, row: any) => formatCurrency(getNetAmount(row)),
		},
	];
	if (purchaseTaxes.value.length > 0) {
		for (const tax of purchaseTaxes.value) {
			cols.push({
				fieldname: `tax__${tax.tax_type}`,
				label: `${tax.tax_type}%`,
				type: "number" as const,
				width: "w-[70px]",
				align: "right" as const,
				min: 0,
				max: 100,
				precision: 1,
				format: (_: any, row: any) => decimal((row.taxes || {})[tax.tax_type] || 0, 1),
			});
		}
	} else {
		cols.push({
			fieldname: "gst_percent",
			label: __("Tax%"),
			type: "number" as const,
			width: "w-[60px]",
			align: "right" as const,
			min: 0,
			max: 100,
			precision: 1,
		});
	}
	cols.push(
		{
			fieldname: "tax_amount",
			label: __("Tax Amt"),
			type: "readonly" as const,
			width: "w-[75px]",
			align: "right" as const,
			editable: false,
			format: (_: any, row: any) => formatCurrency(getTaxAmount(row)),
		},
		{
			fieldname: "total_amount",
			label: __("Total"),
			type: "readonly" as const,
			width: "w-[90px]",
			align: "right" as const,
			editable: false,
			cellClass: "text-green-600 font-medium",
			format: (_: any, row: any) => formatCurrency(getTotalAmount(row)),
		},
		{
			fieldname: "sale_price",
			label: __("Sale Price"),
			type: "number" as const,
			width: "w-[85px]",
			align: "right" as const,
			min: 0,
			precision: 2,
		},
		{
			fieldname: "margin_percent",
			label: __("Margin%"),
			type: "readonly" as const,
			width: "w-[65px]",
			align: "right" as const,
			editable: false,
			format: (_: any, row: any) => percent(getMarginPercent(row), 1),
			cellClass: (_: any, row: any) => (getMarginPercent(row) >= 0 ? "text-green-600" : "text-red-500"),
		},
	);

	return cols;
});

async function createInvoice(): Promise<void> {
	if (!purchaseStore.selectedSupplier) {
		showError(__("Please select a supplier"));
		return;
	}
	if (invoiceItems.value.length === 0) {
		showError(__("Please add at least one item"));
		return;
	}

	isProcessing.value = true;
	try {
		const payload: Record<string, any> = {
			pos_profile: posStore.profileName,
			supplier: purchaseStore.selectedSupplier?.name || purchaseStore.selectedSupplierName || undefined,
			company: posStore.companyName,
			warehouse: posStore.warehouse,
			posting_date: invoiceHeader.posting_date || undefined,
			bill_no: invoiceHeader.supplier_invoice_no || undefined,
			remarks: invoiceHeader.remarks || undefined,
			items: invoiceItems.value
				.filter((i) => i.item_code && i.qty > 0)
				.map((item) => ({
					item_code: item.item_code,
					item_name: item.item_name,
					qty: item.qty,
					rate: item.rate,
					uom: item.uom,
					stock_uom: item.stock_uom,
					conversion_factor: item.conversion_factor,
					batch_no: item.batch_no || undefined,
					warehouse: item.warehouse,
					purchase_order: item.purchase_order || undefined,
					po_detail: item.po_detail || undefined,
					taxes: item.taxes || {},
					sale_price: item.sale_price,
				})),
			receive: true,
		};

		if (purchaseTaxes.value.length === 0 && purchaseTaxTemplate.value) {
			payload.taxes_and_charges = purchaseTaxTemplate.value;
		}

		if (selectedPaymentMode.value) {
			payload.is_paid = 1;
			payload.mode_of_payment = selectedPaymentMode.value;
		}

		const result = await call<{ purchase_invoice?: string }>(
			"xpos.x_pos.api.purchase_orders.create_purchase_invoice_direct",
			{ data: JSON.stringify(payload) },
		);

		if (result?.purchase_invoice) {
			if (currentDraftName.value) {
				try {
					await call("xpos.x_pos.api.purchase_orders.delete_pi_draft", {
						name: currentDraftName.value,
					});
				} catch {
					// ignore
				}
			}
			showSuccess(__("Purchase Invoice {0} created", [result.purchase_invoice]));
			clearForm();
		}
	} catch (error) {
		showError(error instanceof Error ? error.message : __("Failed to create invoice"));
	} finally {
		isProcessing.value = false;
	}
}

async function saveDraft(): Promise<void> {
	if (!purchaseStore.selectedSupplier) {
		showError(__("Please select a supplier before saving a draft."));
		return;
	}
	if (invoiceItems.value.length === 0) {
		showError(__("Please add at least one item."));
		return;
	}

	isDraftSaving.value = true;
	try {
		const payload = {
			draft_name: currentDraftName.value || undefined,
			supplier: purchaseStore.selectedSupplier?.name || purchaseStore.selectedSupplierName,
			company: posStore.companyName,
			warehouse: posStore.warehouse,
			posting_date: invoiceHeader.posting_date,
			bill_no: invoiceHeader.supplier_invoice_no || undefined,
			remarks: invoiceHeader.remarks || undefined,
			receive: true,
			discount_amount: additionalDiscountAmount.value || undefined,
			additional_discount_percentage: additionalDiscountPercent.value || undefined,
			items: invoiceItems.value
				.filter((i) => i.item_code)
				.map((item) => ({
					item_code: item.item_code,
					item_name: item.item_name,
					qty: item.qty,
					rate: item.rate,
					uom: item.uom,
					stock_uom: item.stock_uom,
					conversion_factor: item.conversion_factor,
					batch_no: item.batch_no || undefined,
					warehouse: item.warehouse,
					purchase_order: item.purchase_order || undefined,
					po_detail: item.po_detail || undefined,
				})),
		};

		const result = await call<{ draft_name: string }>("xpos.x_pos.api.purchase_orders.save_pi_draft", {
			data: JSON.stringify(payload),
		});
		currentDraftName.value = result.draft_name;
		showSuccess(__("Draft {0} saved", [result.draft_name]));
	} catch (error) {
		showError(error instanceof Error ? error.message : __("Failed to save draft"));
	} finally {
		isDraftSaving.value = false;
	}
}

async function loadDrafts(): Promise<void> {
	try {
		const result = await call<typeof draftList.value>("xpos.x_pos.api.purchase_orders.list_pi_drafts", {
			limit: 50,
		});
		draftList.value = result || [];
		showDraftPanel.value = true;
	} catch (error) {
		showError(__("Failed to load drafts"));
	}
}

async function loadDraft(name: string): Promise<void> {
	isDraftLoading.value = true;
	try {
		const result = await call<{
			draft_name: string;
			supplier: string;
			posting_date: string;
			bill_no: string;
			remarks: string;
			discount_amount: number;
			additional_discount_percentage: number;
			items: any[];
		}>("xpos.x_pos.api.purchase_orders.load_pi_draft", { name, pos_profile: posStore.profileName });

		clearForm();
		currentDraftName.value = result.draft_name;
		purchaseStore.selectedSupplierName = result.supplier || "";
		invoiceHeader.posting_date = result.posting_date || today();
		invoiceHeader.supplier_invoice_no = result.bill_no || "";
		invoiceHeader.remarks = result.remarks || "";
		additionalDiscountAmount.value = result.discount_amount || 0;
		additionalDiscountPercent.value = result.additional_discount_percentage || 0;

		invoiceItems.value = (result.items || []).map((item: any) => ({
			item_code: item.item_code || "",
			item_name: item.item_name || "",
			qty: item.qty || 0,
			rate: item.rate || 0,
			uom: item.uom || item.stock_uom || "",
			stock_uom: item.stock_uom || "",
			conversion_factor: item.conversion_factor || 1,
			discount_percent: item.discount_percent || 0,
			discount_amount: item.discount_amount || 0,
			gst_percent: item.gst_percent || defaultTaxRate.value,
			sale_price: item.sale_price || 0,
			warehouse: item.warehouse || posStore.warehouse,
			batch_no: item.batch_no || "",
			item_uoms: item.item_uoms || [{ uom: item.stock_uom || item.uom, conversion_factor: 1 }],
			purchase_order: item.purchase_order || undefined,
			po_detail: item.po_detail || undefined,
		}));

		showDraftPanel.value = false;
		showSuccess(__("Draft loaded"));
	} catch (error) {
		showError(error instanceof Error ? error.message : __("Failed to load draft"));
	} finally {
		isDraftLoading.value = false;
	}
}

async function deleteDraft(name: string): Promise<void> {
	try {
		await call("xpos.x_pos.api.purchase_orders.delete_pi_draft", { name });
		if (currentDraftName.value === name) currentDraftName.value = null;
		draftList.value = draftList.value.filter((d) => d.name !== name);
		showSuccess(__("Draft deleted"));
	} catch (error) {
		showError(error instanceof Error ? error.message : __("Failed to delete draft"));
	}
}

async function submitDraft(): Promise<void> {
	if (!currentDraftName.value) return;
	isProcessing.value = true;
	try {
		const itemsWithSalePrice = invoiceItems.value.filter((i) => i.sale_price > 0 && i.item_code);
		if (itemsWithSalePrice.length > 0) {
			await call("xpos.x_pos.api.purchase_orders.update_item_selling_price", {
				data: JSON.stringify({
					items: itemsWithSalePrice.map((i) => ({
						item_code: i.item_code,
						sale_price: i.sale_price,
						uom: i.uom,
					})),
				}),
				pos_profile: posStore.profileName,
				company: posStore.companyName,
			});
		}

		await saveDraft();

		const result = await call<{ purchase_invoice: string }>(
			"xpos.x_pos.api.purchase_orders.submit_pi_draft",
			{ name: currentDraftName.value },
		);

		showSuccess(__("Purchase Invoice {0} submitted", [result.purchase_invoice]));
		clearForm();
	} catch (error) {
		showError(error instanceof Error ? error.message : __("Failed to submit invoice"));
	} finally {
		isProcessing.value = false;
	}
}

async function fetchPurchaseOrders(): Promise<void> {
	if (!purchaseStore.selectedSupplier) {
		showError(__("Please select a supplier first"));
		return;
	}

	isLoadingPOs.value = true;
	try {
		const result = await call<any[]>("xpos.x_pos.api.purchase_orders.get_purchase_orders_for_invoice", {
			supplier: purchaseStore.selectedSupplier?.name || purchaseStore.selectedSupplierName,
			warehouse: posStore.warehouse,
			pos_profile: posStore.profileName,
			company: posStore.companyName,
		});
		purchaseOrders.value = result || [];
		showPOPanel.value = true;
	} catch (error) {
		showError(__("Failed to load purchase orders"));
	} finally {
		isLoadingPOs.value = false;
	}
}

function loadFromPO(po: any): void {
	const items = po.items || [];
	for (const poItem of items) {
		const qty = poItem.pending_qty > 0 ? poItem.pending_qty : poItem.qty;
		if (qty <= 0) continue;

		const existing = invoiceItems.value.find(
			(i) => i.item_code === poItem.item_code && i.purchase_order === po.name,
		);
		if (existing) {
			existing.qty += qty;
			continue;
		}

		invoiceItems.value.push({
			item_code: poItem.item_code,
			item_name: poItem.item_name,
			qty,
			rate: poItem.rate || 0,
			uom: poItem.uom || poItem.stock_uom || "",
			stock_uom: poItem.stock_uom || "",
			conversion_factor: poItem.conversion_factor || 1,
			discount_percent: 0,
			discount_amount: 0,
			gst_percent: defaultTaxRate.value,
			sale_price: poItem.sale_price || 0,
			warehouse: poItem.warehouse || posStore.warehouse,
			batch_no: "",
			item_uoms: poItem.item_uoms || [{ uom: poItem.stock_uom || poItem.uom, conversion_factor: 1 }],
			purchase_order: po.name,
			po_detail: poItem.po_detail,
		});
	}

	showPOPanel.value = false;
	showSuccess(__("Items loaded from PO {0}", [po.name]));
}

function onItemCreated(item: SearchItem, buyingPrice: number): void {
	addItemToInvoice({ ...item, standard_rate: buyingPrice });
}

function goToList(): void {
	router.push("/purchase-invoices");
}

function clearForm(): void {
	invoiceItems.value = [];
	purchaseStore.clearSupplier();
	currentDraftName.value = null;
	invoiceHeader.posting_date = today();
	invoiceHeader.supplier_invoice_no = "";
	invoiceHeader.supplier_invoice_date = "";
	invoiceHeader.remarks = "";
	additionalDiscountPercent.value = 0;
	additionalDiscountAmount.value = 0;
	selectedPaymentMode.value = posStore.cashModeOfPayment || "Cash";
}

async function loadPurchaseTaxTemplate(): Promise<void> {
	try {
		const result = await call<{ template_name: string; taxes: any[] }>(
			"xpos.x_pos.api.purchase_orders.get_purchase_tax_template",
			{ company: posStore.companyName },
		);
		if (result?.template_name) {
			purchaseTaxTemplate.value = result.template_name;
		}
		if (result?.taxes && result.taxes.length > 0) {
			defaultTaxRate.value = result.taxes[0].rate || 0;
		}
	} catch {}
}

onMounted(() => {
	purchaseStore.init();
	purchaseStore.searchItems();
	loadPurchaseTaxTemplate();
});
</script>

<template>
	<div class="h-full flex flex-col bg-background overflow-hidden">
		<header class="bg-card border-b border-border px-4 py-2.5 shrink-0">
			<div class="flex items-center justify-between gap-3">
				<div class="flex items-center gap-2">
					<Receipt class="w-5 h-5 text-primary" />
					<h1 class="text-lg font-semibold text-foreground">
						{{ __("Purchase Invoice") }}
					</h1>
					<span
						v-if="currentDraftName"
						class="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded"
					>
						{{ currentDraftName }}
					</span>
				</div>
				<div class="flex items-center gap-1.5">
					<Button @click="clearForm" variant="outline" size="sm" class="h-7 text-xs">
						<X class="w-3.5 h-3.5 me-1" />
						{{ __("Clear") }}
					</Button>
					<Button
						@click="saveDraft"
						variant="outline"
						size="sm"
						class="h-7 text-xs"
						:disabled="
							!purchaseStore.selectedSupplier || invoiceItems.length === 0 || isDraftSaving
						"
					>
						<Save class="w-3.5 h-3.5 me-1" />
						{{ isDraftSaving ? __("Saving...") : __("Save Draft") }}
					</Button>
					<Button
						v-if="currentDraftName"
						@click="submitDraft"
						:disabled="isProcessing"
						size="sm"
						class="h-7 text-xs"
					>
						<Send class="w-3.5 h-3.5 me-1" />
						{{ isProcessing ? __("Submitting...") : __("Submit") }}
					</Button>
					<Button
						v-else
						@click="createInvoice"
						:disabled="
							!purchaseStore.selectedSupplier || invoiceItems.length === 0 || isProcessing
						"
						size="sm"
						class="h-7 text-xs"
					>
						<Send class="w-3.5 h-3.5 me-1" />
						{{ isProcessing ? __("Creating...") : __("Create & Submit") }}
					</Button>
					<div class="w-px h-5 bg-border mx-0.5"></div>
					<Button @click="loadDrafts" variant="outline" size="sm" class="h-7 text-xs">
						<FileDown class="w-3.5 h-3.5 me-1" />
						{{ __("Drafts") }}
					</Button>
					<Button @click="fetchPurchaseOrders" variant="outline" size="sm" class="h-7 text-xs">
						<ShoppingCart class="w-3.5 h-3.5 me-1" />
						{{ __("From PO") }}
					</Button>
					<Button @click="goToList" variant="outline" size="sm" class="h-7 text-xs">
						<List class="w-3.5 h-3.5 me-1" />
						{{ __("Invoices") }}
					</Button>
				</div>
			</div>
		</header>

		<div class="bg-card border-b border-border px-4 py-2.5 shrink-0">
			<div class="grid grid-cols-5 gap-3">
				<div>
					<label class="text-xs text-muted-foreground mb-1 block">{{ __("Date") }}</label>
					<DateTimePicker v-model="invoiceHeader.posting_date" mode="date" class="h-8 text-sm" />
				</div>
				<div>
					<label class="text-xs text-muted-foreground mb-1 block">{{ __("Supplier") }} *</label>
					<div class="flex gap-1">
						<Autocomplete
							v-model="purchaseStore.selectedSupplierName"
							doctype="Supplier"
							placeholder="Select Supplier"
							class="h-8 text-sm flex-1"
						/>
						<Button
							@click="showNewSupplierDialog = true"
							variant="outline"
							size="icon"
							class="h-8 w-8 shrink-0"
						>
							<Plus class="w-3.5 h-3.5" />
						</Button>
					</div>
				</div>
				<div>
					<label class="text-xs text-muted-foreground mb-1 block">{{ __("Supp. Inv #") }}</label>
					<Input v-model="invoiceHeader.supplier_invoice_no" class="h-8 text-sm" />
				</div>
				<div>
					<label class="text-xs text-muted-foreground mb-1 block">{{ __("Supp. Inv Date") }}</label>
					<DateTimePicker
						v-model="invoiceHeader.supplier_invoice_date"
						mode="date"
						:showToday="true"
						class="h-8 text-sm"
					/>
				</div>
				<div>
					<label class="text-xs text-muted-foreground mb-1 block">{{ __("Remarks") }}</label>
					<Input
						v-model="invoiceHeader.remarks"
						class="h-8 text-sm"
						:placeholder="__('Optional notes...')"
					/>
				</div>
			</div>
		</div>

		<div class="flex-1 flex min-h-0 overflow-hidden">
			<div
				v-if="showDraftPanel"
				class="w-72 border-e border-border bg-card shrink-0 flex flex-col overflow-hidden"
			>
				<div class="px-3 py-2 border-b border-border flex items-center justify-between">
					<span class="text-sm font-medium">{{ __("Saved Drafts") }}</span>
					<Button @click="showDraftPanel = false" variant="ghost" size="icon" class="h-6 w-6">
						<X class="w-3.5 h-3.5" />
					</Button>
				</div>
				<div class="flex-1 overflow-y-auto p-2 space-y-2">
					<div v-if="draftList.length === 0" class="text-center text-muted-foreground text-xs py-8">
						{{ __("No drafts found") }}
					</div>
					<div
						v-for="draft in draftList"
						:key="draft.name"
						class="border border-border rounded-md p-2 text-xs hover:bg-accent/50 transition-colors"
					>
						<div class="flex items-center justify-between mb-1">
							<span class="font-medium truncate">{{ draft.name }}</span>
							<span class="text-muted-foreground"
								>{{ draft.items_count }} {{ __("items") }}</span
							>
						</div>
						<div class="text-muted-foreground truncate mb-1.5">
							{{ draft.supplier_name || draft.supplier }}
						</div>
						<div class="flex gap-1">
							<Button
								@click="loadDraft(draft.name)"
								variant="outline"
								size="sm"
								class="h-6 text-xs flex-1"
							>
								<Edit3 class="w-3 h-3 me-1" />
								{{ __("Load") }}
							</Button>
							<Button
								@click="deleteDraft(draft.name)"
								variant="outline"
								size="sm"
								class="h-6 text-xs text-destructive hover:text-destructive"
							>
								<Trash2 class="w-3 h-3" />
							</Button>
						</div>
					</div>
				</div>
			</div>

			<div
				v-if="showPOPanel"
				class="w-80 border-e border-border bg-card shrink-0 flex flex-col overflow-hidden"
			>
				<div class="px-3 py-2 border-b border-border flex items-center justify-between">
					<span class="text-sm font-medium">{{ __("Purchase Orders") }}</span>
					<Button @click="showPOPanel = false" variant="ghost" size="icon" class="h-6 w-6">
						<X class="w-3.5 h-3.5" />
					</Button>
				</div>
				<div class="flex-1 overflow-y-auto p-2 space-y-2">
					<div v-if="isLoadingPOs" class="text-center py-8">
						<Loader2 class="w-5 h-5 animate-spin mx-auto text-muted-foreground" />
					</div>
					<div
						v-else-if="purchaseOrders.length === 0"
						class="text-center text-muted-foreground text-xs py-8"
					>
						{{ __("No pending purchase orders") }}
					</div>
					<div
						v-for="po in purchaseOrders"
						:key="po.name"
						class="border border-border rounded-md p-2 text-xs hover:bg-accent/50 transition-colors"
					>
						<div class="flex items-center justify-between mb-1">
							<span class="font-medium">{{ po.name }}</span>
							<span class="text-green-600 font-medium">{{
								formatCurrency(po.grand_total)
							}}</span>
						</div>
						<div class="text-muted-foreground mb-1">
							{{ po.transaction_date }} &middot; {{ (po.items || []).length }} {{ __("items") }}
						</div>
						<div class="text-muted-foreground mb-1.5">
							{{ __("Billed") }}: {{ percent(po.per_billed || 0) }} &middot;
							{{ __("Received") }}:
							{{ percent(po.per_received || 0) }}
						</div>
						<Button
							@click="loadFromPO(po)"
							variant="outline"
							size="sm"
							class="h-6 text-xs w-full"
						>
							<FileUp class="w-3 h-3 me-1" />
							{{ __("Load Items") }}
						</Button>
					</div>
				</div>
			</div>

			<div class="flex-1 flex flex-col min-h-0 overflow-hidden">
				<Table
					:rows="invoiceItems"
					:columns="invoiceColumns"
					label="Items"
					min-width="1400px"
					:show-add-row="true"
					:show-checkboxes="true"
					:show-row-numbers="true"
					:show-delete-button="true"
					:keyboard-navigation="true"
					:allow-reorder="true"
					:allow-duplicate="true"
					:show-column-settings="true"
					:highlight-new-rows="true"
					:tab-to-add-row="true"
					:show-edit-row="true"
					empty-message="No items added"
					empty-description="Add a row and search for items, or load from a Purchase Order"
					@add-row="addEmptyRow"
					@cell-change="onCellChange"
					@link-select="onItemLinkSelect"
					class="flex-1 min-h-0 flex flex-col"
				>
					<template #toolbar>
						<div class="flex w-full flex-wrap items-center gap-1.5 sm:w-auto">
							<div class="relative w-full sm:w-auto">
								<ScanBarcode
									class="absolute inset-s-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground"
								/>
								<Input
									v-model="barcodeValue"
									class="ps-7 h-7 w-full text-xs sm:w-40"
									:class="{
										'ring-2 ring-green-500/50 border-green-500':
											barcodeFlash === 'success',
										'ring-2 ring-red-500/50 border-red-500': barcodeFlash === 'error',
									}"
									:placeholder="__('Scan barcode...')"
									@keydown.enter.prevent="onBarcodeScan"
									@paste="onBarcodePaste"
								/>
								<Loader2
									v-if="isBarcodeScan"
									class="absolute inset-e-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 animate-spin"
								/>
							</div>
							<Button
								@click="showNewItemDialog = true"
								variant="outline"
								size="sm"
								class="h-7 w-full text-xs sm:w-auto"
							>
								<Plus class="w-3.5 h-3.5 me-1" />
								{{ __("New Item") }}
							</Button>
						</div>
					</template>
				</Table>

				<div class="border-t border-border bg-muted shrink-0">
					<div class="px-4 py-2 grid grid-cols-7 gap-3 text-xs">
						<div>
							<span class="text-muted-foreground block">{{ __("Items") }}</span>
							<span class="font-semibold text-sm">{{ invoiceItems.length }}</span>
						</div>
						<div>
							<span class="text-muted-foreground block">{{ __("Total Qty") }}</span>
							<span class="font-semibold text-sm">{{ totalQty }}</span>
						</div>
						<div>
							<span class="text-muted-foreground block">{{ __("Gross Total") }}</span>
							<span class="font-semibold text-sm">{{ formatCurrency(grossTotal) }}</span>
						</div>
						<div>
							<span class="text-muted-foreground block">{{ __("Item Discount") }}</span>
							<span class="font-semibold text-sm text-red-500"
								>-{{ formatCurrency(totalDiscount) }}</span
							>
						</div>
						<div>
							<span class="text-muted-foreground block">{{ __("Net Total") }}</span>
							<span class="font-semibold text-sm">{{ formatCurrency(netTotal) }}</span>
						</div>
						<div>
							<span class="text-muted-foreground block">{{ __("Tax Total") }}</span>
							<span class="font-semibold text-sm">{{ formatCurrency(totalTax) }}</span>
						</div>
						<div>
							<span class="text-muted-foreground block">{{ __("Addl. Discount") }}</span>
							<div class="flex items-center gap-1">
								<Input
									v-model.number="additionalDiscountPercent"
									type="number"
									min="0"
									max="100"
									step="0.1"
									class="h-6 text-xs w-14"
									placeholder="%"
								/>
								<span class="text-muted-foreground">{{ __("or") }}</span>
								<Input
									v-model.number="additionalDiscountAmount"
									type="number"
									min="0"
									step="1"
									class="h-6 text-xs w-20"
									placeholder="Amt"
								/>
							</div>
						</div>
					</div>

					<div class="px-4 py-2.5 border-t border-border flex items-center justify-between">
						<div class="flex items-center gap-4">
							<div class="flex items-center gap-2">
								<label class="text-xs text-muted-foreground whitespace-nowrap">{{
									__("Payment")
								}}</label>
								<select
									v-model="selectedPaymentMode"
									class="h-7 text-xs rounded-md border border-input bg-background px-2 focus:outline-none focus:ring-1 focus:ring-ring"
								>
									<option value="">{{ __("No Payment") }}</option>
									<option
										v-for="pm in posStore.paymentMethods"
										:key="pm.mode_of_payment"
										:value="pm.mode_of_payment"
									>
										{{ pm.mode_of_payment }}
									</option>
								</select>
							</div>
							<div>
								<span class="text-sm text-muted-foreground">{{ __("Grand Total") }}</span>
								<div class="text-xl font-bold text-green-600">
									{{ formatCurrency(grandTotal) }}
								</div>
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>

		<CreateItemDialog
			v-model:open="showNewItemDialog"
			:initial-name="itemSearchTerm"
			@created="onItemCreated"
		/>

		<CreateSupplierDialog
			v-model:open="showNewSupplierDialog"
			:initial-name="purchaseStore.selectedSupplierName"
		/>
	</div>
</template>
