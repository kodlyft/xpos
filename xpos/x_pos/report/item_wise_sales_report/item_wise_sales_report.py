# Copyright (c) 2026, Kodlyft and contributors
# For license information, please see license.txt

import json

import frappe
from erpnext.selling.report.item_wise_sales_history.item_wise_sales_history import (
	get_customer_details,
)
from frappe import _
from frappe.desk.reportview import build_match_conditions
from frappe.model.meta import get_field_precision
from frappe.query_builder import DocType
from frappe.query_builder.functions import IfNull, Sum
from frappe.utils import flt, getdate
from frappe.utils.nestedset import get_descendants_of
from frappe.utils.xlsxutils import handle_html

DOCTYPES = ("Sales Invoice", "POS Invoice")

GROUP_BY_FIELDS = {
	"Item": ("item_code", "invoice"),
	"Item Group": ("item_group", "item_code"),
	"Customer": ("customer", "item_code"),
	"Customer Group": ("customer_group", "item_code"),
	"Territory": ("territory", "item_code"),
	"Invoice": ("invoice", "item_code"),
}


def execute(filters=None):
	filters = frappe._dict(frappe.parse_json(filters) if filters else {})
	validate_filters(filters)

	columns = get_columns(filters)
	item_list = get_items(filters)

	if not item_list:
		return columns, [], None, None, get_report_summary([])

	company_currency = frappe.get_cached_value("Company", filters.company, "default_currency")
	itemised_tax, tax_columns = get_itemised_tax(item_list, columns, company_currency)

	rows, data, skip_total_row = build_data(item_list, itemised_tax, tax_columns, company_currency, filters)

	return columns, data, None, None, get_report_summary(rows), skip_total_row


def validate_filters(filters):
	if not filters.company:
		frappe.throw(_("Please select a Company"))

	if not (filters.from_date and filters.to_date):
		frappe.throw(_("Please select From Date and To Date"))

	if getdate(filters.from_date) > getdate(filters.to_date):
		frappe.throw(_("From Date cannot be after To Date"))

	if filters.get("group_by") and filters.group_by not in GROUP_BY_FIELDS:
		frappe.throw(_("Invalid Group By: {0}").format(filters.group_by))


def get_items(filters):
	item_list = []
	for doctype in DOCTYPES:
		item_list.extend(_get_items_for_doctype(doctype, filters))
	return item_list


def _get_items_for_doctype(doctype, filters):
	"""Item-wise rows for one invoice doctype. ``Sales Invoice Item`` and ``POS Invoice Item``
	share the same relevant fields, so the same query shape is reused for both."""
	invoice = DocType(doctype)
	invoice_item = DocType(f"{doctype} Item")
	item = DocType("Item")

	query = (
		frappe.qb.from_(invoice)
		.join(invoice_item)
		.on(invoice.name == invoice_item.parent)
		.left_join(item)
		.on(invoice_item.item_code == item.name)
		.select(
			invoice_item.name,
			invoice_item.parent,
			invoice.posting_date,
			invoice.company,
			invoice.customer,
			invoice.pos_profile,
			IfNull(invoice.territory, "Not Specified").as_("territory"),
			invoice.base_net_total,
			invoice_item.item_code,
			IfNull(invoice_item.item_name, item.item_name).as_("item_name"),
			IfNull(invoice_item.item_group, item.item_group).as_("item_group"),
			invoice_item.description,
			invoice_item.project,
			invoice_item.sales_order,
			invoice_item.warehouse,
			invoice_item.cost_center,
			invoice_item.enable_deferred_revenue,
			invoice_item.deferred_revenue_account,
			invoice_item.income_account,
			invoice_item.stock_qty,
			invoice_item.stock_uom,
			invoice_item.uom,
			invoice_item.qty,
			invoice_item.base_net_rate,
			invoice_item.base_net_amount,
		)
		.where(invoice.docstatus == 1)
		.where(invoice.company == filters.company)
		.where(invoice.posting_date >= filters.from_date)
		.where(invoice.posting_date <= filters.to_date)
	)

	if doctype == "Sales Invoice":
		# consolidated Sales Invoices are already counted through their originating POS Invoices
		query = query.where(invoice.is_consolidated == 0)

	if filters.customer:
		query = query.where(invoice.customer == filters.customer)

	if filters.pos_profile:
		query = query.where(invoice.pos_profile == filters.pos_profile)

	if filters.item_code:
		query = query.where(invoice_item.item_code == filters.item_code)

	if filters.item_group:
		item_groups = [filters.item_group]
		if frappe.db.get_value("Item Group", filters.item_group, "is_group"):
			item_groups = get_descendants_of("Item Group", filters.item_group)
			item_groups.append(filters.item_group)
		query = query.where(invoice_item.item_group.isin(item_groups))

	if filters.warehouse:
		if frappe.db.get_value("Warehouse", filters.warehouse, "is_group"):
			lft, rgt = frappe.db.get_value("Warehouse", filters.warehouse, ["lft", "rgt"])
			warehouses = frappe.db.get_all("Warehouse", {"lft": (">", lft), "rgt": ("<", rgt)}, pluck="name")
			query = query.where(invoice_item.warehouse.isin(warehouses))
		else:
			query = query.where(invoice_item.warehouse == filters.warehouse)

	if filters.brand:
		query = query.where(invoice_item.brand == filters.brand)

	query, params = query.walk()

	match_conditions = build_match_conditions(doctype)
	if match_conditions:
		query += " and " + match_conditions

	rows = frappe.db.sql(query, params, as_dict=True)
	for row in rows:
		row["voucher_type"] = doctype
		row["income_account"] = (
			row["deferred_revenue_account"] if row.get("enable_deferred_revenue") else row["income_account"]
		)

	return rows


