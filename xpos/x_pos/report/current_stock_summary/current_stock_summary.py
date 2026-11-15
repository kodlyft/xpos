# Copyright (c) 2025, Ali Raza and contributors
# For license information, please see license.txt

import frappe
from frappe import _

from xpos.reports import scope


def execute(filters=None):
	scope.enforce(filters)
	columns, data = get_columns(), get_data(filters.get("warehouse"))
	return columns, data


def get_data(warehouse):
	query = """
        SELECT
            ti.item_code,
            ti.item_name,
            bin.actual_qty,
            bin.valuation_rate,
            bin.warehouse,
            bin.stock_value
        FROM `tabItem` ti
        INNER JOIN `tabBin` bin ON ti.item_code = bin.item_code
        WHERE bin.actual_qty > 0 AND bin.warehouse = %(warehouse)s
        GROUP BY bin.item_code
        ORDER BY ti.item_name ASC
    """

	return frappe.db.sql(query, {"warehouse": warehouse}, as_dict=True)


def get_columns():
	return [
		{
			"label": _("Item Code"),
			"fieldname": "item_code",
			"fieldtype": "Link",
			"options": "Item",
			"width": 150,
		},
		{
			"label": _("Item Name"),
			"fieldname": "item_name",
			"fieldtype": "Data",
			"width": 200,
		},
		{
			"label": _("Warehouse"),
			"fieldname": "warehouse",
			"fieldtype": "Link",
			"options": "Warehouse",
			"width": 150,
		},
		{
			"label": _("Actual Qty"),
			"fieldname": "actual_qty",
			"fieldtype": "Float",
			"width": 100,
		},
		{
			"label": _("Valuation Rate"),
			"fieldname": "valuation_rate",
			"fieldtype": "Currency",
			"width": 120,
		},
		{
			"label": _("Stock Value"),
			"fieldname": "stock_value",
			"fieldtype": "Currency",
			"width": 120,
		},
	]
