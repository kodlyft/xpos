# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

from xpos.patches.add_open_tab_permissions import backfill_permissions


def execute():
	"""Add the Stock Receiving permissions to POS Roles that already exist."""
	backfill_permissions(("receive_stock_draft", "receive_stock_submit", "receive_stock_rates"))
