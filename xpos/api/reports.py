# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""Server-driven report catalog for the X POS report viewer.

The catalog, each report's filters and its capabilities come from ``xpos.reports``;
report data is produced by Frappe's own runner after the POS checks (permission,
scope, export) in :func:`xpos.reports.execute.run`.
"""

import frappe

from xpos.reports import catalog, execute


def company_default() -> str:
	"""Resolve the user's default company, mirroring the desk ``*.js`` defaults."""
	return frappe.defaults.get_user_default("Company") or frappe.defaults.get_global_default("company") or ""


def apply_company_defaults(filters: list) -> list:
	"""Inject the user's default company into the company filter at request time."""
	company = company_default()
	if not company:
		return filters
	for field in filters:
		if field.get("fieldname") == "company" and "defaultValue" not in field:
			field["defaultValue"] = company
	return filters


@frappe.whitelist()
def get_report_catalog() -> list[dict]:
	"""Every report the current user may open from the POS, with its capabilities."""
	return catalog.get_catalog()


@frappe.whitelist()
def get_report_meta(report: str) -> dict:
	"""The catalog entry and filter configuration for a report id, slug or alias.

	Columns are intentionally omitted - they arrive with the data, so no report execution
	is needed here.
	"""
	entry = execute.require_entry(report)
	filters = catalog.entry_filters(entry) if entry["capability"]["state"] == "supported" else []
	return {**entry, "filters": apply_company_defaults(filters)}


@frappe.whitelist()
def run_report(report: str, filters: str | dict | None = None, purpose: str = "view") -> dict:
	"""Run a catalog report for ``view``, ``export`` or ``print``; the purpose is checked here."""
	return execute.run(report, filters, purpose)


@frappe.whitelist()
def get_report_candidates() -> list[dict]:
	"""Installed reports an administrator could enable; a suggestion list, never an enablement."""
	frappe.only_for("System Manager")
	declared = set(catalog.declarations())
	candidates = []
	for report in frappe.get_all(
		"Report",
		filters={"disabled": 0, "report_type": ("in", ["Script Report", "Query Report", "Custom Report"])},
		fields=["name", "report_type", "ref_doctype", "module"],
		order_by="name",
	):
		if report.name in declared:
			continue
		doc = frappe.get_cached_doc("Report", report.name)
		state, reasons, _filters = catalog.assess(doc, {})
		candidates.append({**report, "capability": {"state": state, "reasons": reasons}})
	return candidates


@frappe.whitelist()
def check_report_compatibility(report: str, filter_provider: str | None = None) -> dict:
	frappe.only_for("System Manager")
	doc = frappe.get_doc("Report", report)
	state, reasons, filters = catalog.assess(doc, {"filter_provider": filter_provider})
	return {"state": state, "reasons": reasons, "filters": filters or []}
