# Copyright (c) 2025, Ali Raza and contributors
# For license information, please see license.txt

import frappe
from frappe import _

from xpos.reports import scope


def execute(filters=None):
	columns, data = get_columns(), get_sales_data(filters)
	return columns, data


def get_sales_data(filters):
	scope.enforce(filters)
	query = """
        SELECT
            tsi.item_code,
            tsi.item_name,
            ROUND(SUM(tsi.qty), 2) AS sold_qty,
            tsi.uom,
            ROUND(tsi.price_list_rate, 2) AS rate,
			iv.supplier,
            ti.brand,
            ROUND(IFNULL(bin.actual_qty, 0), 2) AS stock
        FROM `tabSales Invoice Item` tsi
        INNER JOIN `tabSales Invoice` ts ON tsi.parent = ts.name
        LEFT JOIN `tabItem` ti ON tsi.item_code = ti.name
        LEFT JOIN `tabBin` bin ON tsi.item_code = bin.item_code {bin_scope}
		LEFT JOIN `tabItem Supplier` iv ON ti.name = iv.parent
        WHERE
            ts.docstatus = 1
            AND ts.company = %(company)s
			AND ts.posting_date >= %(from_date)s AND ts.posting_date <= %(to_date)s
            AND IFNULL(bin.actual_qty, 0) <= 0
            {sales_scope}
        GROUP BY tsi.item_code
    """

	params = {
		"from_date": filters.get("from_date"),
		"to_date": filters.get("to_date"),
		"company": filters.get("company"),
	}
	query = query.replace("{bin_scope}", scope.warehouse_condition("bin.warehouse", params)).replace(
		"{sales_scope}", scope.warehouse_condition("tsi.warehouse", params)
	)
	data = frappe.db.sql(query, params, as_dict=True)
	return data


def get_columns():
	columns = [
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
			"width": 150,
		},
		{
			"label": _("Sold Qty"),
			"fieldname": "sold_qty",
			"fieldtype": "Float",
			"width": 100,
		},
		{"label": _("UOM"), "fieldname": "uom", "fieldtype": "Data", "width": 100},
		{"label": _("Rate"), "fieldname": "rate", "fieldtype": "Currency", "width": 100},
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
			"width": 150,
		},
		{"label": _("Stock"), "fieldname": "stock", "fieldtype": "Float", "width": 100},
	]
	return columns