def get_itemised_tax(item_list, columns, company_currency):
	"""Per-tax-account rate/amount breakdown, pro-rated across item rows the same way
	``item_wise_sales_register.get_tax_accounts`` does, but pulling ``Sales Taxes and Charges``
	rows for both Sales Invoice and POS Invoice parents in one query."""
	item_row_map = {}
	invoice_item_row = {}
	itemised_tax = {}
	tax_columns = {}
	scrubbed_description_map = {}

	for d in item_list:
		key = (d.voucher_type, d.parent)
		invoice_item_row.setdefault(key, []).append(d)
		item_row_map.setdefault(key, {}).setdefault(d.item_code or d.item_name, []).append(d)

	if not invoice_item_row:
		return itemised_tax, []

	tax_amount_precision = (
		get_field_precision(
			frappe.get_meta("Sales Taxes and Charges").get_field("tax_amount"), currency=company_currency
		)
		or 2
	)

	parents = tuple({parent for _voucher_type, parent in invoice_item_row})

	tax_details = frappe.db.sql(
		"""
		select
			name, parent, parenttype, description, item_wise_tax_detail,
			account_head, charge_type, base_tax_amount_after_discount_amount as tax_amount
		from `tabSales Taxes and Charges`
		where
			parenttype in ('Sales Invoice', 'POS Invoice') and docstatus = 1
			and (description is not null and description != '')
			and parent in %(parents)s
		order by description
		""",
		{"parents": parents},
		as_dict=True,
	)

	account_doctype = DocType("Account")
	tax_accounts = {
		row[0]
		for row in frappe.qb.from_(account_doctype)
		.select(account_doctype.name)
		.where(account_doctype.account_type == "Tax")
		.run()
	}

	for tax in tax_details:
		key = (tax.parenttype, tax.parent)
		if key not in invoice_item_row:
			continue

		description = handle_html(tax.description)
		scrubbed_description = scrubbed_description_map.get(description)
		if not scrubbed_description:
			scrubbed_description = frappe.scrub(description)
			scrubbed_description_map[description] = scrubbed_description

		if scrubbed_description not in tax_columns and tax.tax_amount:
			tax_columns[scrubbed_description] = description

		if not tax.item_wise_tax_detail:
			if tax.charge_type == "Actual" and tax.tax_amount:
				for d in invoice_item_row[key]:
					if not d.base_net_total:
						continue
					itemised_tax.setdefault((d.voucher_type, d.name), {})[scrubbed_description] = (
						frappe._dict(
							{
								"tax_rate": "NA",
								"tax_amount": flt(
									(tax.tax_amount * d.base_net_amount) / d.base_net_total,
									tax_amount_precision,
								),
							}
						)
					)
			continue

		try:
			item_wise_tax_detail = json.loads(tax.item_wise_tax_detail)
		except ValueError:
			continue

		for item_code, tax_data in item_wise_tax_detail.items():
			if isinstance(tax_data, list):
				tax_rate, tax_amount = tax_data
			else:
				tax_rate, tax_amount = tax_data, 0

			if tax.charge_type == "Actual" and not tax_rate:
				tax_rate = "NA"

			rows = item_row_map.get(key, {}).get(item_code, [])
			item_net_amount = sum(flt(d.base_net_amount) for d in rows)

			for d in rows:
				item_tax_amount = (
					flt((tax_amount * d.base_net_amount) / item_net_amount) if item_net_amount else 0
				)
				if not item_tax_amount:
					continue

				itemised_tax.setdefault((d.voucher_type, d.name), {})[scrubbed_description] = frappe._dict(
					{
						"tax_rate": tax_rate,
						"tax_amount": flt(item_tax_amount, tax_amount_precision),
						"is_other_charges": 0 if tax.account_head in tax_accounts else 1,
					}
				)

	tax_columns_list = sorted(tax_columns.keys())
	for scrubbed_desc in tax_columns_list:
		desc = tax_columns[scrubbed_desc]
		columns.append(
			{
				"label": _(desc + " Rate"),
				"fieldname": f"{scrubbed_desc}_rate",
				"fieldtype": "Float",
				"width": 100,
			}
		)
		columns.append(
			{
				"label": _(desc + " Amount"),
				"fieldname": f"{scrubbed_desc}_amount",
				"fieldtype": "Currency",
				"options": "currency",
				"width": 100,
			}
		)

	columns += [
		{
			"label": _("Total Tax"),
			"fieldname": "total_tax",
			"fieldtype": "Currency",
			"options": "currency",
			"width": 100,
		},
		{
			"label": _("Total Other Charges"),
			"fieldname": "total_other_charges",
			"fieldtype": "Currency",
			"options": "currency",
			"width": 100,
		},
		{
			"label": _("Total"),
			"fieldname": "total",
			"fieldtype": "Currency",
			"options": "currency",
			"width": 100,
		},
		{"fieldname": "currency", "label": _("Currency"), "fieldtype": "Currency", "width": 80, "hidden": 1},
	]

	return itemised_tax, tax_columns_list


