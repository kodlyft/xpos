# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

import frappe

from xpos.x_pos.doctype.referral_code.referral_code import add_customer_company_unique


def execute():
	"""One Referral Code per customer and company; existing duplicates are reported, not touched."""
	duplicates = add_customer_company_unique()
	if duplicates:
		print(
			f"Referral Code: {len(duplicates)} customer/company pairs have more than one code; "
			"the unique index is added once they are resolved."
		)
	frappe.clear_cache(doctype="Referral Code")
