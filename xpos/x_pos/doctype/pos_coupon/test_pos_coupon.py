# Copyright (c) 2026, Ali Raza and Contributors
# See license.txt

import threading
from unittest.mock import patch

import frappe
from erpnext.accounts.doctype.pos_closing_entry.test_pos_closing_entry import init_user_and_profile
from erpnext.accounts.doctype.pos_invoice.test_pos_invoice import create_pos_invoice
from erpnext.accounts.doctype.pos_opening_entry.test_pos_opening_entry import create_opening_entry
from erpnext.accounts.doctype.sales_invoice.test_sales_invoice import create_sales_invoice
from erpnext.stock.doctype.stock_entry.test_stock_entry import make_stock_entry
from erpnext.tests.utils import ERPNextTestSuite
from frappe.utils import add_days, nowdate

from xpos.api import offers as active_api
from xpos.x_pos.api import offers as legacy_api
from xpos.x_pos.doctype.pos_coupon.pos_coupon import check_coupon_code, validate_coupon_code

COMPANY = "_Test Company"
CUSTOMER = "_Test Customer"
OTHER_CUSTOMER = "_Test Customer 1"


def make_offer(title="_Test Coupon Offer", **args):
	offer = frappe.new_doc("POS Offer")
	offer.update(
		{
			"title": title,
			"description": title,
			"company": COMPANY,
			"apply_on": "Transaction",
			"offer": "Grand Total",
			"discount_type": "Discount Percentage",
			"discount_percentage": 10,
			"coupon_based": 1,
			"valid_from": add_days(nowdate(), -30),
		}
	)
	offer.update(args)
	return offer.insert()


def make_coupon(name, offer=None, **args):
	coupon = frappe.new_doc("POS Coupon")
	coupon.update(
		{
			"coupon_name": name,
			"coupon_code": name.upper().replace(" ", ""),
			"coupon_type": "Promotional",
			"company": COMPANY,
			"pos_offer": offer or make_offer(f"{name} Offer").name,
		}
	)
	coupon.update(args)
	return coupon.insert()


def make_sales_invoice(coupon, customer=CUSTOMER, submit=True, **args):
	invoice = create_sales_invoice(customer=customer, do_not_save=True, **args)
	invoice.append("coupons", {"coupon": coupon, "applied": 1, "customer": customer})
	invoice.insert()
	if submit:
		invoice.submit()
	return invoice


def make_pos_invoice(coupon, pos_profile, customer=CUSTOMER, submit=True):
	invoice = create_pos_invoice(pos_profile=pos_profile, customer=customer, do_not_submit=True)
	invoice.append("coupons", {"coupon": coupon, "applied": 1, "customer": customer})
	invoice.append("payments", {"mode_of_payment": "Cash", "amount": invoice.grand_total})
	invoice.save()
	if submit:
		invoice.submit()
	return invoice


def used(coupon):
	return frappe.db.get_value("POS Coupon", coupon, "used")


