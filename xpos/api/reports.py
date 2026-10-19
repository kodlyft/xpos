# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""Report metadata for the X POS frontend report viewer.

The frontend renders a generic, Frappe-style report view (filter bar + data
table). The filter configuration for each report lives here so the frontend no
longer hardcodes it; this mirrors the filters defined in each report's desk
``*.js`` file but is JSON-serialisable.

Report data itself is still fetched through the standard
``frappe.desk.query_report.run`` endpoint.
"""

import frappe
from frappe import _
from frappe.utils import add_months, today


def _company_default() -> str:
	"""Resolve the user's default company, mirroring the desk ``*.js`` defaults."""
	return frappe.defaults.get_user_default("Company") or frappe.defaults.get_default("company") or ""


def _company_filter():
	return {
		"fieldname": "company",
		"label": "Company",
		"type": "link",
		"doctype": "Company",
		"required": True,
		"clears": ["warehouse"],
	}


def _warehouse_filter(required: bool = False, multi: bool = False):
	return {
		"fieldname": "warehouse",
		"label": "Warehouses" if multi else "Warehouse",
		"type": "multi-link" if multi else "link",
		"doctype": "Warehouse",
		"required": required,
		# "$company" resolves to the current value of the company filter.
		"getQueryFilters": {"company": "$company", "is_group": 0} if not multi else {"company": "$company"},
	}


def _multi_link(fieldname: str, label: str, doctype: str, required: bool = False):
	return {
		"fieldname": fieldname,
		"label": label,
		"type": "multi-link",
		"doctype": doctype,
		"required": required,
	}


def _link(fieldname: str, label: str, doctype: str, required: bool = False):
	return {
		"fieldname": fieldname,
		"label": label,
		"type": "link",
		"doctype": doctype,
		"required": required,
	}


def _date(fieldname: str, label: str, required: bool = False, default=None):
	field = {"fieldname": fieldname, "label": label, "type": "date", "required": required}
	if default is not None:
		field["defaultValue"] = default
	return field


def _filters() -> dict:
	return {
		"Current Stock Report": [
			_company_filter(),
			_warehouse_filter(required=True),
			_link("supplier", "Supplier", "Supplier"),
			_link("brand", "Brand", "Brand"),
			_link("item_group", "Item Group", "Item Group"),
		],
		"Current Stock By Brand": [
			_multi_link("brand", "Brand", "Brand", required=True),
		],
		"Current Stock Summary": [
			_company_filter(),
			_warehouse_filter(required=True),
		],
		"Current Stock With Levels": [
			_company_filter(),
			_warehouse_filter(required=False),
		],
		"Dead Stock Report": [
			_company_filter(),
			_warehouse_filter(required=False),
			{"fieldname": "days", "label": "Days", "type": "integer", "required": True, "defaultValue": 30},
			{
				"fieldname": "min_value",
				"label": "Minimum Value",
				"type": "float",
				"required": True,
				"defaultValue": 1000,
			},
			_multi_link("supplier", "Supplier", "Supplier"),
		],
		"Stock Value By Warehouse": [
			_company_filter(),
		],
		"Stock Value Summary By Date": [
			_company_filter(),
			_date("from_posting_date", "From Posting Date", required=True, default=today()),
		],
		"Warehouse Stock Movement": [
			_company_filter(),
			_date("from_date", "From Date", required=True, default=today()),
			_date("to_date", "To Date", required=True, default=today()),
		],
		"Branch Item Summary": [
			_company_filter(),
			_warehouse_filter(required=True),
			_date("from_date", "From Date", required=True, default=today()),
			_date("to_date", "To Date", required=True, default=today()),
		],
		"Branch Set Summary": [
			_company_filter(),
			_warehouse_filter(required=True),
			_date("date", "Date", required=True, default=today()),
		],
		"Low Qty Sales Report": [
			_company_filter(),
			_date("from_date", "From Date", required=True, default=add_months(today(), -1)),
			_date("to_date", "To Date", required=True, default=today()),
			{
				"fieldname": "min_qty",
				"label": "Min Qty",
				"type": "integer",
				"required": True,
				"defaultValue": 10,
			},
		],
		"Zero Qty Sales Report": [
			_company_filter(),
			_date("from_date", "From Date", required=True, default=today()),
			_date("to_date", "To Date", required=True, default=today()),
		],
		"Slow Fast Moving Items": [
			_company_filter(),
			_date("from_date", "From Date", required=True, default=add_months(today(), -1)),
			_date("to_date", "To Date", required=True, default=today()),
			_multi_link("supplier", "Supplier", "Supplier"),
		],
		"Stock Audit Report": [
			_company_filter(),
			_warehouse_filter(required=False, multi=True),
			_multi_link("item_group", "Item Group", "Item Group"),
			_multi_link("brand", "Brand", "Brand"),
			_multi_link("supplier", "Supplier", "Supplier"),
		],
		"Purchase Order Report": [
			_company_filter(),
			_link("supplier", "Supplier", "Supplier", required=True),
			_date("from_date", "From Date", required=True),
			_date("to_date", "To Date", required=True),
			{
				"fieldname": "type",
				"label": "Type",
				"type": "select",
				"required": True,
				"defaultValue": "All",
				"options": [
					{"label": "All", "value": "All"},
					{"label": "Based on ReOrder Level", "value": "Based on ReOrder Level"},
					{"label": "Based on Sales", "value": "Based on Sales"},
				],
			},
		],
		"POS Shift Reconciliation": [
			_link("pos_opening_shift", "Opening Shift", "POS Opening Shift"),
			_link("company", "Company", "Company"),
			_link("pos_profile", "POS Profile", "POS Profile"),
			_date("from_date", "From Date"),
			_date("to_date", "To Date"),
		],
	}


def _apply_company_defaults(filters: list) -> list:
	"""Inject the user's default company into the company filter at request time."""
	company = _company_default()
	if not company:
		return filters
	for field in filters:
		if field.get("fieldname") == "company" and "defaultValue" not in field:
			field["defaultValue"] = company
	return filters


@frappe.whitelist()
def get_report_meta(report: str) -> dict:
	"""Return the JSON filter configuration for a report.

	Columns are intentionally omitted - they arrive with the data from
	``frappe.desk.query_report.run`` so no report execution is needed here.
	"""
	registry = _filters()
	filters = registry.get(report)
	if filters is None:
		frappe.throw(_("Unknown report: {0}").format(report), frappe.DoesNotExistError)

	if not frappe.has_permission("Report", "read"):
		frappe.throw(_("Not permitted to view reports"), frappe.PermissionError)

	return {"filters": _apply_company_defaults(filters)}
