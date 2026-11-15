# Copyright (c) 2025, Ali Raza and contributors
# For license information, please see license.txt

import frappe
from frappe import _

from xpos.reports import scope


def get_sales_data(company, from_date, to_date, suppliers=[]):
	query = """
        SELECT
            ROUND(SUM(tsi.stock_qty), 2) AS sold_qty,
            tsi.item_name,
            tsi.item_code,
            ROUND(IFNULL(bin.actual_qty, 0), 2) AS stock,
            tsi.brand
        FROM `tabSales Invoice Item` tsi
        LEFT JOIN `tabSales Invoice` ts ON tsi.parent = ts.name
        LEFT JOIN `tabBin` bin ON tsi.item_code = bin.item_code {bin_scope}
        LEFT JOIN `tabItem Supplier` sup ON tsi.item_code = sup.parent
        WHERE
        	ts.posting_date >= %(from_date)s AND ts.posting_date <= %(to_date)s
            AND sup.supplier IN %(supplier)s
            {sales_scope}
        GROUP BY tsi.item_code
        ORDER BY tsi.item_name ASC
    """

	params = {
		"company": company,
		"from_date": from_date,
		"to_date": to_date,
		"supplier": tuple(suppliers),
	}
	query = query.replace("{bin_scope}", scope.warehouse_condition("bin.warehouse", params)).replace(
		"{sales_scope}",
		scope.warehouse_condition("tsi.warehouse", params) + scope.company_condition("ts.company", params),
	)
	data = frappe.db.sql(query, params, as_dict=True)

	return data


def execute(filters=None):
	scope.enforce(filters or {})
	suppliers = frappe.parse_json(filters.get("supplier"))
	if not suppliers:
		suppliers = []

	if len(suppliers) <= 0:
		frappe.throw(_("Please select supplier first"))

	data = get_sales_data(
		filters.get("company"),
		filters.get("from_date"),
		filters.get("to_date"),
		suppliers,
	)
	return get_columns(), data


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
			"label": _("Sold Qty"),
			"fieldname": "sold_qty",
			"fieldtype": "Float",
			"width": 100,
		},
		{"label": _("Stock"), "fieldname": "stock", "fieldtype": "Float", "width": 100},
		{
			"label": _("Brand"),
			"fieldname": "brand",
			"fieldtype": "Link",
			"options": "Brand",
			"width": 120,
		},
	]
