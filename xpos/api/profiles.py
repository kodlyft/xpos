# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

import frappe
from frappe import _

from xpos.api.auth import is_superuser


def resolve_pos_profile(pos_profile: str | None = None, user: str | None = None):
	"""Load a POS Profile the given user is allowed to act through."""
	user = user or frappe.session.user

	if isinstance(pos_profile, dict):
		frappe.throw(
			_("A POS Profile must be referenced by name, not supplied as data."),
			frappe.PermissionError,
		)

	profile_name = (pos_profile or "").strip() if isinstance(pos_profile, str) else None
	if not profile_name:
		profile_name = get_default_pos_profile(user)

	if not profile_name:
		frappe.throw(_("No POS Profile is assigned to {0}.").format(user))

	if not frappe.db.exists("POS Profile", profile_name):
		frappe.throw(_("POS Profile {0} does not exist.").format(profile_name))

	if not user_may_use_profile(profile_name, user):
		frappe.throw(
			_("{0} is not permitted to use POS Profile {1}.").format(user, profile_name),
			frappe.PermissionError,
		)

	return frappe.get_cached_doc("POS Profile", profile_name)


def user_may_use_profile(profile_name: str, user: str | None = None) -> bool:
	"""Whether `user` appears in the profile's `applicable_for_users` rows."""
	user = user or frappe.session.user

	if user == "Guest":
		return False
	if is_superuser(user):
		return True

	return bool(
		frappe.db.exists(
			"POS Profile User",
			{"parent": profile_name, "parenttype": "POS Profile", "user": user},
		)
	)


def get_default_pos_profile(user: str | None = None) -> str | None:
	"""Return the enabled POS Profile assigned to `user`, preferring their default."""
	user = user or frappe.session.user

	rows = frappe.db.sql(
		"""
		SELECT u.parent
		FROM `tabPOS Profile User` u
		INNER JOIN `tabPOS Profile` p ON p.name = u.parent
		WHERE u.user = %(user)s AND u.parenttype = 'POS Profile' AND p.disabled = 0
		ORDER BY u.`default` DESC, u.idx ASC
		LIMIT 1
		""",
		{"user": user},
	)
	if rows:
		return rows[0][0]

	if is_superuser(user):
		return frappe.db.get_single_value("POS Settings", "pos_profile") or frappe.db.get_value(
			"POS Profile", {"disabled": 0}, "name"
		)

	return None


def ensure_profile_allows(profile, flag: str, label: str) -> None:
	"""Raise unless `flag` is enabled on the server-loaded `profile`."""
	if not frappe.utils.cint(profile.get(flag)):
		frappe.throw(_("{0} is disabled for POS Profile {1}.").format(label, profile.name))


def validate_offline_payment_modes(doc, method=None) -> None:
	allowed = {row.mode_of_payment for row in doc.get("payments") or []}
	seen = set()
	for row in doc.get("offline_payment_modes") or []:
		if row.mode_of_payment in seen:
			frappe.throw(_("Row {0}: {1} is listed twice.").format(row.idx, row.mode_of_payment))
		seen.add(row.mode_of_payment)
		if row.mode_of_payment not in allowed:
			frappe.throw(
				_("Row {0}: {1} is not one of this profile's payment methods.").format(
					row.idx, row.mode_of_payment
				)
			)
