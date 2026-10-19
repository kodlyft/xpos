# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class XPOSFiscalAttempt(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		attempt_no: DF.Int
		channel: DF.Literal["Cloud", "Local Service", "Unknown"]
		company: DF.Link | None
		content_hash: DF.Data | None
		fbr_invoice_number: DF.Data | None
		fbr_pos_id: DF.Data
		invoice: DF.Data | None
		invoice_doctype: DF.Data | None
		payload: DF.Code | None
		pos_profile: DF.Link | None
		posted_on: DF.Datetime | None
		resolution: DF.Literal["", "Recorded", "Not Recorded"]
		resolution_evidence: DF.SmallText | None
		resolved_by: DF.Link | None
		resolved_on: DF.Datetime | None
		response: DF.SmallText | None
		status: DF.Literal["Sent", "Accepted", "Uncertain", "Rejected", "Not Sent"]
		usin: DF.Data
	# end: auto-generated types

	pass


def on_doctype_update():
	frappe.db.add_unique(
		"XPOS Fiscal Attempt", ["fbr_pos_id", "usin", "attempt_no"], constraint_name="unique_fiscal_attempt"
	)