class TestCouponPreview(ERPNextTestSuite):
	"""Both whitelisted endpoints must apply the one shared set of rules."""

	def assert_rejected(self, coupon, customer=CUSTOMER, company=COMPANY):
		for endpoint in (active_api.get_pos_coupon, legacy_api.get_pos_coupon):
			result = endpoint(coupon.coupon_code, customer, company)
			self.assertIsNone(result["coupon"], endpoint.__module__)
			self.assertNotEqual(result["msg"], "Apply")
		self.assertRaises(frappe.ValidationError, validate_coupon_code, coupon.coupon_code, customer, company)

	def assert_accepted(self, coupon, customer=CUSTOMER, company=COMPANY):
		for endpoint in (active_api.get_pos_coupon, legacy_api.get_pos_coupon):
			result = endpoint(coupon.coupon_code, customer, company)
			self.assertEqual(result["msg"], "Apply", endpoint.__module__)
			self.assertEqual(result["coupon"].name, coupon.name)

	def test_active_endpoint_returns_the_linked_offer(self):
		coupon = make_coupon("_Test Shape")
		result = active_api.get_pos_coupon(coupon.coupon_code, CUSTOMER, COMPANY)
		self.assertEqual(result["coupon"]["pos_offer"], coupon.pos_offer)
		self.assertEqual(result["coupon"]["coupon_type"], "Promotional")
		self.assertEqual(result["offer"]["name"], coupon.pos_offer)
		self.assertEqual(result["offer"]["discount_percentage"], 10)

	def test_unknown_code_is_rejected(self):
		for endpoint in (active_api.get_pos_coupon, legacy_api.get_pos_coupon):
			self.assertIsNone(endpoint("_NO_SUCH_CODE", CUSTOMER, COMPANY)["coupon"])

	def test_one_use_rejects_the_same_customer_after_a_submitted_sale(self):
		coupon = make_coupon("_Test One Use", one_use=1)
		self.assert_accepted(coupon)
		make_sales_invoice(coupon.name)
		self.assert_rejected(coupon)

	def test_one_use_is_per_customer(self):
		coupon = make_coupon("_Test One Use", one_use=1)
		make_sales_invoice(coupon.name)
		self.assert_accepted(coupon, customer=OTHER_CUSTOMER)

	def test_one_use_is_per_coupon(self):
		"""Using one coupon must not burn the customer's other one-use coupons."""
		make_sales_invoice(make_coupon("_Test One Use", one_use=1).name)
		self.assert_accepted(make_coupon("_Test Other One Use", one_use=1))

	def test_drafts_do_not_count(self):
		coupon = make_coupon("_Test One Use", one_use=1)
		make_sales_invoice(coupon.name, submit=False)
		self.assert_accepted(coupon)

	def test_maximum_use_zero_is_unlimited(self):
		coupon = make_coupon("_Test Unlimited", maximum_use=0)
		for _i in range(3):
			make_sales_invoice(coupon.name)
		self.assertEqual(used(coupon.name), 3)
		self.assert_accepted(coupon)

	def test_global_maximum(self):
		coupon = make_coupon("_Test Max Two", maximum_use=2)
		make_sales_invoice(coupon.name)
		self.assert_accepted(coupon, customer=OTHER_CUSTOMER)
		make_sales_invoice(coupon.name, customer=OTHER_CUSTOMER)
		self.assert_rejected(coupon)
		self.assert_rejected(coupon, customer=OTHER_CUSTOMER)

	def test_validity_dates(self):
		self.assert_rejected(make_coupon("_Test Future", valid_from=add_days(nowdate(), 1)))
		self.assert_rejected(
			make_coupon(
				"_Test Expired", valid_from=add_days(nowdate(), -5), valid_upto=add_days(nowdate(), -1)
			)
		)
		self.assert_accepted(
			make_coupon("_Test Current", valid_from=nowdate(), valid_upto=nowdate()),
		)

	def test_disabled_offer(self):
		coupon = make_coupon("_Test Disabled Offer")
		frappe.db.set_value("POS Offer", coupon.pos_offer, "disabled", 1)
		self.assert_rejected(coupon)

	def test_expired_offer(self):
		coupon = make_coupon("_Test Expired Offer")
		frappe.db.set_value("POS Offer", coupon.pos_offer, "valid_upto", add_days(nowdate(), -1))
		self.assert_rejected(coupon)

	def test_company_restriction(self):
		self.assert_rejected(make_coupon("_Test Company Bound"), company="_Test Company 1")

	def test_gift_card_is_bound_to_its_customer(self):
		"""Legacy Gift Card behaviour: one use in total, by the customer it was issued to."""
		coupon = make_coupon("_Test Gift", coupon_type="Gift Card", customer=CUSTOMER)
		self.assertEqual(coupon.maximum_use, 1)
		self.assert_rejected(coupon, customer=OTHER_CUSTOMER)
		self.assert_accepted(coupon)
		self.assertIn(coupon.coupon_code, active_api.get_active_gift_coupons(CUSTOMER, COMPANY))
		make_sales_invoice(coupon.name)
		self.assert_rejected(coupon)
		self.assertNotIn(coupon.coupon_code, active_api.get_active_gift_coupons(CUSTOMER, COMPANY))

	def test_promotional_coupon_is_open_to_every_customer(self):
		coupon = make_coupon("_Test Promo")
		make_sales_invoice(coupon.name)
		self.assert_accepted(coupon)
		self.assert_accepted(coupon, customer=OTHER_CUSTOMER)


