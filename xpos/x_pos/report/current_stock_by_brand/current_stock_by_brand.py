# Copyright (c) 2025, Ali Raza and contributors
# For license information, please see license.txt

import frappe
from frappe import _

from xpos.reports import scope


def execute(filters=None):
	columns, data = get_columns(), get_data(filters)
	return columns, data


def get_data(filters):
	scope.enforce(filters)
	if not filters.get("brand"):
		frappe.throw(_("Please select brand first"))
	query = """
        SELECT
            ti.item_code,
            ti.item_name,
            sup.supplier,
            bin.warehouse,
            ti.brand,
            bin.actual_qty,
            bin.valuation_rate,
            bin.stock_value
        FROM `tabItem` ti
        INNER JOIN `tabBin` bin ON ti.name = bin.item_code
        LEFT JOIN `tabItem Supplier` sup ON ti.item_code = sup.parent
        WHERE bin.actual_qty > 0
        AND ti.brand IN %(brand_filter)s
    """

	params = {"brand_filter": tuple(filters.get("brand"))}
	query += scope.warehouse_condition("bin.warehouse", params)
	data = frappe.db.sql(query, params, as_dict=True)
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
			"label": _("Warehouse"),
			"fieldname": "warehouse",
			"fieldtype": "Link",
			"options": "Warehouse",
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
			"label": _("Stock Qty"),
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
