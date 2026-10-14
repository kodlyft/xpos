import { CUSTOMER_IN_GROUP, ITEM_GROUPS, PERMISSIONS, defaultRoutes } from "./pos";

export const COMPANY = "Nut Co";
export const POS_PROFILE = "Beirut Store";
export const BASE_CURRENCY = "LBP";
export const TENDER_CURRENCY = "USD";
export const RATE = 90000;
export const RATE_DATE = "2026-08-17";

export const CASH_LBP = "Cash LBP";
export const CASH_USD = "Cash USD";

/** Priced so one unit is the client's own receipt total. */
export const NUT_ITEM = {
	item_code: "NUT-1",
	item_name: "Mixed Nuts",
	item_group: "Beverages",
	brand: "Acme",
	stock_uom: "Kg",
	uom: "Kg",
	rate: 5892300,
	actual_qty: 500,
	is_stock_item: 1,
	has_batch_no: 0,
	has_serial_no: 0,
	has_variants: 0,
	max_discount: 0,
	image: "",
};

export const INVOICE_TOTAL = NUT_ITEM.rate;
/** $100 at 90,000 is 9,000,000 LBP, so 3,107,700 comes back. */
export const CHANGE_DUE = 9000000 - INVOICE_TOTAL;

export const CURRENCIES = [
	{ name: BASE_CURRENCY, symbol: "L£", number_format: "#,###" },
	{ name: TENDER_CURRENCY, symbol: "$", number_format: "#,###.##" },
];

export const PAYMENT_METHODS = [
	{
		mode_of_payment: CASH_LBP,
		default: 1,
		type: "Cash",
		pos_tender_currency: BASE_CURRENCY,
		is_foreign_tender: false,
		exchange_rate: 1,
		rate_date: RATE_DATE,
		precision: 0,
		symbol: "L£",
	},
	{
		mode_of_payment: CASH_USD,
		default: 0,
		type: "Cash",
		pos_tender_currency: TENDER_CURRENCY,
		is_foreign_tender: true,
		exchange_rate: RATE,
		rate_date: RATE_DATE,
		precision: 2,
		symbol: "$",
	},
];

export const POS_PROFILE_DOC = {
	name: POS_PROFILE,
	company: COMPANY,
	warehouse: "Stores - NC",
	currency: BASE_CURRENCY,
	selling_price_list: "Standard Selling",
	customer: CUSTOMER_IN_GROUP.name,
	payments: PAYMENT_METHODS,
	pos_mixed_currency_tender: 1,
	cash_mode_of_payment: CASH_LBP,
	use_offline_mode: 0,
	allow_open_tab_recall: 1,
	allow_outstanding_settlement: 1,
	ignore_pricing_rule: 0,
	allow_change_posting_date: 0,
	display_additional_notes: 0,
	hide_unavailable_items: 0,
	block_sale_beyond_available_qty: 0,
	max_discount_percentage_allowed: 0,
	input_qty: 0,
	auto_fetch_coupons_gifts: 0,
	allow_coupon_entry: 0,
	item_groups: [],
	customer_groups: [],
};

export const OPEN_SHIFT = {
	pos_opening_shift: {
		name: "POS-OS-0009",
		pos_profile: POS_PROFILE,
		company: COMPANY,
		status: "Open",
		user: "cashier@example.com",
		period_start_date: "2026-08-17 09:00:00",
		posting_date: RATE_DATE,
		balance_details: [
			{ mode_of_payment: CASH_LBP, opening_amount: 1000000, currency: BASE_CURRENCY },
			{ mode_of_payment: CASH_USD, opening_amount: 200, currency: TENDER_CURRENCY },
		],
	},
	pos_profile: POS_PROFILE_DOC,
	company: { name: COMPANY, default_currency: BASE_CURRENCY, company_name: COMPANY },
	company_currency: BASE_CURRENCY,
	company_currency_meta: {
		currency: BASE_CURRENCY,
		symbol: "L£",
		precision: 0,
		smallest_fraction: 0,
		symbol_on_right: 0,
	},
	is_cashier: true,
	stock_settings: { allow_negative_stock: true },
	disable_rounded_total: 1,
	taxes: [],
	tax_inclusive: 0,
	print_settings: { print_format: "POS Invoice" },
};

/**
 * The drawer at close, in each mode's own currency.
 *
 * Cash USD: 200 float + 100 taken - 30 given back = 270.
 * Cash LBP: 1,000,000 float - 407,700 given back = 592,300.
 * The two legs reconcile: 70 x 90,000 - 407,700 is exactly the 5,892,300 invoice.
 */
export const SHIFT_SUMMARY = {
	total_invoices: 1,
	grand_total: INVOICE_TOTAL,
	net_total: INVOICE_TOTAL,
	returns_count: 0,
	payment_summary: {
		[CASH_USD]: { amount: 70, currency: TENDER_CURRENCY },
		[CASH_LBP]: { amount: -407700, currency: BASE_CURRENCY },
	},
	opening_balances: {
		[CASH_LBP]: { amount: 1000000, currency: BASE_CURRENCY },
		[CASH_USD]: { amount: 200, currency: TENDER_CURRENCY },
	},
	expected_amounts: {
		[CASH_USD]: { amount: 270, currency: TENDER_CURRENCY },
		[CASH_LBP]: { amount: 592300, currency: BASE_CURRENCY },
	},
	tax_summary: [],
	pos_profile: POS_PROFILE,
	company: COMPANY,
	invoices: [],
};

/** The default table with every LBP/USD master swapped in. */
export function mixedCurrencyRoutes(): Record<string, unknown> {
	return {
		...defaultRoutes(),
		"xpos.api.auth.get_my_pos_permissions": PERMISSIONS,
		"xpos.api.shifts.check_open_shift": OPEN_SHIFT,
		"xpos.api.shifts.get_shift_summary": SHIFT_SUMMARY,
		"xpos.api.shifts.close_shift": { name: "POS-CS-0009", pos_closing_shift: "POS-CS-0009" },
		"xpos.api.exchange.get_tender_rates": {
			company_currency: BASE_CURRENCY,
			posting_date: RATE_DATE,
			modes: PAYMENT_METHODS,
		},
		"xpos.api.items.get_pos_items": [NUT_ITEM],
		"xpos.api.items.get_items_count": 1,
		"xpos.api.items.get_item_groups": ITEM_GROUPS,
		"xpos.api.items.get_stock_availability": [
			{ item_code: NUT_ITEM.item_code, actual_qty: NUT_ITEM.actual_qty },
		],
		"xpos.api.items.get_item_detail": () => ({
			...NUT_ITEM,
			uoms: [{ uom: NUT_ITEM.stock_uom, conversion_factor: 1 }],
			batches: [],
			serial_numbers: [],
		}),
		"xpos.api.invoices.create_invoice": {
			name: "ACC-SINV-2026-0500",
			status: "success",
			change_amount: CHANGE_DUE,
		},
	};
}