def build_data(item_list, itemised_tax, tax_columns, company_currency, filters):
	default_taxes = {}
	for tax in tax_columns:
		default_taxes[f"{tax}_rate"] = 0
		default_taxes[f"{tax}_amount"] = 0

	customer_details = get_customer_details()
	rows = [
		build_row(d, itemised_tax, tax_columns, default_taxes, customer_details, company_currency)
		for d in item_list
	]

	group_by = filters.get("group_by")
	if not group_by:
		rows.sort(key=lambda r: r.get("posting_date"), reverse=True)
		return rows, rows, 0

	grand_total = get_grand_total(filters)
	for row in rows:
		row["percent_gt"] = flt(row["total"] / grand_total * 100) if grand_total else 0.0

	group_by_field, subtotal_display_field = GROUP_BY_FIELDS[group_by]
	rows.sort(key=lambda r: (str(r.get(group_by_field) or ""), r.get("invoice") or ""))

	data = []
	total_row_map = {}
	prev_group_value = ""
	for row in rows:
		data, prev_group_value = add_total_row(
			data,
			prev_group_value,
			row,
			total_row_map,
			group_by_field,
			subtotal_display_field,
			tax_columns,
			group_by,
		)
		add_sub_total_row(row, total_row_map, row.get(group_by_field, ""), tax_columns)
		data.append(row)

	total_row = total_row_map.get(prev_group_value)
	if total_row:
		total_row["percent_gt"] = flt(total_row["total"] / grand_total * 100) if grand_total else 0.0
		data.append(total_row)
		data.append({})
		add_sub_total_row(total_row, total_row_map, "total_row", tax_columns)
		data.append(total_row_map.get("total_row"))

	return rows, data, 1


