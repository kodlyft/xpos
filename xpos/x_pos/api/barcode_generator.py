# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""Barcode and QR code generation utilities for X POS.

Provides functions to generate barcode and QR code images as base64-encoded
data URIs for use in print formats, Jinja templates, and the frontend.
"""

import base64
import io
import json
from typing import Literal

import frappe
from frappe import _

BARCODE_TYPES = {
	"code128": "code128",
	"code39": "code39",
	"ean13": "ean13",
	"ean8": "ean8",
	"upca": "upca",
	"isbn13": "isbn13",
	"isbn10": "isbn10",
	"issn": "issn",
	"pzn": "pzn",
	"jan": "jan",
	"itf": "itf",
	"gs1_128": "gs1_128",
}

BARCODE_TYPE_ALIASES = {
	"ean": "ean13",
	"ean-13": "ean13",
	"ean-8": "ean8",
	"upc": "upca",
	"upc-a": "upca",
	"code-39": "code39",
	"code-128": "code128",
	"gs1": "gs1_128",
	"gs1-128": "gs1_128",
	"gtin": "ean13",
	"gtin-14": "itf",
	"isbn": "isbn13",
	"isbn-10": "isbn10",
	"isbn-13": "isbn13",
}


def normalize_barcode_type(barcode_type: str | None, default: str = "code128") -> str:
	"""
	Resolve any barcode type label to a supported python-barcode class name.

	Accepts both the frontend identifiers (``code128``, ``ean13``) and the
	ERPNext Item Barcode labels (``CODE-39``, ``UPC-A``, ``EAN-13`` …).
	"""
	if not barcode_type:
		return default

	key = str(barcode_type).strip().lower()
	if key in BARCODE_TYPES:
		return key
	if key in BARCODE_TYPE_ALIASES:
		return BARCODE_TYPE_ALIASES[key]

	compact = key.replace(" ", "").replace("-", "").replace("_", "")
	for name in BARCODE_TYPES:
		if name.replace("_", "") == compact:
			return name
	for alias, name in BARCODE_TYPE_ALIASES.items():
		if alias.replace("-", "").replace("_", "") == compact:
			return name

	return default


def get_barcode_class(barcode_type: str):
	"""Return the python-barcode class for the given type identifier."""
	import barcode as python_barcode

	return python_barcode.get_barcode_class(BARCODE_TYPES[normalize_barcode_type(barcode_type)])


def generate_barcode(
	value: str,
	barcode_type: str = "code128",
	width: float = 0.4,
	height: float = 15.0,
	font_size: int = 10,
	text: str | None = None,
	show_text: bool = True,
	fmt: Literal["png", "svg"] = "svg",
) -> str:
	"""Generate a barcode image and return it as a base64 data URI.

	Args:
	    value: The data to encode in the barcode.
	    barcode_type: Type of barcode (code128, code39, ean13, etc.).
	    width: Module width in mm (default 0.4).
	    height: Barcode height in mm (default 15).
	    font_size: Size of the human-readable text below the barcode.
	    text: Custom text below the barcode (defaults to value).
	    show_text: Whether to display text below the barcode.
	    fmt: Output format, 'png' or 'svg' (default 'svg').

	Returns:
	    A base64-encoded data URI string (e.g. ``data:image/png;base64,...``).
	"""
	if not value:
		return ""

	try:
		barcode_cls = get_barcode_class(barcode_type)

		options = {
			"module_width": width,
			"module_height": height,
			"font_size": font_size,
			"text_distance": 5,
			"write_text": show_text,
		}

		buffer = io.BytesIO()

		if fmt == "svg":
			from barcode.writer import SVGWriter

			barcode_obj = barcode_cls(str(value), writer=SVGWriter())
			barcode_obj.write(buffer, options=options)
			encoded = base64.b64encode(buffer.getvalue()).decode("utf-8")
			return f"data:image/svg+xml;base64,{encoded}"
		else:
			from barcode.writer import ImageWriter

			options["dpi"] = 300
			barcode_obj = barcode_cls(str(value), writer=ImageWriter())
			barcode_obj.write(buffer, options=options)
			encoded = base64.b64encode(buffer.getvalue()).decode("utf-8")
			return f"data:image/png;base64,{encoded}"

	except Exception as e:
		if normalize_barcode_type(barcode_type) != "code128":
			return generate_barcode(value, "code128", width, height, font_size, text, show_text, fmt)
		frappe.log_error(f"Barcode generation failed for '{value}': {e}", "X POS Barcode")
		return ""


def generate_qrcode(
	value: str,
	size: int = 4,
	border: int = 2,
	error_correction: str = "M",
	fmt: Literal["png", "svg"] = "png",
	fill_color: str = "black",
	back_color: str = "white",
) -> str:
	"""Generate a QR code image and return it as a base64 data URI.

	Args:
	    value: The data to encode in the QR code.
	    size: Box size in pixels (default 4).
	    border: Border width in boxes (default 2).
	    error_correction: Error correction level (L, M, Q, H).
	    fmt: Output format, 'png' (default) or 'svg'.
	    fill_color: QR module color (default 'black').
	    back_color: Background color (default 'white').

	Returns:
	    A base64-encoded data URI string.
	"""
	if not value:
		return ""

	try:
		import qrcode
		from qrcode.constants import (
			ERROR_CORRECT_H,
			ERROR_CORRECT_L,
			ERROR_CORRECT_M,
			ERROR_CORRECT_Q,
		)

		ec_map = {
			"L": ERROR_CORRECT_L,
			"M": ERROR_CORRECT_M,
			"Q": ERROR_CORRECT_Q,
			"H": ERROR_CORRECT_H,
		}

		ec_level = ec_map.get(str(error_correction).upper(), ERROR_CORRECT_M)

		qr = qrcode.QRCode(
			version=None,
			error_correction=ec_level,
			box_size=size,
			border=border,
		)
		qr.add_data(str(value))
		qr.make(fit=True)

		if fmt == "svg":
			import qrcode.image.svg

			factory = qrcode.image.svg.SvgPathImage
			img = qr.make_image(image_factory=factory, fill_color=fill_color, back_color=back_color)
			buffer = io.BytesIO()
			img.save(buffer)
			encoded = base64.b64encode(buffer.getvalue()).decode("utf-8")
			return f"data:image/svg+xml;base64,{encoded}"
		else:
			img = qr.make_image(fill_color=fill_color, back_color=back_color)
			buffer = io.BytesIO()
			img.save(buffer, format="PNG")
			encoded = base64.b64encode(buffer.getvalue()).decode("utf-8")
			return f"data:image/png;base64,{encoded}"

	except Exception as e:
		frappe.log_error(f"QR code generation failed for '{value}': {e}", "X POS QR Code")
		return ""


def generate_item_barcode_label(
	item_code: str,
	barcode_value: str | None = None,
	barcode_type: str = "code128",
	include_qr: bool = False,
	width: float = 0.4,
	height: float = 20.0,
	pos_profile: str | None = None,
) -> dict:
	"""Generate barcode (and optionally QR code) data for an item.

	This is designed for batch label printing. If no explicit barcode_value
	is given, the first barcode attached to the item is used, falling back
	to the item_code itself.

	Returns a dict with keys:
	    - item_code, item_name, barcode_value
	    - barcode_uri  (data URI of the barcode image)
	    - qrcode_uri   (data URI of the QR code, if requested)
	    - price, currency, uom
	"""
	if not item_code:
		return {}

	item = frappe.get_cached_doc("Item", item_code)

	if not barcode_value:
		barcodes = item.get("barcodes") or []
		if barcodes:
			barcode_value = barcodes[0].barcode
			barcode_type = barcodes[0].barcode_type or barcode_type
		else:
			barcode_value = item_code

	barcode_type = normalize_barcode_type(barcode_type)

	price = 0
	currency = frappe.defaults.get_global_default("currency") or "USD"
	pp = frappe.get_cached_doc("POS Profile", pos_profile) if pos_profile else None
	default_price_list = None
	if pp and pp.selling_price_list:
		default_price_list = pp.selling_price_list
	if not default_price_list:
		default_price_list = frappe.db.get_single_value("Selling Settings", "selling_price_list") or ""

	if default_price_list:
		price_doc = frappe.db.get_value(
			"Item Price",
			{"item_code": item_code, "price_list": default_price_list, "selling": 1},
			["price_list_rate", "currency"],
			as_dict=True,
		)
		if price_doc:
			price = price_doc.price_list_rate or 0
			currency = price_doc.currency or currency

	barcode_uri = generate_barcode(
		barcode_value,
		barcode_type=barcode_type,
		width=width,
		height=height,
	)

	qrcode_uri = ""
	if include_qr:
		qrcode_uri = generate_qrcode(barcode_value, size=4, border=1)

	return {
		"item_code": item_code,
		"item_name": item.item_name,
		"barcode_value": barcode_value,
		"barcode_type": barcode_type,
		"barcode_uri": barcode_uri,
		"qrcode_uri": qrcode_uri,
		"price": price,
		"currency": currency,
		"uom": item.stock_uom or "Nos",
	}


@frappe.whitelist()
def get_item_barcode_labels(
	items: str | list,
	barcode_type: str = "code128",
	include_qr: bool = False,
	width: float = 0.4,
	height: float = 15.0,
	pos_profile: str | None = None,
) -> list[dict]:
	"""API: Generate barcode labels for a list of items.

	Args:
	    items: JSON string or list of dicts, each with:
	        - item_code (required)
	        - barcode (optional override)
	        - qty (number of labels, default 1)
	    barcode_type: Default barcode type.
	    include_qr: Whether to include QR codes.

	Returns:
	    List of label dicts, one per label copy.
	"""
	if isinstance(items, str):
		items = json.loads(items)

	if not isinstance(items, list):
		frappe.throw(_("items must be a list"), frappe.ValidationError)

	include_qr = bool(int(include_qr or 0))
	labels = []

	for entry in items:
		if isinstance(entry, str):
			entry = {"item_code": entry}

		item_code = entry.get("item_code")
		if not item_code:
			continue

		qty = max(int(entry.get("qty", 1)), 1)
		barcode_override = entry.get("barcode") or None
		entry_type = entry.get("barcode_type") or barcode_type

		label = generate_item_barcode_label(
			item_code=item_code,
			barcode_value=barcode_override,
			barcode_type=entry_type,
			include_qr=include_qr,
			width=float(width),
			height=float(height),
			pos_profile=pos_profile,
		)

		if label:
			for x in range(qty):
				labels.append(label)

	return labels


@frappe.whitelist()
def search_items_for_barcode(query: str = "") -> dict:
	"""API: Search items by name, code, or barcode for the barcode printing UI.

	Returns up to 20 matching items, each with the full list of barcodes
	attached to the item (so the user can pick which one to print).
	"""
	query = (query or "").strip()
	if not query:
		return {"items": []}

	like_query = f"%{query}%"

	items = frappe.db.sql(
		"""
        SELECT DISTINCT i.item_code, i.item_name
        FROM `tabItem` i
        LEFT JOIN `tabItem Barcode` ib ON ib.parent = i.name
        WHERE i.disabled = 0
          AND i.has_variants = 0
          AND (
            i.item_code LIKE %(q)s
            OR i.item_name LIKE %(q)s
            OR ib.barcode LIKE %(q)s
          )
        ORDER BY
            CASE WHEN i.item_code = %(exact)s THEN 0 ELSE 1 END,
            i.item_name
        LIMIT 20
        """,
		{"q": like_query, "exact": query},
		as_dict=True,
	)

	result = []
	for item in items:
		barcodes = frappe.get_all(
			"Item Barcode",
			filters={"parent": item.item_code, "parenttype": "Item"},
			fields=["barcode", "barcode_type", "uom"],
			order_by="idx asc",
		)
		result.append(
			{
				"item_code": item.item_code,
				"item_name": item.item_name,
				"barcodes": barcodes,
			}
		)

	return {"items": result}
