# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

import frappe
from frappe.modules.utils import sync_customizations


def execute():
	"""Keep the Coupon button on profiles that had it while it was tied to auto-fetch."""
	if not frappe.db.has_column("POS Profile", "auto_fetch_coupons_gifts"):
		return

	# Customizations sync after patches, so the new column may not exist yet.
	if not frappe.db.has_column("POS Profile", "allow_coupon_entry"):
		sync_customizations("xpos")

	profiles = frappe.get_all("POS Profile", filters={"auto_fetch_coupons_gifts": 1}, pluck="name")
	for profile in profiles:
		frappe.db.set_value("POS Profile", profile, "allow_coupon_entry", 1, update_modified=False)

	frappe.clear_cache(doctype="POS Profile")
	print(f"Enabled Allow coupon entry on {len(profiles)} POS Profile(s)")
