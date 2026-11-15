# Copyright (c) 2025, Ali Raza and contributors
# For license information, please see license.txt

import frappe
from frappe import _

from xpos.reports import scope


def execute(filters=None):
	scope.enforce(filters or {})
	columns, data = get_columns(), get_data(filters)
	return columns, data


def get_data(filters):
	query = """
        SELECT
            sed.item_code,
            sed.item_name,
            SUM(sed.qty) AS qty
        FROM `tabStock Entry` se
        INNER JOIN `tabStock Entry Detail` sed ON se.name = sed.parent
        WHERE
            se.docstatus = 1
            AND se.company = %(company)s
            AND se.posting_date >= %(from_date)s AND se.posting_date <= %(to_date)s
            AND sed.t_warehouse = %(warehouse)s
        GROUP BY sed.item_code, sed.t_warehouse
    """

	return frappe.db.sql(
		query,
		{
			"company": filters.get("company"),
			"from_date": filters.get("from_date"),
			"to_date": filters.get("to_date"),
			"warehouse": filters.get("warehouse"),
		},
		as_dict=True,
	)


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
		{"label": _("Quantity"), "fieldname": "qty", "fieldtype": "Float", "width": 100},
	]