def build_row(d, itemised_tax, tax_columns, default_taxes, customer_details, company_currency):
	customer_record = customer_details.get(d.customer)

	row = {
		"item_code": d.item_code,
		"item_name": d.item_name,
		"item_group": d.item_group,
		"description": d.description,
		"voucher_type": d.voucher_type,
		"invoice": d.parent,
		"posting_date": d.posting_date,
		"customer": d.customer,
		"customer_name": customer_record.customer_name if customer_record else d.customer,
		"customer_group": customer_record.customer_group if customer_record else None,
		"pos_profile": d.pos_profile,
		"territory": d.territory,
		"project": d.project,
		"sales_order": d.sales_order,
		"company": d.company,
		"income_account": d.income_account,
		"cost_center": d.cost_center,
		"warehouse": d.warehouse,
		"stock_qty": d.stock_qty,
		"stock_uom": d.stock_uom,
	}

	if d.stock_uom != d.uom and d.stock_qty:
		row["rate"] = (d.base_net_rate * d.qty) / d.stock_qty
	else:
		row["rate"] = d.base_net_rate
	row["amount"] = d.base_net_amount

	row.update(default_taxes.copy())

	total_tax = 0.0
	total_other_charges = 0.0
	for tax in tax_columns:
		item_tax = itemised_tax.get((d.voucher_type, d.name), {}).get(tax, {})
		row[f"{tax}_rate"] = item_tax.get("tax_rate", 0)
		row[f"{tax}_amount"] = item_tax.get("tax_amount", 0)
		if item_tax.get("is_other_charges"):
			total_other_charges += flt(item_tax.get("tax_amount"))
		else:
			total_tax += flt(item_tax.get("tax_amount"))

	row["total_tax"] = total_tax
	row["total_other_charges"] = total_other_charges
	row["total"] = flt(row["amount"]) + total_tax + total_other_charges
	row["currency"] = company_currency

	return row


def get_grand_total(filters):
	total = 0.0
	for doctype in DOCTYPES:
		invoice = DocType(doctype)
		query = (
			frappe.qb.from_(invoice)
			.select(Sum(invoice.base_grand_total))
			.where(invoice.docstatus == 1)
			.where(invoice.company == filters.company)
			.where(invoice.posting_date >= filters.from_date)
			.where(invoice.posting_date <= filters.to_date)
		)
		if doctype == "Sales Invoice":
			query = query.where(invoice.is_consolidated == 0)

		result = query.run()
		if result and result[0][0]:
			total += flt(result[0][0])

	return total


def get_display_value(group_by, group_by_field, row):
	if group_by == "Item":
		if row.get("item_code") != row.get("item_name"):
			return f"{row.get('item_code')}: {row.get('item_name')}"
		return row.get("item_code", "")

	if group_by == "Customer":
		if row.get("customer") != row.get("customer_name"):
			return f"{row.get('customer')}: {row.get('customer_name')}"
		return row.get("customer")

	return row.get(group_by_field)


def add_total_row(
	data, prev_group_value, row, total_row_map, group_by_field, subtotal_display_field, tax_columns, group_by
):
	current_group_value = row.get(group_by_field, "")
	if prev_group_value != current_group_value:
		if prev_group_value:
			prev_total = total_row_map.get(prev_group_value)
			if prev_total:
				data.append(prev_total)
				data.append({})
				add_sub_total_row(prev_total, total_row_map, "total_row", tax_columns)

		total_row_map.setdefault(
			current_group_value,
			{
				subtotal_display_field: get_display_value(group_by, group_by_field, row),
				"stock_qty": 0.0,
				"amount": 0.0,
				"bold": 1,
				"total_tax": 0.0,
				"total": 0.0,
				"percent_gt": 0.0,
			},
		)
		total_row_map.setdefault(
			"total_row",
			{
				subtotal_display_field: _("Total"),
				"stock_qty": 0.0,
				"amount": 0.0,
				"bold": 1,
				"total_tax": 0.0,
				"total": 0.0,
				"percent_gt": 0.0,
			},
		)

	return data, current_group_value


def add_sub_total_row(row, total_row_map, group_by_value, tax_columns):
	total_row = total_row_map.get(group_by_value)
	if not total_row:
		return

	total_row["stock_qty"] = flt(total_row.get("stock_qty", 0)) + flt(row.get("stock_qty"))
	total_row["amount"] = flt(total_row.get("amount", 0)) + flt(row.get("amount"))
	total_row["total_tax"] = flt(total_row.get("total_tax", 0)) + flt(row.get("total_tax"))
	total_row["total"] = flt(total_row.get("total", 0)) + flt(row.get("total"))
	total_row["percent_gt"] = flt(total_row.get("percent_gt", 0)) + flt(row.get("percent_gt"))

	for tax in tax_columns:
		total_row.setdefault(f"{tax}_amount", 0.0)
		total_row[f"{tax}_amount"] += flt(row.get(f"{tax}_amount"))


