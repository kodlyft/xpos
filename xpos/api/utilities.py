# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""
POS Utilities API.

- Selling price lists
- App info & version
- Sales person names
- Tax inclusive settings
- Language options
- Item search configuration
"""

import platform
import re
import subprocess

import frappe
from frappe.utils import cint

BASE_ITEM_SEARCH_FIELDS = ("name", "item_name", "item_code")

ITEM_SEARCH_FIELDTYPES = frozenset(
	{"Data", "Link", "Dynamic Link", "Long Text", "Select", "Small Text", "Text", "Text Editor"}
)

SAFE_FIELDNAME = re.compile(r"^[a-z_][a-z0-9_]*$")


@frappe.whitelist()
def get_version_info():
	"""Returns version and system info for the About dialog."""

	xpos_version = "0.0.1"
	try:
		import xpos

		xpos_version = xpos.__version__
	except Exception:
		pass

	frappe_version = ""
	erpnext_version = ""
	try:
		import frappe as _frappe

		frappe_version = _frappe.__version__
	except Exception:
		pass
	try:
		import erpnext

		erpnext_version = erpnext.__version__
	except Exception:
		pass

	# Git info for xpos app
	git_branch = ""
	git_hash = ""
	git_date = ""
	try:
		import os

		app_path = os.path.join(frappe.get_app_path("xpos"), "..")
		git_branch = (
			subprocess.check_output(  # nosemgrep: frappe-subprocess-exec - static argument list, no user input
				["git", "rev-parse", "--abbrev-ref", "HEAD"],
				cwd=app_path,
				stderr=subprocess.DEVNULL,
			)
			.decode()
			.strip()
		)
		git_hash = (
			subprocess.check_output(  # nosemgrep: frappe-subprocess-exec - static argument list, no user input
				["git", "rev-parse", "--short", "HEAD"],
				cwd=app_path,
				stderr=subprocess.DEVNULL,
			)
			.decode()
			.strip()
		)
		git_date = (
			subprocess.check_output(  # nosemgrep: frappe-subprocess-exec - static argument list, no user input
				["git", "log", "-1", "--format=%ci"],
				cwd=app_path,
				stderr=subprocess.DEVNULL,
			)
			.decode()
			.strip()
		)
	except Exception:
		pass

	return {
		"xpos_version": xpos_version,
		"frappe_version": frappe_version,
		"erpnext_version": erpnext_version,
		"git_branch": git_branch,
		"git_hash": git_hash,
		"git_date": git_date,
		"python_version": platform.python_version(),
		"os_info": f"{platform.system()} {platform.release()}",
		"site_name": frappe.local.site,
	}


@frappe.whitelist()
def get_selling_price_lists():
	"""Lists all selling price lists."""

	return frappe.get_all(
		"Price List",
		filters={"selling": 1, "enabled": 1},
		fields=["name"],
		order_by="name asc",
	)


@frappe.whitelist()
def get_pos_profile_tax_inclusive(pos_profile: str):
	"""Returns tax inclusive flag for a POS Profile."""

	try:
		return cint(frappe.db.get_value("POS Profile", pos_profile, "tax_inclusive"))
	except Exception:
		return 0


@frappe.whitelist()
def get_active_pos_profile(user: str | None = None):
	"""Returns the active POS Profile for a user."""

	user = user or frappe.session.user

	profiles = frappe.db.sql(
		"""
		SELECT DISTINCT p.name, p.company, p.currency, p.warehouse
		FROM `tabPOS Profile` p
		INNER JOIN `tabPOS Profile User` u ON u.parent = p.name
		WHERE p.disabled = 0 AND u.user = %(user)s
		ORDER BY u.default DESC, p.name ASC
		LIMIT 1
		""",
		{"user": user},
		as_dict=True,
	)

	if profiles:
		return frappe.get_cached_doc("POS Profile", profiles[0].name).as_dict()
	return None


def get_profile_setting(profile: str, setting: str, default=None):
	"""Helper to get a setting from POS Profile."""
	try:
		return frappe.get_cached_value("POS Profile", profile, setting) or default
	except Exception:
		return default


@frappe.whitelist()
def get_default_warehouse(company: str | None = None):
	"""Return the default warehouse, preferring Stock Settings over the Company default."""

	if not company:
		company = frappe.defaults.get_user_default("company")
	if not company:
		return None

	warehouse = frappe.db.get_single_value("Stock Settings", "default_warehouse")
	if warehouse:
		return warehouse
	return frappe.db.get_value("Company", company, "default_warehouse_for_sales_return")


def get_invoice_type():
	"""Returns the invoice type based on POS settings."""
	return frappe.get_single_value("POS Settings", "invoice_type") or "Sales Invoice"


def get_item_search_settings() -> dict:
	"""Site-wide item search configuration, read from POS Settings."""
	cached = getattr(frappe.local, "xpos_item_search_settings", None)
	if cached is not None:
		return cached

	settings = frappe.get_cached_doc("POS Settings")
	meta = frappe.get_meta("Item")

	fields = list(BASE_ITEM_SEARCH_FIELDS)
	seen = set(fields)

	for row in settings.get("pos_search_fields") or []:
		fieldname = (row.get("fieldname") or "").strip()
		if not fieldname:
			label = (row.get("field") or "").strip()
			match = next((df for df in meta.fields if df.label == label), None)
			fieldname = match.fieldname if match else ""

		if not fieldname or fieldname in seen or not SAFE_FIELDNAME.match(fieldname):
			continue

		docfield = meta.get_field(fieldname)
		if not docfield or docfield.fieldtype not in ITEM_SEARCH_FIELDTYPES:
			continue
		if docfield.get("is_virtual"):
			continue

		seen.add(fieldname)
		fields.append(fieldname)

	config = {
		"fields": fields,
		"item_search_limit": cint(settings.get("item_search_limit")),
		"search_serial_no": cint(settings.get("search_serial_no")),
		"search_batch_no": cint(settings.get("search_batch_no")),
	}
	frappe.local.xpos_item_search_settings = config
	return config


def is_pos_cashier(user: str | None = None, pos_profile: str | None = None) -> bool:
	"""Return whether ``user`` may settle (close) bills on the Cashier screen."""
	user = user or frappe.session.user

	if user == "Administrator" or "System Manager" in frappe.get_roles(user):
		return True

	if not frappe.db.has_column("POS Profile User", "is_cashier"):
		return True

	if not pos_profile:
		pos_profile = frappe.db.get_value(
			"POS Profile User", {"user": user}, "parent"
		) or frappe.db.get_single_value("POS Settings", "pos_profile")

	if not pos_profile:
		return False

	return bool(
		frappe.db.get_value(
			"POS Profile User",
			{"parent": pos_profile, "parenttype": "POS Profile", "user": user},
			"is_cashier",
		)
	)


def can_close_shift(user: str | None = None, pos_profile: str | None = None) -> bool:
	"""Return whether ``user`` may close a cashier/sales shift (the ``close_shift`` right)."""
	from xpos.api.auth import user_has_pos_permission

	return user_has_pos_permission("close_shift", user, pos_profile)


def pos_profile_flag(pos_profile: str | None, fieldname: str) -> bool:
	"""Read a POS Profile checkbox, treating a not-yet-migrated column as off."""
	if not pos_profile:
		return False
	if not frappe.db.has_column("POS Profile", fieldname):
		return False
	return bool(frappe.db.get_value("POS Profile", pos_profile, fieldname))


def can_recall_other_shift_tabs(pos_profile: str | None = None, user: str | None = None) -> bool:
	"""Return whether ``user`` may pull open tabs raised on another shift."""
	from xpos.api.auth import user_has_pos_permission

	if not pos_profile_flag(pos_profile, "allow_open_tab_recall"):
		return False

	return user_has_pos_permission("recall_other_shift_tabs", user, pos_profile)


def can_settle_outstanding(pos_profile: str | None = None, user: str | None = None) -> bool:
	"""Return whether ``user`` may settle a past unpaid invoice from the POS."""
	from xpos.api.auth import user_has_pos_permission

	if not pos_profile_flag(pos_profile, "allow_outstanding_settlement"):
		return False

	return user_has_pos_permission("settle_outstanding_invoice", user, pos_profile)
