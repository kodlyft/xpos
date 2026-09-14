export interface POSSearchField {
	field: string;
	fieldname?: string;
	[key: string]: unknown;
}

export interface POSAdditionalField {
	fieldname: string;
	default_value: any;
	reqd: boolean;
	read_only: boolean;
	[key: string]: unknown;
}

export interface POSSettings {
	invoice_type: string;
	post_change_gl_entries: boolean;
	invoice_fields?: POSAdditionalField[];
	pos_search_fields?: POSSearchField[];
	item_search_limit?: number;
	search_serial_no?: number;
	search_batch_no?: number;
}

export interface ItemSearchSettings {
	fields: string[];
	item_search_limit: number;
	search_serial_no: number;
	search_batch_no: number;
}

export interface POSProfile {
	name: string;
	warehouse: string;
	currency: string;
	company: string;
	payments: POSPaymentMethod[];
	pos_mixed_currency_tender?: boolean;
	taxes_and_charges?: string;
	write_off_account?: string;
	write_off_cost_center?: string;
	selling_price_list?: string;
	default_customer?: string;
	allow_change_posting_date?: boolean;
	show_customer_balance?: boolean;
	allow_partial_payment?: boolean;
	allow_credit_sale?: boolean;
	allow_return?: boolean;
	allow_return_without_invoice?: boolean;
	allow_sales_order?: boolean;
	allow_delete_offline_invoice?: boolean;
	display_additional_notes?: boolean;
	allow_write_off_change?: boolean;
	input_qty?: boolean;
	display_item_code?: boolean;
	allow_zero_rated_items?: boolean;
	enable_cashier_settlement?: boolean;
	allow_open_tab_recall?: boolean;
	allow_outstanding_settlement?: boolean;
	print_backup_receipt?: boolean;
	auto_set_batch?: boolean;
	tax_inclusive?: boolean;
	default_view?: string;
	default_sales_order?: boolean;
	default_print_format?: string;
	enable_return_validity?: boolean;
	return_validity_days?: number;
	enable_cash_movement?: boolean;
	allow_pos_expense?: boolean;
	allow_cash_deposit?: boolean;
	max_discount_percentage_allowed?: number;
	auto_fetch_coupons_gifts?: boolean;
	hide_closing_shift?: boolean;
	use_offline_mode?: boolean;
	cash_mode_of_payment?: string;
	use_customer_credit?: boolean;
	use_cashback?: boolean;
	apply_customer_discount?: boolean;
	show_template_items?: boolean;
	hide_variants_items?: boolean;
	hide_unavailable_items?: boolean;
	hide_images?: boolean;
	default_pos_expense_account?: string;
	back_office_cash_account?: string;
	block_sale_beyond_available_qty?: boolean;
	purchase_taxes?: PurchaseTaxEntry[];
	allowed_sales_persons?: { sales_person: string }[];
	[key: string]: any;
}

export interface PurchaseTaxEntry {
	name?: string;
	tax_type: string;
	erp_tax_account: string;
}

export interface POSPaymentMethod {
	mode_of_payment: string;
	default?: boolean;
	amount?: number;
	pos_tender_currency?: string;
	type?: string;
	is_foreign_tender?: boolean;
	exchange_rate?: number;
	rate_date?: string;
	precision?: number;
	symbol?: string;
}

export interface Company {
	name: string;
	default_currency: string;
	company_name: string;
	[key: string]: unknown;
}

export interface StockSettings {
	allow_negative_stock?: boolean;
	[key: string]: unknown;
}

export interface POSOpeningShift {
	name: string;
	status: "Draft" | "Open" | "Closed" | "Cancelled";
	pos_profile: string;
	company: string;
	user: string;
	period_start_date: string;
	period_end_date?: string;
	posting_date: string;
	balance_details: POSOpeningShiftDetail[];
	pos_closing_shift?: string;
}

export interface POSOpeningShiftDetail {
	mode_of_payment: string;
	opening_amount: number;
}