def get_report_summary(rows):
	qty = sum(flt(r.get("stock_qty")) for r in rows)
	amount = sum(flt(r.get("amount")) for r in rows)
	tax = sum(flt(r.get("total_tax")) for r in rows)
	grand_total = sum(flt(r.get("total")) for r in rows)
	invoices = len({(r.get("voucher_type"), r.get("invoice")) for r in rows})

	return [
		{"label": _("Invoices"), "value": invoices, "indicator": "Blue"},
		{"label": _("Qty Sold"), "value": qty, "datatype": "Float", "indicator": "Blue"},
		{"label": _("Net Sales Amount"), "value": amount, "datatype": "Currency", "indicator": "Green"},
		{"label": _("Tax"), "value": tax, "datatype": "Currency", "indicator": "Grey"},
		{"label": _("Grand Total"), "value": grand_total, "datatype": "Currency", "indicator": "Green"},
	]


def get_columns(filters):
	group_by = filters.get("group_by")
	columns = []

	if group_by != "Item":
		columns += [
			{
				"label": _("Item Code"),
				"fieldname": "item_code",
				"fieldtype": "Link",
				"options": "Item",
				"width": 120,
			},
			{"label": _("Item Name"), "fieldname": "item_name", "fieldtype": "Data", "width": 120},
		]

	if group_by not in ("Item", "Item Group"):
		columns.append(
			{
				"label": _("Item Group"),
				"fieldname": "item_group",
				"fieldtype": "Link",
				"options": "Item Group",
				"width": 120,
			}
		)

	columns += [
		{"label": _("Description"), "fieldname": "description", "fieldtype": "Data", "width": 150},
		{"label": _("Voucher Type"), "fieldname": "voucher_type", "fieldtype": "Data", "width": 110},
		{
			"label": _("Invoice"),
			"fieldname": "invoice",
			"fieldtype": "Dynamic Link",
			"options": "voucher_type",
			"width": 150,
		},
		{"label": _("Posting Date"), "fieldname": "posting_date", "fieldtype": "Date", "width": 100},
		{
			"label": _("POS Profile"),
			"fieldname": "pos_profile",
			"fieldtype": "Link",
			"options": "POS Profile",
			"width": 140,
		},
	]

	if group_by != "Customer":
		columns += [
			{
				"label": _("Customer"),
				"fieldname": "customer",
				"fieldtype": "Link",
				"options": "Customer",
				"width": 120,
			},
			{"label": _("Customer Name"), "fieldname": "customer_name", "fieldtype": "Data", "width": 120},
		]

	if group_by != "Customer Group":
		columns.append(
			{
				"label": _("Customer Group"),
				"fieldname": "customer_group",
				"fieldtype": "Link",
				"options": "Customer Group",
				"width": 120,
			}
		)

	if group_by != "Territory":
		columns.append(
			{
				"label": _("Territory"),
				"fieldname": "territory",
				"fieldtype": "Link",
				"options": "Territory",
				"width": 100,
			}
		)

	columns += [
		{
			"label": _("Sales Order"),
			"fieldname": "sales_order",
			"fieldtype": "Link",
			"options": "Sales Order",
			"width": 100,
		},
		{
			"label": _("Project"),
			"fieldname": "project",
			"fieldtype": "Link",
			"options": "Project",
			"width": 100,
		},
		{
			"label": _("Company"),
			"fieldname": "company",
			"fieldtype": "Link",
			"options": "Company",
			"width": 100,
		},
		{
			"label": _("Income Account"),
			"fieldname": "income_account",
			"fieldtype": "Link",
			"options": "Account",
			"width": 120,
		},
		{
			"label": _("Cost Center"),
			"fieldname": "cost_center",
			"fieldtype": "Link",
			"options": "Cost Center",
			"width": 120,
		},
		{
			"label": _("Warehouse"),
			"fieldname": "warehouse",
			"fieldtype": "Link",
			"options": "Warehouse",
			"width": 120,
		},
		{"label": _("Stock Qty"), "fieldname": "stock_qty", "fieldtype": "Float", "width": 90},
		{
			"label": _("Stock UOM"),
			"fieldname": "stock_uom",
			"fieldtype": "Link",
			"options": "UOM",
			"width": 90,
		},
		{
			"label": _("Rate"),
			"fieldname": "rate",
			"fieldtype": "Currency",
			"options": "currency",
			"width": 100,
		},
		{
			"label": _("Amount"),
			"fieldname": "amount",
			"fieldtype": "Currency",
			"options": "currency",
			"width": 110,
		},
	]

	if group_by:
		columns.append(
			{"label": _("% Of Grand Total"), "fieldname": "percent_gt", "fieldtype": "Float", "width": 100}
		)

	return columns
