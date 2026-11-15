# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""Per-shift reconciliation (Z-report).

Returns the items sold during a POS shift (qty + amount) as the main table, and
the totals by payment mode (plus headline figures) as the report summary, so a
supervisor can reconcile the till at end of shift.
"""

import frappe
from frappe import _
from frappe.utils import flt

from xpos.api.exchange import get_currency_precision
from xpos.api.shifts import get_shift_payment_totals, resolve_cash_mode_of_payment
from xpos.api.utilities import get_invoice_type
from xpos.reports import scope
from xpos.reports.policy import ensure_not_blind, requested_profiles


def execute(filters=None):
	filters = frappe.parse_json(filters) if filters else {}
	doctype = get_invoice_type()
	invoices = get_invoices(filters, doctype)
	ensure_not_blind(requested_profiles(filters) | {inv["pos_profile"] for inv in invoices})
	return (
		get_columns(),
		get_items_sold(invoices, doctype),
		None,
		None,
		get_report_summary(invoices, doctype, filters),
	)


def get_invoices(filters, doctype):
	scope.enforce(filters)
	report_scope = scope.get_scope()
	check_requested_scope(filters, report_scope)
	conditions = {"docstatus": 1, "is_pos": 1}
	if doctype == "POS Invoice":
		conditions["consolidated_invoice"] = ["in", ["", None]]

	if filters.get("pos_opening_shift"):
		conditions["pos_opening_shift"] = filters["pos_opening_shift"]
	else:
		if filters.get("company"):
			conditions["company"] = filters["company"]
		if filters.get("pos_profile"):
			conditions["pos_profile"] = filters["pos_profile"]
		if filters.get("from_date") and filters.get("to_date"):
			conditions["posting_date"] = ["between", [filters["from_date"], filters["to_date"]]]

	invoices = frappe.get_all(
		doctype,
		filters=conditions,
		fields=["name", "currency", "grand_total", "net_total", "change_amount", "is_return", "pos_profile"],
	)
	if not report_scope.restricted:
		return invoices
	return [inv for inv in invoices if report_scope.allows_profile(inv["pos_profile"])]


def check_requested_scope(filters, report_scope):
	"""A shift or profile named in the filters must belong to the caller's company and warehouses."""
	profile = filters.get("pos_profile")
	if not profile and filters.get("pos_opening_shift"):
		profile = frappe.db.get_value("POS Opening Shift", filters["pos_opening_shift"], "pos_profile")
	if profile and not report_scope.allows_profile(profile):
		frappe.throw(
			_("You are not permitted to report on POS Profile {0}.").format(profile), frappe.PermissionError
		)


def get_items_sold(invoices, doctype):
	"""Items sold per (item, UOM, currency): amounts in different invoice currencies are never added."""
	names = [inv["name"] for inv in invoices]
	if not names:
		return []

	from frappe.query_builder import DocType
	from frappe.query_builder.functions import Round, Sum

	item = DocType(f"{doctype} Item")
	invoice = DocType(doctype)
	return (
		frappe.qb.from_(item)
		.join(invoice)
		.on(invoice.name == item.parent)
		.select(
			item.item_code,
			item.item_name,
			item.uom,
			invoice.currency,
			Round(Sum(item.qty), 3).as_("qty"),
			Round(Sum(item.amount), 2).as_("amount"),
		)
		.where((item.parent.isin(names)) & (item.parenttype == doctype))
		.groupby(item.item_code, item.uom, invoice.currency)
		.orderby(item.item_name, item.uom, invoice.currency)
		.run(as_dict=True)
	)


def resolve_report_cash_mode(filters):
	"""The cash mode the shift's change came out of, for the leg-less legacy fallback."""
	pos_profile = filters.get("pos_profile")
	if not pos_profile and filters.get("pos_opening_shift"):
		pos_profile = frappe.db.get_value("POS Opening Shift", filters["pos_opening_shift"], "pos_profile")
	return resolve_cash_mode_of_payment(pos_profile)


def get_report_summary(invoices, doctype, filters):
	payment_summary = get_shift_payment_totals(doctype, invoices, resolve_report_cash_mode(filters))

	grand_totals = {}
	for inv in invoices:
		currency = inv.get("currency") or ""
		grand_totals[currency] = grand_totals.get(currency, 0) + flt(inv.get("grand_total"))
	returns_count = sum(1 for inv in invoices if inv.get("is_return"))

	summary = [
		{"label": _("Total Invoices"), "value": len(invoices), "indicator": "Blue"},
		{"label": _("Returns"), "value": returns_count, "indicator": "Red" if returns_count else "Grey"},
	]
	for currency, total in sorted(grand_totals.items()):
		summary.append(
			{
				"label": _("Grand Total ({0})").format(currency) if currency else _("Grand Total"),
				"value": flt(total, get_currency_precision(currency)),
				"datatype": "Currency",
				"currency": currency or None,
				"indicator": "Green",
			}
		)
	for mode, row in sorted(payment_summary.items()):
		currency = row.get("currency") or ""
		summary.append(
			{
				"label": f"{mode} ({currency})" if currency else mode,
				"value": flt(row.get("amount"), get_currency_precision(currency)),
				"datatype": "Currency",
				"currency": currency or None,
				"indicator": "Green",
			}
		)
	return summary


def get_columns():
	return [
		{
			"label": _("Item Code"),
			"fieldname": "item_code",
			"fieldtype": "Link",
			"options": "Item",
			"width": 180,
		},
		{
			"label": _("Item Name"),
			"fieldname": "item_name",
			"fieldtype": "Data",
			"width": 260,
		},
		{
			"label": _("UOM"),
			"fieldname": "uom",
			"fieldtype": "Link",
			"options": "UOM",
			"width": 90,
		},
		{
			"label": _("Qty Sold"),
			"fieldname": "qty",
			"fieldtype": "Float",
			"width": 110,
		},
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
			"width": 140,
		},
	]
