from collections import defaultdict

import frappe

from xpos.api.exchange import change_leg_table_exists
from xpos.api.utilities import get_invoice_type
from xpos.x_pos.doctype.pos_closing_shift.closing_processing.invoices import (
	submit_printed_invoices,
)


def ensure_opening_shift_read(pos_opening_shift) -> None:
	"""Desk shift figures: doctype access is not enough, the user must be able to read this shift.

	Document permission includes Company user permissions, so a Sales Manager
	restricted to one company cannot read another company's expected amounts.
	"""
	frappe.has_permission("POS Closing Shift", "read", throw=True)
	frappe.has_permission("POS Opening Shift", "read", doc=pos_opening_shift, throw=True)


INVOICE_FIELDS = (
	"name",
	"posting_date",
	"customer",
	"currency",
	"conversion_rate",
	"grand_total",
	"base_grand_total",
	"net_total",
	"base_net_total",
	"total_qty",
	"change_amount",
	"base_change_amount",
	"outstanding_amount",
	"base_outstanding_amount",
	"is_return",
)


@frappe.whitelist()
def get_cashiers(
	doctype: str,
	txt: str,
	searchfield: str | None,
	start: int = 0,
	page_len: int = 20,
	filters: dict | None = None,
):
	cashiers_list = frappe.get_all("POS Profile User", filters=filters, fields=["user"])
	result = []
	for cashier in cashiers_list:
		user_email = frappe.get_value("User", cashier.user, "email")
		if user_email:
			result.append([cashier.user, f"{cashier.user} ({user_email})"])
	return result


@frappe.whitelist()
def get_pos_invoices(pos_opening_shift: str, doctype: str | None = None):
	"""
	Return the submitted invoices of a shift with their tax, payment and change rows.

	Runs four queries regardless of shift size: one for the invoices, one each for
	the tax rows, the payment rows and the change legs.
	"""
	if not pos_opening_shift:
		return []
	ensure_opening_shift_read(pos_opening_shift)

	if not doctype:
		doctype = get_invoice_type()

	submit_printed_invoices(pos_opening_shift, doctype)

	filters = {"pos_opening_shift": pos_opening_shift, "docstatus": 1}
	if doctype == "POS Invoice":
		filters["consolidated_invoice"] = ["in", ["", None]]

	invoices = frappe.get_all(doctype, filters=filters, fields=available_invoice_fields(doctype))
	if not invoices:
		return []

	names = [invoice.name for invoice in invoices]
	taxes_by_invoice = get_child_rows("Sales Taxes and Charges", doctype, "taxes", names)
	payments_by_invoice = get_child_rows("Sales Invoice Payment", doctype, "payments", names)
	change_legs_by_invoice = (
		get_child_rows("POS Change Leg", doctype, "pos_change_legs", names)
		if change_leg_table_exists()
		else {}
	)

	for invoice in invoices:
		invoice.taxes = taxes_by_invoice.get(invoice.name, [])
		invoice.payments = payments_by_invoice.get(invoice.name, [])
		invoice.pos_change_legs = change_legs_by_invoice.get(invoice.name, [])

	return invoices


def available_invoice_fields(doctype):
	"""Narrow INVOICE_FIELDS to columns this doctype actually has.

	Sales Invoice and POS Invoice do not carry an identical field set (for
	example POS Invoice has no `base_outstanding_amount`), and selecting a
	missing column raises instead of yielding None the way `get_doc` did.
	"""
	meta = frappe.get_meta(doctype)
	return [field for field in INVOICE_FIELDS if field == "name" or meta.has_field(field)]


def get_child_rows(child_doctype, parenttype, parentfield, parents):
	"""Fetch one child table for many parents in a single query, grouped by parent."""
	rows = frappe.get_all(
		child_doctype,
		filters={
			"parent": ["in", parents],
			"parenttype": parenttype,
			"parentfield": parentfield,
		},
		fields=["*"],
		order_by="parent asc, idx asc",
	)

	grouped = defaultdict(list)
	for row in rows:
		grouped[row.parent].append(row)
	return grouped


@frappe.whitelist()
def get_payments_entries(pos_opening_shift: str):
	if not pos_opening_shift:
		return []
	ensure_opening_shift_read(pos_opening_shift)

	return frappe.get_all(
		"Payment Entry",
		filters={
			"docstatus": 1,
			"reference_no": pos_opening_shift,
			"payment_type": ["in", ["Receive", "Pay"]],
		},
		fields=[
			"name",
			"mode_of_payment",
			"paid_amount",
			"base_paid_amount",
			"paid_from_account_currency",
			"paid_to_account_currency",
			"target_exchange_rate",
			"reference_no",
			"posting_date",
			"party",
			"payment_type",
		],
	)
