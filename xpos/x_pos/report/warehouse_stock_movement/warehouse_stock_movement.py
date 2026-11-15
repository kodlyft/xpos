# Copyright (c) 2025, Ali Raza and contributors
# For license information, please see license.txt

import frappe
from frappe import _

from xpos.reports import scope


def execute(filters=None):
	scope.enforce(filters or {})
	columns, data = get_columns(), get_data(filters)
	return columns, data


def get_data(filters):
	query = """
        SELECT
            warehouse,
            voucher_type,
            COALESCE(SUM(actual_qty * incoming_rate), 0) AS stock_value_difference
        FROM `tabStock Ledger Entry`
        WHERE
        is_cancelled = 0
        AND posting_date >= %(from_date)s AND posting_date <= %(to_date)s
        AND company = %(company)s
        {scope_condition}
        GROUP BY warehouse, voucher_type
    """
	params = {
		"company": filters.get("company"),
		"from_date": filters.get("from_date"),
		"to_date": filters.get("to_date"),
	}
	query = query.replace("{scope_condition}", scope.warehouse_condition("warehouse", params))
	return frappe.db.sql(query, params, as_dict=True)


def get_columns():
	return [
		{
			"label": _("Warehouse"),
			"fieldname": "warehouse",
			"fieldtype": "Link",
			"options": "Warehouse",
			"width": 200,
		},
		{
			"label": _("Voucher Type"),
			"fieldname": "voucher_type",
			"fieldtype": "Data",
			"width": 200,
		},
		{
			"label": _("Stock Value Difference"),
			"fieldname": "stock_value_difference",
			"fieldtype": "Currency",
			"width": 200,
		},
	]
