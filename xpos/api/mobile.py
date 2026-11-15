# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""Read-only bootstrap for the XPOS Mobile (Android) app.

The browser gets its boot data from server-rendered HTML; a native shell has no page, so it asks
once, right after a normal Frappe login. Nothing here is accepted from the client except an
optional POS Profile *name*, and everything returned is derived from existing checks.
"""

import math
import time
from decimal import Decimal

import frappe
from frappe import _

from xpos.api.auth import get_my_pos_permissions
from xpos.api.customers import can_manage_customers
from xpos.api.profiles import resolve_pos_profile
from xpos.api.shifts import get_open_shift_rows
from xpos.x_pos.doctype.pos_closing_shift.closing_processing.reclass import reference_required_modes
from xpos.x_pos.gift_cards import gift_card_config

SUPPORTED_MAJOR = 16
# Longest the app may accept offline unlock before it must reach the server again.
LEASE_TTL_SECONDS = 24 * 60 * 60
MAX_MINOR_DIGITS = 4


def major_version(version: str | None) -> int | None:
	try:
		return int(str(version).split(".")[0])
	except (TypeError, ValueError):
		return None


def minor_digits_for(currency: str | None) -> int:
	"""Minor units for a currency, from its smallest fraction (0.01 -> 2, 0.001 -> 3, none -> 2)."""
	fraction = (
		frappe.get_cached_value("Currency", currency, "smallest_currency_fraction_value")
		if currency
		else None
	)
	if not fraction:
		return 2
	value = Decimal(str(fraction))
	if value <= 0 or value >= 1:
		return 0
	return min(MAX_MINOR_DIGITS, max(0, math.ceil(-math.log10(value))))


def erpnext_version() -> str | None:
	try:
		return frappe.get_attr("erpnext.__version__")
	except Exception:
		return None


def profile_choices(user: str) -> list[dict]:
	"""Enabled POS Profiles the user is listed on (the same boundary resolve_pos_profile enforces)."""
	return frappe.db.sql(
		"""
		SELECT DISTINCT p.name, p.company, p.warehouse
		FROM `tabPOS Profile` p
		INNER JOIN `tabPOS Profile User` u ON u.parent = p.name
		WHERE p.disabled = 0 AND u.user = %(user)s
		ORDER BY p.name
		""",
		{"user": user},
		as_dict=True,
	)


def payment_modes_for(profile_name: str) -> list[dict]:
	"""Payment modes configured on the profile, with the Mode of Payment type (Cash / Bank / General)."""
	rows = frappe.get_all(
		"POS Payment Method",
		filters={"parent": profile_name, "parenttype": "POS Profile"},
		fields=["mode_of_payment", "default"],
		order_by="idx",
	)
	company = frappe.get_cached_value("POS Profile", profile_name, "company")
	needs_reference = reference_required_modes(company)
	for row in rows:
		row["type"] = frappe.get_cached_value("Mode of Payment", row["mode_of_payment"], "type")
		row["default"] = bool(row["default"])
		row["requires_reference"] = row["mode_of_payment"] in needs_reference
	return rows


def open_shift_for(user: str, profile_name: str) -> str | None:
	"""Name of the user's open POS Opening Shift on this profile, if any."""
	for shift in get_open_shift_rows(user):
		if shift.get("pos_profile") == profile_name:
			return shift.get("name")
	return None


@frappe.whitelist(methods=["GET", "POST"])
def bootstrap(pos_profile: str | None = None) -> dict:
	"""Authorized context for the signed-in cashier; denied for guests and unassigned users."""
	user = frappe.session.user
	if user == "Guest":
		frappe.throw(_("Login required"), frappe.PermissionError)

	# Existing boundary: the profile must list this user (or the user is a superuser).
	profile = resolve_pos_profile(pos_profile, user)

	frappe_version = frappe.__version__
	erp_version = erpnext_version()  # never the Frappe version: None means "could not be determined"
	currency = profile.get("currency") or frappe.get_cached_value(
		"Company", profile.company, "default_currency"
	)

	return {
		"user": user,
		"full_name": frappe.get_cached_value("User", user, "full_name"),
		"site": frappe.local.site,
		"pos_profile": profile.name,
		"company": profile.company,
		"warehouse": profile.warehouse,
		"currency": currency,
		"price_list": profile.get("selling_price_list")
		or frappe.db.get_single_value("Selling Settings", "selling_price_list"),
		"customer": profile.get("customer"),
		"customer_name": frappe.get_cached_value("Customer", profile.get("customer"), "customer_name")
		if profile.get("customer")
		else None,
		"can_create_customer": can_manage_customers("create"),
		"can_edit_customer": can_manage_customers("write"),
		"profiles": profile_choices(user),
		"payment_modes": payment_modes_for(profile.name),
		"open_shift": open_shift_for(user, profile.name),
		"minor_digits": minor_digits_for(currency),
		"permissions": get_my_pos_permissions(profile.name),
		"gift_cards": gift_card_config(profile),
		"frappe_version": frappe_version,
		"erpnext_version": erp_version,
		"supported": major_version(erp_version) == SUPPORTED_MAJOR
		and major_version(frappe_version) == SUPPORTED_MAJOR,
		"lease_ttl_seconds": LEASE_TTL_SECONDS,
		"issued_at": int(time.time() * 1000),
	}
