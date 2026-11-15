# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

from frappe.model.document import Document


class XPOSLayoutPolicy(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		allow_customization: DF.Check
		allowed_display_fields: DF.SmallText | None
		allowed_footer_actions: DF.SmallText | None
		allowed_row_actions: DF.SmallText | None
		default_layout: DF.Code | None
		lock_cart_layout: DF.Check
		lock_favorite_categories: DF.Check
		lock_pinned_items: DF.Check
		lock_product_display: DF.Check
		lock_quick_actions: DF.Check
		lock_view_and_density: DF.Check
		max_favorite_categories: DF.Int
		max_pinned_items: DF.Int
		min_visible_actions: DF.Int
		pos_profile: DF.Link
	# end: auto-generated types

	def validate(self):
		self.min_visible_actions = max(int(self.min_visible_actions or 5), 5)
		self.max_pinned_items = max(int(self.max_pinned_items or 0), 0)
		self.max_favorite_categories = max(int(self.max_favorite_categories or 0), 0)
