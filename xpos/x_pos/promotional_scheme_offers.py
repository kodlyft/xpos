# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""Promotional Scheme slabs converted to POS Offer-shaped dicts for display.

ERPNext applies each scheme through the Pricing Rules it generates, so these
offers are never auto-applied by the POS offer engine (``auto`` is 0).
"""

import frappe
from frappe.utils import cstr, flt, nowdate


def get_promotional_scheme_offers(pos_profile: dict):
	if not frappe.db.table_exists("Promotional Scheme"):
		return []

	date = nowdate()
	values = {"company": pos_profile.get("company"), "date": date}

	try:
		promotional_schemes = frappe.db.sql(
			"""
            SELECT name
            FROM `tabPromotional Scheme`
            WHERE
                disable = 0
                AND selling = 1
                AND company = %(company)s
                AND (valid_from IS NULL OR valid_from <= %(date)s)
                AND (valid_upto IS NULL OR valid_upto >= %(date)s)
            """,
			values=values,
			as_dict=True,
		)
	except Exception:
		frappe.log_error(frappe.get_traceback(), "XPOS - Failed to fetch Promotional Schemes")
		return []

	offers = []
	for row in promotional_schemes:
		try:
			scheme = frappe.get_doc("Promotional Scheme", row.name)
		except Exception:
			frappe.log_error(
				frappe.get_traceback(),
				f"POS - Unable to load Promotional Scheme {row.name}",
			)
			continue

		offers.extend(prepare_promotional_scheme_offers(scheme, pos_profile))

	return offers


def prepare_promotional_scheme_offers(scheme: dict, pos_profile: dict):
	if scheme.applicable_for or scheme.apply_rule_on_other:
		return []

	if scheme.mixed_conditions or scheme.is_cumulative:
		return []

	offers = []
	offers.extend(build_price_discount_offers(scheme, pos_profile))
	offers.extend(build_product_discount_offers(scheme, pos_profile))
	return [offer for offer in offers if offer]


def build_price_discount_offers(scheme: dict, pos_profile: dict):
	slabs = getattr(scheme, "price_discount_slabs", [])
	if not slabs:
		return []

	targets = get_scheme_targets(scheme)
	profile_price_list = getattr(pos_profile, "selling_price_list", None)
	profile_warehouse = getattr(pos_profile, "warehouse", None)

	offers = []

	for slab in slabs:
		if slab.disable:
			continue

		if slab.for_price_list and profile_price_list and slab.for_price_list != profile_price_list:
			continue

		if slab.warehouse and profile_warehouse and slab.warehouse != profile_warehouse:
			continue

		offer_template = {
			"name": make_offer_identifier(scheme.name, slab.name),
			"row_id": make_offer_identifier(scheme.name, slab.name),
			"title": scheme.name,
			"description": slab.rule_description or scheme.name,
			"company": scheme.company,
			"pos_profile": pos_profile.name,
			"warehouse": slab.warehouse,
			"apply_on": scheme.apply_on,
			"apply_type": (scheme.apply_on if scheme.apply_on in ("Item Code", "Item Group") else ""),
			"offer": ("Grand Total" if scheme.apply_on == "Transaction" else "Item Price"),
			"auto": 0,
			"coupon_based": 0,
			"offer_applied": 0,
			"min_qty": flt(slab.min_qty),
			"max_qty": flt(slab.max_qty),
			"min_amt": flt(slab.min_amount),
			"max_amt": flt(slab.max_amount),
			"discount_type": map_discount_type(slab.rate_or_discount),
			"rate": flt(slab.rate),
			"discount_amount": flt(slab.discount_amount),
			"discount_percentage": flt(slab.discount_percentage),
			"given_qty": 0,
			"valid_from": scheme.valid_from,
			"valid_upto": scheme.valid_upto,
			"promo_source": "Promotional Scheme",
			"promotional_scheme": scheme.name,
			"promotional_scheme_rule": slab.name,
		}

		offer_template = normalize_discount_fields(offer_template)

		if scheme.apply_on == "Transaction":
			offers.append(offer_template)
			continue

		if not targets:
			continue

		for target in targets:
			new_offer = offer_template.copy()
			new_offer["name"] = make_offer_identifier(scheme.name, target, slab.name)
			new_offer["row_id"] = new_offer["name"]

			if scheme.apply_on == "Item Code":
				new_offer["item"] = target
				new_offer["apply_item_code"] = target
			elif scheme.apply_on == "Item Group":
				new_offer["item_group"] = target
				new_offer["apply_item_group"] = target
			elif scheme.apply_on == "Brand":
				new_offer["brand"] = target

			offers.append(new_offer)

	return offers


def build_product_discount_offers(scheme: dict, pos_profile: dict):
	slabs = getattr(scheme, "product_discount_slabs", [])
	if not slabs:
		return []

	targets = get_scheme_targets(scheme)
	profile_warehouse = getattr(pos_profile, "warehouse", None)

	offers = []

	for slab in slabs:
		if slab.disable:
			continue

		if slab.warehouse and profile_warehouse and slab.warehouse != profile_warehouse:
			continue

		if flt(slab.free_qty) <= 0:
			continue

		offer_template = {
			"name": make_offer_identifier(scheme.name, slab.name),
			"row_id": make_offer_identifier(scheme.name, slab.name),
			"title": scheme.name,
			"description": slab.rule_description or scheme.name,
			"company": scheme.company,
			"pos_profile": pos_profile.name,
			"warehouse": slab.warehouse,
			"apply_on": scheme.apply_on,
			"offer": "Give Product",
			"auto": 0,
			"coupon_based": 0,
			"offer_applied": 0,
			"min_qty": flt(slab.min_qty),
			"max_qty": flt(slab.max_qty),
			"min_amt": flt(slab.min_amount),
			"max_amt": flt(slab.max_amount),
			"given_qty": flt(slab.free_qty),
			"discount_type": ("Rate" if flt(slab.free_item_rate) else "Discount Percentage"),
			"rate": flt(slab.free_item_rate),
			"discount_amount": 0,
			"discount_percentage": 100 if not flt(slab.free_item_rate) else 0,
			"valid_from": scheme.valid_from,
			"valid_upto": scheme.valid_upto,
			"promo_source": "Promotional Scheme",
			"promotional_scheme": scheme.name,
			"promotional_scheme_rule": slab.name,
			"round_free_qty": slab.round_free_qty,
			"is_recursive": slab.is_recursive,
			"recurse_for": flt(slab.recurse_for),
			"apply_recursion_over": flt(slab.apply_recursion_over),
		}

		if slab.free_item and not slab.same_item:
			offer_template["give_item"] = slab.free_item
			offer_template["apply_item_code"] = slab.free_item

		offer_template = normalize_discount_fields(offer_template)

		if scheme.apply_on == "Transaction":
			offers.append(offer_template)
			continue

		if not targets:
			continue

		for target in targets:
			new_offer = offer_template.copy()
			new_offer["name"] = make_offer_identifier(scheme.name, target, slab.name)
			new_offer["row_id"] = new_offer["name"]

			if scheme.apply_on == "Item Code":
				new_offer["item"] = target
				new_offer["apply_type"] = "Item Code"
				new_offer["apply_item_code"] = target
				new_offer["replace_item"] = 1 if slab.same_item else 0
			elif scheme.apply_on == "Item Group":
				new_offer["item_group"] = target
				new_offer["apply_type"] = "Item Group"
				new_offer["apply_item_group"] = target
				if slab.same_item:
					new_offer["replace_cheapest_item"] = 1
			elif scheme.apply_on == "Brand":
				new_offer["brand"] = target
				if slab.same_item:
					new_offer["replace_cheapest_item"] = 1

			offers.append(new_offer)

	return offers


def get_scheme_targets(scheme: dict):
	targets = []
	if scheme.get("apply_on") == "Item Code":
		targets = [row.get("item_code") for row in scheme.get("items", []) if row.get("item_code")]
	elif scheme.get("apply_on") == "Item Group":
		targets = [row.get("item_group") for row in scheme.get("item_groups", []) if row.get("item_group")]
	elif scheme.get("apply_on") == "Brand":
		targets = [row.get("brand") for row in scheme.get("brands", []) if row.get("brand")]

	seen = set()
	unique_targets = []
	for target in targets:
		target_key = cstr(target)
		if target_key and target_key not in seen:
			seen.add(target_key)
			unique_targets.append(target_key)

	return unique_targets


def map_discount_type(rate_or_discount: str) -> str:
	mapping = {
		"Rate": "Rate",
		"Discount Percentage": "Discount Percentage",
		"Discount Amount": "Discount Amount",
	}
	return mapping.get(rate_or_discount, "Discount Percentage")


def normalize_discount_fields(offer: dict) -> dict:
	discount_type = offer.get("discount_type")

	if discount_type != "Rate":
		offer["rate"] = flt(0)

	if discount_type != "Discount Amount":
		offer["discount_amount"] = flt(0)

	if discount_type != "Discount Percentage":
		offer["discount_percentage"] = flt(0)

	return offer


def make_offer_identifier(*parts: str) -> str:
	cleaned = [frappe.scrub(cstr(part)) for part in parts if part]
	if not cleaned:
		cleaned = [frappe.generate_hash(length=10)]
	return "ps-" + "-".join(cleaned)