class TestCouponRedemption(ERPNextTestSuite):
	"""Preview is advisory; the limits are enforced again when the invoice is submitted."""

	def test_second_sale_by_the_same_customer_is_rejected_on_submit(self):
		coupon = make_coupon("_Test One Use", one_use=1)
		make_sales_invoice(coupon.name)
		second = make_sales_invoice(coupon.name, submit=False)
		self.assertRaises(frappe.ValidationError, second.submit)
		self.assertEqual(used(coupon.name), 1)

	def test_spent_coupon_is_rejected_before_fiscalization(self):
		coupon = make_coupon("_Test One Use", one_use=1)
		make_sales_invoice(coupon.name)
		second = make_sales_invoice(coupon.name, submit=False)
		with patch("xpos.x_pos.api.invoice.fiscalize_invoice") as fiscalize:
			self.assertRaises(frappe.ValidationError, second.submit)
		fiscalize.assert_not_called()

	def test_other_customer_and_other_coupon_still_submit(self):
		coupon = make_coupon("_Test One Use", one_use=1)
		make_sales_invoice(coupon.name)
		make_sales_invoice(coupon.name, customer=OTHER_CUSTOMER)
		make_sales_invoice(make_coupon("_Test Other One Use", one_use=1).name)
		self.assertEqual(used(coupon.name), 2)

	def test_global_maximum_is_enforced_on_submit(self):
		coupon = make_coupon("_Test Max One", maximum_use=1)
		make_sales_invoice(coupon.name)
		second = make_sales_invoice(coupon.name, customer=OTHER_CUSTOMER, submit=False)
		self.assertRaises(frappe.ValidationError, second.submit)
		self.assertEqual(used(coupon.name), 1)

	def test_restrictions_are_enforced_on_submit(self):
		gift = make_coupon("_Test Gift", coupon_type="Gift Card", customer=CUSTOMER)
		stolen = make_sales_invoice(gift.name, customer=OTHER_CUSTOMER, submit=False)
		self.assertRaises(frappe.ValidationError, stolen.submit)

		disabled = make_coupon("_Test Disabled Offer")
		draft = make_sales_invoice(disabled.name, submit=False)
		frappe.db.set_value("POS Offer", disabled.pos_offer, "disabled", 1)
		self.assertRaises(frappe.ValidationError, draft.submit)

		expired = make_coupon(
			"_Test Expired", valid_from=add_days(nowdate(), -5), valid_upto=add_days(nowdate(), -1)
		)
		draft = make_sales_invoice(expired.name, submit=False)
		self.assertRaises(frappe.ValidationError, draft.submit)

		foreign = make_coupon("_Test Foreign")
		draft = make_sales_invoice(foreign.name, submit=False)
		frappe.db.set_value("POS Coupon", foreign.name, "company", "_Test Company 1")
		self.assertRaises(frappe.ValidationError, draft.submit)

		for coupon in (gift, disabled, expired, foreign):
			self.assertEqual(used(coupon.name), 0)

	def test_coupon_listed_twice_on_one_invoice_is_one_use(self):
		coupon = make_coupon("_Test Max One", maximum_use=1)
		invoice = make_sales_invoice(coupon.name, submit=False)
		invoice.append("coupons", {"coupon": coupon.name, "applied": 1})
		invoice.save()
		invoice.submit()
		self.assertEqual(used(coupon.name), 1)
		invoice.cancel()
		self.assertEqual(used(coupon.name), 0)

	def test_unapplied_row_is_not_a_use(self):
		coupon = make_coupon("_Test One Use", one_use=1)
		invoice = create_sales_invoice(customer=CUSTOMER, do_not_save=True)
		invoice.append("coupons", {"coupon": coupon.name, "applied": 0})
		invoice.insert()
		invoice.submit()
		self.assertEqual(used(coupon.name), 0)
		self.assertEqual(check_coupon_code(coupon.coupon_code, CUSTOMER, COMPANY)["msg"], "Apply")

	def test_customer_is_taken_from_the_invoice_not_the_row(self):
		"""The row's customer comes from the client and cannot be trusted to scope a use."""
		coupon = make_coupon("_Test One Use", one_use=1)
		make_sales_invoice(coupon.name)
		second = create_sales_invoice(customer=CUSTOMER, do_not_save=True)
		second.append("coupons", {"coupon": coupon.name, "applied": 1, "customer": OTHER_CUSTOMER})
		second.insert()
		self.assertRaises(frappe.ValidationError, second.submit)

	def test_cancellation_frees_the_use_for_a_retry(self):
		coupon = make_coupon("_Test Gift", coupon_type="Gift Card", customer=CUSTOMER, one_use=1)
		first = make_sales_invoice(coupon.name)
		self.assertEqual(used(coupon.name), 1)
		first.cancel()
		self.assertEqual(used(coupon.name), 0)
		self.assertEqual(check_coupon_code(coupon.coupon_code, CUSTOMER, COMPANY)["msg"], "Apply")
		make_sales_invoice(coupon.name)
		self.assertEqual(used(coupon.name), 1)

	def test_cancellation_works_after_the_offer_is_disabled(self):
		coupon = make_coupon("_Test Promo")
		invoice = make_sales_invoice(coupon.name)
		frappe.db.set_value("POS Offer", coupon.pos_offer, "disabled", 1)
		invoice.cancel()
		self.assertEqual(used(coupon.name), 0)

	def test_consolidated_invoice_is_not_a_second_use(self):
		"""Shift closing rolls POS Invoices, each counted already, into one Sales Invoice."""
		coupon = make_coupon("_Test One Use", one_use=1, maximum_use=1)
		make_sales_invoice(coupon.name)
		consolidated = make_sales_invoice(coupon.name, submit=False)
		consolidated.is_consolidated = 1
		consolidated.submit()
		self.assertEqual(used(coupon.name), 1)
		consolidated.cancel()
		self.assertEqual(used(coupon.name), 1)
		self.assertIsNone(check_coupon_code(coupon.coupon_code, CUSTOMER, COMPANY)["coupon"])

	def test_return_neither_uses_nor_frees_the_coupon(self):
		from erpnext.controllers.sales_and_purchase_return import make_return_doc

		coupon = make_coupon("_Test One Use", one_use=1, maximum_use=1)
		sale = make_sales_invoice(coupon.name)
		credit_note = make_return_doc("Sales Invoice", sale.name)
		credit_note.insert()
		credit_note.submit()
		self.assertEqual(used(coupon.name), 1)
		credit_note.cancel()
		self.assertEqual(used(coupon.name), 1)


