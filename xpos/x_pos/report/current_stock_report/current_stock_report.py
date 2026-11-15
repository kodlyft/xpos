# Copyright (c) 2025, Ali Raza and contributors
# For license information, please see license.txt

import frappe
from frappe import _

from xpos.reports import scope


def execute(filters=None):
	filters = frappe._dict(filters or {})
	scope.enforce(filters)
	data = get_filtered_items(filters)
	return get_columns(), data


def get_filtered_items(filters):
	query = """
        SELECT
            ti.item_code,
            ti.item_name,
            ti.brand,
            ti.item_group,
            bin.actual_qty AS stock,
            bin.valuation_rate,
            bin.stock_value
        FROM `tabItem` ti
        INNER JOIN `tabBin` bin ON ti.item_code = bin.item_code
        WHERE bin.actual_qty > 0
            AND bin.warehouse = %(warehouse)s
    """

	conditions = {}
	conditions["warehouse"] = filters.get("warehouse")

	if filters.get("supplier"):
		query += """
            AND ti.item_code IN (
                SELECT parent FROM `tabItem Supplier` WHERE supplier = %(supplier)s
            )
        """
		conditions["supplier"] = filters.get("supplier")

	if filters.get("brand"):
		query += " AND ti.brand = %(brand)s"
		conditions["brand"] = filters.get("brand")

	if filters.get("item_group"):
		query += " AND ti.item_group = %(item_group)s"
		conditions["item_group"] = filters.get("item_group")

	query += scope.warehouse_condition("bin.warehouse", conditions)
	query += " ORDER BY ti.item_name"

	return frappe.db.sql(query, conditions, as_dict=True)


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
			"label": _("Item Group"),
			"fieldname": "item_group",
			"fieldtype": "Data",
			"width": 200,
		},
		{
			"label": _("Brand"),
			"fieldname": "brand",
			"fieldtype": "Link",
			"options": "Brand",
			"width": 120,
		},
		{"label": _("Stock"), "fieldname": "stock", "fieldtype": "Float", "width": 100},
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
