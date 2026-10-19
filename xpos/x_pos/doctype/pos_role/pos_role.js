// Copyright (c) 2026, Ali Raza and contributors
// For license information, please see license.txt
//
// Renders a grouped checkbox matrix into the `permissions_html` field, bound to
// the `permissions` child table, and hides the raw child grid.

const POS_PERMISSION_GROUPS = [
	{
		title: "Billing & Invoicing",
		items: [
			{ key: "close_bill", label: "Close Bill" },
			{ key: "close_shift", label: "Close Shift" },
			{ key: "allow_reprint_invoice", label: "Reprint Invoice" },
			{ key: "shift_report", label: "Shift Report" },
			{ key: "allow_cancel_invoice", label: "Cancel Invoice" },
			{ key: "unsettled_invoices", label: "Unsettled Invoices" },
		],
	},
	{
		title: "Discounts & Pricing",
		items: [
			{ key: "apply_additional_discount", label: "Apply Additional Discount" },
			{ key: "apply_standard_discount", label: "Apply Standard Discount" },
			{ key: "show_edit_discount_field", label: "Edit Discount Field" },
			{ key: "edit_tax_template", label: "Edit Tax Template" },
			{ key: "allow_change_price", label: "Change Price" },
		],
	},
	{
		title: "Sales Operations",
		items: [
			{ key: "quotation", label: "Quotation" },
			{ key: "sale_return", label: "Sale Return" },
		],
	},
	{
		title: "Purchasing & Stock",
		items: [
			{ key: "local_purchase", label: "Local Purchase" },
			{ key: "purchase_order", label: "Purchase Order" },
			{ key: "purchase_invoice", label: "Purchase Invoice" },
			{ key: "stock_adjustment", label: "Stock Adjustment" },
			{ key: "stock_entry", label: "Stock Entry" },
			{ key: "near_expiry_items", label: "Near Expiry Items" },
		],
	},
	{
		title: "Cash Management",
		items: [
			{ key: "expense", label: "Expense" },
			{ key: "bank_drop", label: "Bank Drop" },
		],
	},
	{
		title: "Lists",
		items: [
			{ key: "list_of_invoices", label: "List of Invoices" },
			{ key: "list_of_cancelled_invoices", label: "List of Cancelled Invoices" },
			{ key: "list_of_errors", label: "List of Errors" },
			{ key: "list_of_purchase_invoices", label: "List of Purchase Invoices" },
			{ key: "list_of_quotations", label: "List of Quotations" },
			{ key: "list_of_stock_entries", label: "List of Stock Entries" },
			{ key: "list_of_local_purchases", label: "List of Local Purchases" },
			{ key: "list_of_stock_adjustments", label: "List of Stock Adjustments" },
			{ key: "list_of_expense", label: "List of Expenses" },
			{ key: "list_of_bank_drops", label: "List of Bank Drops" },
		],
	},
	{
		title: "Reports",
		items: [
			{ key: "invoice_settlement_report", label: "Invoice Settlement Report" },
			{ key: "sales_report_by_time", label: "Sales Report by Time" },
			{ key: "sales_summary_by_hour", label: "Sales Summary by Hour" },
			{ key: "current_stock_by_brand", label: "Current Stock by Brand" },
			{ key: "stock_register", label: "Stock Register" },
			{ key: "current_stock_report", label: "Current Stock Report" },
		],
	},
];

frappe.ui.form.on("POS Role", {
	refresh(frm) {
		frm.set_df_property("permissions", "hidden", 1);
		render_permission_matrix(frm);
	},
});

function get_perm_row(frm, key) {
	return (frm.doc.permissions || []).find((row) => row.permission === key);
}

function set_permission(frm, key, enabled) {
	let row = get_perm_row(frm, key);
	if (!row) {
		row = frm.add_child("permissions", { permission: key, enabled: enabled ? 1 : 0 });
	} else {
		row.enabled = enabled ? 1 : 0;
	}
	frm.dirty();
}

function render_permission_matrix(frm) {
	const wrapper = frm.get_field("permissions_html").$wrapper;
	wrapper.empty();

	const $container = $('<div class="pos-role-permissions"></div>');

	POS_PERMISSION_GROUPS.forEach((group) => {
		const $group = $(`
			<div class="mb-4">
				<div class="text-muted text-uppercase mb-2" style="font-size:11px;letter-spacing:.05em;">
					${frappe.utils.escape_html(__(group.title))}
				</div>
			</div>
		`);

		group.items.forEach((item) => {
			const row = get_perm_row(frm, item.key);
			const checked = row && cint(row.enabled) ? "checked" : "";
			const $item = $(`
				<label class="d-flex align-items-center mb-1" style="gap:8px;cursor:pointer;">
					<input type="checkbox" data-perm="${item.key}" ${checked}
						style="width:14px;height:14px;cursor:pointer;" />
					<span>${frappe.utils.escape_html(__(item.label))}</span>
				</label>
			`);
			$item.find("input").on("change", function () {
				set_permission(frm, item.key, this.checked);
			});
			$group.append($item);
		});

		$container.append($group);
	});

	wrapper.append($container);
}
