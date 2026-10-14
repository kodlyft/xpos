# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""
Install-time seeding for the xPOS role-based permission system.
"""

import frappe

POS_PERMISSIONS = (
	# Billing & Invoicing
	("close_shift", "Close Shift", "Billing & Invoicing"),
	("allow_reprint_invoice", "Reprint Invoice", "Billing & Invoicing"),
	("print_draft_invoice", "Print Draft Invoice", "Billing & Invoicing"),
	("shift_report", "Shift Report", "Billing & Invoicing"),
	# Discounts & Pricing
	("apply_additional_discount", "Apply Additional Discount", "Discounts & Pricing"),
	("show_edit_discount_field", "Edit Discount Field", "Discounts & Pricing"),
	("allow_change_price", "Change Price", "Discounts & Pricing"),
	# Sales Operations
	("sale_return", "Sale Return", "Sales Operations"),
	("recall_other_shift_tabs", "Recall Other Shifts' Tabs", "Sales Operations"),
	("settle_outstanding_invoice", "Settle Outstanding Invoice", "Sales Operations"),
	("sell_gift_card", "Sell Gift Card", "Sales Operations"),
	("redeem_gift_card", "Accept Gift Card Payment", "Sales Operations"),
	# Cash Management
	("expense", "Expense", "Cash Management"),
	("bank_drop", "Bank Drop", "Cash Management"),
	# Reports
	("current_stock_by_brand", "Current Stock by Brand", "Reports"),
	("current_stock_report", "Current Stock Report", "Reports"),
	# Administration
	("manage_role_permissions", "Manage Role Permissions", "Administration"),
)

ALL_PERMISSION_NAMES = tuple(name for name, _label, _group in POS_PERMISSIONS)

# Cashiers ring up sales out of the box; every catalog permission is an elevated
# capability, so none are enabled by default.
_CASHIER_ENABLED: set[str] = set()
_MANAGER_DISABLED = {"manage_role_permissions"}

DEFAULT_ROLES = (
	("Cashier", _CASHIER_ENABLED),
	("Manager", set(ALL_PERMISSION_NAMES) - _MANAGER_DISABLED),
	("Administrator", set(ALL_PERMISSION_NAMES)),
)


def after_install():
	seed_pos_permissions()
	seed_default_roles()


def seed_pos_permissions():
	"""Upsert the static POS Permission catalog. Idempotent."""
	for permission_name, permission_label, _group in POS_PERMISSIONS:
		if frappe.db.exists("POS Permission", permission_name):
			continue
		frappe.get_doc(
			{
				"doctype": "POS Permission",
				"permission_name": permission_name,
				"permission_label": permission_label,
			}
		).insert(ignore_permissions=True)


def seed_default_roles():
	"""Create the default POS Role records with their child permission rows.

	Skips roles that already exist so existing customisations are preserved.
	"""
	for role_name, enabled_set in DEFAULT_ROLES:
		if frappe.db.exists("POS Role", role_name):
			continue
		role = frappe.get_doc({"doctype": "POS Role", "role_name": role_name})
		for permission_name in ALL_PERMISSION_NAMES:
			role.append(
				"permissions",
				{
					"permission": permission_name,
					"enabled": 1 if permission_name in enabled_set else 0,
				},
			)
		role.insert(ignore_permissions=True)
