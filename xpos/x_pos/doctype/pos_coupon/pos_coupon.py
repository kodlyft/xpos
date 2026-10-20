# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.query_builder.functions import Count
from frappe.utils import cint, cstr, getdate, strip, today

from xpos.utils import read_latest_on_lock

COUPON_INVOICE_DOCTYPES = ("Sales Invoice", "POS Invoice")


class POSCoupon(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		campaign: DF.Link | None
		company: DF.Link
		coupon_code: DF.Data | None
		coupon_name: DF.Data
		coupon_type: DF.Literal["Promotional", "Gift Card"]
		customer: DF.Link | None
		customer_name: DF.Data | None
		description: DF.TextEditor | None
		email_id: DF.Data | None
		maximum_use: DF.Int
		mobile_no: DF.Data | None
		one_use: DF.Check
		pos_offer: DF.Link
		referral_code: DF.Link | None
		used: DF.Int
		valid_from: DF.Date | None
		valid_upto: DF.Date | None

	# end: auto-generated types
	def autoname(self):
		self.coupon_name = strip(self.coupon_name)
		self.name = self.coupon_name

		if not self.coupon_code:
			if self.coupon_type == "Promotional":
				self.coupon_code = "".join(i for i in self.coupon_name if not i.isdigit())[0:8].upper()
			elif self.coupon_type == "Gift Card":
				self.coupon_code = frappe.generate_hash()[:10].upper()

	def validate(self):
		if self.coupon_type == "Gift Card":
			self.maximum_use = 1
			if not self.customer:
				frappe.throw(_("Please select the customer."))
		pos_offer = frappe.get_doc("POS Offer", self.pos_offer)
		if self.company != pos_offer.company:
			frappe.throw(_("Please select the correct POS Offer with the same company."))
		if not pos_offer.coupon_based:
			frappe.throw(_("Please select Coupon Code Based POS Offer."))
		if pos_offer.disabled:
			frappe.throw(_("POS Offer is disabled."))
		if pos_offer.valid_from and pos_offer.valid_from > getdate(self.valid_from):
			self.valid_from = pos_offer.valid_from
		if pos_offer.valid_upto and pos_offer.valid_upto < getdate(self.valid_upto):
			self.valid_upto = pos_offer.valid_upto

	def create_coupon_from_referral(self):
		if not self.customer:
			frappe.throw(_("Customer is required"))
		if not self.referral_code:
			frappe.throw(_("Referral Code is required"))
		ref_doc = None
		ref_code_exist = frappe.db.exists("Referral Code", self.referral_code)
		if not ref_code_exist:
			ref_doc = frappe.get_doc("Referral Code", {"referral_code": self.referral_code})
		else:
			ref_doc = frappe.get_doc("Referral Code", self.referral_code)
		if not ref_doc:
			frappe.throw(_("Referral Code {0} does not exist").format(self.referral_code))
		if ref_doc.disabled:
			frappe.throw(_("Referral Code {0} is disabled").format(self.referral_code))

		self.coupon_name = frappe.generate_hash()[:10].upper()
		self.coupon_type = "Gift Card"
		self.company = ref_doc.company
		self.pos_offer = ref_doc.customer_offer
		self.campaign = ref_doc.campaign
		self.referral_code = ref_doc.name
		self.save(ignore_permissions=True)

		if ref_doc.primary_offer:
			doc = frappe.new_doc("POS Coupon")
			doc.coupon_name = frappe.generate_hash()[:10].upper()
			doc.coupon_type = "Gift Card"
			doc.company = ref_doc.company
			doc.customer = ref_doc.customer
			doc.pos_offer = ref_doc.primary_offer
			doc.campaign = ref_doc.campaign
			doc.referral_code = ref_doc.name
			doc.save(ignore_permissions=True)


def check_coupon_code(coupon_code, customer=None, company=None):
	"""Preview whether a coupon can be applied.

	This is advisory only: nothing is locked, so the same rules are enforced
	again by ``update_coupon_usage`` when the invoice is submitted.
	"""
	res = {"coupon": None}
	coupon_name = get_coupon_name(coupon_code)
	if not coupon_name:
		res["msg"] = _("Sorry, this coupon code not exists")
		return res

	coupon = frappe.get_doc("POS Coupon", coupon_name)
	rejection = get_coupon_rejection(coupon, customer, company)
	if rejection:
		res["msg"] = rejection
		return res

	res["coupon"] = coupon
	res["msg"] = "Apply"
	return res


def validate_coupon_code(coupon_code, customer=None, company=None):
	res = check_coupon_code(coupon_code, customer, company)
	if not res.get("coupon"):
		frappe.throw(res.get("msg"))
	else:
		return res


def get_coupon_name(coupon_code):
	coupon_code = strip(cstr(coupon_code))
	if not coupon_code:
		return None
	return frappe.db.get_value("POS Coupon", {"coupon_code": coupon_code}) or frappe.db.get_value(
		"POS Coupon", {"coupon_code": coupon_code.upper()}
	)


def get_coupon_rejection(coupon, customer=None, company=None, on_date=None):
	"""Return the reason ``coupon`` cannot be used, or None when it can.

	The single set of rules shared by the preview endpoints and by submission.
	``coupon`` is a POS Coupon document or a row holding the same fields.
	"""
	on_date = getdate(on_date or today())

	if coupon.valid_from and getdate(coupon.valid_from) > on_date:
		return _("Sorry, this coupon code's validity has not started")
	if coupon.valid_upto and getdate(coupon.valid_upto) < on_date:
		return _("Sorry, this coupon code's validity has expired")
	# maximum_use = 0 means the coupon has no overall limit
	if cint(coupon.maximum_use) and cint(coupon.used) >= cint(coupon.maximum_use):
		return _("Sorry, this coupon code is no longer valid")

	pos_offer = frappe.db.get_value(
		"POS Offer", coupon.pos_offer, ["disabled", "valid_from", "valid_upto"], as_dict=True
	)
	if not pos_offer or pos_offer.disabled:
		return _("Sorry, this coupon code is no longer valid")
	if pos_offer.valid_from and getdate(pos_offer.valid_from) > on_date:
		return _("Sorry, this coupon code's validity has not started")
	if pos_offer.valid_upto and getdate(pos_offer.valid_upto) < on_date:
		return _("Sorry, this coupon code's validity has expired")

	# Gift Cards always carry the customer they were issued to
	if coupon.customer and coupon.customer != customer:
		return _("Sorry, this coupon code cannot be used by this customer")

	if company and coupon.company != company:
		return _("Sorry, this coupon code cannot be used by this company")

	if customer and coupon.one_use and count_customer_redemptions(coupon.name, customer):
		return _("Sorry, {0} have used this coupon before").format(customer)

	return None


def count_customer_redemptions(coupon_name, customer):
	"""Number of submitted sales on which ``customer`` redeemed this exact coupon.

	The customer is read from the invoice, not from the coupon row, which is
	filled in by the client. Drafts and cancelled invoices are not uses.
	"""
	detail = frappe.qb.DocType("POS Coupon Detail")
	redemptions = 0
	for doctype in COUPON_INVOICE_DOCTYPES:
		invoice = frappe.qb.DocType(doctype)
		query = (
			frappe.qb.from_(detail)
			.join(invoice)
			.on(detail.parent == invoice.name)
			.select(Count(invoice.name).distinct())
			.where(detail.parenttype == doctype)
			.where(detail.parentfield == "coupons")
			.where(detail.coupon == coupon_name)
			.where(detail.applied == 1)
			.where(invoice.docstatus == 1)
			.where(invoice.customer == customer)
			.where(invoice.is_return == 0)
		)
		if doctype == "Sales Invoice":
			# a consolidated invoice repeats sales already counted on their POS Invoices
			query = query.where(invoice.is_consolidated == 0)
		redemptions += query.run()[0][0]
	return redemptions


def is_coupon_redemption(doc):
	"""Returns and consolidated invoices only mirror a sale that was counted already."""
	return not cint(doc.get("is_return")) and not cint(doc.get("is_consolidated"))


def get_applied_coupons(doc):
	"""Coupons an invoice redeems: one use each, however many rows repeat a coupon.

	Sorted so that two invoices sharing several coupons lock them in the same order.
	"""
	if not is_coupon_redemption(doc):
		return []
	return sorted({row.coupon for row in doc.get("coupons") or [] if row.applied and row.coupon})


def validate_invoice_coupons(doc):
	"""Reject an invoice whose coupons can no longer be used, without locking anything.

	Lets a sale fail early, before any step that cannot be rolled back such as
	fiscalization. ``update_coupon_usage`` remains the check that counts.
	"""
	for coupon_name in get_applied_coupons(doc):
		coupon = frappe.get_doc("POS Coupon", coupon_name)
		rejection = get_coupon_rejection(coupon, doc.customer, doc.company, doc.posting_date)
		if rejection:
			frappe.throw(rejection)


def update_coupon_usage(doc, transaction_type):
	"""Redeem ("used") or release ("cancelled") every coupon applied on an invoice.

	Called while the invoice is being submitted or cancelled, so the coupon
	rows stay locked until that transaction commits or rolls back.
	"""
	for coupon_name in get_applied_coupons(doc):
		if transaction_type == "used":
			redeem_coupon(coupon_name, doc.customer, doc.company, doc.posting_date)
		elif transaction_type == "cancelled":
			release_coupon(coupon_name)


def redeem_coupon(coupon_name, customer, company, posting_date=None):
	coupon = lock_coupon(coupon_name)
	if coupon.one_use and coupon.changed_in_flight:
		# The per-customer count below is read from this transaction's snapshot,
		# which predates the other sale, so it cannot be trusted this time round.
		frappe.throw(
			_("Coupon {0} was just used in another sale. Please try again.").format(coupon.coupon_code),
			frappe.TimestampMismatchError,
		)

	rejection = get_coupon_rejection(coupon, customer, company, posting_date)
	if rejection:
		frappe.throw(rejection)

	frappe.db.set_value("POS Coupon", coupon_name, "used", cint(coupon.used) + 1)


def release_coupon(coupon_name):
	coupon = lock_coupon(coupon_name)
	if cint(coupon.used) > 0:
		frappe.db.set_value("POS Coupon", coupon_name, "used", cint(coupon.used) - 1)


def lock_coupon(coupon_name):
	"""Lock a coupon until the transaction ends and return its latest committed state.

	Every redemption and cancellation goes through here, so concurrent invoices
	queue up on the row and each one sees the ``used`` count left by the last.
	``changed_in_flight`` tells the caller that another transaction changed the
	coupon after this one took its snapshot.
	"""
	read_latest_on_lock()
	seen = frappe.db.get_value("POS Coupon", coupon_name, "modified")
	coupon = frappe.db.get_value(
		"POS Coupon",
		coupon_name,
		[
			"name",
			"coupon_code",
			"company",
			"customer",
			"pos_offer",
			"valid_from",
			"valid_upto",
			"maximum_use",
			"used",
			"one_use",
			"modified",
		],
		as_dict=True,
		for_update=True,
	)
	if not coupon:
		frappe.throw(_("Sorry, this coupon code not exists"))

	coupon.changed_in_flight = seen != coupon.modified
	return coupon
