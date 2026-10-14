# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

from xpos.x_pos.gift_cards import GiftCardSettingsController


class GiftCardSettings(GiftCardSettingsController):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		from xpos.x_pos.doctype.gift_card_company_setting.gift_card_company_setting import (
			GiftCardCompanySetting,
		)

		companies: DF.Table[GiftCardCompanySetting]
	# end: auto-generated types

	pass
