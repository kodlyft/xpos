# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""Append-only log of changes that can alter what a till's offline catalogue holds."""

from frappe.model.document import Document


class XPOSCatalogChange(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		kind: DF.Literal["item", "reset"]
		logged_at: DF.Datetime | None
		name: DF.Int | None
		ref: DF.Data | None
	# end: auto-generated types

	pass