class TestCouponRedemptionOnPOSInvoice(ERPNextTestSuite):
	def setUp(self):
		self.test_user, self.pos_profile = init_user_and_profile()
		frappe.set_user("Administrator")
		frappe.db.set_single_value("POS Settings", "invoice_type", "POS Invoice")
		make_stock_entry(target="_Test Warehouse - _TC", item_code="_Test Item", qty=100, basic_rate=100)
		create_opening_entry(self.pos_profile, self.test_user.name)

	def test_pos_invoice_use_blocks_both_doctypes(self):
		coupon = make_coupon("_Test One Use", one_use=1)
		make_pos_invoice(coupon.name, self.pos_profile.name)
		self.assertEqual(used(coupon.name), 1)
		self.assertIsNone(check_coupon_code(coupon.coupon_code, CUSTOMER, COMPANY)["coupon"])
		self.assertIsNone(active_api.get_pos_coupon(coupon.coupon_code, CUSTOMER, COMPANY)["coupon"])

		second = make_pos_invoice(coupon.name, self.pos_profile.name, submit=False)
		self.assertRaises(frappe.ValidationError, second.submit)
		self.assertRaises(frappe.ValidationError, make_sales_invoice(coupon.name, submit=False).submit)

		make_pos_invoice(coupon.name, self.pos_profile.name, customer=OTHER_CUSTOMER)
		self.assertEqual(used(coupon.name), 2)

	def test_sales_invoice_use_blocks_pos_invoice(self):
		coupon = make_coupon("_Test One Use", one_use=1)
		make_sales_invoice(coupon.name)
		second = make_pos_invoice(coupon.name, self.pos_profile.name, submit=False)
		self.assertRaises(frappe.ValidationError, second.submit)

	def test_pos_invoice_cancellation_frees_the_use(self):
		coupon = make_coupon("_Test Max One", maximum_use=1)
		invoice = make_pos_invoice(coupon.name, self.pos_profile.name)
		invoice.cancel()
		self.assertEqual(used(coupon.name), 0)
		make_pos_invoice(coupon.name, self.pos_profile.name)
		self.assertEqual(used(coupon.name), 1)

	def test_consolidation_counts_the_sale_once(self):
		coupon = make_coupon("_Test Max One", one_use=1, maximum_use=1)
		pos_invoice = make_pos_invoice(coupon.name, self.pos_profile.name)
		self.assertEqual(used(coupon.name), 1)

		merge_log = frappe.new_doc("POS Invoice Merge Log")
		merge_log.update(
			{
				"posting_date": pos_invoice.posting_date,
				"posting_time": pos_invoice.posting_time,
				"company": pos_invoice.company,
				"customer": pos_invoice.customer,
			}
		)
		merge_log.append(
			"pos_invoices",
			{
				"pos_invoice": pos_invoice.name,
				"posting_date": pos_invoice.posting_date,
				"grand_total": pos_invoice.grand_total,
				"customer": pos_invoice.customer,
			},
		)
		merge_log.insert()
		merge_log.submit()

		pos_invoice.reload()
		self.assertTrue(pos_invoice.consolidated_invoice)
		self.assertEqual(used(coupon.name), 1)
		# still exactly one use of the one allowed, so the customer stays blocked
		self.assertIsNone(check_coupon_code(coupon.coupon_code, CUSTOMER, COMPANY)["coupon"])

		consolidated = frappe.get_doc("Sales Invoice", pos_invoice.consolidated_invoice)
		self.assertEqual(consolidated.is_consolidated, 1)
		self.assertEqual(consolidated.docstatus, 1)

		merge_log.cancel()
		self.assertEqual(used(coupon.name), 1)
		self.assertIsNone(check_coupon_code(coupon.coupon_code, CUSTOMER, COMPANY)["coupon"])