export interface POSClosingShift {
	name: string;
	pos_opening_shift: string;
	pos_profile: string;
	company: string;
	user: string;
	period_start_date: string;
	period_end_date: string;
	posting_date: string;
	net_total: number;
	grand_total: number;
	total_quantity: number;
	payment_reconciliation: POSClosingShiftDetail[];
	taxes: POSClosingShiftTax[];
}

export interface POSClosingShiftDetail {
	mode_of_payment: string;
	expected_amount: number;
	closing_amount: number;
	difference: number;
	opening_amount?: number;
}

export interface POSClosingShiftTax {
	account_head: string;
	rate: number;
	amount: number;
}

export interface POSItem {
	item_code: string;
	item_name: string;
	local_item_name?: string;
	item_group?: string;
	description?: string;
	rate: number;
	uom: string;
	stock_uom: string;
	image?: string;
	actual_qty?: number;
	serial_no?: string;
	batch_no?: string;
	has_serial_no?: boolean;
	has_batch_no?: boolean;
	barcode?: string;
	item_tax_template?: string;
	is_stock_item?: boolean;
	has_variants?: boolean;
	variant_of?: string;
	is_template?: boolean;
	qty?: number;
	is_scale_barcode?: boolean;
	[key: string]: unknown;
}

export interface CartItem extends POSItem {
	qty: number;
	discount_percentage: number;
	discount_amount: number;
	pos_notes?: string;
	pos_delivery_date?: string;
	pos_offers?: string;
	pos_is_offer?: boolean;
	pos_is_replace?: boolean;
	conversion_factor?: number;
	item_tax_template?: string;
	item_tax_map?: Record<string, number>;
	pos_offer_applied?: boolean;
	uid?: string;
	pos_pricing_rules?: string[];
	pos_rate_overridden?: boolean;
	pos_is_free_item?: boolean;
	pos_free_item_rule?: string;
}

export interface ItemGroup {
	name: string;
	parent_item_group?: string;
	is_group?: boolean;
}

export interface ItemDetail {
	item_code: string;
	item_name: string;
	local_item_name?: string;
	uom: string;
	stock_uom: string;
	has_serial_no: boolean;
	has_batch_no: boolean;
	uoms: ItemUOM[];
	batches: BatchInfo[];
	serial_numbers: string[];
	barcode_uom?: string;
	conversion_factor?: number;
	price_list_rate?: number;
	[key: string]: unknown;
}

export interface ItemUOM {
	uom: string;
	conversion_factor: number;
}

export interface BatchInfo {
	batch_no: string;
	qty: number;
	expiry_date?: string;
}

export interface ItemVariant {
	item_code: string;
	item_name: string;
	local_item_name?: string;
	attributes: Record<string, string>;
	[key: string]: unknown;
}

export interface ItemAttribute {
	attribute: string;
	values: string[];
}

export interface StockAvailability {
	item_code: string;
	actual_qty: number;
	warehouse: string;
}

export interface Customer {
	name: string;
	customer_name: string;
	customer_group?: string;
	territory?: string;
	mobile_no?: string;
	email_id?: string;
	customer_type?: string;
	loyalty_program?: { name?: string; loyalty_points?: number; conversion_factor?: number };
	loyalty_points?: number;
	loyalty_amount?: number;
	discount?: number;
	referral_code?: string;
	birthday?: string;
	default_price_list?: string;
	gender?: string;
	tax_id?: string;
	balance?: number;
	credit_limit?: number;
	[key: string]: unknown;
}

export interface CustomerAddress {
	name: string;
	address_title?: string;
	address_line1: string;
	address_line2?: string;
	city: string;
	state?: string;
	country: string;
	pincode?: string;
	phone?: string;
	is_primary_address?: boolean;
	is_shipping_address?: boolean;
}

export interface CustomerCredit {
	total_credit: number;
	credit_notes: CreditNote[];
	unallocated_payments: UnallocatedPayment[];
	loyalty_points?: number;
	loyalty_amount?: number;
}

export interface CreditNote {
	name: string;
	grand_total: number;
	outstanding_amount: number;
	posting_date: string;
	customer: string;
}

