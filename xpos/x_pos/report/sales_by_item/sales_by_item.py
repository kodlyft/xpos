# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.utils import flt

from xpos.reports.sales import pos_invoices


def execute(filters=None):
	filters = frappe._dict(filters or {})
	doctype, invoices = pos_invoices(filters, ["name", "currency"])
	return get_columns(), get_data(doctype, {inv["name"]: inv["currency"] for inv in invoices})


def get_data(doctype, currencies):
	"""Totals per (item, UOM, currency); amounts in different invoice currencies are never added."""
	names = list(currencies)
	if not names:
		return []
	item = frappe.qb.DocType(f"{doctype} Item")
	rows = (
		frappe.qb.from_(item)
		.select(item.parent, item.item_code, item.item_name, item.uom, item.qty, item.amount)
		.where((item.parent.isin(names)) & (item.parenttype == doctype))
		.run(as_dict=True)
	)
	items = {}
	for row in rows:
		currency = currencies[row.parent]
		total = items.setdefault(
			(row.item_code, row.uom, currency),
			{
				"item_code": row.item_code,
				"item_name": row.item_name,
				"uom": row.uom,
				"currency": currency,
				"qty": 0,
				"amount": 0,
			},
		)
		total["qty"] += flt(row.qty)
		total["amount"] += flt(row.amount)
	return sorted(items.values(), key=lambda row: (row["currency"], -row["amount"]))


def get_columns():
	return [
		{
			"label": _("Item Code"),
			"fieldname": "item_code",
			"fieldtype": "Link",
			"options": "Item",
			"width": 160,
		},
		{"label": _("Item Name"), "fieldname": "item_name", "fieldtype": "Data", "width": 240},
		{"label": _("UOM"), "fieldname": "uom", "fieldtype": "Link", "options": "UOM", "width": 90},
		{"label": _("Qty Sold"), "fieldname": "qty", "fieldtype": "Float", "width": 110},
		{
			"label": _("Currency"),
			"fieldname": "currency",
			"fieldtype": "Link",
			"options": "Currency",
			"width": 90,
		},
		{
			"label": _("Amount"),
			"fieldname": "amount",
			"fieldtype": "Currency",
			"options": "currency",
			"width": 130,
		},
	]
