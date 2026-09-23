# Copyright (c) 2025, Kodlyft and contributors
# For license information, please see license.txt

import json

import frappe
from frappe import _
from frappe.utils import flt, nowdate


def execute(filters=None):
	columns, data = get_columns(), evaluate_filters(filters)
	return columns, data


@frappe.whitelist()
def create_purchase_order(report_data: str | list, filters: str | dict | None = None) -> dict:
	"""Create a draft Purchase Order from the report rows that need restocking."""
	rows = json.loads(report_data) if isinstance(report_data, str) else report_data
	filters = frappe._dict(json.loads(filters) if isinstance(filters, str) else (filters or {}))
	if not filters.supplier or not filters.company:
		frappe.throw(_("Company and Supplier filters are required to create a Purchase Order."))

	items = [
		{
			"item_code": row.get("item_code"),
			"qty": flt(row.get("req_qty")),
			"uom": row.get("uom"),
			"conversion_factor": flt(row.get("conversion_factor")) or 1,
			"rate": flt(row.get("rate")),
			"warehouse": row.get("warehouse"),
			"schedule_date": nowdate(),
		}
		for row in rows or []
		if row.get("item_code") and flt(row.get("req_qty")) > 0
	]
	if not items:
		frappe.throw(_("No items with a Required Qty to order."))

	po = frappe.get_doc(
		{
			"doctype": "Purchase Order",
			"supplier": filters.supplier,
			"company": filters.company,
			"transaction_date": nowdate(),
			"schedule_date": nowdate(),
			"items": items,
		}
	)
	po.insert()
	return {"name": po.name}


def evaluate_filters(filters):
	if filters.get("type") != "All":
		return []

	sql = """
        SELECT
            ti.item_code,
            ti.item_name,
            ti.brand,
            ti.item_group,
            bin.warehouse,
            ROUND(COALESCE(tr.warehouse_reorder_level, 0)) AS reorder_level,
            ROUND(COALESCE(tr.warehouse_reorder_qty, 0)) AS reorder_qty,
            ROUND(ip.price_list_rate, 2) * ROUND(u.conversion_factor) AS rate,
            u.uom,
            ROUND(u.conversion_factor) AS conversion_factor,
            ROUND(COALESCE(bin.actual_qty, 0)) AS stock_qty,
            ROUND(COALESCE(tsi.qty, 2)) AS sold_qty,
            CASE
				WHEN COALESCE(tr.warehouse_reorder_level, 0) > COALESCE(tsi.qty, 0) THEN
					ROUND(COALESCE(tr.warehouse_reorder_qty, 0) / COALESCE(u.conversion_factor, 1))
				ELSE
					0
			END AS req_qty,
            ROUND(COALESCE(ip.price_list_rate, 0), 2) *
			CASE
				WHEN COALESCE(tr.warehouse_reorder_level, 0) > COALESCE(tsi.qty, 0) THEN
					ROUND(COALESCE(tr.warehouse_reorder_qty, 0) / COALESCE(u.conversion_factor, 1))
				ELSE
					0
			END AS amount

        FROM
            `tabItem` ti
            LEFT JOIN `tabItem Reorder` tr
                ON ti.item_code = tr.parent
            LEFT JOIN (
                SELECT
                    parent,
                    uom,
                    MAX(conversion_factor) AS conversion_factor
                FROM
                    `tabUOM Conversion Detail`
                GROUP BY parent
            ) u
                ON ti.item_code = u.parent
            LEFT JOIN `tabBin` bin
                ON ti.item_code = bin.item_code
            LEFT JOIN (
                SELECT
                    item_code,
                    ABS(SUM(actual_qty)) AS qty,
                    warehouse
                FROM
                    `tabStock Ledger Entry`
                WHERE
                    docstatus = 1
                    AND is_cancelled = 0
                    AND posting_date >= %(from_date)s AND posting_date <= %(to_date)s
                    AND voucher_type = 'Sales Invoice'
                    AND company = %(company)s
                GROUP BY item_code
            ) tsi
                ON ti.item_code = tsi.item_code
                AND tsi.warehouse = bin.warehouse
            LEFT JOIN (
                SELECT
                    item_code,
                    price_list_rate
                FROM
                    `tabItem Price`
                WHERE
                    buying = 1
            ) ip
                ON ti.item_code = ip.item_code
        WHERE
            ti.item_code IN (
                SELECT
                    parent
                FROM
                    `tabItem Supplier`
                WHERE
                    supplier = %(supplier)s
            )
        GROUP BY
            ti.item_code, bin.warehouse
        ORDER BY
            ti.item_name, bin.warehouse ASC;
    """

	return frappe.db.sql(sql, filters, as_dict=1)


def get_columns():
	return [
		{
			"fieldname": "item_code",
			"label": _("Item Code"),
			"fieldtype": "Link",
			"options": "Item",
			"width": 100,
		},
		{
			"fieldname": "item_name",
			"label": _("Item Name"),
			"fieldtype": "Data",
			"width": 200,
		},
		{
			"fieldname": "brand",
			"label": _("Brand"),
			"fieldtype": "Link",
			"options": "Brand",
			"width": 100,
		},
		{
			"fieldname": "item_group",
			"label": _("Item Group"),
			"fieldtype": "Link",
			"options": "Item Group",
			"width": 100,
		},
		{
			"fieldname": "reorder_level",
			"label": _("Reorder Level"),
			"fieldtype": "Int",
			"width": 100,
		},
		{
			"fieldname": "reorder_qty",
			"label": _("Reorder Qty"),
			"fieldtype": "Int",
			"width": 100,
		},
		{
			"fieldname": "sold_qty",
			"label": _("Sold Qty"),
			"fieldtype": "Float",
			"width": 100,
		},
		{
			"fieldname": "req_qty",
			"label": _("Required Qty"),
			"fieldtype": "Float",
			"width": 100,
		},
		{
			"fieldname": "uom",
			"label": _("UOM"),
			"fieldtype": "Link",
			"options": "UOM",
			"width": 100,
		},
		{
			"fieldname": "conversion_factor",
			"label": _("Conversion Factor"),
			"fieldtype": "Int",
			"width": 100,
		},
		{
			"fieldname": "stock_qty",
			"label": _("Stock Qty"),
			"fieldtype": "Float",
			"width": 100,
		},
		{
			"fieldname": "rate",
			"label": _("Rate"),
			"fieldtype": "Currency",
			"width": 100,
		},
		{
			"fieldname": "amount",
			"label": _("Amount"),
			"fieldtype": "Currency",
			"width": 100,
		},
	]
