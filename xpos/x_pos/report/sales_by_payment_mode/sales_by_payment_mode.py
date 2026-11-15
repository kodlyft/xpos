# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

from collections import defaultdict

import frappe
from frappe import _
from frappe.utils import flt

from xpos.api.shifts import get_shift_payment_totals, resolve_cash_mode_of_payment
from xpos.reports.policy import ensure_not_blind, requested_profiles
from xpos.reports.sales import pos_invoices


def execute(filters=None):
	filters = frappe._dict(filters or {})
	doctype, invoices = pos_invoices(
		filters, ["name", "currency", "grand_total", "change_amount", "is_return"]
	)
	ensure_not_blind(requested_profiles(filters) | {inv["pos_profile"] for inv in invoices})
	return get_columns(), get_data(doctype, invoices)


def get_data(doctype, invoices):
	by_profile = defaultdict(list)
	for invoice in invoices:
		by_profile[invoice["pos_profile"]].append(invoice)

	totals = {}
	for profile, group in by_profile.items():
		for mode, row in get_shift_payment_totals(
			doctype, group, resolve_cash_mode_of_payment(profile)
		).items():
			total = totals.setdefault((mode, row.get("currency") or ""), 0)
			totals[(mode, row.get("currency") or "")] = total + flt(row.get("amount"))
	return [
		{"mode_of_payment": mode, "currency": currency, "amount": amount}
		for (mode, currency), amount in sorted(totals.items())
	]


def get_columns():
	return [
		{
			"label": _("Mode of Payment"),
			"fieldname": "mode_of_payment",
			"fieldtype": "Link",
			"options": "Mode of Payment",
			"width": 200,
		},
		{"label": _("Currency"), "fieldname": "currency", "fieldtype": "Data", "width": 90},
		{"label": _("Amount"), "fieldname": "amount", "fieldtype": "Float", "width": 140},
	]
