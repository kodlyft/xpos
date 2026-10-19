# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""
Customer-facing price checker / product lookup terminal.

Powers the standalone kiosk page where a customer can
scan a barcode (or type an item code / name) on a secondary display and instantly
see the item name, image, price and stock availability the "price verifier"
terminal found in most retail stores.
"""

import frappe
from frappe.utils import flt

from xpos.api.items import get_stock_qty


def _resolve_profile(pos_profile: str | None):
	"""Return (pos_profile_doc | None, currency, symbol, warehouse, price_list)."""
	pos = None
	currency = None
	warehouse = None
	price_list = None

	if pos_profile and frappe.db.exists("POS Profile", pos_profile):
		pos = frappe.get_cached_doc("POS Profile", pos_profile)
		currency = pos.get("currency")
		warehouse = pos.get("warehouse")
		price_list = pos.get("selling_price_list")

	if not currency:
		currency = frappe.db.get_default("currency")
	if not price_list:
		price_list = frappe.db.get_single_value("Selling Settings", "selling_price_list")

	symbol = None
	if currency:
		symbol = frappe.db.get_value("Currency", currency, "symbol")

	return pos, currency, symbol or currency or "", warehouse, price_list


def _get_rate(item_code: str, price_list: str | None, uom: str | None = None):
	"""Best selling rate for an item from the given price list."""
	if not price_list:
		return 0.0

	filters = {"item_code": item_code, "price_list": price_list, "selling": 1}
	if uom:
		rate = frappe.db.get_value("Item Price", {**filters, "uom": uom}, "price_list_rate")
		if rate is not None:
			return flt(rate)

	rate = frappe.db.get_value("Item Price", filters, "price_list_rate")
	return flt(rate or 0)


def _find_item_code(barcode: str) -> str | None:
	"""
	Resolve a scanned barcode to a single Item code.
	"""
	item_code = frappe.db.get_value("Item Barcode", {"barcode": barcode}, "parent")
	if item_code:
		return item_code

	if frappe.db.exists("Item", {"name": barcode, "disabled": 0, "is_sales_item": 1}):
		return barcode

	return None


@frappe.whitelist()
def lookup(barcode: str, pos_profile: str | None = None):
	"""
	Look up an item from a scanned barcode for the customer price checker.

	Barcode-scan only - returns display-ready item details with the current
	selling price and stock status, or ``None`` when the barcode matches nothing
	so the terminal can show a friendly "not found" message.
	"""
	barcode = (barcode or "").strip()
	if not barcode:
		return None

	pos, currency, symbol, warehouse, price_list = _resolve_profile(pos_profile)

	item_code = _find_item_code(barcode)
	if not item_code:
		return None

	item = frappe.get_cached_doc("Item", item_code)

	uom = frappe.db.get_value("Item Barcode", {"barcode": barcode}, "uom") or item.stock_uom
	rate = _get_rate(item.name, price_list, uom)

	actual_qty = 0.0
	if warehouse and item.is_stock_item:
		actual_qty = flt(get_stock_qty(item.name, warehouse, pos_profile=pos.name if pos else None))

	return {
		"item_code": item.name,
		"item_name": item.item_name,
		"local_item_name": item.get("local_item_name"),
		"description": frappe.utils.strip_html_tags(item.get("description") or "")[:240] or None,
		"item_group": item.item_group,
		"image": item.image,
		"uom": uom,
		"stock_uom": item.stock_uom,
		"rate": rate,
		"currency": currency,
		"symbol": symbol,
		"is_stock_item": bool(item.is_stock_item),
		"in_stock": (actual_qty > 0) if item.is_stock_item else True,
		"actual_qty": actual_qty,
		"has_price": rate > 0,
	}


@frappe.whitelist()
def get_terminal_context():
	"""
	POS profiles + currency the price-check terminal can operate under.

	Lets the kiosk offer a profile selector (which drives price list, warehouse
	and currency) when a device serves more than one store/register.
	"""
	profiles = frappe.db.sql(
		"""
		SELECT DISTINCT p.name, p.company, p.currency, p.warehouse
		FROM `tabPOS Profile` p
		INNER JOIN `tabPOS Profile User` u ON u.parent = p.name
		WHERE p.disabled = 0 AND u.user = %(user)s
		ORDER BY p.name
		""",
		{"user": frappe.session.user},
		as_dict=True,
	)

	return {
		"pos_profiles": profiles,
		"default_pos_profile": profiles[0].name if profiles else None,
		"default_currency": frappe.db.get_default("currency"),
	}
