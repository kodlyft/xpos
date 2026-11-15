# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""Create the offline catalogue change log and the offline payment mode child table."""

import frappe


def execute():
	frappe.reload_doc("x_pos", "doctype", "pos_offline_payment_mode")
	frappe.reload_doc("x_pos", "doctype", "xpos_catalog_change")
