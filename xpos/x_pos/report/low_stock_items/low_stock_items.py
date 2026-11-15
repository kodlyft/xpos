# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

import frappe
from frappe import _

from xpos.reports import scope


def execute(filters=None):
	filters = frappe._dict(filters or {})
	scope.enforce(filters)
	return get_columns(), get_data(filters)


def get_data(filters):
	params = {"company": filters.get("company")}
	conditions = ""
	if filters.get("warehouse"):
		conditions += " AND bin.warehouse = %(warehouse)s"
		params["warehouse"] = filters["warehouse"]
	conditions += scope.warehouse_condition("bin.warehouse", params)
	query = """
		SELECT
			bin.item_code,
			item.item_name,
			bin.warehouse,
			bin.actual_qty,
			reorder.warehouse_reorder_level AS reorder_level,
			reorder.warehouse_reorder_qty AS reorder_qty
		FROM `tabBin` bin
		INNER JOIN `tabItem` item ON item.name = bin.item_code
		INNER JOIN `tabWarehouse` wh ON wh.name = bin.warehouse
		INNER JOIN `tabItem Reorder` reorder ON reorder.parent = bin.item_code AND reorder.warehouse = bin.warehouse
		WHERE wh.company = %(company)s
			AND item.disabled = 0
			AND reorder.warehouse_reorder_level > 0
			AND bin.actual_qty <= reorder.warehouse_reorder_level
			{conditions}
		ORDER BY bin.actual_qty - reorder.warehouse_reorder_level, item.item_name
	"""
	return frappe.db.sql(query.replace("{conditions}", conditions), params, as_dict=True)


def get_columns():
	return [
		{
			"label": _("Item Code"),
			"fieldname": "item_code",
			"fieldtype": "Link",
			"options": "Item",
			"width": 160,
		},
		{"label": _("Item Name"), "fieldname": "item_name", "fieldtype": "Data", "width": 220},
		{
			"label": _("Warehouse"),
			"fieldname": "warehouse",
			"fieldtype": "Link",
			"options": "Warehouse",
			"width": 200,
		},
		{"label": _("In Stock"), "fieldname": "actual_qty", "fieldtype": "Float", "width": 100},
		{"label": _("Reorder Level"), "fieldname": "reorder_level", "fieldtype": "Float", "width": 120},
		{"label": _("Reorder Qty"), "fieldname": "reorder_qty", "fieldtype": "Float", "width": 120},
	]
