# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""Filter definitions for the reports bundled with X POS.

Registered as a filter provider in ``hooks.xpos_report_filter_providers``. Other apps
supply their own providers the same way; a provider returns plain JSON-safe filter
dicts and is never handed anything to execute.
"""

from frappe.utils import add_months, today


def company_filter():
	return {
		"fieldname": "company",
		"label": "Company",
		"type": "link",
		"doctype": "Company",
		"required": True,
		"clears": ["warehouse"],
	}


def warehouse_filter(required: bool = False, multi: bool = False):
	return {
		"fieldname": "warehouse",
		"label": "Warehouses" if multi else "Warehouse",
		"type": "multi-link" if multi else "link",
		"doctype": "Warehouse",
		"required": required,
		# "$company" resolves to the current value of the company filter.
		"getQueryFilters": {"company": "$company", "is_group": 0} if not multi else {"company": "$company"},
	}


def multi_link(fieldname: str, label: str, doctype: str, required: bool = False):
	return {
		"fieldname": fieldname,
		"label": label,
		"type": "multi-link",
		"doctype": doctype,
		"required": required,
	}


def link(fieldname: str, label: str, doctype: str, required: bool = False):
	return {
		"fieldname": fieldname,
		"label": label,
		"type": "link",
		"doctype": doctype,
		"required": required,
	}


def date(fieldname: str, label: str, required: bool = False, default=None):
	field = {"fieldname": fieldname, "label": label, "type": "date", "required": required}
	if default is not None:
		field["defaultValue"] = default
	return field


def bundled_filter_sets() -> dict:
	return {
		"Current Stock Report": [
			company_filter(),
			warehouse_filter(required=True),
			link("supplier", "Supplier", "Supplier"),
			link("brand", "Brand", "Brand"),
			link("item_group", "Item Group", "Item Group"),
		],
		"Current Stock By Brand": [
			multi_link("brand", "Brand", "Brand", required=True),
		],
		"Current Stock Summary": [
			company_filter(),
			warehouse_filter(required=True),
		],
		"Current Stock With Levels": [
			company_filter(),
			warehouse_filter(required=False),
		],
		"Dead Stock Report": [
			company_filter(),
			warehouse_filter(required=False),
			{"fieldname": "days", "label": "Days", "type": "integer", "required": True, "defaultValue": 30},
			{
				"fieldname": "min_value",
				"label": "Minimum Value",
				"type": "float",
				"required": True,
				"defaultValue": 1000,
			},
			multi_link("supplier", "Supplier", "Supplier"),
		],
		"Stock Value By Warehouse": [
			company_filter(),
		],
		"Stock Value Summary By Date": [
			company_filter(),
			date("from_posting_date", "From Posting Date", required=True, default=today()),
		],
		"Warehouse Stock Movement": [
			company_filter(),
			date("from_date", "From Date", required=True, default=today()),
			date("to_date", "To Date", required=True, default=today()),
		],
		"Branch Item Summary": [
			company_filter(),
			warehouse_filter(required=True),
			date("from_date", "From Date", required=True, default=today()),
			date("to_date", "To Date", required=True, default=today()),
		],
		"Branch Set Summary": [
			company_filter(),
			warehouse_filter(required=True),
			date("date", "Date", required=True, default=today()),
		],
		"Low Qty Sales Report": [
			company_filter(),
			date("from_date", "From Date", required=True, default=add_months(today(), -1)),
			date("to_date", "To Date", required=True, default=today()),
			{
				"fieldname": "min_qty",
				"label": "Min Qty",
				"type": "integer",
				"required": True,
				"defaultValue": 10,
			},
		],
		"Zero Qty Sales Report": [
			company_filter(),
			date("from_date", "From Date", required=True, default=today()),
			date("to_date", "To Date", required=True, default=today()),
		],
		"Slow Fast Moving Items": [
			company_filter(),
			date("from_date", "From Date", required=True, default=add_months(today(), -1)),
			date("to_date", "To Date", required=True, default=today()),
			multi_link("supplier", "Supplier", "Supplier"),
		],
		"Stock Audit Report": [
			company_filter(),
			warehouse_filter(required=False, multi=True),
			multi_link("item_group", "Item Group", "Item Group"),
			multi_link("brand", "Brand", "Brand"),
			multi_link("supplier", "Supplier", "Supplier"),
		],
		"Purchase Order Report": [
			company_filter(),
			link("supplier", "Supplier", "Supplier", required=True),
			date("from_date", "From Date", required=True),
			date("to_date", "To Date", required=True),
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
			link("pos_opening_shift", "Opening Shift", "POS Opening Shift"),
			link("company", "Company", "Company"),
			link("pos_profile", "POS Profile", "POS Profile"),
			date("from_date", "From Date"),
			date("to_date", "To Date"),
		],
	}


def bundled_filters(report) -> list | None:
	"""Provider entry point: the filters of a bundled report, None when it is not one of ours."""
	filter_sets = {name.lower(): filters for name, filters in bundled_filter_sets().items()}
	return filter_sets.get(report.name.lower())
