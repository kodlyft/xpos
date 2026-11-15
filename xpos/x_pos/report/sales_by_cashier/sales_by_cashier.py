# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.utils import flt

from xpos.reports.sales import cashier_of, pos_invoices


def execute(filters=None):
	filters = frappe._dict(filters or {})
	doctype, invoices = pos_invoices(
		filters, ["name", "owner", "currency", "grand_total", "is_return", "pos_opening_shift"]
	)
	return get_columns(), get_data(invoices, cashier_of(doctype, invoices))


def get_data(invoices, cashier_by_invoice):
	"""Totals per (cashier, currency); the cashier is who held the till, not who created the invoice."""
	cashiers = {}
	for invoice in invoices:
		cashier = cashier_by_invoice[invoice["name"]]
		row = cashiers.setdefault(
			(cashier, invoice["currency"]),
			{
				"cashier": cashier,
				"currency": invoice["currency"],
				"invoices": 0,
				"returns": 0,
				"grand_total": 0,
			},
		)
		row["invoices"] += 1
		row["returns"] += 1 if invoice["is_return"] else 0
		row["grand_total"] += flt(invoice["grand_total"])
	return sorted(cashiers.values(), key=lambda row: (row["currency"], -row["grand_total"]))


def get_columns():
	return [
		{"label": _("Cashier"), "fieldname": "cashier", "fieldtype": "Link", "options": "User", "width": 220},
		{"label": _("Invoices"), "fieldname": "invoices", "fieldtype": "Int", "width": 100},
		{"label": _("Returns"), "fieldname": "returns", "fieldtype": "Int", "width": 100},
		{
			"label": _("Currency"),
			"fieldname": "currency",
			"fieldtype": "Link",
			"options": "Currency",
			"width": 90,
		},
		{
			"label": _("Grand Total"),
			"fieldname": "grand_total",
			"fieldtype": "Currency",
			"options": "currency",
			"width": 140,
		},
	]
