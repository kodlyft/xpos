# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

from typing import Any

import frappe
from frappe.utils import cstr, flt, getdate, nowdate

from xpos.utils import row_value
from xpos.x_pos.doctype.pos_coupon.pos_coupon import check_coupon_code
from xpos.x_pos.promotional_scheme_offers import get_promotional_scheme_offers


@frappe.whitelist()
def get_offers(pos_profile: str):
	"""Return all active POS Offers + promotional scheme offers for a profile."""
	pos = frappe.get_cached_doc("POS Profile", pos_profile)
	company = pos.company
	warehouse = pos.warehouse
	date = nowdate()

	values = {
		"company": company,
		"pos_profile": pos_profile,
		"warehouse": warehouse,
		"valid_from": date,
		"valid_upto": date,
	}

	data = (
		frappe.db.sql(
			"""
		SELECT *
		FROM `tabPOS Offer`
		WHERE
			disabled = 0
			AND company = %(company)s
			AND (pos_profile IS NULL OR pos_profile = '' OR pos_profile = %(pos_profile)s)
			AND (warehouse IS NULL OR warehouse = '' OR warehouse = %(warehouse)s)
			AND (valid_from IS NULL OR valid_from = '' OR valid_from <= %(valid_from)s)
			AND (valid_upto IS NULL OR valid_upto = '' OR valid_upto >= %(valid_upto)s)
		""",
			values=values,
			as_dict=True,
		)
		or []
	)

	for offer in data:
		offer["row_id"] = cstr(offer.get("row_id") or offer.get("name"))
		offer["offer_applied"] = flt(offer.get("offer_applied") or 0)
		offer["auto"] = flt(offer.get("auto") or 0)
		offer["min_qty"] = flt(offer.get("min_qty") or 0)
		offer["max_qty"] = flt(offer.get("max_qty") or 0)
		offer["min_amt"] = flt(offer.get("min_amt") or 0)
		offer["max_amt"] = flt(offer.get("max_amt") or 0)
		_normalize_discount_fields(offer)

	promo_offers = get_promotional_scheme_offers(pos) or []
	data.extend(promo_offers)

	return data


@frappe.whitelist()
def get_pos_coupon(coupon: str, customer: str, company: str):
	"""Validate and return a POS coupon with its linked POS Offer.

	A coupon that cannot be used comes back as ``{"coupon": None, "msg": reason}``.
	"""
	result = check_coupon_code(coupon, customer, company)
	coupon_doc = result.get("coupon")
	if not coupon_doc:
		return {"coupon": None, "offer": None, "msg": result.get("msg")}

	coupon_data = frappe._dict(
		{
			field: coupon_doc.get(field)
			for field in (
				"name",
				"coupon_code",
				"coupon_type",
				"valid_from",
				"valid_upto",
				"customer",
				"pos_offer",
				"maximum_use",
				"used",
			)
		}
	)

	offer_data = frappe.get_doc("POS Offer", coupon_doc.pos_offer).as_dict()
	offer_data["row_id"] = cstr(offer_data.get("row_id") or offer_data.get("name"))
	offer_data["auto"] = flt(offer_data.get("auto") or 0)
	offer_data["min_qty"] = flt(offer_data.get("min_qty") or 0)
	offer_data["max_qty"] = flt(offer_data.get("max_qty") or 0)
	offer_data["min_amt"] = flt(offer_data.get("min_amt") or 0)
	offer_data["max_amt"] = flt(offer_data.get("max_amt") or 0)
	_normalize_discount_fields(offer_data)

	return {"coupon": coupon_data, "offer": offer_data, "msg": "Apply"}


@frappe.whitelist()
def get_active_gift_coupons(customer: str, company: str):
	"""Returns all active gift card coupons for a customer."""

	today = getdate(nowdate())
	coupons_data = frappe.get_all(
		"POS Coupon",
		filters={
			"company": company,
			"coupon_type": "Gift Card",
			"customer": customer,
			"used": 0,
		},
		fields=["coupon_code", "valid_from", "valid_upto"],
	)

	return [row_value(c, "coupon_code") for c in coupons_data if _is_coupon_active(c, today)]


@frappe.whitelist()
def get_applicable_delivery_charges(
	company: str,
	pos_profile: str,
	customer: str | None = None,
	shipping_address_name: str | None = None,
):
	"""Returns applicable delivery charges"""
	from xpos.x_pos.doctype.delivery_charges.delivery_charges import (
		get_applicable_delivery_charges as resolve_delivery_charges,
	)

	return resolve_delivery_charges(company, pos_profile, customer, shipping_address_name)


def _is_coupon_active(coupon_data: dict | object, today: Any):
	"""Return True if the coupon is valid for the provided date."""
	valid_from = row_value(coupon_data, "valid_from")
	valid_upto = row_value(coupon_data, "valid_upto")
	if valid_from and getdate(valid_from) > today:
		return False
	if valid_upto and getdate(valid_upto) < today:
		return False
	return True


def _normalize_discount_fields(offer: dict):
	"""Ensure discount fields are numeric."""
	for field in ("discount_percentage", "discount_amount", "rate"):
		if field in offer:
			offer[field] = flt(offer[field])
