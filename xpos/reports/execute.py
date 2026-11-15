# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""Run a catalog report through Frappe's own report runner, after the POS-level checks."""

import frappe
from frappe import _
from frappe.desk.query_report import _run

from xpos.reports import catalog, scope
from xpos.reports.catalog import entry_filters, resolve_entry
from xpos.reports.policy import ensure_not_blind, requested_profiles

PURPOSES = ("view", "export", "print")
MAX_RESULT_ROWS = 100_000


def deny():
	frappe.throw(_("You do not have access to this report."), frappe.PermissionError)


def require_entry(identifier: str | None) -> dict:
	entry = resolve_entry(identifier)
	if not entry:
		deny()
	return entry


REVEALS_EXPECTED = ("POS Shift Reconciliation", "Sales By Payment Mode")
MODE_FIELDS = {"Company and Warehouse": ("Company", "Warehouse"), "Company": ("Company",), "None": ()}


def apply_scope(entry: dict, filters: dict) -> None:
	"""Hold the request inside the caller's scope; the filters can narrow it, never widen it.

	A restricted user may only run a report that limits its own rows and totals (``scope.verified``).
	Every Company/Warehouse filter the report defines is checked, whatever it is named, and a lone
	permitted company is filled in when the request leaves it out. Report SQL is never rewritten.
	"""
	report_scope = scope.enforce(filters)
	if not report_scope.restricted:
		return
	if not entry["scope"]["verified"]:
		deny()

	checked = MODE_FIELDS[entry["scope"]["mode"]]
	for field in entry_filters(entry):
		doctype = field.get("doctype")
		if field["type"] not in ("link", "multi-link") or doctype not in checked:
			continue
		name = field["fieldname"]
		values = scope.as_list(filters.get(name))
		allows = report_scope.allows_company if doctype == "Company" else report_scope.allows_warehouse
		if any(not allows(value) for value in values):
			frappe.throw(
				_("You are not permitted to report on {0} {1}.").format(_(doctype), ", ".join(values)),
				frappe.PermissionError,
			)
		allowed = report_scope.companies if doctype == "Company" else report_scope.warehouses
		if not values and doctype == "Company" and allowed is not None and len(allowed) == 1:
			filters[name] = next(iter(allowed))


def run(identifier: str, filters, purpose: str = "view") -> dict:
	entry = require_entry(identifier)
	if purpose not in PURPOSES:
		frappe.throw(_("Unknown report purpose: {0}").format(purpose))
	if entry["capability"]["state"] != "supported":
		frappe.throw(_("This report cannot be run from the POS yet."), frappe.ValidationError)
	if purpose == "export" and not entry["export"]["allowed"]:
		frappe.throw(_("You are not permitted to export this report."), frappe.PermissionError)
	if purpose == "print" and not entry["print"]["allowed"]:
		frappe.throw(_("You are not permitted to print this report."), frappe.PermissionError)

	filters = frappe.parse_json(filters) if filters else {}
	if not isinstance(filters, dict):
		frappe.throw(_("Report filters must be an object."))
	apply_scope(entry, filters)
	if entry["id"] in REVEALS_EXPECTED:
		ensure_not_blind(requested_profiles(filters))

	result = _run(report_name=entry["id"], filters=filters, are_default_filters=False)
	if len(result.get("result") or []) > MAX_RESULT_ROWS:
		frappe.throw(
			_("This report returned more than {0} rows. Narrow the filters and run it again.").format(
				MAX_RESULT_ROWS
			),
			frappe.ValidationError,
		)
	return result


DIRECT_RUNNERS = (
	"frappe.desk.query_report.run",
	"frappe.desk.query_report.export_query",
	"frappe.desk.query_report.background_enqueue_run",
)


def guard_direct_request():
	"""``before_request``: the desk runner must not be a way round the scope a POS report is held to.

	Only reports the XPOS catalog serves are judged; other reports stay under Frappe's own checks.
	"""
	path = getattr(frappe.request, "path", "") or ""
	if not path.startswith("/api/method/") or path[len("/api/method/") :] not in DIRECT_RUNNERS:
		return
	name = frappe.form_dict.get("report_name")
	if not name or frappe.session.user == "Guest" or not scope.get_scope().restricted:
		return
	declared = catalog.declarations().get(name)
	if not declared:
		return
	report = frappe.get_cached_doc("Report", name)
	if not catalog.scope_verified(report, declared):
		deny()
