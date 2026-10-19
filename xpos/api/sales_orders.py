# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""
Sales Orders & Quotations API.

- Search unbilled sales orders
- Create/update sales orders from POS
- Submit sales orders with payment entries
- Create/submit quotations from POS
"""

import json

import frappe
from frappe import _
from frappe.utils import flt, nowdate

from xpos.api.invoices import apply_sales_person
from xpos.api.profiles import ensure_profile_allows, resolve_pos_profile


def order_profile(pos_profile: str | None):
	"""A POS Profile the user may use, with "Allow Sales Order" on."""
	pos = resolve_pos_profile(pos_profile)
	ensure_profile_allows(pos, "allow_sales_order", _("Sales Orders"))
	return pos


@frappe.whitelist()
def search_orders(
	company: str, currency: str | None = None, order_name: str | None = None, pos_profile: str | None = None
):
	"""Searches for unbilled Sales Orders."""
	pos = order_profile(pos_profile)
	if company != pos.company:
		frappe.throw(
			_("POS Profile {0} belongs to another company.").format(pos.name), frappe.PermissionError
		)
	filters = {
		"company": company,
		"docstatus": 1,
		"status": ["not in", ["Closed", "Completed"]],
		"per_billed": ["<", 100],
	}

	if currency:
		filters["currency"] = currency
	if order_name:
		filters["name"] = ["like", f"%{order_name}%"]

	orders = frappe.get_list(
		"Sales Order",
		filters=filters,
		fields=[
			"name",
			"customer",
			"customer_name",
			"transaction_date",
			"grand_total",
			"currency",
			"status",
			"per_billed",
			"per_delivered",
			"delivery_date",
		],
		limit_page_length=50,
		order_by="transaction_date desc",
	)

	return orders


@frappe.whitelist()
def create_sales_order(data: str | dict):
	"""Creates or updates a Sales Order from POS."""
	if isinstance(data, str):
		data = json.loads(data)

	pos_profile = data.get("pos_profile")
	customer = data.get("customer")
	items = data.get("items", [])
	delivery_date = data.get("delivery_date")

	if not pos_profile or not customer or not items:
		frappe.throw(_("POS Profile, Customer, and Items are required"))

	pos = order_profile(pos_profile)

	so_name = data.get("name")
	if so_name and frappe.db.exists("Sales Order", so_name):
		so = frappe.get_doc("Sales Order", so_name)
		if so.docstatus != 0:
			frappe.throw(_("Only draft Sales Orders can be updated"))
		so.set("items", [])
	else:
		so = frappe.new_doc("Sales Order")

	so.customer = customer
	so.company = pos.company
	so.transaction_date = nowdate()
	so.delivery_date = delivery_date or nowdate()
	so.currency = data.get("currency") or pos.currency
	so.selling_price_list = data.get("selling_price_list") or pos.selling_price_list

	for item_data in items:
		item = so.append("items", {})
		item.item_code = item_data.get("item_code")
		item.item_name = item_data.get("item_name")
		item.qty = flt(item_data.get("qty", 1))
		item.rate = flt(item_data.get("rate", 0))
		item.uom = item_data.get("uom") or item_data.get("stock_uom")
		item.warehouse = item_data.get("warehouse") or pos.warehouse
		item.delivery_date = item_data.get("delivery_date") or delivery_date or nowdate()

		if item_data.get("discount_percentage"):
			item.discount_percentage = flt(item_data["discount_percentage"])
		if item_data.get("discount_amount"):
			item.discount_amount = flt(item_data["discount_amount"])

	if data.get("additional_discount_percentage"):
		so.additional_discount_percentage = flt(data["additional_discount_percentage"])
		so.apply_discount_on = data.get("apply_discount_on") or "Grand Total"
	if data.get("discount_amount"):
		so.discount_amount = flt(data["discount_amount"])
		so.apply_discount_on = data.get("apply_discount_on") or "Grand Total"

	apply_sales_person(so, data.get("sales_person") or None, pos_profile)

	so.save()

	return {
		"name": so.name,
		"grand_total": so.grand_total,
		"customer": so.customer,
		"customer_name": so.customer_name,
		"status": "Draft",
	}


@frappe.whitelist()
def submit_sales_order(data: str | dict):
	"""Submits a Sales Order."""

	if isinstance(data, str):
		data = json.loads(data)

	so_name = data.get("name")
	if not so_name:
		frappe.throw(_("Sales Order name is required"))

	so = frappe.get_doc("Sales Order", so_name)
	order_profile(data.get("pos_profile"))
	so.submit()

	return {
		"name": so.name,
		"status": so.status,
		"grand_total": so.grand_total,
	}


@frappe.whitelist()
def create_sales_invoice_from_order(sales_order: str, pos_profile: str | None = None):
	"""Creates a Sales Invoice from a Sales Order."""
	from erpnext.selling.doctype.sales_order.sales_order import make_sales_invoice

	pos = order_profile(pos_profile)
	if frappe.db.get_value("Sales Order", sales_order, "company") != pos.company:
		frappe.throw(
			_("Sales Order {0} belongs to another company.").format(sales_order), frappe.PermissionError
		)
	si = make_sales_invoice(sales_order)
	si.is_pos = 1
	si.pos_profile = pos.name
	si.update_stock = pos.update_stock
	si.insert()

	return {
		"name": si.name,
		"grand_total": si.grand_total,
		"customer": si.customer,
	}


@frappe.whitelist()
def create_quotation(data: str | dict):
	"""Creates or updates a Quotation from POS."""
	if isinstance(data, str):
		data = json.loads(data)

	pos_profile = data.get("pos_profile")
	customer = data.get("customer")
	items = data.get("items", [])

	if not pos_profile or not customer or not items:
		frappe.throw(_("POS Profile, Customer, and Items are required"))

	pos = order_profile(pos_profile)

	qt_name = data.get("name")
	if qt_name and frappe.db.exists("Quotation", qt_name):
		qt = frappe.get_doc("Quotation", qt_name)
		if qt.docstatus != 0:
			frappe.throw(_("Only draft Quotations can be updated"))
		qt.set("items", [])
	else:
		qt = frappe.new_doc("Quotation")

	qt.quotation_to = "Customer"
	qt.party_name = customer
	qt.company = pos.company
	qt.transaction_date = nowdate()
	qt.currency = data.get("currency") or pos.currency
	qt.selling_price_list = data.get("selling_price_list") or pos.selling_price_list

	for item_data in items:
		item = qt.append("items", {})
		item.item_code = item_data.get("item_code")
		item.item_name = item_data.get("item_name")
		item.qty = flt(item_data.get("qty", 1))
		item.rate = flt(item_data.get("rate", 0))
		item.uom = item_data.get("uom") or item_data.get("stock_uom")

	if data.get("additional_discount_percentage"):
		qt.additional_discount_percentage = flt(data["additional_discount_percentage"])
		qt.apply_discount_on = data.get("apply_discount_on") or "Grand Total"

	qt.save()

	return {
		"name": qt.name,
		"grand_total": qt.grand_total,
		"customer": qt.party_name,
		"status": "Draft",
	}


@frappe.whitelist()
def submit_quotation(data: str | dict):
	"""Submits a Quotation."""

	if isinstance(data, str):
		data = json.loads(data)

	qt_name = data.get("name")
	if not qt_name:
		frappe.throw(_("Quotation name is required"))

	qt = frappe.get_doc("Quotation", qt_name)
	order_profile(data.get("pos_profile"))
	qt.submit()

	return {
		"name": qt.name,
		"status": qt.status,
		"grand_total": qt.grand_total,
	}