export interface UnallocatedPayment {
	name: string;
	unallocated_amount: number;
	posting_date: string;
	mode_of_payment?: string;
}

export interface SalesPerson {
	name: string;
	sales_person_name?: string;
}

export interface LoyaltyProgramTier {
	tier_name: string;
	min_spent: number;
	collection_factor: number;
}

export interface LoyaltyProgram {
	name: string;
	loyalty_program_name?: string;
	company?: string;
	conversion_factor: number;
	expiry_duration?: number;
	tiers?: LoyaltyProgramTier[];
}

export interface CustomerLoyaltyInfo {
	enrolled: boolean;
	customer: string;
	customer_name: string;
	loyalty_program?: string | null;
	loyalty_program_name?: string;
	conversion_factor?: number;
	loyalty_points?: number;
	points_value?: number;
	current_tier?: string | null;
	tiers?: LoyaltyProgramTier[];
	expiry_duration?: number;
}

export interface InvoiceItem {
	item_code: string;
	item_name: string;
	local_item_name?: string;
	qty: number;
	rate: number;
	price_list_rate?: number;
	amount?: number;
	uom?: string;
	discount_percentage?: number;
	discount_amount?: number;
	serial_no?: string;
	batch_no?: string;
	item_tax_template?: string;
	additional_notes?: string;
	delivery_date?: string;
	offers?: string;
	row_id?: string;
	offer_applied?: boolean;
	is_offer?: boolean;
	is_replace?: boolean;
	is_free_item?: number;
	pricing_rules?: string;
}

export interface InvoicePayment {
	mode_of_payment: string;
	amount: number;
	base_amount?: number;
	account?: string;
	type?: string;
	pos_tender_currency?: string;
	pos_tender_amount?: number;
	pos_exchange_rate?: number;
}

export interface TenderLeg {
	id: string;
	mode_of_payment: string;
	currency: string;
	native_amount: number;
	exchange_rate: number;
	base_amount: number;
}

export interface InvoiceChangeLeg {
	mode_of_payment: string;
	currency: string;
	amount: number;
	base_amount: number;
	exchange_rate: number;
}

export interface InvoiceData {
	name?: string;
	modified?: string;
	doctype?: string;
	pos_profile: string;
	customer: string;
	items: InvoiceItem[];
	posting_date?: string;
	additional_discount_percentage?: number;
	discount_amount?: number;
	apply_discount_on?: string;
	payments?: InvoicePayment[];
	pos_notes?: string;
	pos_delivery_date?: string;
	pos_opening_shift?: string;
	offers?: string;
	coupons?: string;
	offers_detail?: Array<Record<string, unknown>>;
	coupons_detail?: Array<Record<string, unknown>>;
	loyalty_points?: number;
	loyalty_amount?: number;
	redeem_loyalty_points?: boolean;
	sales_person?: string;
	is_return?: boolean;
	return_against?: string;
	write_off_amount?: number;
	write_off_account?: string;
	change_amount?: number;
	pos_change_legs?: InvoiceChangeLeg[];
	currency?: string;
	conversion_rate?: number;
	is_credit_sale?: boolean;
	pos_awaiting_settlement?: boolean;
	pos_delivery_charges?: string;
	pos_delivery_charges_rate?: number;
}

export interface InvoiceTax {
	description: string;
	rate: number;
	tax_amount: number;
}

export interface Invoice {
	name: string;
	customer: string;
	customer_name: string;
	posting_date: string;
	posting_time?: string;
	grand_total: number;
	net_total: number;
	paid_amount: number;
	outstanding_amount: number;
	status: string;
	docstatus: number;
	items: InvoiceItem[];
	payments: InvoicePayment[];
	taxes?: InvoiceTax[];
	is_return?: boolean;
	return_against?: string;
	loyalty_points?: number;
	loyalty_amount?: number;
	total_taxes_and_charges?: number;
	change_amount?: number;
	discount_amount?: number;
	additional_discount_percentage?: number;
	base_discount_amount?: number;
	total_qty?: number;
	total?: number;
	sales_partner?: string;
	commission_rate?: number;
	total_commission?: number;
	loyalty_program?: string;
	redeem_loyalty_points?: number;
	loyalty_redemption_account?: string;
	owner?: string;
	pos_profile?: string;
	coupon_code?: string;
	remarks?: string;
	currency?: string;
	[key: string]: unknown;
}

