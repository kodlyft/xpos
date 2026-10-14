# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

from xpos.x_pos.gift_cards import GiftCardController


class GiftCard(GiftCardController):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		balance: DF.Currency
		code_hash: DF.Data | None
		code_last4: DF.Data | None
		company: DF.Link
		currency: DF.Link
		issue_voucher: DF.DynamicLink | None
		issue_voucher_detail: DF.Data | None
		issue_voucher_type: DF.Link | None
		issued_value: DF.Currency
		purchaser: DF.Link | None
		status: DF.Literal["Active", "Depleted", "Voided"]
		valid_upto: DF.Date | None
	# end: auto-generated types

	pass
