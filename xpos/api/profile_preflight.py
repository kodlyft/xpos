# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""Read-only report of what the activated POS Profile settings change on a site.

Run before (or after) migrating::

    bench --site <site> execute xpos.api.profile_preflight.print_report

It reads configuration only and reports counts, never amounts. Duplicate Referral Codes,
which block referral creation, are listed by customer ID so an administrator can resolve them.
Nothing is written.
"""

import frappe
from frappe.utils import cint


def preflight_profile_settings() -> list[dict]:
	rows = []
	customers_with_discount = frappe.db.count("Customer", {"discount": (">", 0), "disabled": 0})
	customers_with_list = frappe.db.count("Customer", {"default_price_list": ("is", "set"), "disabled": 0})
	groups_with_list = frappe.db.count("Customer Group", {"default_price_list": ("is", "set")})
	items_with_purchase_uom = frappe.db.sql(
		"""SELECT COUNT(*) FROM `tabItem`
		WHERE disabled = 0 AND IFNULL(purchase_uom, '') != '' AND purchase_uom != stock_uom"""
	)[0][0]

	for profile in frappe.get_all("POS Profile", filters={"disabled": 0}, pluck="name"):
		pos = frappe.get_cached_doc("POS Profile", profile)

		def add(setting, enabled, change):
			rows.append({"pos_profile": profile, "setting": setting, "enabled": enabled, "change": change})

		add(
			"apply_customer_discount",
			cint(pos.get("apply_customer_discount")),
			f"{customers_with_discount} enabled customers have a Discount (%); it now becomes the invoice discount"
			if cint(pos.get("apply_customer_discount"))
			else "no change (off)",
		)
		add(
			"force_price_from_customer_price_list",
			cint(pos.get("force_price_from_customer_price_list")),
			f"{customers_with_list} customers and {groups_with_list} customer groups have their own price list; "
			"their sale lines now price from it"
			if cint(pos.get("force_price_from_customer_price_list"))
			else "no change: lines price from the profile list (the invoice header now says so too)",
		)
		add(
			"allow_zero_rated_items",
			cint(pos.get("allow_zero_rated_items")),
			"no change (zero-price lines allowed)"
			if cint(pos.get("allow_zero_rated_items"))
			else "zero-price sale lines, 100% discounts and zero-total sales are refused",
		)
		add(
			"hide_expected_amount",
			cint(pos.get("hide_expected_amount")),
			f"{blind_users(pos)} assigned users will close blind (their POS Role lacks View Expected Amount)"
			if cint(pos.get("hide_expected_amount"))
			else "no change (expected amounts shown)",
		)
		add(
			"auto_create_referral_for_new_customers",
			cint(pos.get("auto_create_referral_for_new_customers")),
			referral_change(pos)
			if cint(pos.get("auto_create_referral_for_new_customers"))
			else "no change (off)",
		)
		add(
			"default_purchase_uom",
			pos.get("default_purchase_uom") or "",
			(
				f"new purchase lines default to {pos.default_purchase_uom} where the item has that UOM"
				if pos.get("default_purchase_uom")
				else "no profile default"
			)
			+ f"; {items_with_purchase_uom} enabled items have a Purchase UOM other than their stock UOM "
			"and now default to it on purchase lines",
		)
		add(
			"print_format_rules",
			len(pos.get("print_format_rules") or []),
			print_change(pos),
		)
		add(
			"use_customer_credit",
			cint(pos.get("use_customer_credit")),
			credit_change(pos) if cint(pos.get("use_customer_credit")) else "no change (off)",
		)
		add(
			"use_cashback",
			cint(pos.get("use_cashback")),
			"not available: stays inert until its meaning is defined",
		)
	return rows


def blind_users(pos) -> int:
	from xpos.api.auth import DEFAULT_ROLE, get_role_permissions, is_superuser

	count = 0
	for row in pos.get("applicable_for_users") or []:
		if not row.user or is_superuser(row.user):
			continue
		if not get_role_permissions(row.get("pos_role") or DEFAULT_ROLE).get("view_expected_amount"):
			count += 1
	return count


def referral_change(pos) -> str:
	from xpos.api.customers import referral_setup_problem

	problem = referral_setup_problem(frappe.get_cached_doc("Company", pos.company))
	if problem:
		return f"setup incomplete, no codes will be created: {problem}"
	return "each customer created at the till gets a Referral Code"


def print_change(pos) -> str:
	from xpos.api.print_formats import usable_print_format

	rules = pos.get("print_format_rules") or []
	invalid = sum(1 for r in rules if not usable_print_format(r.print_format))
	default = pos.get("default_print_format")
	parts = [f"{len(rules)} customer-group rules" + (f" ({invalid} unusable)" if invalid else "")]
	parts.append(
		f"default {default}" if usable_print_format(default) else "default XPOS Thermal Receipt (fallback)"
	)
	return "online receipts now use " + ", ".join(parts)


def credit_change(pos) -> str:
	from xpos.api.customer_credit import credit_account_supported, invoice_receivable_account

	account = invoice_receivable_account(pos)
	if not credit_account_supported(pos.company, account):
		return "not usable: the receivable account is not in the company currency"
	receipts = frappe.db.count(
		"Payment Entry",
		{
			"docstatus": 1,
			"payment_type": "Receive",
			"company": pos.company,
			"paid_from": account,
			"unallocated_amount": (">", 0),
		},
	)
	notes = frappe.db.count(
		"Sales Invoice",
		{
			"docstatus": 1,
			"is_return": 1,
			"company": pos.company,
			"debit_to": account,
			"outstanding_amount": ("<", 0),
		},
	)
	return (
		f"cashiers can spend existing credit online: {receipts} open receipts and {notes} open credit notes"
	)


def print_report() -> None:
	"""Same report, printed as a table for ``bench execute``."""
	for row in preflight_profile_settings():
		print(f"{row['pos_profile']} | {row['setting']} = {row['enabled']} | {row['change']}")
	for row in referral_duplicates():
		print(f"Duplicate Referral Codes | customer {row.customer} | company {row.company} | {row.n} codes")


def referral_duplicates() -> list:
	"""Customer/company pairs with more than one Referral Code; they block referral creation."""
	return frappe.db.sql(
		"""SELECT customer, company, COUNT(*) AS n FROM `tabReferral Code`
		GROUP BY customer, company HAVING COUNT(*) > 1""",
		as_dict=True,
	)
