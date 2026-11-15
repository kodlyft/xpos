# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""The POS report catalog: which reports exist for a user, and what each can do.

A report is eligible only when it is in the X POS module or enabled by an
XPOS Report Setting and the user passes Frappe's own report checks and the POS
permission the declaration asks for. Entries are plain JSON; nothing in them is run.
"""

import hashlib
import json
import re

import frappe
from frappe import _

from xpos.api.auth import (
	ALL_PERMISSION_KEYS,
	all_enabled,
	get_role_permissions,
	get_user_pos_role,
	is_superuser,
)
from xpos.reports import bundled, scope
from xpos.reports.filters import FilterError, build_filters

CATEGORIES = ("Inventory", "Sales", "Purchasing", "Operations", "Accounting", "Other")
SCOPE_MODES = ("Company and Warehouse", "Company", "None")
VERSION_KEY = "xpos_report_catalog_version"
CACHE_TTL = 600
SETTING_FIELDS = (
	"category",
	"description",
	"pos_permission",
	"scope_mode",
	"scope_verified",
	"filter_provider",
	"allow_export",
	"thermal_print",
	"summary",
	"chart",
	"aliases",
)


def slugify(value: str) -> str:
	return re.sub(r"^-+|-+$", "", re.sub(r"[^a-z0-9]+", "-", value.lower()))


def catalog_version() -> str:
	version = frappe.cache.get_value(VERSION_KEY, shared=True)
	if not version:
		version = bump_version()
	return version


def bump_version(doc=None, method=None) -> str:
	"""Invalidate every cached catalog. Registered as a doc event for the records a catalog depends on."""
	version = frappe.generate_hash(length=10)
	frappe.cache.set_value(VERSION_KEY, version, shared=True)
	return version


def permission_map(user: str) -> dict:
	if user == "Administrator" or is_superuser(user):
		return all_enabled()
	return get_role_permissions(get_user_pos_role(user))


def declarations() -> dict[str, dict]:
	"""Reports of the X POS module overlaid with XPOS Report Setting rows; a disabled row removes the report."""
	declared = {}
	bundled_meta = {name.lower(): meta for name, meta in bundled.BUNDLED.items()}
	for name in frappe.get_all("Report", filters={"module": bundled.MODULE, "disabled": 0}, pluck="name"):
		declared[name] = {
			"report": name,
			"filter_provider": bundled.PROVIDER,
			**bundled_meta.get(name.lower(), {}),
		}

	fields = ["name", "enabled", *SETTING_FIELDS]
	for setting in frappe.get_all("XPOS Report Setting", fields=fields, ignore_permissions=True):
		if not setting.enabled:
			declared.pop(setting.name, None)
			continue
		decl = declared.setdefault(setting.name, {"report": setting.name})
		for field in SETTING_FIELDS:
			value = setting.get(field)
			if value in (None, "") or (field == "thermal_print" and not value):
				continue
			decl[field] = value
	return declared


def reference_report(report):
	while report.report_type == "Custom Report":
		report = frappe.get_cached_doc("Report", report.reference_report)
	return report


def aliases_of(decl: dict) -> list[str]:
	aliases = decl.get("aliases") or []
	if isinstance(aliases, str):
		aliases = aliases.splitlines()
	return [slugify(a) for a in aliases if a and slugify(a)]


def assess(report, decl: dict) -> tuple[str, list[str], list[dict] | None]:
	"""(capability state, reasons, filters) for a report; independent of who is asking."""
	reference = reference_report(report)
	if reference.report_type not in ("Script Report", "Query Report"):
		return "unsupported", ["report_type_not_supported"], None
	if report.prepared_report:
		return "unsupported", ["prepared_report_not_supported"], None
	try:
		provider = decl.get("filter_provider") or declarations().get(reference.name, {}).get(
			"filter_provider"
		)
		return "supported", [], build_filters(reference, provider)
	except FilterError as error:
		reason = str(error)
		state = (
			"unsupported"
			if reason in ("provider_not_registered", "invalid_provider_output")
			else "adapter_required"
		)
		return state, [reason], None


def scope_verified(report, decl: dict) -> bool:
	"""Whether the report itself limits its rows and totals to the caller's scope.

	Standard reports of the X POS module ship that guarantee in code; any other report has it only
	when an administrator ticked ``scope_verified`` on its XPOS Report Setting. Never client-declared.
	"""
	if report.module == bundled.MODULE and report.is_standard == "Yes":
		return True
	return bool(decl.get("scope_verified"))


def base_entry(name: str, decl: dict) -> dict | None:
	if not frappe.db.exists("Report", name):
		return None
	report = frappe.get_cached_doc("Report", name)
	reference = reference_report(report)
	state, reasons, _filters = assess(report, decl)
	title = report.report_name or report.name
	return {
		"id": report.name,
		"slug": slugify(report.name),
		"aliases": aliases_of(decl),
		"title": _(title),
		"description": _(decl["description"]) if decl.get("description") else "",
		"category": decl.get("category") if decl.get("category") in CATEGORIES else "Other",
		"report_type": report.report_type,
		"ref_doctype": reference.ref_doctype,
		"capability": {"state": state, "reasons": reasons},
		"permissions": {"pos_permission": decl.get("pos_permission") or None},
		"scope": {
			"mode": decl.get("scope_mode")
			if decl.get("scope_mode") in SCOPE_MODES
			else "Company and Warehouse",
			"verified": scope_verified(report, decl),
		},
		"execution": {
			"prepared": "unsupported" if report.prepared_report else "none",
			"summary": decl.get("summary") or "runtime",
			"chart": decl.get("chart") or "runtime",
		},
		"export": {"declared": bool(decl.get("allow_export", True))},
		"print": {"thermal": bool(decl.get("thermal_print"))},
	}


def base_entries() -> list[dict]:
	key = f"xpos_report_catalog_base:{catalog_version()}"
	cached = frappe.cache.get_value(key)
	if cached is not None:
		return cached
	entries = [e for name, decl in declarations().items() if (e := base_entry(name, decl))]
	frappe.cache.set_value(key, entries, expires_in_sec=CACHE_TTL)
	return entries


def user_can_see(entry: dict, user: str, permissions: dict) -> bool:
	if entry["capability"]["state"] == "unsupported":
		return False
	report = frappe.get_cached_doc("Report", entry["id"])
	reference = reference_report(report)
	if report.disabled or reference.disabled or not reference.is_permitted():
		return False
	if not frappe.has_permission(entry["ref_doctype"], "report", user=user):
		return False
	key = entry["permissions"]["pos_permission"]
	if key and (key not in ALL_PERMISSION_KEYS or not permissions.get(key)):
		return False
	return entry["scope"]["verified"] or not scope.get_scope(user).restricted


def finish_entry(entry: dict, user: str) -> dict:
	entry = json.loads(json.dumps(entry))
	ref = entry["ref_doctype"]
	entry["export"] = {
		"allowed": bool(entry["export"]["declared"] and frappe.permissions.can_export(ref)),
	}
	can_print = frappe.has_permission(ref, "print", user=user)
	entry["print"]["allowed"] = bool(can_print)
	return entry


def user_key(user: str, permissions: dict) -> str:
	restricted = scope.get_scope(user).restricted
	fingerprint = json.dumps(
		[user, sorted(frappe.get_roles(user)), sorted(k for k, v in permissions.items() if v), restricted]
	)
	return hashlib.sha1(fingerprint.encode()).hexdigest()


def get_catalog() -> list[dict]:
	"""The session user's reports."""
	user = frappe.session.user
	if user == "Guest":
		return []
	permissions = permission_map(user)
	key = f"xpos_report_catalog:{catalog_version()}:{user_key(user, permissions)}"
	cached = frappe.cache.get_value(key)
	if cached is not None:
		return cached

	entries = [finish_entry(e, user) for e in base_entries() if user_can_see(e, user, permissions)]
	entries.sort(key=lambda e: (CATEGORIES.index(e["category"]), e["title"]))
	frappe.cache.set_value(key, entries, expires_in_sec=CACHE_TTL)
	return entries


