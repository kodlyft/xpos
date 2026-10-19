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
from xpos.api.profile_rules import is_blind_closing
from xpos.api.shifts import get_shift_payment_totals, resolve_cash_mode_of_payment
from xpos.api.utilities import get_invoice_type


def execute(filters=None):
	filters = frappe.parse_json(filters) if filters else {}
	doctype = get_invoice_type()
	invoices = _get_invoices(filters, doctype)
	ensure_not_blind({inv["pos_profile"] for inv in invoices})
	return (
		get_columns(),
		_get_items_sold(invoices, doctype),
		None,
		None,
		_get_report_summary(invoices, doctype, filters),
	)


def _get_invoices(filters, doctype):
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

	return frappe.get_all(
		doctype,
		filters=conditions,
		fields=["name", "currency", "grand_total", "net_total", "change_amount", "is_return", "pos_profile"],
	)


def ensure_not_blind(pos_profiles):
	"""Per-mode totals reveal the expected drawer, so blind-closing profiles need desk access."""
	if frappe.has_permission("POS Closing Shift", "read"):
		return
	if any(is_blind_closing(p) for p in pos_profiles):
		frappe.throw(_("Shift totals are hidden for blind-closing POS Profiles."), frappe.PermissionError)


def _get_items_sold(invoices, doctype):
	names = [inv["name"] for inv in invoices]
	if not names:
		return []

	from frappe.query_builder import DocType
	from frappe.query_builder.functions import Round, Sum

	item = DocType(f"{doctype} Item")
	return (
		frappe.qb.from_(item)
		.select(
			item.item_code,
			item.item_name,
			item.uom,
			Round(Sum(item.qty), 3).as_("qty"),
			Round(Sum(item.amount), 2).as_("amount"),
		)
		.where((item.parent.isin(names)) & (item.parenttype == doctype))
		.groupby(item.item_code)
		.orderby(item.item_name)
		.run(as_dict=True)
	)


def _resolve_report_cash_mode(filters):
	"""The cash mode the shift's change came out of, for the leg-less legacy fallback."""
	pos_profile = filters.get("pos_profile")
	if not pos_profile and filters.get("pos_opening_shift"):
		pos_profile = frappe.db.get_value("POS Opening Shift", filters["pos_opening_shift"], "pos_profile")
	return resolve_cash_mode_of_payment(pos_profile)


def _get_report_summary(invoices, doctype, filters):
	payment_summary = get_shift_payment_totals(doctype, invoices, _resolve_report_cash_mode(filters))

	grand_total = sum(flt(inv.get("grand_total")) for inv in invoices)
	returns_count = sum(1 for inv in invoices if inv.get("is_return"))

	summary = [
		{"label": _("Total Invoices"), "value": len(invoices), "indicator": "Blue"},
		{"label": _("Returns"), "value": returns_count, "indicator": "Red" if returns_count else "Grey"},
		{
			"label": _("Grand Total"),
			"value": flt(grand_total, 2),
			"datatype": "Currency",
			"indicator": "Green",
		},
	]
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
			"label": _("Amount"),
			"fieldname": "amount",
			"fieldtype": "Currency",
			"width": 140,
		},
	]
