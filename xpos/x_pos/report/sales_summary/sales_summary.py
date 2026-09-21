# Copyright (c) 2026, Kodlyft and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.query_builder import DocType
from frappe.query_builder.functions import Count, Sum
from frappe.utils import flt, getdate

GROUP_BY_FIELDS = {
	"Date": "posting_date",
	"POS Profile": "pos_profile",
	"Cashier": "owner",
	"Customer": "customer",
}


def execute(filters=None):
	filters = frappe._dict(frappe.parse_json(filters) if filters else {})
	validate_filters(filters)
	group_by = filters.group_by or "Date"
	data = get_data(filters, group_by)
	return get_columns(group_by), data, None, None, get_report_summary(data)


def validate_filters(filters):
	if not filters.company:
		frappe.throw(_("Please select a Company"))

	if not (filters.from_date and filters.to_date):
		frappe.throw(_("Please select From Date and To Date"))

	if getdate(filters.from_date) > getdate(filters.to_date):
		frappe.throw(_("From Date cannot be after To Date"))

	if (filters.group_by or "Date") not in GROUP_BY_FIELDS:
		frappe.throw(_("Invalid Group By: {0}").format(filters.group_by))


def get_data(filters, group_by):
	group_field = GROUP_BY_FIELDS[group_by]
	precision = frappe.get_precision("Sales Invoice", "base_net_total")

	groups = {}
	for doctype in ("Sales Invoice", "POS Invoice"):
		for row in _aggregate(doctype, filters, group_field):
			key = row.group_key or ""
			group = groups.setdefault(
				key,
				{
					"group": key,
					"invoices": 0,
					"returns": 0,
					"sales_amount": 0.0,
					"returns_amount": 0.0,
					"tax": 0.0,
					"grand_total": 0.0,
				},
			)

			if row.is_return:
				group["returns"] += row.invoices
				group["returns_amount"] += flt(row.net_total)
			else:
				group["invoices"] += row.invoices
				group["sales_amount"] += flt(row.net_total)

			group["tax"] += flt(row.tax)
			group["grand_total"] += flt(row.grand_total)

	data = list(groups.values())
	for group in data:
		group["net_sales"] = group["sales_amount"] + group["returns_amount"]
		for fieldname in ("sales_amount", "returns_amount", "net_sales", "tax", "grand_total"):
			group[fieldname] = flt(group[fieldname], precision)

	if group_by == "Date":
		data.sort(key=lambda d: d["group"])
	else:
		data.sort(key=lambda d: (-d["net_sales"], d["group"]))

	return data


def _aggregate(doctype, filters, group_field):
	"""Aggregate one invoice doctype by ``group_field`` and return/sale."""
	invoice = DocType(doctype)
	group_column = getattr(invoice, group_field)

	query = (
		frappe.qb.from_(invoice)
		.select(
			group_column.as_("group_key"),
			invoice.is_return,
			Count(invoice.name).as_("invoices"),
			Sum(invoice.base_net_total).as_("net_total"),
			Sum(invoice.base_total_taxes_and_charges).as_("tax"),
			Sum(invoice.base_grand_total).as_("grand_total"),
		)
		.where(invoice.docstatus == 1)
		.where(invoice.company == filters.company)
		.where(invoice.posting_date >= filters.from_date)
		.where(invoice.posting_date <= filters.to_date)
		.groupby(group_column, invoice.is_return)
	)

	if doctype == "Sales Invoice":
		# consolidated Sales Invoices are already counted through their POS Invoices
		query = query.where(invoice.is_consolidated == 0)

	if filters.pos_profile:
		query = query.where(invoice.pos_profile == filters.pos_profile)

	return query.run(as_dict=True)


def get_report_summary(data):
	invoices = sum(d["invoices"] for d in data)
	returns = sum(d["returns"] for d in data)
	net_sales = sum(d["net_sales"] for d in data)
	tax = sum(d["tax"] for d in data)
	grand_total = sum(d["grand_total"] for d in data)

	return [
		{"label": _("Invoices"), "value": invoices, "indicator": "Blue"},
		{"label": _("Returns"), "value": returns, "indicator": "Red" if returns else "Grey"},
		{"label": _("Net Sales"), "value": net_sales, "datatype": "Currency", "indicator": "Green"},
		{"label": _("Tax"), "value": tax, "datatype": "Currency", "indicator": "Grey"},
		{"label": _("Grand Total"), "value": grand_total, "datatype": "Currency", "indicator": "Green"},
	]


def get_columns(group_by):
	group_columns = {
		"Date": {"label": _("Date"), "fieldtype": "Date", "width": 110},
		"POS Profile": {
			"label": _("POS Profile"),
			"fieldtype": "Link",
			"options": "POS Profile",
			"width": 200,
		},
		"Cashier": {"label": _("Cashier"), "fieldtype": "Link", "options": "User", "width": 220},
		"Customer": {"label": _("Customer"), "fieldtype": "Link", "options": "Customer", "width": 220},
	}

	return [
		{"fieldname": "group", **group_columns[group_by]},
		{"label": _("Invoices"), "fieldname": "invoices", "fieldtype": "Int", "width": 90},
		{"label": _("Returns"), "fieldname": "returns", "fieldtype": "Int", "width": 90},
		{"label": _("Sales Amount"), "fieldname": "sales_amount", "fieldtype": "Currency", "width": 140},
		{"label": _("Returns Amount"), "fieldname": "returns_amount", "fieldtype": "Currency", "width": 140},
		{"label": _("Net Sales"), "fieldname": "net_sales", "fieldtype": "Currency", "width": 140},
		{"label": _("Tax"), "fieldname": "tax", "fieldtype": "Currency", "width": 120},
		{"label": _("Grand Total"), "fieldname": "grand_total", "fieldtype": "Currency", "width": 140},
	]