export interface ReturnInvoice {
	name: string;
	customer: string;
	customer_name: string;
	posting_date: string;
	grand_total: number;
	items: InvoiceItem[];
	[key: string]: unknown;
}

export interface POSOffer {
	name: string;
	title: string;
	offer_type: string;
	apply_on: string;
	disabled: boolean;
	items?: POSOfferDetail[];
	[key: string]: unknown;
}

export interface POSOfferDetail {
	item_code: string;
	qty: number;
	rate?: number;
	[key: string]: unknown;
}

export interface POSCoupon {
	name: string;
	coupon_name: string;
	coupon_type: string;
	coupon_code?: string;
	pricing_rule?: string;
	valid_from?: string;
	valid_upto?: string;
	[key: string]: unknown;
}

export interface GiftCoupon {
	name: string;
	coupon_code: string;
	amount: number;
	balance_amount: number;
	[key: string]: unknown;
}

export interface POSCashMovement {
	name: string;
	pos_profile: string;
	company: string;
	user: string;
	movement_type: string;
	amount: number;
	posting_date: string;
	status: string;
	remarks?: string;
	expense_account?: string;
	target_account?: string;
	source_account?: string;
	[key: string]: unknown;
}

export interface CashMovementContext {
	expense_accounts: Record<string, any>[];
	deposit_accounts: Record<string, any>[];
	source_accounts: Record<string, any>[];
	cash_account: string;
	cost_center: string;
	mode_of_payment: string;
	enable_cash_movement?: boolean;
	allow_pos_expense?: boolean;
	allow_cash_deposit?: boolean;
}

export interface DeliveryCharge {
	name: string;
	label: string;
	default_rate: number;
	rate: number;
	shipping_account?: string;
	cost_center?: string;
	[key: string]: unknown;
}

export interface ReferralCode {
	name: string;
	referral_name: string;
	customer: string;
	[key: string]: unknown;
}

export interface OutstandingInvoice {
	name: string;
	grand_total: number;
	outstanding_amount: number;
	posting_date: string;
	customer: string;
	customer_name?: string;
	paid_amount?: number;
	currency?: string;
	status?: string;
}

export interface OpenTab {
	name: string;
	customer: string;
	customer_name?: string;
	posting_date?: string;
	grand_total?: number;
	total_qty?: number;
	currency?: string;
	creation?: string;
	modified?: string;
	pos_opening_shift?: string;
	owner?: string;
	paid_amount?: number;
	pos_awaiting_settlement?: boolean | number;
}

export interface PaymentRequest {
	name: string;
	status: string;
	[key: string]: unknown;
}

export interface PricingRule {
	name: string;
	title?: string;
	apply_on: string;
	applicable_for?: string;
	price_or_product_discount: string;
	rate_or_discount?: string;
	discount_percentage?: number;
	discount_amount?: number;
	rate?: number;
	items?: { item_code: string }[];
	[key: string]: unknown;
}

export interface SalesOrder {
	name: string;
	customer: string;
	customer_name: string;
	transaction_date: string;
	grand_total: number;
	status: string;
	items: SalesOrderItem[];
	[key: string]: unknown;
}

export interface SalesOrderItem {
	item_code: string;
	item_name: string;
	qty: number;
	rate: number;
	amount: number;
	uom?: string;
	[key: string]: unknown;
}

export interface Quotation {
	name: string;
	party_name: string;
	transaction_date: string;
	grand_total: number;
	status: string;
	items: SalesOrderItem[];
	[key: string]: unknown;
}

export interface PrintFormat {
	name: string;
	doc_type?: string;
	standard?: string;
	[key: string]: unknown;
}

