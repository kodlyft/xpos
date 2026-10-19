# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""Keep existing POS Profiles selling as before now that ignored settings are enforced.

Until this release `force_price_from_customer_price_list`, `allow_zero_rated_items`
and `use_delivery_charges` were stored but never read. Each profile is set to
what it actually did, so nothing changes until an admin opts in. Only POS
Profile configuration is touched; no transactions.
"""

import frappe

DONE_KEY = "xpos_profile_settings_activated"


def execute():
	# A marker rather than value checks: after the first run an admin may have
	# deliberately re-enabled a setting, and a rerun must not undo that.
	if frappe.db.get_default(DONE_KEY):
		return

	for profile in frappe.get_all("POS Profile", fields=["name", "company"]):
		values = {
			# Prices always came from the profile's own price list.
			"force_price_from_customer_price_list": 0,
			# Zero-price sale lines were always accepted.
			"allow_zero_rated_items": 1,
		}
		if delivery_was_available(profile.name, profile.company):
			values["use_delivery_charges"] = 1
		# Bump `modified` so Electron tills (incremental pull) fetch the new columns.
		frappe.db.set_value("POS Profile", profile.name, values)

	frappe.db.set_default(DONE_KEY, "1")
	frappe.clear_cache(doctype="POS Profile")


def delivery_was_available(profile: str, company: str) -> bool:
	"""Whether the profile could already charge delivery: deterministic evidence only."""
	if frappe.db.get_value("POS Profile", profile, "auto_set_delivery_charges"):
		return True

	from xpos.x_pos.doctype.delivery_charges.delivery_charges import get_applicable_delivery_charges

	# The delivery button listed every enabled charge of the company that is
	# either linked to this profile or not restricted to any profile.
	if get_applicable_delivery_charges(company, profile):
		return True

	for doctype in ("Sales Invoice", "POS Invoice"):
		if frappe.db.has_column(doctype, "pos_delivery_charges") and frappe.db.exists(
			doctype, {"pos_profile": profile, "pos_delivery_charges": ("is", "set")}
		):
			return True
	return False
