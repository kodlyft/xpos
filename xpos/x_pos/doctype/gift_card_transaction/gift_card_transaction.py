# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

from xpos.x_pos.gift_cards import GiftCardTransactionController


class GiftCardTransaction(GiftCardTransactionController):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		amount: DF.Currency
		balance_after: DF.Currency
		company: DF.Link
		currency: DF.Link | None
		gift_card: DF.Link
		operation_id: DF.Data | None
		posting_date: DF.Date | None
		remarks: DF.SmallText | None
		reverses: DF.Link | None
		transaction_type: DF.Literal["Issue", "Redeem", "Refund", "Void", "Adjustment"]
		user: DF.Link | None
		voucher_detail_no: DF.Data | None
		voucher_no: DF.DynamicLink | None
		voucher_type: DF.Link | None
	# end: auto-generated types

	pass