export interface BundleComponent {
	item_code: string;
	item_name?: string;
	qty: number;
	rate?: number;
	uom?: string;
	description?: string;
}

export interface TaxDetail {
	description: string;
	charge_type: string;
	rate: number;
	account_head: string;
	included_in_print_rate: number;
}

export interface PrintSettings {
	print_format: string;
	print_format_for_online?: string;
	allow_print_before_pay: number;
	auto_print_receipt: number;
	letter_head: string;
}

export interface ReceiptContext {
	company_name: string;
	company_phone: string;
	company_email: string;
	company_website: string;
	company_address: string;
	company_tax_id: string;
	company_logo: string;
	receipt_header: string;
	receipt_footer: string;
	currency: string;
	print_discount_amount: number;
	print_format: string;
	css: string;
}

export interface ReceiptSnapshotItem {
	item_code: string;
	item_name: string;
	qty: number;
	rate: number;
	amount: number;
	uom?: string;
	discount_percentage?: number;
	discount_amount?: number;
	price_list_rate?: number;
	serial_no?: string;
	batch_no?: string;
	pos_notes?: string;
}

export interface ReceiptSnapshotTax {
	description: string;
	rate: number;
	amount: number;
	included_in_print_rate: boolean;
}

export interface ReceiptSnapshotPayment {
	mode_of_payment: string;
	amount: number;
	currency?: string;
	native_amount?: number;
	exchange_rate?: number;
	rate_date?: string;
}

export interface ReceiptSnapshot {
	name: string;
	posting_date: string;
	posting_time: string;
	is_return: boolean;
	cashier: string;
	customer_name: string;
	items: ReceiptSnapshotItem[];
	taxes: ReceiptSnapshotTax[];
	payments: ReceiptSnapshotPayment[];
	subtotal: number;
	total_discount: number;
	net_total: number;
	grand_total: number;
	total_qty: number;
	change: number;
	change_legs?: InvoiceChangeLeg[];
	currency?: string;
	notes?: string;
}

export interface ShiftCheckResult {
	pos_opening_shift: POSOpeningShift;
	pos_profile: POSProfile;
	company: Company;
	stock_settings?: StockSettings;
	taxes?: TaxDetail[];
	tax_inclusive?: number;
	print_settings?: PrintSettings;
	disable_rounded_total?: number;
	is_cashier?: boolean;
}

export interface OpeningData {
	pos_profiles: POSProfile[];
	companies: Company[];
	payment_methods: POSPaymentMethod[];
}

export interface ShiftModeTotal {
	amount: number;
	currency: string;
}

export interface ShiftSummary {
	net_total: number;
	grand_total: number;
	total_invoices: number;
	returns_count: number;
	payment_summary: Record<string, ShiftModeTotal>;
	opening_balances: Record<string, ShiftModeTotal>;
	expected_amounts: Record<string, ShiftModeTotal>;
	tax_summary: POSClosingShiftTax[];
	pos_profile: string;
	company: string;
	invoices: {
		name: string;
		customer: string;
		customer_name: string;
		grand_total: number;
		is_return: boolean;
	}[];
}

export type CurrencyCode =
	| "USD"
	| "EUR"
	| "GBP"
	| "JPY"
	| "INR"
	| "PKR"
	| "AED"
	| "SAR"
	| "CNY"
	| "KRW"
	| "BDT"
	| "LKR"
	| "NPR"
	| "CAD"
	| "AUD"
	| string;

export type CurrencySymbolMap = Record<CurrencyCode, string>;

export interface FrappeCallResponse<T = unknown> {
	message: T;
}

export interface UserSession {
	user: string;
	user_email?: string;
	user_fullname?: string;
	image?: string;
}

export interface CalculatedTax {
	description: string;
	rate: number;
	amount: number;
	included_in_print_rate: boolean;
}

export interface Supplier {
	name: string;
	supplier_name: string;
	supplier_group?: string;
	supplier_type?: string;
	default_currency?: string;
	mobile_no?: string;
	email_id?: string;
	tax_id?: string;
	disabled?: boolean;
	[key: string]: unknown;
}

