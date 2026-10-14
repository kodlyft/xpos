# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

from frappe.model.document import Document


class GiftCardCompanySetting(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		company: DF.Link
		issue_item: DF.Link
		liability_account: DF.Link
		max_amount: DF.Currency
		min_amount: DF.Currency
		mode_of_payment: DF.Link
		parent: DF.Data
		parentfield: DF.Data
		parenttype: DF.Data
		validity_days: DF.Int
	# end: auto-generated types

	pass
