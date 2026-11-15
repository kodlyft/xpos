# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""The submitted POS sales a shift report reads, limited to the caller's scope."""

import frappe
from frappe import _

from xpos.api.utilities import get_invoice_type
from xpos.reports import scope


def pos_invoices(filters, fields: list[str]) -> tuple[str, list[dict]]:
	"""(invoice doctype, submitted POS invoices in the filtered window the user may see).

	History reads each sale once from the configured invoice type. In POS Invoice mode that is the
	POS Invoice itself, consolidated or not: its merged Sales Invoice is never read, so closing a
	shift neither drops nor doubles it. Pending-stock and open-shift code keeps its own
	``consolidated_invoice`` filter.
	"""
	scope.enforce(filters)
	if not filters.get("company"):
		frappe.throw(_("Company is required"))
	if not (filters.get("from_date") or filters.get("to_date")):
		frappe.throw(_("A date range is required"))
	report_scope = scope.get_scope()
	if filters.get("pos_profile") and not report_scope.allows_profile(filters["pos_profile"]):
		frappe.throw(
			_("You are not permitted to report on POS Profile {0}.").format(filters["pos_profile"]),
			frappe.PermissionError,
		)

	doctype = get_invoice_type()
	conditions = {
		"docstatus": 1,
		"company": filters["company"],
		"posting_date": [
			"between",
			[filters.get("from_date") or filters.get("to_date"), filters.get("to_date")],
		],
	}
	if doctype != "POS Invoice":
		conditions["is_pos"] = 1
	if filters.get("pos_profile"):
		conditions["pos_profile"] = filters["pos_profile"]

	invoices = frappe.get_all(doctype, filters=conditions, fields=["pos_profile", *fields])
	return doctype, [inv for inv in invoices if report_scope.allows_profile(inv["pos_profile"])]


def cashier_of(doctype: str, invoices: list[dict]) -> dict[str, str]:
	"""Invoice name -> the user whose till collected it (the opening shift's user, else the creator).

	``owner`` alone is the waiter for a sale parked for settlement, not the cashier who took payment.
	"""
	shifts = {inv["pos_opening_shift"] for inv in invoices if inv.get("pos_opening_shift")}
	users = {}
	if shifts:
		users = dict(
			frappe.get_all(
				"POS Opening Shift",
				filters={"name": ["in", list(shifts)]},
				fields=["name", "user"],
				as_list=True,
			)
		)
	return {inv["name"]: users.get(inv.get("pos_opening_shift")) or inv["owner"] for inv in invoices}
