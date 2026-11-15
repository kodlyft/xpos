# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.model.document import Document

from xpos.reports import catalog


class XPOSReportSetting(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		aliases: DF.SmallText | None
		allow_export: DF.Check
		capability: DF.Data | None
		capability_reason: DF.SmallText | None
		category: DF.Literal["Inventory", "Sales", "Purchasing", "Operations", "Accounting", "Other"]
		chart: DF.Literal["runtime", "yes", "no"]
		description: DF.SmallText | None
		enabled: DF.Check
		filter_provider: DF.Data | None
		pos_permission: DF.Link | None
		report: DF.Link
		scope_verified: DF.Check
		scope_mode: DF.Literal["Company and Warehouse", "Company", "None"]
		summary: DF.Literal["runtime", "yes", "no"]
		thermal_print: DF.Check
	# end: auto-generated types

	def validate(self):
		self.assess_compatibility()

	def assess_compatibility(self):
		report = frappe.get_doc("Report", self.report)
		state, reasons, _filters = catalog.assess(report, self.as_dict())
		self.capability = state
		self.capability_reason = ", ".join(reasons)

		if self.enabled and state == "unsupported":
			frappe.throw(
				_("{0} cannot be shown in the POS: {1}").format(self.report, self.capability_reason),
			)
		if self.enabled and state == "adapter_required":
			frappe.msgprint(
				_("{0} needs a filter provider before the POS can run it: {1}").format(
					self.report, self.capability_reason
				),
				indicator="orange",
			)

	def on_update(self):
		catalog.bump_version()

	def on_trash(self):
		catalog.bump_version()
