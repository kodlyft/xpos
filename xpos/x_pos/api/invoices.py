# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

import time

import frappe
from erpnext.selling.doctype.sales_order.sales_order import make_sales_invoice
from frappe import _

from xpos.api.invoices import ensure_invoice_doctype, get_pos_invoice
from xpos.x_pos.api.invoice_processing.creation import update_invoice
from xpos.x_pos.api.invoice_processing.utils import get_latest_rate
from xpos.x_pos.api.utils import log_perf_event


@frappe.whitelist()
def get_draft_invoices(pos_opening_shift: str, doctype: str = "Sales Invoice"):
	ensure_invoice_doctype(doctype)
	started_at = time.perf_counter()
	filters = {
		"pos_opening_shift": pos_opening_shift,
		"docstatus": 0,
	}
	if frappe.db.has_column(doctype, "is_printed"):
		filters["is_printed"] = 0

	invoices_list = frappe.get_list(
		doctype,
		filters=filters,
		fields=[
			"name",
			"customer",
			"customer_name",
			"posting_date",
			"posting_time",
			"grand_total",
			"currency",
		],
		limit_page_length=0,
		order_by="modified desc",
	)
	for invoice in invoices_list:
		invoice["doctype"] = doctype
	log_perf_event(
		"get_draft_invoices",
		started_at,
		doctype=doctype,
		rows=len(invoices_list),
	)
	return invoices_list


@frappe.whitelist()
def get_draft_invoice_doc(invoice_name: str, doctype: str = "Sales Invoice"):
	started_at = time.perf_counter()
	doc = get_pos_invoice(doctype, invoice_name)
	log_perf_event(
		"get_draft_invoice_doc",
		started_at,
		doctype=doctype,
		invoice=invoice_name,
		items=len(getattr(doc, "items", []) or []),
	)
	return doc


@frappe.whitelist()
def fetch_exchange_rate_pair(from_currency: str, to_currency: str):
	"""Return exchange rate payload expected by POS multi-currency UI."""

	if not from_currency or not to_currency:
		frappe.throw(_("from_currency and to_currency are required"))

	if from_currency == to_currency:
		from frappe.utils import nowdate

		return {
			"exchange_rate": 1,
			"date": nowdate(),
		}

	exchange_rate, rate_date = get_latest_rate(from_currency, to_currency)
	return {
		"exchange_rate": exchange_rate,
		"date": rate_date,
	}


@frappe.whitelist()
def create_sales_invoice_from_order(sales_order: str):
	"""Backward-compatible facade for legacy frontend method path."""

	if not sales_order:
		frappe.throw(_("sales_order is required"))

	if not frappe.db.exists("Sales Order", sales_order):
		frappe.throw(_("Sales Order {0} does not exist").format(sales_order))

	invoice_doc = make_sales_invoice(sales_order)
	invoice_doc.flags.ignore_permissions = True
	invoice_doc.run_method("set_missing_values")
	invoice_doc.run_method("calculate_taxes_and_totals")
	return invoice_doc


@frappe.whitelist()
def update_invoice_from_order(data: dict):
	"""Backward-compatible facade used by order-to-invoice flow."""

	return update_invoice(data)
