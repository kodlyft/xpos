# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""Indexes behind the v3 catalogue and pending-POS-stock queries."""

import frappe

INDEXES = (
	("Item", ["disabled", "is_sales_item", "has_variants", "item_name"], "xpos_catalog_order"),
	("POS Invoice", ["docstatus", "consolidated_invoice"], "xpos_pending_docstatus_consolidated"),
)


def execute():
	for doctype, columns, index_name in INDEXES:
		table = f"tab{doctype}"
		if frappe.db.table_exists(doctype) and not frappe.db.has_index(table, index_name):
			frappe.db.add_index(doctype, columns, index_name)