export interface PurchaseItem {
	item_code: string;
	item_name: string;
	qty: number;
	rate: number;
	schdn?: number;
	amount?: number;
	uom?: string;
	stock_uom?: string;
	taxes?: Record<string, number>;
	conversion_factor?: number;
	warehouse?: string;
	serial_no?: string;
	batch_no?: string;
	schedule_date?: string;
	received_qty?: number;
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
}

export interface PurchaseOrder {
	name: string;
	supplier: string;
	supplier_name?: string;
	company: string;
	transaction_date: string;
	schedule_date?: string;
	grand_total: number;
	status: string;
	docstatus: number;
	currency?: string;
	items: PurchaseItem[];
	per_received?: number;
	per_billed?: number;
	[key: string]: unknown;
}

export interface PurchaseReceipt {
	name: string;
	supplier: string;
	supplier_name?: string;
	company: string;
	posting_date: string;
	grand_total: number;
	status: string;
	docstatus: number;
	currency?: string;
	items: PurchaseItem[];
	purchase_order?: string;
	[key: string]: unknown;
}

export interface PurchaseInvoice {
	name: string;
	supplier: string;
	supplier_name?: string;
	company: string;
	posting_date: string;
	bill_no?: string;
	remarks?: string;
	grand_total: number;
	outstanding_amount: number;
	status: string;
	docstatus: number;
	currency?: string;
	items: PurchaseItem[];
	purchase_order?: string;
	purchase_receipt?: string;
	is_paid?: boolean;
	[key: string]: unknown;
}

export interface PurchaseOrderData {
	pos_profile?: string;
	supplier: string;
	company?: string;
	warehouse?: string;
	transaction_date?: string;
	schedule_date?: string;
	items: PurchaseItem[];
	receive?: boolean;
	create_invoice?: boolean;
	payments?: { mode_of_payment: string; amount: number }[];
	submit?: boolean;
	custom_alias_name?: string;
	custom_po_category?: string;
	custom_po_type?: string;
	custom_po_department?: string;
	custom_po_remarks?: string;
	custom_zero_qty?: string;
}

export interface PurchaseOrderResult {
	purchase_order?: string;
	purchase_receipt?: string;
	purchase_invoice?: string;
}

export interface ItemUOMDetail {
	uom: string;
	conversion_factor: number;
}

export interface SearchItem {
	item_code: string;
	item_name: string;
	local_item_name?: string;
	stock_uom: string;
	item_uoms?: ItemUOMDetail[];
	standard_rate?: number;
	selling_price?: number;
	buying_price?: number;
	barcode?: string;
	item_group?: string;
	custom_item_packing?: string;
	custom_pack_units?: number;
	custom_generic_item?: string;
	custom_class?: string;
}

export interface NewItemData {
	item_code?: string;
	item_name: string;
	item_group?: string;
	stock_uom: string;
	barcode?: string;
	selling_price?: number;
	buying_price?: number;
	pos_profile?: string;
}

export interface PendingReceiptItem {
	po_detail: string;
	item_code: string;
	item_name: string;
	qty: number;
	received_qty: number;
	pending_qty: number;
	rate: number;
	uom: string;
	stock_uom: string;
	conversion_factor: number;
	warehouse: string;
}

export interface PendingReceiptOrder {
	name: string;
	supplier: string;
	supplier_name: string;
	company: string;
	transaction_date: string;
	grand_total: number;
	status: string;
	per_received: number;
	per_billed: number;
	items: PendingReceiptItem[];
}

export interface ReceiveStockItem {
	po_detail: string;
	item_code: string;
	accept_qty: number;
	reject_qty: number;
	warehouse?: string;
	rejected_warehouse?: string;
}

export interface ReceiveStockResult {
	purchase_receipt: string;
	purchase_order: string;
	status: string;
	has_rejections: boolean;
	items_received: number;
}