class TestConcurrentCouponRedemption(ERPNextTestSuite):
	"""Two database connections racing for a coupon.

	These tests commit, because the two sessions can only contend on rows that
	both of them can see; everything they create is removed again afterwards.
	"""

	def setUp(self):
		frappe.db.rollback()
		self.invoices = []
		self.coupons = []
		self.addCleanup(self.remove_committed_records)

	def remove_committed_records(self):
		frappe.db.rollback()
		frappe.set_user("Administrator")
		frappe.db.set_single_value("Accounts Settings", "delete_linked_ledger_entries", 1)
		for name in self.invoices:
			invoice = frappe.get_doc("Sales Invoice", name)
			if invoice.docstatus == 1:
				invoice.cancel()
			frappe.delete_doc("Sales Invoice", name, force=True)
		for coupon in self.coupons:
			frappe.delete_doc("POS Coupon", coupon.name, force=True)
			frappe.delete_doc("POS Offer", coupon.pos_offer, force=True)
		frappe.db.set_single_value("Accounts Settings", "delete_linked_ledger_entries", 0)
		frappe.db.commit()  # nosemgrep

	def committed_coupon(self, **args):
		coupon = make_coupon(f"_Test Race {frappe.generate_hash(length=6)}", **args)
		self.coupons.append(coupon)
		return coupon

	def committed_draft(self, coupon, customer=CUSTOMER):
		invoice = make_sales_invoice(coupon.name, customer=customer, submit=False)
		self.invoices.append(invoice.name)
		return invoice.name

	def race(self, first, second):
		"""Submit ``first`` and hold its transaction open while ``second`` is submitted.

		``second`` reads the coupon before ``first`` commits, which is exactly the
		view a preview-only check would act on.
		"""
		# make the fixtures visible to both sessions
		frappe.db.commit()  # nosemgrep
		site = frappe.local.site
		second_has_read = threading.Event()
		first_has_submitted = threading.Event()
		second_is_submitting = threading.Event()
		outcome = {}

		def session(name, work):
			frappe.init(site)
			frappe.connect()
			frappe.flags.in_test = True
			try:
				work()
				frappe.db.commit()  # nosemgrep
				outcome[name] = None
			except Exception as error:
				frappe.db.rollback()
				outcome[name] = error
			finally:
				second_has_read.set()
				first_has_submitted.set()
				frappe.destroy()

		def submit_first():
			second_has_read.wait(30)
			frappe.get_doc("Sales Invoice", first).submit()
			first_has_submitted.set()
			second_is_submitting.wait(30)
			# give the second session time to reach the coupon before we commit
			threading.Event().wait(1.5)

		def submit_second():
			invoice = frappe.get_doc("Sales Invoice", second)
			second_has_read.set()
			first_has_submitted.wait(30)
			second_is_submitting.set()
			invoice.submit()

		threads = [
			threading.Thread(target=session, args=("first", submit_first)),
			threading.Thread(target=session, args=("second", submit_second)),
		]
		for thread in threads:
			thread.start()
		for thread in threads:
			thread.join(120)
		frappe.db.rollback()  # start a fresh read view
		return outcome["first"], outcome["second"]

	def submitted(self):
		return frappe.db.count("Sales Invoice", {"name": ("in", self.invoices), "docstatus": 1})

	def test_final_global_use_cannot_be_redeemed_twice(self):
		coupon = self.committed_coupon(maximum_use=1)
		first = self.committed_draft(coupon)
		second = self.committed_draft(coupon, customer=OTHER_CUSTOMER)

		first_error, second_error = self.race(first, second)

		self.assertIsNone(first_error)
		self.assertIsInstance(second_error, frappe.ValidationError)
		self.assertEqual(self.submitted(), 1)
		self.assertEqual(used(coupon.name), 1)

	def test_one_use_cannot_be_redeemed_twice_by_one_customer(self):
		coupon = self.committed_coupon(one_use=1)
		first = self.committed_draft(coupon)
		second = self.committed_draft(coupon)

		first_error, second_error = self.race(first, second)

		self.assertIsNone(first_error)
		self.assertIsNotNone(second_error)
		self.assertEqual(self.submitted(), 1)
		self.assertEqual(used(coupon.name), 1)

		# a retry sees the committed sale and is refused for the real reason
		self.assertRaises(frappe.ValidationError, frappe.get_doc("Sales Invoice", second).submit)
		frappe.db.rollback()

	def test_unlimited_coupon_is_counted_for_both_concurrent_sales(self):
		coupon = self.committed_coupon()
		first = self.committed_draft(coupon)
		second = self.committed_draft(coupon, customer=OTHER_CUSTOMER)

		first_error, second_error = self.race(first, second)

		self.assertIsNone(first_error)
		self.assertIsNone(second_error)
		self.assertEqual(self.submitted(), 2)
		self.assertEqual(used(coupon.name), 2)
