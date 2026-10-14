/**
 * Canonical POS fixtures for E2E runs.
 *
 * Shapes mirror what the real endpoints return (xpos/api/shifts.py,
 * xpos/api/items.py, xpos/api/customers.py) so a spec that passes here is
 * exercising the same data the app sees in production.
 */

export const COMPANY = "Test Co";
export const POS_PROFILE = "Main";
export const PRICE_LIST = "Standard Selling";
export const WAREHOUSE = "Stores - TC";
export const CURRENCY = "USD";

export const ITEM_A = {
	item_code: "ITEM-A",
	item_name: "Espresso Beans",
	item_group: "Beverages",
	brand: "Acme",
	stock_uom: "Nos",
	uom: "Nos",
	rate: 100,
	actual_qty: 500,
	is_stock_item: 1,
	has_batch_no: 0,
	has_serial_no: 0,
	has_variants: 0,
	max_discount: 0,
	image: "",
};

export const ITEM_B = {
	...ITEM_A,
	item_code: "ITEM-B",
	item_name: "Filter Papers",
	item_group: "Supplies",
	brand: "Acme",
	rate: 40,
};

export const ITEM_GIFT = {
	...ITEM_A,
	item_code: "ITEM-GIFT",
	item_name: "Branded Mug",
	item_group: "Merch",
	rate: 25,
};

export const ITEMS = [ITEM_A, ITEM_B, ITEM_GIFT];

/** Belongs to the group a pricing rule in these specs is scoped to. */
export const CUSTOMER_IN_GROUP = {
	name: "CUST-001",
	customer_name: "Ada Lovelace",
	customer_group: "Retail",
	territory: "All Territories",
	mobile_no: "1234567890",
	email_id: "ada@example.com",
	default_currency: CURRENCY,
	image: "",
};

export const CUSTOMER_OUT_OF_GROUP = {
	...CUSTOMER_IN_GROUP,
	name: "CUST-002",
	customer_name: "Grace Hopper",
	customer_group: "Wholesale",
	email_id: "grace@example.com",
};

export const CUSTOMERS = [CUSTOMER_IN_GROUP, CUSTOMER_OUT_OF_GROUP];

export const POS_PROFILE_DOC = {
	name: POS_PROFILE,
	company: COMPANY,
	warehouse: WAREHOUSE,
	currency: CURRENCY,
	selling_price_list: PRICE_LIST,
	customer: CUSTOMER_IN_GROUP.name,
	payments: [{ mode_of_payment: "Cash", default: 1 }],
	use_offline_mode: 1,
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
		name: "POS-OS-0001",
		pos_profile: POS_PROFILE,
		company: COMPANY,
		status: "Open",
		user: "cashier@example.com",
		period_start_date: "2026-08-10 09:00:00",
		posting_date: "2026-08-10",
		balance_details: [{ mode_of_payment: "Cash", opening_amount: 0 }],
	},
	pos_profile: POS_PROFILE_DOC,
	company: { name: COMPANY, default_currency: CURRENCY, company_name: COMPANY },
	is_cashier: true,
	stock_settings: { allow_negative_stock: true },
	disable_rounded_total: 1,
	taxes: [],
	tax_inclusive: 0,
	print_settings: { print_format: "POS Invoice" },
};

/** Everything the cashier needs for these specs to be meaningful. */
export const PERMISSIONS = {
	close_shift: true,
	allow_reprint_invoice: true,
	print_draft_invoice: true,
	shift_report: true,
	apply_additional_discount: true,
	show_edit_discount_field: true,
	allow_change_price: true,
	sale_return: true,
	recall_other_shift_tabs: true,
	settle_outstanding_invoice: true,
	expense: true,
	bank_drop: true,
	current_stock_by_brand: true,
	current_stock_report: true,
};

export const CURRENT_SHIFT = OPEN_SHIFT.pos_opening_shift.name;
export const OTHER_SHIFT = "POS-OS-0002";

export const OWN_TAB = {
	name: "ACC-SINV-2026-0001",
	customer: CUSTOMER_IN_GROUP.name,
	customer_name: CUSTOMER_IN_GROUP.customer_name,
	posting_date: "2026-08-10",
	grand_total: 100,
	total_qty: 1,
	currency: CURRENCY,
	creation: "2026-08-10 10:15:00",
	modified: "2026-08-10 10:15:00",
	pos_opening_shift: CURRENT_SHIFT,
	owner: "cashier@example.com",
	paid_amount: 0,
	pos_awaiting_settlement: 0,
};

export const FOREIGN_TAB = {
	name: "ACC-SINV-2026-0002",
	customer: CUSTOMER_OUT_OF_GROUP.name,
	customer_name: CUSTOMER_OUT_OF_GROUP.customer_name,
	posting_date: "2026-08-10",
	grand_total: 140,
	total_qty: 2,
	currency: CURRENCY,
	creation: "2026-08-09 21:40:00",
	modified: "2026-08-09 21:40:00",
	pos_opening_shift: OTHER_SHIFT,
	owner: "bartender@example.com",
	paid_amount: 40,
	pos_awaiting_settlement: 0,
};

export const TAB_DETAILS: Record<string, Record<string, unknown>> = {
	[OWN_TAB.name]: {
		...OWN_TAB,
		items: [{ ...ITEM_A, qty: 1, rate: ITEM_A.rate, price_list_rate: ITEM_A.rate }],
	},
	[FOREIGN_TAB.name]: {
		...FOREIGN_TAB,
		items: [
			{ ...ITEM_B, qty: 2, rate: ITEM_B.rate, price_list_rate: ITEM_B.rate },
			{ ...ITEM_GIFT, qty: 1, rate: ITEM_GIFT.rate, price_list_rate: ITEM_GIFT.rate },
		],
	},
};

