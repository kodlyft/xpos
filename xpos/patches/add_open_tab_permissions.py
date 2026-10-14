import frappe

from xpos.api.auth import clear_role_permission_cache
from xpos.install import DEFAULT_ROLES, seed_pos_permissions

NEW_PERMISSIONS = (
	"recall_other_shift_tabs",
	"settle_outstanding_invoice",
)


def execute():
	"""Backfill the open-tab permissions onto POS Roles that already exist."""
	backfill_permissions(NEW_PERMISSIONS)


def backfill_permissions(new_permissions):
	"""Add catalog permissions missing from existing POS Roles, enabled per the role defaults."""
	seed_pos_permissions()

	defaults = dict(DEFAULT_ROLES)

	for role_name in frappe.get_all("POS Role", pluck="name"):
		role = frappe.get_doc("POS Role", role_name)
		present = {row.permission for row in role.permissions}
		missing = [key for key in new_permissions if key not in present]
		if not missing:
			continue

		enabled_set = defaults.get(role_name, set())
		for permission_name in missing:
			role.append(
				"permissions",
				{
					"permission": permission_name,
					"enabled": 1 if permission_name in enabled_set else 0,
				},
			)
		role.save(ignore_permissions=True)

	clear_role_permission_cache()
