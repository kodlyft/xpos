# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document
from frappe.utils import strip


class ReferralCode(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		campaign: DF.Link | None
		company: DF.Link
		customer: DF.Link
		customer_name: DF.Data | None
		customer_offer: DF.Link
		disabled: DF.Check
		email_id: DF.Data | None
		mobile_no: DF.Data | None
		primary_offer: DF.Link | None
		referral_code: DF.Data | None
		referral_name: DF.Data | None
	# end: auto-generated types

	def autoname(self):
		if not self.referral_name:
			self.referral_name = strip(self.customer) + "-" + frappe.generate_hash()[:5].upper()
			self.name = self.referral_name
		else:
			self.referral_name = strip(self.referral_name)
			self.name = self.referral_name

		if not self.referral_code:
			self.referral_code = frappe.generate_hash()[:10].upper()


def create_referral_code(company, customer, customer_offer, primary_offer=None, campaign=None):
	doc = frappe.new_doc("Referral Code")
	doc.company = company
	doc.customer = customer
	doc.customer_offer = customer_offer
	doc.primary_offer = primary_offer
	doc.campaign = campaign
	doc.save(ignore_permissions=True)
	return doc


UNIQUE_CUSTOMER_COMPANY = "unique_referral_customer_company"


def on_doctype_update():
	add_customer_company_unique()


def add_customer_company_unique() -> list:
	"""One referral code per customer and company, enforced by the database.

	Existing duplicates are left alone and returned: the index is only added
	once an admin has resolved them, so migrate never fails on old data.
	"""
	duplicates = frappe.db.sql(
		"""SELECT customer, company, COUNT(*) AS n FROM `tabReferral Code`
		GROUP BY customer, company HAVING COUNT(*) > 1""",
		as_dict=True,
	)
	if not duplicates:
		frappe.db.add_unique("Referral Code", ["customer", "company"], UNIQUE_CUSTOMER_COMPANY)
	return duplicates


def has_customer_company_unique() -> bool:
	return bool(frappe.db.has_index("tabReferral Code", UNIQUE_CUSTOMER_COMPANY))
