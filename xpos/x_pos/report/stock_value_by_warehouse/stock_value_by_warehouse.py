# Copyright (c) 2025, Ali Raza and contributors
# For license information, please see license.txt

import frappe
from frappe import _

from xpos.reports import scope


def execute(filters=None):
	scope.enforce(filters or {})
	columns, data = get_columns(), get_stock_value_by_warehouse(filters)
	return columns, data


def get_stock_value_by_warehouse(filters):
	query = """
        SELECT
            b.warehouse,
            SUM(b.stock_value) stock_value
        FROM `tabBin` b
        INNER JOIN `tabWarehouse` w ON b.warehouse = w.name
        WHERE
			b.actual_qty > 0
			AND b.warehouse IS NOT NULL
			AND b.warehouse != ''
			AND w.company = %(company)s
			{scope_condition}
        GROUP BY b.warehouse
        HAVING SUM(b.stock_value) IS NOT NULL AND SUM(b.stock_value) > 0
    """
	params = {"company": filters.get("company")}
	query = query.replace("{scope_condition}", scope.warehouse_condition("b.warehouse", params))
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
			"label": _("Stock Value"),
			"fieldname": "stock_value",
			"fieldtype": "Currency",
			"align": "right",
			"width": 200,
		},
	]
