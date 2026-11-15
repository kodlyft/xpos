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
	scope_params = {}
	conditions = ["bin.actual_qty > 0", "bin.stock_value > %(min_value)s"]
	if filters.get("warehouse"):
		conditions.append("bin.warehouse = %(warehouse)s")
	if scope_clause := scope.warehouse_clause("bin.warehouse", scope_params):
		conditions.append(scope_clause)

	supplier_filter = ""
	if filters.get("supplier"):
		supplier_filter = "AND sup.supplier IN %(suppliers)s"
	else:
		filters["suppliers"] = tuple()

	# `conditions` and `supplier_filter` contain only server-controlled SQL
	# fragments; user-supplied values are bound through the parameter dict below.
	query = (
		"""
        SELECT
            ti.item_code,
            ti.item_name,
            COALESCE(ROUND(bin.actual_qty), 0) AS qty,
            bin.warehouse,
            ti.brand,
            sup.supplier,
            COALESCE(ROUND(bin.valuation_rate, 2), 0) AS valuation_rate,
            COALESCE(bin.stock_value, 0) AS total
        FROM `tabItem` ti
        LEFT JOIN `tabBin` bin ON ti.item_code = bin.item_code
        LEFT JOIN `tabItem Supplier` sup ON ti.item_code = sup.parent
        WHERE
            """
		+ " AND ".join(conditions)
		+ """
            AND ti.item_code NOT IN (
                SELECT tsi.item_code
                FROM `tabSales Invoice Item` tsi
                WHERE tsi.qty > 0
                AND tsi.creation >= DATE_SUB(NOW(), INTERVAL %(days)s DAY)
            )
            AND ti.item_code NOT IN (
                SELECT sl.item_code
                FROM `tabStock Ledger Entry` sl
                WHERE sl.actual_qty > 0
                AND sl.voucher_type = 'Sales Invoice'
                AND sl.creation >= DATE_SUB(NOW(), INTERVAL %(days)s DAY)
            )
            """
		+ supplier_filter
		+ """
        GROUP BY ti.item_code
        ORDER BY ti.item_name ASC
    """
	)

	data = frappe.db.sql(
		query,
		{
			"days": filters.get("days"),
			"min_value": filters.get("min_value"),
			"suppliers": tuple(filters.get("supplier")) if filters.get("supplier") else (),
			"company": filters.get("company"),
			"warehouse": filters.get("warehouse"),
			**scope_params,
		},
		as_dict=True,
	)
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
			"label": _("Warehouse"),
			"fieldname": "warehouse",
			"fieldtype": "Link",
			"options": "Warehouse",
			"width": 200,
		},
		{"label": _("Quantity"), "fieldname": "qty", "fieldtype": "Float", "width": 100},
		{
			"label": _("Brand"),
			"fieldname": "brand",
			"fieldtype": "Link",
			"options": "Brand",
			"width": 120,
		},
		{
			"label": _("Supplier"),
			"fieldname": "supplier",
			"fieldtype": "Link",
			"options": "Supplier",
			"width": 120,
		},
		{
			"label": _("Valuation Rate"),
			"fieldname": "valuation_rate",
			"fieldtype": "Currency",
			"width": 120,
		},
		{
			"label": _("Total Value"),
			"fieldname": "total",
			"fieldtype": "Currency",
			"width": 150,
		},
	]
