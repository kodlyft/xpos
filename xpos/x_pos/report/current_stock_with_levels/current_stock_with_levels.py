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
            b.item_code,
            i.item_name,
            iv.supplier,
            i.brand,
            b.actual_qty,
            b.valuation_rate,
            b.stock_value,
            COALESCE(tir.warehouse_reorder_level, 0) AS warehouse_reorder_level,
            COALESCE(tir.warehouse_reorder_qty, 0) AS warehouse_reorder_qty,
            b.warehouse
        FROM `tabBin` AS b
        INNER JOIN `tabItem` AS i ON i.item_code = b.item_code
        LEFT JOIN `tabItem Supplier` AS iv ON iv.parent = b.item_code
        LEFT JOIN `tabItem Reorder` AS tir ON i.item_code = tir.parent
        AND b.warehouse = tir.warehouse
        WHERE b.actual_qty > 0
        AND b.warehouse = %(warehouse)s
        ORDER BY b.item_code, b.warehouse
    """

	data = frappe.db.sql(query, {"warehouse": warehouse}, as_dict=True)
	return data


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
			"label": _("Supplier"),
			"fieldname": "supplier",
			"fieldtype": "Link",
			"options": "Supplier",
			"width": 150,
		},
		{
			"label": _("Brand"),
			"fieldname": "brand",
			"fieldtype": "Link",
			"options": "Brand",
			"width": 120,
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
			"width": 120,
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
			"width": 150,
		},
		{
			"label": _("Reorder Level"),
			"fieldname": "warehouse_reorder_level",
			"fieldtype": "Float",
			"width": 120,
		},
		{
			"label": _("Reorder Qty"),
			"fieldname": "warehouse_reorder_qty",
			"fieldtype": "Float",
			"width": 120,
		},
	]
