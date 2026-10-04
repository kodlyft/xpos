# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import flt

from xpos.x_pos.doctype.pos_closing_shift.closing_processing.invoices import (
	_clear_closing_entry_invoices,
	_set_closing_entry_invoices,
	consolidate_closing_shift_invoices,
	delete_draft_invoices,
)
from xpos.x_pos.doctype.pos_closing_shift.closing_processing.overview import (
	get_payment_reconciliation_details,
)


class POSClosingShift(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		from xpos.x_pos.doctype.pos_closing_shift_detail.pos_closing_shift_detail import POSClosingShiftDetail
		from xpos.x_pos.doctype.pos_closing_shift_taxes.pos_closing_shift_taxes import POSClosingShiftTaxes
		from xpos.x_pos.doctype.pos_payment_entry_reference.pos_payment_entry_reference import (
			POSPaymentEntryReference,
		)
		from xpos.x_pos.doctype.sales_invoice_reference.sales_invoice_reference import SalesInvoiceReference

		amended_from: DF.Link | None
		company: DF.Link
		grand_total: DF.Currency
		net_total: DF.Currency
		payment_reconciliation: DF.Table[POSClosingShiftDetail]
		period_end_date: DF.Datetime
		period_start_date: DF.Datetime
		pos_opening_shift: DF.Link
		pos_payments: DF.Table[POSPaymentEntryReference]
		pos_profile: DF.Link
		pos_transactions: DF.Table[SalesInvoiceReference]
		posting_date: DF.Date
		taxes: DF.Table[POSClosingShiftTaxes]
		total_quantity: DF.Float
		user: DF.Link
		xpos_local_id: DF.Data | None
	# end: auto-generated types

	def validate(self):
		user = frappe.get_all(
			"POS Closing Shift",
			filters={
				"user": self.user,
				"docstatus": 1,
				"pos_opening_shift": self.pos_opening_shift,
				"name": ["!=", self.name],
			},
		)

		if user:
			frappe.throw(
				_("POS Closing Shift {0} against {1} between selected period").format(
					frappe.bold("already exists"), frappe.bold(self.user)
				)
			)

		if frappe.db.get_value("POS Opening Shift", self.pos_opening_shift, "status") != "Open":
			frappe.throw(
				_("Selected POS Opening Shift should be open."),
				title=_("Invalid Opening Entry"),
			)
		self.update_payment_reconciliation()

	def update_payment_reconciliation(self):
		precision = frappe.get_cached_value("System Settings", None, "currency_precision") or 3
		for d in self.payment_reconciliation:
			d.difference = +flt(d.closing_amount, precision) - flt(d.expected_amount, precision)

	def on_submit(self):
		opening_entry = frappe.get_doc("POS Opening Shift", self.pos_opening_shift)
		opening_entry.pos_closing_shift = self.name
		opening_entry.set_status()
		delete_draft_invoices(self.pos_opening_shift, self.pos_profile)
		opening_entry.save()
		_set_closing_entry_invoices(self)
		consolidate_closing_shift_invoices(self)

	def on_cancel(self):
		if frappe.db.exists("POS Opening Shift", self.pos_opening_shift):
			opening_entry = frappe.get_doc("POS Opening Shift", self.pos_opening_shift)
			if opening_entry.pos_closing_shift == self.name:
				opening_entry.pos_closing_shift = ""
				opening_entry.set_status()
				opening_entry.save()

		_clear_closing_entry_invoices(self)

	def delete_draft_invoices(self):
		delete_draft_invoices(self.pos_opening_shift, self.pos_profile)

	@frappe.whitelist()
	def get_payment_reconciliation_details(self):
		return get_payment_reconciliation_details(self)
