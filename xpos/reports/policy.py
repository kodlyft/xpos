# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""Who may see the figures a blind-closing drawer count must not reveal."""

import frappe
from frappe import _

from xpos.api.profile_rules import is_blind_closing


def requested_profiles(filters) -> set[str]:
	"""POS Profiles a request names directly, through ``pos_profile`` or ``pos_opening_shift``."""
	profiles = set()
	if filters.get("pos_profile"):
		profiles.add(filters["pos_profile"])
	if filters.get("pos_opening_shift"):
		profile = frappe.db.get_value("POS Opening Shift", filters["pos_opening_shift"], "pos_profile")
		if profile:
			profiles.add(profile)
	return profiles


def ensure_not_blind(pos_profiles, user: str | None = None) -> None:
	"""Refuse expected-drawer figures for a blind-closing profile, judged on every call."""
	if any(is_blind_closing(profile, user) for profile in set(pos_profiles) if profile):
		frappe.throw(_("Shift totals are hidden for blind-closing POS Profiles."), frappe.PermissionError)
