# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

from xpos.patches.add_open_tab_permissions import backfill_permissions


def execute():
	"""Add the permission to record FBR checks to POS Roles that already exist."""
	backfill_permissions(("resolve_fiscal_check",))
