# Copyright (c) 2026, xpos contributors
# For license information, please see license.txt

import frappe
from frappe import _

from xpos.reports import scope


def execute(filters=None):
	filters = frappe._dict(filters or {})
	data = get_data(filters)
	columns = get_columns()
	return columns, data


def as_list(value):
	"""Normalise a filter value to a plain Python list of strings."""
	if not value:
		return []
	if isinstance(value, (list, tuple)):
		return [str(v).strip() for v in value if str(v).strip()]
	return [str(v).strip() for v in str(value).split(",") if str(v).strip()]


def get_data(filters):
	scope.enforce(filters)
	conditions = ["bin.actual_qty > 0"]
	params = {}
	if scope_clause := scope.warehouse_clause("bin.warehouse", params):
		conditions.append(scope_clause)

	company = filters.get("company")
	if company:
		params["company"] = company

	warehouse_list = as_list(filters.get("warehouse"))
	if warehouse_list:
		placeholders = ", ".join([f"%(wh_{i})s" for i in range(len(warehouse_list))])
		conditions.append(f"bin.warehouse IN ({placeholders})")
		for i, wh in enumerate(warehouse_list):
			params[f"wh_{i}"] = wh
	elif company:
		conditions.append(
			"bin.warehouse IN (SELECT name FROM `tabWarehouse` WHERE company = %(company)s AND is_group = 0)"
		)

	brand_list = as_list(filters.get("brand"))
	if brand_list:
		placeholders = ", ".join([f"%(br_{i})s" for i in range(len(brand_list))])
		conditions.append(f"ti.brand IN ({placeholders})")
		for i, br in enumerate(brand_list):
			params[f"br_{i}"] = br

	supplier_list = as_list(filters.get("supplier"))
	if supplier_list:
		placeholders = ", ".join([f"%(sp_{i})s" for i in range(len(supplier_list))])
		conditions.append(
			f"ti.item_code IN (SELECT parent FROM `tabItem Supplier` WHERE supplier IN ({placeholders}))"
		)
		for i, sp in enumerate(supplier_list):
			params[f"sp_{i}"] = sp

	item_group_list = as_list(filters.get("item_group"))
	if item_group_list:
		placeholders = ", ".join([f"%(it_{i})s" for i in range(len(item_group_list))])
		conditions.append(f"ti.item_group IN ({placeholders})")
		for i, it in enumerate(item_group_list):
			params[f"it_{i}"] = it

	where = " AND ".join(conditions)

	# `where` is composed of server-controlled SQL fragments only; user-supplied
	# values are bound via the `params` dict.
	query = (
		"""
		SELECT
			ti.item_code,
			ti.item_name,
			COALESCE(ti.brand, '') AS brand,
			bin.warehouse,
			bin.actual_qty AS qty_in_hand
		FROM `tabItem` ti
		INNER JOIN `tabBin` bin ON ti.item_code = bin.item_code
		WHERE """
		+ where
		+ """
		ORDER BY bin.warehouse, ti.item_name
	"""
	)

	return frappe.db.sql(query, params, as_dict=True)


def get_columns():
	return [
		{
			"label": _("Item Code"),
			"fieldname": "item_code",
			"fieldtype": "Link",
			"options": "Item",
			"width": 120,
		},
		{
			"label": _("Item Name"),
			"fieldname": "item_name",
			"fieldtype": "Data",
			"width": 220,
		},
		{
			"label": _("Brand"),
			"fieldname": "brand",
			"fieldtype": "Data",
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
			"label": _("Qty in Hand"),
			"fieldname": "qty_in_hand",
			"fieldtype": "Float",
			"width": 100,
		},
	]
