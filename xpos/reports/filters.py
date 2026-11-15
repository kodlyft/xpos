# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""Turn a Report into the serializable filter list the POS viewer renders.

Order of authority: the Report's structured ``filters`` table, then an allow-listed
filter provider, then nothing. A report whose filters exist only in its desk
JavaScript is reported as ``adapter_required``; that JavaScript is never executed.
"""

import datetime
import re
from pathlib import Path

import frappe
from frappe.utils import cint, flt, today

FILTER_TYPES = {"link", "multi-link", "date", "integer", "float", "select", "text"}
FIELDTYPE_MAP = {
	"Link": "link",
	"Date": "date",
	"Data": "text",
	"Int": "integer",
	"Float": "float",
	"Currency": "float",
	"Select": "select",
}
FIELDNAME = re.compile(r"^[a-z_][a-z0-9_]*$")
JS_FILTERS = re.compile(r"\bfilters\s*:\s*\[\s*[^\]\s]")


class FilterError(Exception):
	"""A filter definition the POS cannot render safely; the message is the capability reason."""


def structured_filters(report) -> list[dict]:
	filters = []
	for row in report.get("filters") or []:
		filter_type = FIELDTYPE_MAP.get(row.fieldtype)
		if not filter_type:
			raise FilterError(f"unsupported_filter_type:{row.fieldname}:{row.fieldtype}")
		field = {
			"fieldname": row.fieldname,
			"label": row.label or row.fieldname,
			"type": filter_type,
			"required": bool(row.mandatory),
		}
		if filter_type == "link":
			field["doctype"] = row.options
		elif filter_type == "select":
			field["options"] = [
				{"label": option, "value": option}
				for option in (row.options or "").split("\n")
				if option.strip()
			]
		default = default_value(row.default, filter_type)
		if default is not None:
			field["defaultValue"] = default
		filters.append(field)
	return add_dependencies(filters)


def default_value(raw, filter_type: str):
	if raw in (None, ""):
		return None
	if filter_type == "date":
		return today() if str(raw).strip().lower() == "today" else str(raw)
	if filter_type == "integer":
		return cint(raw)
	if filter_type == "float":
		return flt(raw)
	return str(raw)


def add_dependencies(filters: list[dict]) -> list[dict]:
	"""A Warehouse link beside a Company filter lists only that company's leaf warehouses."""
	company = next((f for f in filters if f["type"] == "link" and f.get("doctype") == "Company"), None)
	if not company:
		return filters
	for field in filters:
		if field.get("doctype") != "Warehouse" or field["type"] not in ("link", "multi-link"):
			continue
		if field.get("getQueryFilters"):
			continue
		field["getQueryFilters"] = {"company": f"${company['fieldname']}"}
		if field["type"] == "link":
			field["getQueryFilters"]["is_group"] = 0
		company.setdefault("clears", [])
		if field["fieldname"] not in company["clears"]:
			company["clears"].append(field["fieldname"])
	return filters


def validate_provider_output(filters) -> list[dict]:
	"""Accept only plain JSON data in the known filter shape; anything else is refused."""
	if not isinstance(filters, list):
		raise FilterError("invalid_provider_output")

	names = {f.get("fieldname") for f in filters if isinstance(f, dict)}
	clean = []
	for field in filters:
		if not isinstance(field, dict):
			raise FilterError("invalid_provider_output")
		fieldname = field.get("fieldname")
		if not isinstance(fieldname, str) or not FIELDNAME.match(fieldname) or fieldname not in names:
			raise FilterError("invalid_provider_output")
		if field.get("type") not in FILTER_TYPES or not isinstance(field.get("label"), str):
			raise FilterError(f"unsupported_filter_type:{fieldname}:{field.get('type')}")

		out = {"fieldname": fieldname, "label": field["label"], "type": field["type"]}
		out["required"] = bool(field.get("required"))
		if field["type"] in ("link", "multi-link"):
			if not isinstance(field.get("doctype"), str):
				raise FilterError("invalid_provider_output")
			out["doctype"] = field["doctype"]
		if "defaultValue" in field:
			default = field["defaultValue"]
			if isinstance(default, datetime.date):
				default = default.isoformat()
			if isinstance(default, bool) or not isinstance(default, str | int | float | list):
				raise FilterError("invalid_provider_output")
			out["defaultValue"] = default
		if field["type"] == "select":
			options = field.get("options")
			if not isinstance(options, list) or not all(
				isinstance(o, dict) and isinstance(o.get("label"), str) and isinstance(o.get("value"), str)
				for o in options
			):
				raise FilterError("invalid_provider_output")
			out["options"] = [{"label": o["label"], "value": o["value"]} for o in options]
		if "getQueryFilters" in field:
			out["getQueryFilters"] = validate_query_filters(field["getQueryFilters"], names)
		if "clears" in field:
			clears = field["clears"]
			if not isinstance(clears, list) or not all(isinstance(c, str) for c in clears):
				raise FilterError("invalid_provider_output")
			out["clears"] = [c for c in clears if c in names]
		for key in ("placeholder", "helpText"):
			if isinstance(field.get(key), str):
				out[key] = field[key]
		clean.append(out)
	return clean


def validate_query_filters(query_filters, names: set) -> dict:
	if not isinstance(query_filters, dict):
		raise FilterError("invalid_provider_output")
	for key, value in query_filters.items():
		if not isinstance(key, str) or not FIELDNAME.match(key):
			raise FilterError("invalid_provider_output")
		if isinstance(value, str) and value.startswith("$"):
			if value[1:] not in names:
				raise FilterError("invalid_provider_output")
		elif not isinstance(value, str | int | float | bool):
			raise FilterError("invalid_provider_output")
	return dict(query_filters)


def allowed_providers() -> set[str]:
	return set(frappe.get_hooks("xpos_report_filter_providers") or [])


def provider_filters(report, provider_path: str) -> list[dict] | None:
	if provider_path not in allowed_providers():
		raise FilterError("provider_not_registered")
	provider = frappe.get_attr(provider_path)
	filters = provider(report)
	if filters is None:
		return None
	return add_dependencies(validate_provider_output(filters))


def declares_script_filters(report) -> bool:
	"""Whether the report's desk JavaScript lists filters. The text is only read, never run."""
	script = report.get("javascript") or ""
	if report.is_standard == "Yes" and report.module:
		scrubbed = frappe.scrub(report.name)
		path = Path(frappe.get_module_path(report.module)) / "report" / scrubbed / f"{scrubbed}.js"
		if path.exists():
			script = path.read_text()
	return bool(JS_FILTERS.search(script))


def build_filters(report, provider_path: str | None) -> list[dict]:
	"""Filters for ``report`` (a reference report for custom ones); raises FilterError with the reason."""
	if report.get("filters"):
		return structured_filters(report)
	if provider_path:
		filters = provider_filters(report, provider_path)
		if filters is not None:
			return filters
	if declares_script_filters(report):
		raise FilterError("js_only_filters")
	return []