export const UNPAID_FULL = {
	name: "ACC-SINV-2026-0100",
	customer: CUSTOMER_IN_GROUP.name,
	customer_name: CUSTOMER_IN_GROUP.customer_name,
	posting_date: "2026-08-01",
	grand_total: 300,
	paid_amount: 0,
	outstanding_amount: 300,
	currency: CURRENCY,
	status: "Unpaid",
};

export const UNPAID_PARTIAL = {
	name: "ACC-SINV-2026-0101",
	customer: CUSTOMER_OUT_OF_GROUP.name,
	customer_name: CUSTOMER_OUT_OF_GROUP.customer_name,
	posting_date: "2026-08-05",
	grand_total: 500,
	paid_amount: 200,
	outstanding_amount: 300,
	currency: CURRENCY,
	status: "Partly Paid",
};

export const OUTSTANDING_INVOICES = [UNPAID_FULL, UNPAID_PARTIAL];

export const ITEM_GROUPS = [
	{ name: "All Item Groups", parent_item_group: "", is_group: 1 },
	{ name: "Beverages", parent_item_group: "All Item Groups", is_group: 0 },
	{ name: "Supplies", parent_item_group: "All Item Groups", is_group: 0 },
	{ name: "Merch", parent_item_group: "All Item Groups", is_group: 0 },
];

/**
 * The default route table: enough for the app to boot to a usable POS screen.
 * Specs override the pricing endpoints on top of this.
 */
export function defaultRoutes(): Record<string, unknown> {
	return {
		"frappe.auth.get_logged_user": "cashier@example.com",
		"xpos.api.auth.get_my_pos_permissions": PERMISSIONS,
		"xpos.api.shifts.check_open_shift": OPEN_SHIFT,
		"xpos.api.settings.get_erp_settings": {
			pos_settings: {
				invoice_type: "Sales Invoice",
				post_change_gl_entries: 0,
			},
			item_search: {
				fields: ["name", "item_name", "item_code", "local_item_name"],
				item_search_limit: 20,
				search_serial_no: 0,
				search_batch_no: 0,
			},
		},
		"xpos.api.settings.get_xpos_branding": null,
		"xpos.api.print_formats.get_print_formats": [],
		"xpos.api.print_formats.get_receipt_context": null,
		"xpos.api.items.get_pos_items": ITEMS,
		"xpos.api.items.get_items_count": ITEMS.length,
		"xpos.api.items.get_item_groups": ITEM_GROUPS,
		"xpos.api.items.get_stock_availability": ITEMS.map((i) => ({
			item_code: i.item_code,
			actual_qty: i.actual_qty,
		})),
		"xpos.api.items.get_item_detail": (args: Record<string, unknown>) => {
			const item = ITEMS.find((i) => i.item_code === args.item_code) || ITEM_A;
			return {
				...item,
				uoms: [{ uom: item.stock_uom, conversion_factor: 1 }],
				batches: [],
				serial_numbers: [],
			};
		},
		"xpos.api.customers.get_customers": CUSTOMERS,
		"xpos.api.customers.get_customer_info": (args: Record<string, unknown>) =>
			CUSTOMERS.find((c) => c.name === args.customer) || CUSTOMER_IN_GROUP,
		"xpos.api.customers.get_customer_groups": ["Retail", "Wholesale"],
		"xpos.api.taxes.get_item_tax_template": { item_tax_template: null, item_tax_map: {} },
		"xpos.api.offers.get_offers": [],
		"xpos.api.offers.get_applicable_delivery_charges": [],
		"xpos.api.invoices.get_draft_invoices": (args: Record<string, unknown>) =>
			args.scope === "profile" ? [OWN_TAB, FOREIGN_TAB] : [OWN_TAB],
		"xpos.api.invoices.get_invoice_details": (args: Record<string, unknown>) =>
			TAB_DETAILS[String(args.invoice_name)] || null,
		"xpos.api.invoices.delete_draft_invoice": { success: true },
		"xpos.api.payments.get_outstanding_invoices": (args: Record<string, unknown>) => {
			const term = String(args.search_term || "")
				.trim()
				.toLowerCase();
			if (!term) return OUTSTANDING_INVOICES;
			return OUTSTANDING_INVOICES.filter((invoice) =>
				[invoice.name, invoice.customer, invoice.customer_name].some((field) =>
					String(field).toLowerCase().includes(term),
				),
			);
		},
		"xpos.api.payments.settle_outstanding_invoice": (args: Record<string, unknown>) => ({
			payment_entry: "ACC-PAY-2026-0001",
			allocated_amount: args.amount,
			outstanding_after: 0,
		}),
		// Pricing: no rules by default. Specs replace these.
		"xpos.api.pricing_rules.get_active_pricing_rules": [],
		"xpos.api.pricing_rules.reconcile_line_prices": noPricingChange,
	};
}

/** A reconcile response that leaves every line at its list price. */
export function noPricingChange(args: Record<string, unknown>): unknown {
	const payload = JSON.parse(String(args.cart_payload || "{}"));
	return {
		updates: (payload.lines || []).map((l: Record<string, unknown>) => ({
			row_id: l.row_id,
			item_code: l.item_code,
			price_list_rate: l.rate,
			rate: l.rate,
			discount_percentage: 0,
			discount_amount: 0,
			margin_type: null,
			margin_rate_or_amount: 0,
			pricing_rules: [],
		})),
		free_lines: [],
		invoice_updates: {
			additional_discount_percentage: 0,
			discount_amount: 0,
			apply_discount_on: "Grand Total",
			from_pricing_rule: false,
		},
	};
}