def resolve_entry(identifier: str | None) -> dict | None:
	"""The user's catalog entry for a canonical id, slug or alias; None if absent or not permitted."""
	if not identifier or not isinstance(identifier, str):
		return None
	wanted = identifier.strip()
	slug = slugify(wanted)
	entries = get_catalog()
	for entry in entries:
		if entry["id"] == wanted:
			return entry
	for entry in entries:
		if slug == entry["slug"] or slug in entry["aliases"]:
			return entry
	return None


def entry_filters(entry: dict) -> list[dict]:
	"""Fresh filters for an entry (defaults such as today's date are never cached)."""
	declaration = declarations().get(entry["id"], {})
	report = frappe.get_cached_doc("Report", entry["id"])
	_state, _reasons, filters = assess(report, declaration)
	return apply_saved_defaults(report, filters or [])


def apply_saved_defaults(report, filters: list[dict]) -> list[dict]:
	"""A Custom Report's saved filter values become the defaults of the matching filters."""
	if report.report_type != "Custom Report" or not report.json:
		return filters
	try:
		saved = frappe.parse_json(report.json).get("filters") or {}
	except ValueError:
		return filters
	for field in filters:
		value = saved.get(field["fieldname"]) if isinstance(saved, dict) else None
		if isinstance(value, str | int | float | list) and not isinstance(value, bool):
			field["defaultValue"] = value
	return filters
