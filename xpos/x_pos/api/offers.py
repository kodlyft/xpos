# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

import frappe
from frappe.utils import cstr, flt, getdate, nowdate

from xpos.x_pos.doctype.delivery_charges.delivery_charges import (
	get_applicable_delivery_charges as _get_applicable_delivery_charges,
)
from xpos.x_pos.doctype.pos_coupon.pos_coupon import check_coupon_code
from xpos.x_pos.promotional_scheme_offers import get_promotional_scheme_offers, normalize_discount_fields


@frappe.whitelist()
def get_pos_coupon(coupon: str, customer: str, company: str):
	res = check_coupon_code(coupon, customer, company)
	return res


@frappe.whitelist()
def get_active_gift_coupons(customer: str, company: str):
	coupons = []
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
	if len(coupons_data):
		coupons = [i.coupon_code for i in coupons_data if _is_coupon_active(i, today)]
	return coupons


def _is_coupon_active(coupon_data: dict, today: str) -> bool:
	"""Return True if the coupon is valid for the provided date."""

	if coupon_data.valid_from and getdate(coupon_data.valid_from) > today:
		return False

	if coupon_data.valid_upto and getdate(coupon_data.valid_upto) < today:
		return False

	return True


@frappe.whitelist()
def get_offers(profile: str):
	pos_profile = frappe.get_doc("POS Profile", profile)
	company = pos_profile.company
	warehouse = pos_profile.warehouse
	date = nowdate()

	values = {
		"company": company,
		"pos_profile": profile,
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
        disabled = 0 AND
        company = %(company)s AND
        (pos_profile is NULL OR pos_profile  = '' OR  pos_profile = %(pos_profile)s) AND
        (warehouse is NULL OR warehouse  = '' OR  warehouse = %(warehouse)s) AND
        (valid_from is NULL OR valid_from  = '' OR  valid_from <= %(valid_from)s) AND
        (valid_upto is NULL OR valid_upto  = '' OR  valid_upto >= %(valid_upto)s)
    """,
			values=values,
			as_dict=1,
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
		if not cstr(offer.get("discount_type")).strip():
			inferred_discount_type = _infer_discount_type_from_values(offer)
			if inferred_discount_type:
				offer["discount_type"] = inferred_discount_type
		offer = normalize_discount_fields(offer)

	promotional_scheme_offers = get_promotional_scheme_offers(pos_profile) or []

	return data + promotional_scheme_offers


@frappe.whitelist()
def get_applicable_delivery_charges(
	company: str,
	pos_profile: str,
	customer: str,
	shipping_address_name: str | None = None,
):
	return _get_applicable_delivery_charges(company, pos_profile, customer, shipping_address_name)


def _infer_discount_type_from_values(offer: dict) -> str | None:
	if flt(offer.get("rate")) > 0:
		return "Rate"
	if flt(offer.get("discount_amount")) > 0:
		return "Discount Amount"
	if flt(offer.get("discount_percentage")) > 0:
		return "Discount Percentage"
	return None
