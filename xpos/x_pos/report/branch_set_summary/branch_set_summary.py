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
            se.name,
            se.posting_date,
            sed.t_warehouse,
            sed.s_warehouse
        FROM `tabStock Entry` se
        INNER JOIN `tabStock Entry Detail` sed ON se.name = sed.parent
        WHERE
            se.docstatus = 1
            AND se.company = %(company)s
            AND se.posting_date = %(date)s
            AND (
                sed.t_warehouse = %(warehouse)s
                OR (sed.s_warehouse = '' AND se.purpose = 'Material Transfer')
            )
            {scope_condition}
        GROUP BY se.name, sed.t_warehouse
    """

	params = {
		"date": filters.get("date"),
		"warehouse": filters.get("warehouse"),
		"company": filters.get("company"),
	}
	data = frappe.db.sql(
		query.replace("{scope_condition}", scope.warehouse_condition("sed.t_warehouse", params)),
		params,
		as_dict=True,
	)
	return data


def get_columns():
	return [
		{
			"label": _("Stock Entry ID"),
			"fieldname": "name",
			"fieldtype": "Link",
			"options": "Stock Entry",
			"width": 150,
		},
		{
			"label": _("Posting Date"),
			"fieldname": "posting_date",
			"fieldtype": "Date",
			"width": 120,
		},
		{
			"label": _("Target Warehouse"),
			"fieldname": "t_warehouse",
			"fieldtype": "Link",
			"options": "Warehouse",
			"width": 200,
		},
		{
			"label": _("Source Warehouse"),
			"fieldname": "s_warehouse",
			"fieldtype": "Link",
			"options": "Warehouse",
			"width": 200,
		},
	]
