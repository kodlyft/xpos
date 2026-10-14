# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""Jinja template helpers for barcodes, QR codes and mixed-currency receipts.

These functions are registered via ``hooks.py`` under ``jenv`` so they can
be called directly in Jinja / Print Format templates:

    {{ xpos_barcode("12345", barcode_type="code128") }}
    {{ xpos_qrcode("https://example.com") }}
    {{ xpos_item_barcode("ITEM-001") }}
    {{ xpos_tender_rate(payment.pos_exchange_rate, doc.currency) }}
    {{ xpos_number(item.rate) }}
    {{ xpos_qty(item.qty) }}
"""

from __future__ import annotations

import re

import frappe
from frappe.locale import get_number_format
from frappe.utils import cint, flt, fmt_money

from xpos.x_pos.api.barcode_generator import (
	generate_barcode,
	generate_item_barcode_label,
	generate_qrcode,
)


def xpos_tender_rate(rate, currency: str | None = None) -> str:
	"""Jinja helper: an exchange rate as a plain grouped number, with no currency symbol."""
	from xpos.api.exchange import get_currency_precision

	return fmt_money(flt(rate), precision=get_currency_precision(currency))


def xpos_float_precision() -> int:
	"""Decimals for non-currency figures: System Settings ``float_precision``, else 3."""
	return cint(frappe.db.get_default("float_precision")) or 3


def xpos_number(value, precision: int | None = None) -> str:
	"""
	Jinja helper: a plain grouped number in the site's number format, no symbol.

	Use for the narrow rate and amount columns of a thermal receipt, where a repeated
	currency symbol would not fit but the grouping and decimal separator still have to
	follow System Settings.
	"""
	return fmt_money(flt(value), precision=precision)


def xpos_qty(value, precision: int | None = None) -> str:
	"""
	Jinja helper: a quantity in the site's number format, trailing zeros trimmed.

	A whole 2 prints as ``2`` rather than ``2.000``, while 2.5 keeps its half.
	"""
	digits = xpos_float_precision() if precision is None else cint(precision)
	formatted = fmt_money(flt(value), precision=digits)

	decimal_separator = get_number_format().decimal_separator
	if not decimal_separator or decimal_separator not in formatted:
		return formatted

	return re.sub(rf"{re.escape(decimal_separator)}?0+$", "", formatted)


def xpos_barcode(
	value: str,
	barcode_type: str = "code128",
	width: float = 0.4,
	height: float = 15.0,
	font_size: int = 10,
	show_text: bool = True,
	fmt: str = "png",
) -> str:
	"""Jinja helper: Generate a barcode and return as an ``<img>`` tag.

	Usage in Jinja:
	    {{ xpos_barcode("1234567890128", barcode_type="ean13") }}
	"""
	data_uri = generate_barcode(
		value,
		barcode_type=barcode_type,
		width=width,
		height=height,
		font_size=font_size,
		show_text=show_text,
		fmt=fmt,
	)
	if not data_uri:
		return ""
	return f'<img src="{data_uri}" alt="Barcode {value}" style="max-width:100%;height:auto;" />'


def xpos_barcode_uri(
	value: str,
	barcode_type: str = "code128",
	width: float = 0.4,
	height: float = 15.0,
	font_size: int = 10,
	show_text: bool = True,
	fmt: str = "png",
) -> str:
	"""Jinja helper: Generate a barcode and return the raw data URI string.

	Useful when you need to set the ``src`` attribute yourself:
	    <img src="{{ xpos_barcode_uri('123') }}" style="width:50mm;" />
	"""
	return generate_barcode(
		value,
		barcode_type=barcode_type,
		width=width,
		height=height,
		font_size=font_size,
		show_text=show_text,
		fmt=fmt,
	)


def xpos_qrcode(
	value: str,
	size: int = 4,
	border: int = 2,
	error_correction: str = "M",
	fmt: str = "png",
) -> str:
	"""Jinja helper: Generate a QR code and return as an ``<img>`` tag.

	Usage in Jinja:
	    {{ xpos_qrcode(doc.name) }}
	"""
	data_uri = generate_qrcode(
		value,
		size=size,
		border=border,
		error_correction=error_correction,
		fmt=fmt,
	)
	if not data_uri:
		return ""
	return f'<img src="{data_uri}" alt="QR Code" style="max-width:100%;height:auto;" />'


def xpos_qrcode_uri(
	value: str,
	size: int = 4,
	border: int = 2,
	error_correction: str = "M",
	fmt: str = "png",
) -> str:
	"""Jinja helper: Generate a QR code and return the raw data URI string."""
	return generate_qrcode(
		value,
		size=size,
		border=border,
		error_correction=error_correction,
		fmt=fmt,
	)


def xpos_item_barcode(
	item_code: str,
	barcode_type: str = "code128",
	include_qr: bool = False,
	width: float = 0.4,
	height: float = 15.0,
) -> dict:
	"""Jinja helper: Return full barcode label data for an item.

	Usage in Jinja:
	    {% set label = xpos_item_barcode("ITEM-001", include_qr=True) %}
	    <img src="{{ label.barcode_uri }}" />
	    <p>{{ label.item_name }} - {{ label.price }} {{ label.currency }}</p>
	"""
	return generate_item_barcode_label(
		item_code=item_code,
		barcode_type=barcode_type,
		include_qr=include_qr,
		width=width,
		height=height,
	)


def xpos_gift_card_line(row) -> str:
	"""Jinja helper: the masked card on a gift-card payment or sale row, and what it holds after it."""
	card = row.get("xpos_gift_card")
	if not card:
		return ""
	from xpos.x_pos.gift_cards import mask_code

	details = frappe.db.get_value("Gift Card", card, ["code_last4", "currency"], as_dict=True)
	if not details:
		return ""
	balance = frappe.db.get_value(
		"Gift Card Transaction", {"gift_card": card, "voucher_detail_no": row.name}, "balance_after"
	)
	line = mask_code(details.code_last4)
	if balance is not None:
		line += " · " + frappe._("Balance {0}").format(fmt_money(flt(balance), currency=details.currency))
	return line