export interface InTransitItem {
	ste_detail: string;
	parent: string;
	item_code: string;
	item_name: string;
	qty: number;
	received_qty: number;
	pending_qty: number;
	uom: string;
	stock_uom: string;
	conversion_factor: number;
	basic_rate: number;
	valuation_rate: number;
	s_warehouse: string;
	t_warehouse: string;
}

export interface InTransitEntry {
	name: string;
	company: string;
	posting_date: string;
	from_warehouse: string;
	to_warehouse: string;
	total_amount: number;
	per_transferred: number;
	remarks: string;
	source_warehouse: string;
	transit_warehouse: string;
	total_pending_items: number;
	items: InTransitItem[];
}

export interface ReceiveTransitItem {
	ste_detail: string;
	item_code: string;
	receive_qty: number;
}

export interface ReceiveTransitResult {
	stock_entry: string;
	outgoing_stock_entry: string;
	status: string;
	items_received: number;
	total_received_qty: number;
	total_shortage_qty: number;
	has_shortage: boolean;
}

export interface ReturnShortageItem {
	ste_detail: string;
	item_code: string;
	return_qty: number;
	reason?: string;
}

export interface ReturnShortageResult {
	stock_entry: string;
	outgoing_stock_entry: string;
	status: string;
	items_returned: number;
	total_returned_qty: number;
}

export interface SellingSettings {
	selling_price_list: string;
	default_selling_price_list: string;
	customer_group: string;
	territory: string;
	campaign: string;
	allow_multiple_items: number;
	allow_against_multiple_purchase_orders: number;
	validate_selling_price: number;
	editable_bundle_item_rates: number;
	hide_tax_id: number;
	so_required: string;
	dn_required: string;
	allow_sales_order_creation_for_expired_quotation: number;
	default_valid_till: string;
	[key: string]: unknown;
}

export interface BuyingSettings {
	buying_price_list: string;
	default_buying_price_list: string;
	supplier_group: string;
	supp_master_name: string;
	maintain_same_rate: number;
	allow_multiple_items: number;
	po_required: string;
	pr_required: string;
	[key: string]: unknown;
}

export interface ERPStockSettings {
	allow_negative_stock: number;
	valuation_method: string;
	show_barcode_field: number;
	auto_insert_price_list_rate_if_missing: number;
	automatically_set_serial_nos_based_on_fifo: number;
	default_warehouse: string;
	stock_uom: string;
	over_delivery_receipt_allowance: number;
	item_naming_by: string;
	[key: string]: unknown;
}

export interface AccountsSettings {
	allow_stale: number;
	stale_days: number;
	make_payment_via_journal_entry: number;
	over_billing_allowance: number;
	credit_controller: string;
	add_taxes_from_item_tax_template: number;
	automatically_fetch_payment_terms: number;
	enable_discount_accounting: number;
	unlink_payment_on_cancellation_of_invoice: number;
	book_asset_depreciation_entry_automatically: number;
	[key: string]: unknown;
}

export interface GlobalDefaults {
	default_currency: string;
	default_company: string;
	country: string;
	language: string;
	disable_rounded_total: number;
	disable_in_words: number;
	[key: string]: unknown;
}

export interface CurrencyPrecision {
	currency_precision: string;
	float_precision: string;
	[key: string]: unknown;
}

export interface NumberFormatSettings {
	number_format: string;
	float_precision: number | string;
	currency_precision: number | string;
	use_number_format_from_currency: number | boolean;
	hide_currency_symbol: number | boolean | string;
	[key: string]: unknown;
}

export interface ERPSettings {
	selling_settings: SellingSettings;
	buying_settings: BuyingSettings;
	stock_settings: ERPStockSettings;
	accounts_settings: AccountsSettings;
	pos_settings: POSSettings;
	item_search: ItemSearchSettings;
	global_defaults: GlobalDefaults;
	currency_precision: CurrencyPrecision;
	number_format: NumberFormatSettings;
}

export const DOCSTATUS_MAP: Record<number, string> = {
	0: "Draft",
	1: "Submitted",
	2: "Cancelled",
};
