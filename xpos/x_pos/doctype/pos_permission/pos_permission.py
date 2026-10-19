# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

from frappe.model.document import Document

from xpos.api.auth import clear_role_permission_cache


class POSPermission(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		permission_label: DF.Data
		permission_name: DF.Data
	# end: auto-generated types

	def on_update(self):
		clear_role_permission_cache()

	def on_trash(self):
		clear_role_permission_cache()
