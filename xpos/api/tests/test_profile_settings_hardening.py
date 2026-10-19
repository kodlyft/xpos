# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""Live checks for the POS Profile settings review (real ERPNext documents).

Run on a disposable test site::

    bench --site <site> run-tests --module xpos.api.tests.test_profile_settings_hardening

Most classes roll back after each test. The concurrency classes commit, because
two database sessions cannot see each other's uncommitted rows, and remove
everything they created afterwards.
"""

import threading
from unittest.mock import patch

import erpnext.accounts.doctype.payment_reconciliation.payment_reconciliation  # noqa: F401 - binds the real reconcile_against_document before tests patch erpnext.accounts.utils
import frappe
from erpnext.accounts.doctype.sales_invoice.test_sales_invoice import create_sales_invoice
from erpnext.tests.utils import ERPNextTestSuite
from frappe.utils import add_days, flt, nowdate

from xpos.api import invoices as invoices_api
from xpos.api.auth import clear_role_permission_cache
from xpos.api.invoices import _submit_invoice_job, create_invoice
from xpos.x_pos.integrations import fiscal_ledger

COMPANY = "_Test Company"
PROFILE = "_Test PS Hardening Profile"
PROFILE_2 = "_Test PS Hardening Profile 2"
PRICE_LIST = "_Test Price List"
CUSTOMER_LIST = "_Test PS Customer List"
ITEM_A = "_Test PS Item A"
ITEM_B = "_Test PS Item B"
UNPRICED = "_Test PS Unpriced Item"
CUSTOMER = "_Test Customer"
LIST_CUSTOMER = "_Test PS List Customer"
DISCOUNT_CUSTOMER = "_Test PS Discount Customer"
CASHIER = "ps-cashier@example.com"
MANAGER = "ps-manager@example.com"
DISCOUNTER_ROLE = "_Test PS Discounter"
DEBTORS = "Debtors - _TC"


def ensure(doctype, name, values):
	if not frappe.db.exists(doctype, name):
		frappe.get_doc({"doctype": doctype, **values}).insert(ignore_permissions=True)


def ensure_price(item, price_list, rate, **extra):
	filters = {"item_code": item, "price_list": price_list}
	if not frappe.db.exists("Item Price", filters):
		frappe.get_doc(
			{
				"doctype": "Item Price",
				"item_code": item,
				"price_list": price_list,
				"price_list_rate": rate,
				**extra,
			}
		).insert(ignore_permissions=True)


def ensure_user(email, roles):
	if not frappe.db.exists("User", email):
		user = frappe.get_doc(
			{"doctype": "User", "email": email, "first_name": email.split("@")[0], "send_welcome_email": 0}
		)
		user.insert(ignore_permissions=True)
	user = frappe.get_doc("User", email)
	user.add_roles(*roles)


def ensure_pos_role(name, permissions):
	if frappe.db.exists("POS Role", name):
		frappe.delete_doc("POS Role", name, force=True, ignore_permissions=True)
	role = frappe.get_doc({"doctype": "POS Role", "role_name": name})
	for key in permissions:
		role.append("permissions", {"permission": key, "enabled": 1})
	role.insert(ignore_permissions=True)
	clear_role_permission_cache()


def make_profile(name=PROFILE, warehouse="_Test Warehouse - _TC", users=(), **settings):
	"""A POS Profile without ERPNext's make_pos_profile, which deletes every other profile."""
	if frappe.db.exists("POS Profile", name):
		frappe.delete_doc("POS Profile", name, force=True, ignore_permissions=True)
	if not frappe.db.get_value("Mode of Payment Account", {"company": COMPANY, "parent": "Cash"}):
		cash = frappe.get_doc("Mode of Payment", "Cash")
		cash.append("accounts", {"company": COMPANY, "default_account": "Cash - _TC"})
		cash.save(ignore_permissions=True)
	pos = frappe.get_doc(
		{
			"doctype": "POS Profile",
			"name": name,
			"company": COMPANY,
			"currency": "INR",
			"cost_center": "_Test Cost Center - _TC",
			"income_account": "Sales - _TC",
			"expense_account": "_Test Account Cost for Goods Sold - _TC",
			"write_off_account": "_Test Write Off - _TC",
			"write_off_cost_center": "_Test Write Off Cost Center - _TC",
			"selling_price_list": PRICE_LIST,
			"warehouse": warehouse,
			"update_stock": 0,
			"payments": [{"mode_of_payment": "Cash", "default": 1}],
			"applicable_for_users": [{"user": "Administrator"}]
			+ [{"user": user, "pos_role": role, "discount_limit": limit} for user, role, limit in users],
			"allow_zero_rated_items": 0,
			"max_discount_percentage_allowed": 50,
		}
	)
	pos.update(settings)
	pos.flags.ignore_mandatory = True
	pos.insert(ignore_permissions=True)
	frappe.clear_cache(doctype="POS Profile")
	return pos


def setup_fixtures():
	frappe.db.set_single_value("POS Settings", "invoice_type", "Sales Invoice")
	for code in (ITEM_A, ITEM_B, UNPRICED):
		ensure(
			"Item",
			code,
			{
				"item_code": code,
				"item_name": code,
				"item_group": "All Item Groups",
				"stock_uom": "Nos",
				"is_stock_item": 0,
				"is_sales_item": 1,
			},
		)
	ensure(
		"Price List",
		CUSTOMER_LIST,
		{"price_list_name": CUSTOMER_LIST, "currency": "INR", "selling": 1, "enabled": 1},
	)
	ensure_price(ITEM_A, PRICE_LIST, 100)
	ensure_price(ITEM_B, PRICE_LIST, 40)
	ensure_price(ITEM_A, CUSTOMER_LIST, 80)
	for name, values in (
		(LIST_CUSTOMER, {"default_price_list": CUSTOMER_LIST}),
		(DISCOUNT_CUSTOMER, {"discount": 10}),
	):
		ensure(
			"Customer",
			name,
			{
				"customer_name": name,
				"customer_group": "_Test Customer Group",
				"territory": "_Test Territory",
				**values,
			},
		)
	ensure_user(CASHIER, ["Sales User", "Accounts User"])
	ensure_user(MANAGER, ["Sales User", "Accounts User"])
	ensure_pos_role(DISCOUNTER_ROLE, ["apply_additional_discount", "show_edit_discount_field"])


def line(item=ITEM_A, rate=100, qty=1, **extra):
	return {"item_code": item, "item_name": item, "qty": qty, "rate": rate, "uom": "Nos", **extra}


def sale(items, paid=None, customer=CUSTOMER, profile=PROFILE, local_id=None, **extra):
	paid = sum(i["qty"] * i["rate"] for i in items) if paid is None else paid
	data = {
		"pos_profile": profile,
		"customer": customer,
		"items": items,
		"payments": [{"mode_of_payment": "Cash", "amount": paid}],
		"local_id": local_id or "inv_" + frappe.generate_hash(length=32),
	}
	data.update(extra)
	return create_invoice(data)


def invoices_for(local_id):
	return frappe.get_all("Sales Invoice", {"xpos_local_id": local_id}, ["name", "docstatus"])


class HardeningTestCase(ERPNextTestSuite):
	def setUp(self):
		frappe.set_user("Administrator")
		setup_fixtures()
		self.pos = make_profile(
			users=[(CASHIER, "Cashier", 0), (MANAGER, DISCOUNTER_ROLE, 0)],
			apply_customer_discount=1,
		)

	def tearDown(self):
		frappe.set_user("Administrator")
		super().tearDown()


class TestDiscountAuthority(HardeningTestCase):
	"""1. Discount eligibility and authority are derived on the server, whatever the till labels it."""

	def test_forged_customer_tag_does_not_authorise_a_discount(self):
		frappe.set_user(CASHIER)
		with self.assertRaises(frappe.PermissionError):
			sale([line()], paid=50, additional_discount_percentage=50, discount_source="customer")

	def test_missing_tag_customer_discount_is_still_recognised(self):
		frappe.set_user(CASHIER)
		result = sale([line()], paid=90, customer=DISCOUNT_CUSTOMER, additional_discount_percentage=10)
		self.assertEqual(flt(frappe.db.get_value("Sales Invoice", result["name"], "grand_total")), 90)

	def test_inconsistent_tag_for_customer_without_discount_is_rejected(self):
		frappe.set_user(CASHIER)
		with self.assertRaises(frappe.PermissionError):
			sale([line()], paid=90, additional_discount_percentage=10, discount_source="customer")

	def test_customer_discount_disabled_on_profile_is_manual(self):
		frappe.db.set_value("POS Profile", PROFILE, "apply_customer_discount", 0)
		frappe.clear_cache(doctype="POS Profile")
		frappe.set_user(CASHIER)
		with self.assertRaises(frappe.PermissionError):
			sale([line()], paid=90, customer=DISCOUNT_CUSTOMER, additional_discount_percentage=10)

	def test_manual_line_discount_needs_permission_and_cap(self):
		frappe.set_user(CASHIER)
		with self.assertRaises(frappe.PermissionError):
			sale([line(discount_percentage=10)], paid=90)
		frappe.set_user(MANAGER)
		sale([line(discount_percentage=10)], paid=90)
		with self.assertRaisesRegex(frappe.ValidationError, "exceeds maximum allowed"):
			sale([line(discount_percentage=60)], paid=40)

	def test_user_discount_limit_caps_manual_discount(self):
		self.pos = make_profile(users=[(MANAGER, DISCOUNTER_ROLE, 5)], apply_customer_discount=1)
		frappe.set_user(MANAGER)
		sale([line()], paid=95, additional_discount_percentage=5)
		with self.assertRaisesRegex(frappe.ValidationError, "exceeds maximum allowed 5"):
			sale([line()], paid=90, additional_discount_percentage=10)

	def test_manual_discount_on_top_of_customer_discount_is_checked_as_excess(self):
		frappe.set_user(CASHIER)
		with self.assertRaises(frappe.PermissionError):
			sale([line()], paid=80, customer=DISCOUNT_CUSTOMER, additional_discount_percentage=20)

	def test_line_and_invoice_manual_discounts_cannot_stack_past_cap(self):
		self.pos = make_profile(users=[(MANAGER, DISCOUNTER_ROLE, 0)], max_discount_percentage_allowed=10)
		frappe.set_user(MANAGER)
		with self.assertRaisesRegex(frappe.ValidationError, "together give"):
			sale([line(discount_percentage=10)], paid=81, additional_discount_percentage=10)


class TestZeroPayable(HardeningTestCase):
	"""2. allow_zero_rated_items cannot be bypassed through invoice-level discounts or forged flags."""

	def setUp(self):
		super().setUp()
		# Administrator may discount without a cap here, so only the zero-price rule can refuse.
		self.pos = make_profile(max_discount_percentage_allowed=0)

	def test_full_invoice_discount_is_a_zero_price_sale(self):
		with self.assertRaisesRegex(frappe.ValidationError, "sold for nothing|totals zero"):
			sale([line()], paid=0, additional_discount_percentage=100)

	def test_fixed_discount_to_zero_is_a_zero_price_sale(self):
		with self.assertRaisesRegex(frappe.ValidationError, "sold for nothing|totals zero"):
			sale([line()], paid=0, discount_amount=100)

	def test_line_and_invoice_discount_combined_to_zero(self):
		with self.assertRaisesRegex(frappe.ValidationError, "sold for nothing|totals zero"):
			sale([line(discount_percentage=50)], paid=0, discount_amount=50)

	def test_forged_free_and_offer_flags_are_ordinary_lines(self):
		with self.assertRaisesRegex(frappe.ValidationError, "sold for nothing|totals zero"):
			sale(
				[line(), line(ITEM_B, rate=0, is_free_item=1, is_offer=1, offers="NO-SUCH-OFFER")],
				paid=100,
			)

	def test_allowed_when_profile_allows_zero_price(self):
		frappe.db.set_value("POS Profile", PROFILE, "allow_zero_rated_items", 1)
		frappe.clear_cache(doctype="POS Profile")
		result = sale([line()], paid=0, additional_discount_percentage=100)
		self.assertEqual(frappe.db.get_value("Sales Invoice", result["name"], "docstatus"), 1)


class TestRepricing(HardeningTestCase):
	"""3. A changed authoritative price is handed back for review; nothing is posted first."""

	def test_stale_price_returns_reprice_and_posts_nothing(self):
		frappe.set_user(CASHIER)
		local_id = "inv_" + frappe.generate_hash(length=32)
		result = sale([line(rate=90)], paid=90, local_id=local_id)
		self.assertEqual(result["status"], "reprice_required")
		self.assertEqual(result["lines"][0]["quoted_rate"], 90)
		self.assertEqual(result["lines"][0]["rate"], 100)
		self.assertEqual(result["grand_total"], 100)
		self.assertEqual(invoices_for(local_id), [], "no draft or submitted invoice may remain")

		# Cashier reviewed: resubmit at the new price with the same id, then a lost-response retry.
		accepted = sale([line(rate=100)], paid=100, local_id=local_id)
		self.assertEqual(frappe.db.get_value("Sales Invoice", accepted["name"], "docstatus"), 1)
		retry = sale([line(rate=100)], paid=100, local_id=local_id)
		self.assertTrue(retry["duplicate"])
		self.assertEqual(retry["name"], accepted["name"])

	def test_customer_change_reprices_from_the_customer_list(self):
		frappe.db.set_value("POS Profile", PROFILE, "force_price_from_customer_price_list", 1)
		frappe.clear_cache(doctype="POS Profile")
		frappe.set_user(CASHIER)
		result = sale([line(rate=100)], customer=LIST_CUSTOMER)
		self.assertEqual(result["status"], "reprice_required")
		self.assertEqual(result["lines"][0]["rate"], 80)
		self.assertEqual(result["price_list"], CUSTOMER_LIST)

	def test_expired_price_is_unavailable(self):
		price = frappe.get_doc("Item Price", {"item_code": ITEM_B, "price_list": PRICE_LIST})
		price.valid_upto = add_days(nowdate(), -1)
		price.valid_from = add_days(nowdate(), -30)
		price.save(ignore_permissions=True)
		frappe.set_user(CASHIER)
		with self.assertRaisesRegex(frappe.ValidationError, "Price unavailable"):
			sale([line(ITEM_B, rate=40)])

	def test_missing_price_cannot_be_invented(self):
		frappe.set_user(CASHIER)
		with self.assertRaisesRegex(frappe.ValidationError, "Price unavailable"):
			sale([line(UNPRICED, rate=50)])

	def test_permitted_manual_override_is_kept(self):
		frappe.set_user("Administrator")
		result = sale([line(rate=90)], paid=90)
		self.assertNotEqual(result.get("status"), "reprice_required")
		self.assertEqual(
			flt(frappe.db.get_value("Sales Invoice Item", {"parent": result["name"]}, "rate")), 90
		)

	def test_queued_invoice_reprices_on_sync(self):
		"""An offline-queued sale synced later goes through the same check (held for review on the till)."""
		frappe.set_user(CASHIER)
		local_id = "inv_" + frappe.generate_hash(length=32)
		payload = {
			"pos_profile": PROFILE,
			"customer": CUSTOMER,
			"items": [line(rate=95)],
			"payments": [{"mode_of_payment": "Cash", "amount": 95}],
		}
		result = create_invoice(frappe.as_json(payload), local_id=local_id)
		self.assertEqual(result["status"], "reprice_required")
		self.assertEqual(invoices_for(local_id), [])


class TestHeaderPriceList(HardeningTestCase):
	"""4. The invoice header names the list its line rates came from, even after a background submit."""

	def submit_in_background(self, customer):
		with patch.object(invoices_api, "enqueue") as enqueue:
			result = sale([line(rate=100)], customer=customer, submit_in_background=1)
		self.assertEqual(result["status"], "Queued")
		enqueue.assert_called_once()
		_submit_invoice_job(result["name"], "Sales Invoice")
		return frappe.get_doc("Sales Invoice", result["name"])

	def test_profile_list_when_customer_prices_not_forced(self):
		doc = self.submit_in_background(LIST_CUSTOMER)
		self.assertEqual(doc.docstatus, 1)
		self.assertEqual(doc.selling_price_list, PRICE_LIST)
		self.assertEqual(flt(doc.items[0].rate), 100)

	def test_customer_list_when_forced(self):
		frappe.db.set_value("POS Profile", PROFILE, "force_price_from_customer_price_list", 1)
		frappe.clear_cache(doctype="POS Profile")
		result = sale([line(rate=80)], customer=LIST_CUSTOMER)
		doc = frappe.get_doc("Sales Invoice", result["name"])
		self.assertEqual(doc.selling_price_list, CUSTOMER_LIST)
		self.assertEqual(flt(doc.items[0].rate), 80)


class TestCustomerGroupPriceList(HardeningTestCase):
	"""8. Customer-group fallback (with ancestry) prices the sale and is what offline tills cache."""

	def test_parent_group_list_is_used_and_cached_for_offline(self):
		ensure(
			"Customer Group",
			"_Test PS Priced Parent",
			{
				"customer_group_name": "_Test PS Priced Parent",
				"is_group": 1,
				"parent_customer_group": "All Customer Groups",
				"default_price_list": CUSTOMER_LIST,
			},
		)
		ensure(
			"Customer Group",
			"_Test PS Priced Child",
			{
				"customer_group_name": "_Test PS Priced Child",
				"parent_customer_group": "_Test PS Priced Parent",
			},
		)
		ensure(
			"Customer",
			"_Test PS Group Customer",
			{
				"customer_name": "_Test PS Group Customer",
				"customer_group": "_Test PS Priced Child",
				"territory": "_Test Territory",
			},
		)
		frappe.db.set_value("POS Profile", PROFILE, "force_price_from_customer_price_list", 1)
		frappe.clear_cache(doctype="POS Profile")

		from xpos.api.customers import get_customers

		cached = next(
			c for c in get_customers("_Test PS Group", 20, PROFILE) if c.name == "_Test PS Group Customer"
		)
		self.assertEqual(cached["pos_price_list"], CUSTOMER_LIST)

		result = sale([line(rate=80)], customer="_Test PS Group Customer")
		doc = frappe.get_doc("Sales Invoice", result["name"])
		self.assertEqual(doc.selling_price_list, CUSTOMER_LIST)
		self.assertEqual(flt(doc.items[0].rate), 80)


class TestLocalIdReuse(HardeningTestCase):
	"""5. A local_id reused for a different sale is refused, never answered with another sale."""

	def test_reuse_with_different_customer_payload_user_or_profile(self):
		local_id = "inv_" + frappe.generate_hash(length=32)
		sale([line()], local_id=local_id)
		with self.assertRaisesRegex(frappe.ValidationError, "already used for a different sale"):
			sale([line()], customer=DISCOUNT_CUSTOMER, local_id=local_id)
		with self.assertRaisesRegex(frappe.ValidationError, "already used for a different sale"):
			sale([line(qty=2)], local_id=local_id)
		make_profile(PROFILE_2, warehouse="_Test Warehouse 1 - _TC")
		with self.assertRaisesRegex(frappe.ValidationError, "already used for a different sale"):
			sale([line()], profile=PROFILE_2, local_id=local_id)
		frappe.set_user(CASHIER)
		with self.assertRaisesRegex(frappe.ValidationError, "already used for a different sale"):
			sale([line()], local_id=local_id)


class TestSaleIdentity(HardeningTestCase):
	"""4. A sale id returns its invoice only to the same user and the same financial payload."""

	def test_identical_retry_returns_the_same_invoice(self):
		local_id = "inv_" + frappe.generate_hash(length=32)
		first = sale([line()], local_id=local_id)
		retry = sale([line()], local_id=local_id)
		self.assertTrue(retry["duplicate"])
		self.assertEqual(retry["name"], first["name"])
		self.assertEqual(len(invoices_for(local_id)), 1)

	def test_changed_financial_inputs_are_refused(self):
		local_id = "inv_" + frappe.generate_hash(length=32)
		sale([line()], local_id=local_id)
		for change in (
			{"posting_date": add_days(nowdate(), -1)},
			{"discount_amount": 5},
			{"currency": "USD"},
			{"write_off_amount": 1},
			{"offers_detail": [{"offer_name": "X"}]},
		):
			with self.assertRaisesRegex(frappe.ValidationError, "already used for a different sale"):
				sale([line()], local_id=local_id, **change)
		with self.assertRaisesRegex(frappe.ValidationError, "already used for a different sale"):
			sale([line(warehouse="_Test Warehouse 1 - _TC")], local_id=local_id)
		self.assertEqual(len(invoices_for(local_id)), 1)

	def test_other_user_never_gets_the_invoice_even_without_a_fingerprint(self):
		local_id = "inv_" + frappe.generate_hash(length=32)
		first = sale([line()], local_id=local_id)
		frappe.db.set_value(
			"Sales Invoice", first["name"], "xpos_request_hash", None
		)  # pre-fingerprint invoice
		frappe.set_user(CASHIER)
		with self.assertRaisesRegex(frappe.ValidationError, "already used for a different sale") as caught:
			sale([line()], local_id=local_id)
		self.assertNotIn(first["name"], str(caught.exception))


def make_receipt(customer, amount):
	pe = frappe.get_doc(
		{
			"doctype": "Payment Entry",
			"payment_type": "Receive",
			"company": COMPANY,
			"party_type": "Customer",
			"party": customer,
			"paid_from": DEBTORS,
			"paid_to": "Cash - _TC",
			"paid_amount": amount,
			"received_amount": amount,
			"source_exchange_rate": 1,
			"target_exchange_rate": 1,
			"reference_no": frappe.generate_hash(length=8),
			"reference_date": nowdate(),
			"mode_of_payment": "Cash",
		}
	)
	pe.insert(ignore_permissions=True)
	pe.submit()
	return pe.name


def make_credit_note(customer, amount):
	return create_sales_invoice(
		customer=customer, item=ITEM_A, qty=-1, rate=amount, is_return=1, debit_to=DEBTORS
	).name


def credit(source_type, source_name, amount):
	return {"source_type": source_type, "source_name": source_name, "amount": amount}


def unallocated(pe):
	return flt(frappe.db.get_value("Payment Entry", pe, "unallocated_amount"))


def note_outstanding(note):
	return flt(frappe.db.get_value("Sales Invoice", note, "outstanding_amount"))


class TestCustomerCreditAccounting(HardeningTestCase):
	"""5. Credit spending through ERPNext reconciliation (single session; rolled back)."""

	def setUp(self):
		super().setUp()
		self.pos = make_profile(use_customer_credit=1, apply_customer_discount=1)

	def test_receipt_and_credit_note_in_one_sale(self):
		pe, note = make_receipt(CUSTOMER, 60), make_credit_note(CUSTOMER, 30)
		result = sale(
			[line(), line(ITEM_B, rate=40)],
			paid=50,
			customer_credit=[credit("Payment Entry", pe, 60), credit("Sales Invoice", note, 30)],
		)
		invoice = frappe.get_doc("Sales Invoice", result["name"])
		self.assertEqual(flt(invoice.outstanding_amount), 0)
		self.assertEqual(unallocated(pe), 0)
		self.assertEqual(note_outstanding(note), 0)

	def test_insufficient_after_earlier_allocation(self):
		pe = make_receipt(CUSTOMER, 50)
		sale([line(ITEM_B, rate=40)], paid=0, customer_credit=[credit("Payment Entry", pe, 40)])
		with self.assertRaisesRegex(frappe.ValidationError, "Only 10.0 of credit is left"):
			sale([line(ITEM_B, rate=40)], paid=0, customer_credit=[credit("Payment Entry", pe, 40)])

	def test_other_customers_credit_or_foreign_currency_rejected(self):
		pe = make_receipt("_Test Customer 1", 40)
		with self.assertRaisesRegex(frappe.ValidationError, "not available as credit"):
			sale([line(ITEM_B, rate=40)], paid=0, customer_credit=[credit("Payment Entry", pe, 40)])
		own = make_receipt(CUSTOMER, 40)
		with self.assertRaisesRegex(frappe.ValidationError, "company currency"):
			sale(
				[line(ITEM_B, rate=40)],
				paid=0,
				currency="USD",
				conversion_rate=80,
				customer_credit=[credit("Payment Entry", own, 40)],
			)

	def test_cancel_returns_credit_for_reuse(self):
		pe = make_receipt(CUSTOMER, 40)
		first = sale([line(ITEM_B, rate=40)], paid=0, customer_credit=[credit("Payment Entry", pe, 40)])
		self.assertEqual(unallocated(pe), 0)
		frappe.get_doc("Sales Invoice", first["name"]).cancel()
		self.assertEqual(unallocated(pe), 40)
		second = sale([line(ITEM_B, rate=40)], paid=0, customer_credit=[credit("Payment Entry", pe, 40)])
		self.assertEqual(frappe.db.get_value("Sales Invoice", second["name"], "outstanding_amount"), 0)

	def test_lost_response_retry_allocates_once(self):
		pe = make_receipt(CUSTOMER, 100)
		local_id = "inv_" + frappe.generate_hash(length=32)
		args = {"paid": 0, "local_id": local_id, "customer_credit": [credit("Payment Entry", pe, 40)]}
		first = sale([line(ITEM_B, rate=40)], **args)
		retry = sale([line(ITEM_B, rate=40)], **args)
		self.assertTrue(retry["duplicate"])
		self.assertEqual(retry["name"], first["name"])
		self.assertEqual(unallocated(pe), 60)


class CommittedCreditTestCase(ERPNextTestSuite):
	"""Two database sessions spending one customer's credit. Commits, then removes what it made."""

	def setUp(self):
		frappe.db.rollback()
		frappe.set_user("Administrator")
		setup_fixtures()
		make_profile(use_customer_credit=1)
		frappe.db.commit()  # nosemgrep
		self.created = []
		self.addCleanup(self.remove_committed_records)

	def remove_committed_records(self):
		frappe.db.rollback()
		frappe.set_user("Administrator")
		frappe.db.set_single_value("Accounts Settings", "delete_linked_ledger_entries", 1)
		names = self.created + [
			r.name
			for r in frappe.get_all("Sales Invoice", {"xpos_local_id": ("like", "inv_pstest%")}, ["name"])
		]
		for doctype in ("Sales Invoice", "Payment Entry", "Journal Entry"):
			for name in reversed(names):
				if frappe.db.exists(doctype, name) and frappe.db.get_value(doctype, name, "docstatus") == 1:
					frappe.get_doc(doctype, name).cancel()
		for je in frappe.get_all("Journal Entry", {"user_remark": ("like", "%_Test PS%")}, pluck="name"):
			names.append(je)
		for doctype in ("Sales Invoice", "Journal Entry", "Payment Entry"):
			for name in names:
				if frappe.db.exists(doctype, name):
					frappe.delete_doc(doctype, name, force=True, ignore_permissions=True)
		frappe.db.set_single_value("Accounts Settings", "delete_linked_ledger_entries", 0)
		frappe.db.commit()  # nosemgrep

	def run_sessions(self, works):
		"""Run each callable in its own committed session at the same time; return errors by index."""
		site = frappe.local.site
		start = threading.Barrier(len(works))
		outcome = {}

		def session(index, work):
			frappe.init(site)
			frappe.connect()
			frappe.set_user("Administrator")
			frappe.flags.in_test = True
			try:
				start.wait(30)
				result = work()
				frappe.db.commit()  # nosemgrep
				outcome[index] = result
			except Exception as error:
				frappe.db.rollback()
				outcome[index] = error
			finally:
				frappe.destroy()

		threads = [threading.Thread(target=session, args=(i, w)) for i, w in enumerate(works)]
		for thread in threads:
			thread.start()
		for thread in threads:
			thread.join(180)
		frappe.db.rollback()
		for result in outcome.values():
			if isinstance(result, dict) and result.get("name"):
				self.created.append(result["name"])
		return outcome

	def spend(self, source_type, source, amount, local_id):
		return lambda: sale(
			[line(ITEM_B, rate=40)],
			paid=40 - amount,
			local_id=local_id,
			customer_credit=[credit(source_type, source, amount)],
		)


class TestConcurrentCredit(CommittedCreditTestCase):
	def test_two_sales_cannot_both_spend_one_credit_note(self):
		note = make_credit_note(CUSTOMER, 40)
		self.created.append(note)
		frappe.db.commit()  # nosemgrep
		outcome = self.run_sessions(
			[
				self.spend("Sales Invoice", note, 40, f"inv_pstest{i}{frappe.generate_hash(length=8)}")
				for i in range(2)
			]
		)
		errors = [r for r in outcome.values() if isinstance(r, Exception)]
		successes = [r for r in outcome.values() if isinstance(r, dict)]
		self.assertEqual(len(successes), 1, outcome)
		self.assertEqual(len(errors), 1, outcome)
		self.assertIsInstance(errors[0], frappe.ValidationError)
		self.assertEqual(note_outstanding(note), 0)

	def test_concurrent_partial_allocations_of_one_receipt(self):
		pe = make_receipt(CUSTOMER, 100)
		self.created.append(pe)
		frappe.db.commit()  # nosemgrep
		outcome = self.run_sessions(
			[
				self.spend("Payment Entry", pe, 40, f"inv_pstest{i}{frappe.generate_hash(length=8)}")
				for i in range(2)
			]
		)
		self.assertTrue(all(isinstance(r, dict) for r in outcome.values()), outcome)
		self.assertEqual(unallocated(pe), 20)

	def test_failure_after_submit_rolls_back_invoice_and_allocations(self):
		pe = make_receipt(CUSTOMER, 100)
		self.created.append(pe)
		frappe.db.commit()  # nosemgrep
		local_id = f"inv_pstest{frappe.generate_hash(length=8)}"

		def fail_during_reconciliation():
			with patch(
				"erpnext.accounts.doctype.payment_reconciliation.payment_reconciliation.reconcile_dr_cr_note",
				side_effect=RuntimeError("injected"),
			):
				note = frappe.get_all("Sales Invoice", {"name": ("in", self.created)}, pluck="name")
				return sale(
					[line(ITEM_B, rate=40)],
					paid=0,
					local_id=local_id,
					customer_credit=[credit("Payment Entry", pe, 20)]
					+ [credit("Sales Invoice", n, 20) for n in note],
				)

		note = make_credit_note(CUSTOMER, 20)
		self.created.append(note)
		frappe.db.commit()  # nosemgrep
		outcome = self.run_sessions([fail_during_reconciliation])
		self.assertIsInstance(outcome[0], RuntimeError)
		self.assertEqual(invoices_for(local_id), [])
		self.assertEqual(unallocated(pe), 100)
		self.assertEqual(note_outstanding(note), -20)


class TestConcurrentSaleIdentity(CommittedCreditTestCase):
	def test_two_sessions_sending_one_sale_create_one_invoice(self):
		local_id = f"inv_pstest{frappe.generate_hash(length=8)}"
		outcome = self.run_sessions([lambda: sale([line(ITEM_B, rate=40)], local_id=local_id)] * 2)
		self.assertTrue(all(isinstance(r, dict) for r in outcome.values()), outcome)
		self.assertEqual({r["name"] for r in outcome.values()}, {invoices_for(local_id)[0].name})
		self.assertEqual(len(invoices_for(local_id)), 1)
		self.assertEqual(sorted(bool(r.get("duplicate")) for r in outcome.values()), [False, True])


def erpnext_reconciliation(source_type, source, invoice):
	"""Standard ERPNext Payment Reconciliation of ``source`` against ``invoice``, pulled now."""
	pr = frappe.new_doc("Payment Reconciliation")
	pr.company = COMPANY
	pr.party_type = "Customer"
	pr.party = CUSTOMER
	pr.receivable_payable_account = DEBTORS
	pr.get_unreconciled_entries()
	invoices = [i.as_dict() for i in pr.invoices if i.invoice_number == invoice]
	payments = [
		p.as_dict() for p in pr.payments if p.reference_type == source_type and p.reference_name == source
	]
	assert invoices and payments, (invoices, payments)
	return pr, invoices, payments


def ledger_remaining(voucher_type, voucher_no):
	"""Unspent credit on a source according to the Payment Ledger (negative = still available)."""
	return flt(
		frappe.db.sql(
			"""SELECT SUM(amount) FROM `tabPayment Ledger Entry`
			WHERE against_voucher_type = %s AND against_voucher_no = %s AND delinked = 0""",
			(voucher_type, voucher_no),
		)[0][0]
	)


class TestExternalCreditAllocation(CommittedCreditTestCase):
	"""ERPNext's own Payment Reconciliation spends the same credit as an XPOS sale, at the same time."""

	def source(self, source_type):
		name = (
			make_receipt(CUSTOMER, 40) if source_type == "Payment Entry" else make_credit_note(CUSTOMER, 40)
		)
		target = create_sales_invoice(customer=CUSTOMER, item=ITEM_A, qty=1, rate=40, debit_to=DEBTORS).name
		self.created += [name, target]
		frappe.db.commit()  # nosemgrep
		return name, target

	def track_journals(self, *names):
		self.created += frappe.get_all(
			"Journal Entry Account", {"reference_name": ("in", names), "docstatus": 1}, pluck="parent"
		)

	def race(self, source_type, erpnext_first):
		source, target = self.source(source_type)
		pulled, step = threading.Event(), threading.Event()
		local_id = f"inv_pstest{frappe.generate_hash(length=8)}"

		def desk_user():
			pr, invoices, payments = erpnext_reconciliation(source_type, source, target)
			pulled.set()
			if not erpnext_first:
				step.wait(60)  # the XPOS sale commits while this snapshot is open
			pr.allocate_entries(frappe._dict({"invoices": invoices, "payments": payments}))
			pr.reconcile()
			if erpnext_first:
				step.set()
				threading.Event().wait(2)  # hold the locks while the till tries
			return "reconciled"

		def till():
			pulled.wait(60)
			if erpnext_first:
				step.wait(60)
			try:
				result = self.spend(source_type, source, 40, local_id)()
				frappe.db.commit()  # nosemgrep
				return result
			finally:
				step.set()

		outcome = self.run_sessions([desk_user, till])
		self.track_journals(source, target)
		return source, target, local_id, outcome

	def assert_spent_once(self, source_type, source, target, local_id, outcome):
		successes = [i for i, r in outcome.items() if not isinstance(r, Exception)]
		self.assertEqual(len(successes), 1, outcome)
		loser = 1 - successes[0]
		# The till (1) is always refused by XPOS. ERPNext's reconciliation (0) rewrites Payment Entry
		# references before any hook runs, so on MariaDB 11.6+ the database refuses it first (1020).
		refusals = (
			frappe.ValidationError if loser == 1 else (frappe.ValidationError, frappe.QueryDeadlockError)
		)
		self.assertIsInstance(outcome[loser], refusals, outcome)
		self.assertEqual(ledger_remaining(source_type, source), 0)
		if source_type == "Payment Entry":
			self.assertEqual(unallocated(source), 0)
		else:
			self.assertEqual(note_outstanding(source), 0)
		target_outstanding = flt(frappe.db.get_value("Sales Invoice", target, "outstanding_amount"))
		self.assertEqual(target_outstanding, 0 if successes[0] == 0 else 40)
		self.assertEqual(len(invoices_for(local_id)), 1 if successes[0] == 1 else 0)

	def test_receipt_reconciled_in_erpnext_while_till_spends_it(self):
		self.assert_spent_once("Payment Entry", *self.race("Payment Entry", erpnext_first=False))

	def test_till_waits_for_erpnext_reconciliation_of_receipt(self):
		self.assert_spent_once("Payment Entry", *self.race("Payment Entry", erpnext_first=True))

	def test_credit_note_reconciled_in_erpnext_while_till_spends_it(self):
		self.assert_spent_once("Sales Invoice", *self.race("Sales Invoice", erpnext_first=False))

	def test_till_waits_for_erpnext_reconciliation_of_credit_note(self):
		self.assert_spent_once("Sales Invoice", *self.race("Sales Invoice", erpnext_first=True))

	def test_credit_note_refunded_in_erpnext_while_till_spends_it(self):
		from erpnext.accounts.doctype.payment_entry.payment_entry import get_payment_entry

		note, _target = self.source("Sales Invoice")
		pulled, committed = threading.Event(), threading.Event()
		local_id = f"inv_pstest{frappe.generate_hash(length=8)}"

		def desk_refund():
			pe = get_payment_entry("Sales Invoice", note)
			pe.reference_no, pe.reference_date = frappe.generate_hash(length=8), nowdate()
			pulled.set()
			committed.wait(60)
			pe.insert(ignore_permissions=True)
			pe.submit()
			return pe.name

		def till():
			pulled.wait(60)
			try:
				result = self.spend("Sales Invoice", note, 40, local_id)()
				frappe.db.commit()  # nosemgrep
				return result
			finally:
				committed.set()

		outcome = self.run_sessions([desk_refund, till])
		self.created += [r for r in outcome.values() if isinstance(r, str)]
		self.assertIsInstance(outcome[0], frappe.ValidationError, outcome)
		self.assertIsInstance(outcome[1], dict, outcome)
		self.assertEqual(note_outstanding(note), 0)
		self.assertEqual(ledger_remaining("Sales Invoice", note), 0)


SUPERVISOR_ROLE = "_Test PS Supervisor"
DESK_MANAGER = "ps-desk-manager@example.com"


class TestCreditNoteHookWorkflows(HardeningTestCase):
	"""``lock_credit_note_spend`` on standard ERPNext Journal and Payment Entries (rolled back)."""

	def refund(self, *notes):
		from erpnext.accounts.doctype.payment_entry.payment_entry import get_payment_entry

		pe = get_payment_entry("Sales Invoice", notes[0])
		for note in notes[1:]:
			pe.append(
				"references",
				{
					"reference_doctype": "Sales Invoice",
					"reference_name": note,
					"allocated_amount": note_outstanding(note),
					"total_amount": note_outstanding(note),
					"outstanding_amount": note_outstanding(note),
				},
			)
		pe.paid_amount = pe.received_amount = sum(abs(r.allocated_amount) for r in pe.references)
		pe.reference_no, pe.reference_date = frappe.generate_hash(length=8), nowdate()
		return pe

	def locked_invoices(self, doc):
		from xpos.api.customer_credit import lock_credit_note_spend

		with patch.object(frappe.db, "sql", wraps=frappe.db.sql) as sql:
			lock_credit_note_spend(doc)
		return [c.args[1] for c in sql.call_args_list if "FOR UPDATE" in c.args[0]]

	def test_a_receipt_against_ordinary_invoices_locks_nothing_and_submits(self):
		from erpnext.accounts.doctype.payment_entry.payment_entry import get_payment_entry

		invoice = create_sales_invoice(customer=CUSTOMER, item=ITEM_A, qty=1, rate=40, debit_to=DEBTORS)
		pe = get_payment_entry("Sales Invoice", invoice.name)
		pe.reference_no, pe.reference_date = "R1", nowdate()
		self.assertEqual(self.locked_invoices(pe), [])
		pe.insert(ignore_permissions=True).submit()
		self.assertEqual(frappe.db.get_value("Sales Invoice", invoice.name, "outstanding_amount"), 0)

	def test_refund_of_two_credit_notes_locks_both_in_name_order(self):
		notes = sorted([make_credit_note(CUSTOMER, 30), make_credit_note(CUSTOMER, 20)], reverse=True)
		pe = self.refund(*notes)
		self.assertEqual(self.locked_invoices(pe), sorted(notes))
		pe.insert(ignore_permissions=True).submit()
		self.assertEqual([note_outstanding(n) for n in notes], [0, 0])

	def test_journal_rows_on_one_credit_note_are_added_up(self):
		note = make_credit_note(CUSTOMER, 40)

		def journal(*amounts):
			je = frappe.new_doc("Journal Entry")
			je.update({"company": COMPANY, "posting_date": nowdate(), "voucher_type": "Credit Note"})
			for amount in amounts:
				je.append(
					"accounts",
					{
						"account": DEBTORS,
						"party_type": "Customer",
						"party": CUSTOMER,
						"reference_type": "Sales Invoice",
						"reference_name": note,
						"debit_in_account_currency": amount,
					},
				)
			je.append("accounts", {"account": "Cash - _TC", "credit_in_account_currency": sum(amounts)})
			return je

		from xpos.api.customer_credit import lock_credit_note_spend

		with self.assertRaisesRegex(frappe.ValidationError, "has only 40.0 left"):
			lock_credit_note_spend(journal(25, 25))
		je = journal(25, 15)
		je.insert(ignore_permissions=True).submit()
		self.assertEqual(note_outstanding(note), 0)

	def test_cancelled_refund_can_be_amended_against_the_restored_balance(self):
		note = make_credit_note(CUSTOMER, 40)
		pe = self.refund(note)
		pe.insert(ignore_permissions=True).submit()
		self.assertEqual(note_outstanding(note), 0)
		pe.cancel()  # no before_submit: cancelling is never blocked
		self.assertEqual(note_outstanding(note), -40)
		amended = frappe.copy_doc(pe)
		amended.amended_from, amended.docstatus = pe.name, 0
		amended.insert(ignore_permissions=True).submit()
		self.assertEqual(note_outstanding(note), 0)
		# A second refund of the now spent note is refused by the hook.
		with self.assertRaisesRegex(frappe.ValidationError, "has only 0.0 left"):
			from xpos.api.customer_credit import lock_credit_note_spend

			lock_credit_note_spend(self.refund_of(note, 40))

	def refund_of(self, note, amount):
		pe = frappe.copy_doc(frappe.get_last_doc("Payment Entry", {"docstatus": 1}))
		pe.references[0].reference_name, pe.references[0].allocated_amount = note, amount
		return pe


class TestBlindClosingBoundary(HardeningTestCase):
	"""6. Who sees expected amounts: POS Role on the shift's profile for XPOS, document access on Desk."""

	def setUp(self):
		super().setUp()
		ensure_pos_role(SUPERVISOR_ROLE, ["close_shift", "view_expected_amount"])
		ensure_user(DESK_MANAGER, ["Sales Manager"])
		self.pos = make_profile(
			users=[(CASHIER, "Cashier", 0), (MANAGER, SUPERVISOR_ROLE, 0), (DESK_MANAGER, "Cashier", 0)],
			hide_expected_amount=1,
		)
		# The supervisor is only a cashier on the second profile.
		make_profile(PROFILE_2, warehouse="_Test Warehouse 1 - _TC", users=[(MANAGER, "Cashier", 0)])
		from xpos.api.shifts import open_shift

		frappe.set_user(CASHIER)
		self.opening = open_shift(PROFILE, COMPANY, [{"mode_of_payment": "Cash", "opening_amount": 0}])[
			"pos_opening_shift"
		]["name"]
		sale([line()], customer=CUSTOMER, pos_opening_shift=self.opening)
		frappe.set_user("Administrator")

	def summary(self, user):
		from xpos.api.shifts import get_shift_summary

		frappe.set_user(user)
		return get_shift_summary(self.opening)

	def assert_blind(self, summary):
		self.assertTrue(summary.get("blind_closing"))
		text = frappe.as_json(summary)
		for key in ("grand_total", "net_total", "expected_amount", "difference"):
			self.assertNotIn(f'"{key}"', text)

	def test_cashier_counts_blind_and_supervisor_sees_expected(self):
		self.assert_blind(self.summary(CASHIER))
		supervisor = self.summary(MANAGER)
		self.assertFalse(supervisor.get("blind_closing"))
		self.assertEqual(flt(supervisor["grand_total"]), 100)

	def test_desk_role_does_not_unblind_the_till(self):
		"""Sales Manager (Desk) with a Cashier POS Role still closes blind in XPOS."""
		frappe.set_user(DESK_MANAGER)
		from xpos.api.shifts import get_shift_summary

		with self.assertRaises(frappe.PermissionError):
			get_shift_summary(self.opening)  # not the shift's cashier and no close right here

	def test_unassigned_user_cannot_read_the_shift(self):
		ensure_user("ps-outsider@example.com", ["Sales User"])
		with self.assertRaises(frappe.PermissionError):
			self.summary("ps-outsider@example.com")

	def test_close_right_is_per_profile(self):
		from xpos.api.shifts import open_shift

		# MANAGER supervises PROFILE but is only a cashier on PROFILE_2.
		frappe.set_user(MANAGER)
		other = open_shift(PROFILE_2, COMPANY, [{"mode_of_payment": "Cash", "opening_amount": 0}])[
			"pos_opening_shift"
		]["name"]
		from xpos.api.shifts import close_shift

		with self.assertRaises(frappe.PermissionError):
			close_shift(other, [])

	def test_after_closing_cashier_still_blind(self):
		from xpos.api.shifts import close_shift

		frappe.set_user(MANAGER)
		closed = close_shift(self.opening, [{"mode_of_payment": "Cash", "closing_amount": 100}])
		self.assertEqual(flt(closed["grand_total"]), 100)
		self.assert_blind(self.summary(CASHIER))

	def test_desk_endpoints_need_document_access(self):
		from xpos.x_pos.doctype.pos_closing_shift.closing_processing.data import get_pos_invoices
		from xpos.x_pos.doctype.pos_closing_shift.closing_processing.overview import (
			get_closing_shift_overview,
		)

		frappe.set_user(CASHIER)
		with self.assertRaises(frappe.PermissionError):
			get_pos_invoices(self.opening)

		# Documented supervisory policy: Desk read of the shift shows its figures...
		frappe.set_user(DESK_MANAGER)
		self.assertEqual(len(get_pos_invoices(self.opening)), 1)
		self.assertIn("payments", frappe.as_json(get_closing_shift_overview(self.opening)))

		# ...but never across a Company user permission.
		frappe.set_user("Administrator")
		frappe.get_doc(
			{
				"doctype": "User Permission",
				"user": DESK_MANAGER,
				"allow": "Company",
				"for_value": "_Test Company 1",
			}
		).insert(ignore_permissions=True)
		frappe.clear_cache(user=DESK_MANAGER)
		frappe.set_user(DESK_MANAGER)
		with self.assertRaises(frappe.PermissionError):
			get_pos_invoices(self.opening)
		with self.assertRaises(frappe.PermissionError):
			get_closing_shift_overview(self.opening)


def make_referral_offer(disabled=0):
	offer = frappe.get_doc(
		{
			"doctype": "POS Offer",
			"title": "_Test PS Referral Offer",
			"description": "Referral welcome offer",
			"apply_on": "Transaction",
			"offer": "Grand Total",
			"discount_percentage": 5,
			"company": COMPANY,
			"valid_from": nowdate(),
			"disabled": disabled,
		}
	).insert(ignore_permissions=True)
	frappe.db.set_value("Company", COMPANY, "final_customer_offer", offer.name)
	frappe.clear_document_cache("Company", COMPANY)
	return offer.name


class TestReferralCreation(HardeningTestCase):
	"""9. Referral codes: database uniqueness, open-shift profile, explicit setup errors, no orphans."""

	def setUp(self):
		super().setUp()
		self.pos = make_profile(users=[(CASHIER, "Cashier", 0)], auto_create_referral_for_new_customers=1)
		from xpos.api.shifts import open_shift

		frappe.set_user(CASHIER)
		open_shift(PROFILE, COMPANY, [{"mode_of_payment": "Cash", "opening_amount": 0}])

	def create(self, name, **kwargs):
		from xpos.api.customers import create_customer

		return create_customer(name, customer_group="_Test Customer Group", pos_profile=PROFILE, **kwargs)

	def test_code_created_once_and_reused(self):
		frappe.set_user("Administrator")
		make_referral_offer()
		frappe.set_user(CASHIER)
		created = self.create("_Test PS Referral A")
		self.assertTrue(created.get("referral_code"))
		from xpos.api.customers import create_pos_referral_code

		again = create_pos_referral_code(created["name"], PROFILE)
		self.assertEqual(again["referral_code"], created["referral_code"])
		self.assertEqual(frappe.db.count("Referral Code", {"customer": created["name"]}), 1)

	def test_database_rejects_a_second_code_for_customer_and_company(self):
		frappe.set_user("Administrator")
		offer = make_referral_offer()
		from xpos.x_pos.doctype.referral_code.referral_code import create_referral_code

		create_referral_code(COMPANY, CUSTOMER, offer)
		with self.assertRaises((frappe.UniqueValidationError, frappe.DuplicateEntryError)):
			create_referral_code(COMPANY, CUSTOMER, offer)

	def test_duplicates_block_creation_until_an_admin_resolves_them(self):
		from xpos.api.profile_preflight import referral_change
		from xpos.x_pos.doctype.referral_code import referral_code

		frappe.set_user("Administrator")
		make_referral_offer()
		self.assertTrue(referral_code.has_customer_company_unique())
		# Mocked: this site has the index, so its absence (duplicates present) is simulated.
		with patch.object(referral_code, "has_customer_company_unique", return_value=False):
			self.assertIn("more than one Referral Code", referral_change(self.pos))
			frappe.set_user(CASHIER)
			created = self.create("_Test PS Referral D")
		self.assertIn("more than one Referral Code", created["referral_note"])
		self.assertEqual(frappe.db.count("Referral Code", {"customer": created["name"]}), 0)

		duplicates = [frappe._dict(customer=CUSTOMER, company=COMPANY, n=2)]
		with (
			patch.object(frappe.db, "sql", return_value=duplicates),
			patch.object(frappe.db, "add_unique") as add_unique,
		):
			self.assertEqual(referral_code.add_customer_company_unique(), duplicates)
		add_unique.assert_not_called()

	def test_bad_setup_is_explained_and_creates_nothing(self):
		frappe.set_user("Administrator")
		make_referral_offer(disabled=1)
		frappe.set_user(CASHIER)
		created = self.create("_Test PS Referral B")
		self.assertIn("disabled", created["referral_note"])
		self.assertNotIn("referral_code", created)
		self.assertEqual(frappe.db.count("Referral Code", {"customer": created["name"]}), 0)

	def test_profile_without_open_shift_creates_nothing(self):
		frappe.set_user("Administrator")
		make_referral_offer()
		make_profile(
			PROFILE_2,
			warehouse="_Test Warehouse 1 - _TC",
			users=[(CASHIER, "Cashier", 0)],
			auto_create_referral_for_new_customers=1,
		)
		frappe.set_user(CASHIER)
		from xpos.api.customers import create_customer

		created = create_customer(
			"_Test PS Referral C", customer_group="_Test Customer Group", pos_profile=PROFILE_2
		)
		self.assertNotIn("referral_code", created)

	def test_failure_leaves_no_orphan_customer(self):
		"""The request is one transaction; emulated here with a savepoint, as the web request rolls back."""
		frappe.set_user("Administrator")
		make_referral_offer()
		frappe.set_user(CASHIER)
		frappe.db.savepoint("referral_failure")
		with patch(
			"xpos.x_pos.doctype.referral_code.referral_code.create_referral_code",
			side_effect=RuntimeError("boom"),
		):
			with self.assertRaises(RuntimeError):
				self.create("_Test PS Referral Orphan")
		frappe.db.rollback(save_point="referral_failure")
		self.assertFalse(frappe.db.exists("Customer", {"customer_name": "_Test PS Referral Orphan"}))


class TestPreflight(HardeningTestCase):
	"""7. The preflight report is read-only and carries counts, not customer data."""

	def test_report_shape_and_no_customer_names(self):
		from xpos.api.profile_preflight import preflight_profile_settings

		self.pos = make_profile(apply_customer_discount=1, hide_expected_amount=1, use_cashback=1)
		writes = frappe.db.transaction_writes
		rows = [r for r in preflight_profile_settings() if r["pos_profile"] == PROFILE]
		self.assertEqual(frappe.db.transaction_writes, writes, "preflight must not write")
		settings = {r["setting"] for r in rows}
		self.assertTrue(
			{
				"apply_customer_discount",
				"hide_expected_amount",
				"auto_create_referral_for_new_customers",
				"default_purchase_uom",
				"print_format_rules",
				"use_customer_credit",
				"use_cashback",
			}
			<= settings
		)
		text = frappe.as_json(rows)
		self.assertNotIn(DISCOUNT_CUSTOMER, text)
		self.assertIn("not available", next(r["change"] for r in rows if r["setting"] == "use_cashback"))


def make_print_format(name, disabled=0):
	if not frappe.db.exists("Print Format", name):
		frappe.get_doc(
			{
				"doctype": "Print Format",
				"name": name,
				"doc_type": "Sales Invoice",
				"module": "X POS",
				"standard": "No",
				"custom_format": 1,
				"print_format_type": "Jinja",
				"html": "<p>{{ doc.name }}</p>",
			}
		).insert(ignore_permissions=True)
	frappe.db.set_value("Print Format", name, "disabled", disabled)


class TestPrintFormatRules(HardeningTestCase):
	"""8. Receipt format rules: order, customer-group ancestry, fallback, invalid formats, reprint right."""

	def setUp(self):
		super().setUp()
		ensure(
			"Customer Group",
			"_Test PS Parent Group",
			{
				"customer_group_name": "_Test PS Parent Group",
				"is_group": 1,
				"parent_customer_group": "All Customer Groups",
			},
		)
		ensure(
			"Customer Group",
			"_Test PS Child Group",
			{"customer_group_name": "_Test PS Child Group", "parent_customer_group": "_Test PS Parent Group"},
		)
		ensure(
			"Customer",
			"_Test PS Child Customer",
			{
				"customer_name": "_Test PS Child Customer",
				"customer_group": "_Test PS Child Group",
				"territory": "_Test Territory",
			},
		)
		for name in ("_Test PS Receipt Parent", "_Test PS Receipt Child", "_Test PS Receipt Default"):
			make_print_format(name)
		ensure_pos_role(SUPERVISOR_ROLE, ["close_shift", "view_expected_amount", "allow_reprint_invoice"])

	def profile_with(self, rules, default="_Test PS Receipt Default"):
		return make_profile(
			users=[(CASHIER, "Cashier", 0), (MANAGER, SUPERVISOR_ROLE, 0)],
			print_format_rules=[{"customer_group": g, "print_format": f} for g, f in rules],
			default_print_format=default,
		)

	def test_first_matching_rule_by_group_ancestry(self):
		from xpos.api.print_formats import resolve_print_format

		self.profile_with(
			[
				("_Test PS Parent Group", "_Test PS Receipt Parent"),
				("_Test PS Child Group", "_Test PS Receipt Child"),
			]
		)
		self.assertEqual(resolve_print_format(PROFILE, "_Test PS Child Customer"), "_Test PS Receipt Parent")
		self.profile_with(
			[
				("_Test PS Child Group", "_Test PS Receipt Child"),
				("_Test PS Parent Group", "_Test PS Receipt Parent"),
			]
		)
		self.assertEqual(resolve_print_format(PROFILE, "_Test PS Child Customer"), "_Test PS Receipt Child")
		self.assertEqual(resolve_print_format(PROFILE, CUSTOMER), "_Test PS Receipt Default")

	def test_unusable_formats_are_refused_on_save_and_skipped_later(self):
		from xpos.api.print_formats import resolve_print_format

		make_print_format("_Test PS Receipt Disabled", disabled=1)
		with self.assertRaisesRegex(frappe.ValidationError, "disabled, missing or not for"):
			self.profile_with([("_Test PS Parent Group", "_Test PS Receipt Disabled")])
		self.profile_with([("_Test PS Parent Group", "_Test PS Receipt Parent")])
		make_print_format("_Test PS Receipt Parent", disabled=1)
		make_print_format("_Test PS Receipt Default", disabled=1)
		self.assertEqual(resolve_print_format(PROFILE, "_Test PS Child Customer"), "XPOS Thermal Receipt")

	def test_first_print_and_reprint_use_the_same_rule_and_reprint_right_is_per_profile(self):
		from xpos.api.print_formats import get_invoice_print_format, mark_invoice_printed

		self.profile_with([("_Test PS Parent Group", "_Test PS Receipt Parent")])
		make_profile(PROFILE_2, warehouse="_Test Warehouse 1 - _TC", users=[(MANAGER, "Cashier", 0)])
		frappe.set_user(CASHIER)
		name = sale([line()], customer="_Test PS Child Customer")["name"]
		first = get_invoice_print_format("Sales Invoice", name)["print_format"]
		self.assertTrue(frappe.has_permission("Sales Invoice", "print", doc=name))
		mark_invoice_printed("Sales Invoice", name)

		self.assertEqual(get_invoice_print_format("Sales Invoice", name)["print_format"], first)
		self.assertFalse(frappe.has_permission("Sales Invoice", "print", doc=name), "cashier may not reprint")
		frappe.set_user(MANAGER)
		self.assertTrue(
			frappe.has_permission("Sales Invoice", "print", doc=name), "supervisor on this profile"
		)

		# The same supervisor is only a cashier on PROFILE_2: no reprint there.
		doc = frappe.get_doc("Sales Invoice", name)
		doc.pos_profile = PROFILE_2
		from xpos.api.print_formats import invoice_has_permission

		self.assertFalse(invoice_has_permission(doc, "print", MANAGER))

	def test_print_tracking_needs_read_access(self):
		from xpos.api.print_formats import mark_invoice_printed

		name = sale([line()])["name"]
		ensure_user("ps-outsider@example.com", ["Website Manager"])
		frappe.set_user("ps-outsider@example.com")
		with self.assertRaises(frappe.PermissionError):
			mark_invoice_printed("Sales Invoice", name)

	def test_cashier_cannot_render_a_reprint_but_supervisor_and_back_office_can(self):
		"""/printview needs only read access, so the reprint right is enforced when rendering."""
		from xpos.api.print_formats import mark_invoice_printed

		self.profile_with([])
		frappe.set_user(CASHIER)
		name = sale([line()])["name"]
		frappe.get_print("Sales Invoice", name, "_Test PS Receipt Default")  # first print
		mark_invoice_printed("Sales Invoice", name)
		with self.assertRaises(frappe.PermissionError):
			frappe.get_print("Sales Invoice", name, "_Test PS Receipt Default")

		frappe.set_user(MANAGER)
		self.assertIn(name, frappe.get_print("Sales Invoice", name, "_Test PS Receipt Default"))

		frappe.set_user("Administrator")
		ensure_user("ps-back-office@example.com", ["Accounts User"])
		frappe.set_user("ps-back-office@example.com")
		self.assertIn(name, frappe.get_print("Sales Invoice", name, "_Test PS Receipt Default"))


class TestOfferRuleDiscountConflict(HardeningTestCase):
	"""2. An invoice discount ERPNext sets cannot be combined with POS Offer discounts: refused, recoverable."""

	def test_offer_sale_under_a_transaction_rule_is_refused_then_posts_without_offers(self):
		offer = frappe.get_doc(
			{
				"doctype": "POS Offer",
				"title": "_Test PS Item Offer",
				"description": "10% off item A",
				"apply_on": "Item Code",
				"item": ITEM_A,
				"offer": "Item Price",
				"discount_type": "Discount Percentage",
				"discount_percentage": 10,
				"company": COMPANY,
				"valid_from": nowdate(),
			}
		).insert(ignore_permissions=True)
		frappe.get_doc(
			{
				"doctype": "Pricing Rule",
				"title": "_Test PS Transaction Rule",
				"apply_on": "Transaction",
				"selling": 1,
				"company": COMPANY,
				"price_or_product_discount": "Price",
				"rate_or_discount": "Discount Percentage",
				"discount_percentage": 5,
				"currency": "INR",
			}
		).insert(ignore_permissions=True)
		local_id = "inv_" + frappe.generate_hash(length=32)
		# The till folds the 10% offer into the invoice discount.
		refused = sale(
			[line()],
			paid=90,
			local_id=local_id,
			discount_amount=10,
			offers_detail=[{"offer_name": offer.name}],
		)
		self.assertEqual(refused["status"], "reprice_required", refused)
		self.assertTrue(refused["offer_conflict"])
		self.assertIn("Remove the offers", refused["message"])
		self.assertEqual(invoices_for(local_id), [])

		# The cashier removes the offer and takes the server's discount: it posts, checked as usual.
		posted = sale(
			[line()],
			paid=refused["rounded_total"] or refused["grand_total"],
			additional_discount_percentage=refused["additional_discount_percentage"],
			discount_amount=0 if refused["additional_discount_percentage"] else refused["discount_amount"],
		)
		self.assertEqual(frappe.db.get_value("Sales Invoice", posted["name"], "docstatus"), 1)


FBR_OK = {"InvoiceNumber": "FBR-CLOUD-1", "Code": "100"}


def fbr_answer(body):
	from unittest.mock import Mock

	return Mock(status_code=200, json=Mock(return_value=body), text="")


def unreachable():
	import requests
	from urllib3.exceptions import MaxRetryError, NewConnectionError

	return requests.ConnectionError(MaxRetryError(None, "/", reason=NewConnectionError(None, "refused")))


FBR_POS_ID = "123456"
EVIDENCE = "Checked IRIS POS invoice list for this POS ID on the sale date."


def ledger(usin):
	"""The fiscal ledger rows for a sale id, read on the ledger's own connection."""
	with fiscal_ledger.ledger_db() as db:
		return [
			(r.channel, r.status, r.resolution or "", r.fbr_invoice_number)
			for r in db.sql(
				"""SELECT channel, status, resolution, fbr_invoice_number FROM `tabXPOS Fiscal Attempt`
				WHERE usin = %s ORDER BY attempt_no""",
				usin,
				as_dict=True,
			)
		]


def clear_ledger():
	with fiscal_ledger.ledger_db() as db:
		db.sql("DELETE FROM `tabXPOS Fiscal Attempt` WHERE fbr_pos_id = %s", FBR_POS_ID)


def keep_writes(call):
	"""Frappe zeroes ``transaction_writes`` on ROLLBACK TO SAVEPOINT although the test's earlier
	writes are still pending. Restore it, or the next sale's credit lock ends the transaction."""
	writes = frappe.db.transaction_writes
	try:
		return call()
	finally:
		frappe.db.transaction_writes = max(frappe.db.transaction_writes, writes)


def as_request(call):
	"""Run ``call`` the way a web request does: everything it wrote is undone if it raises."""

	def run():
		frappe.db.savepoint("xpos_test_request")
		try:
			return call()
		except Exception:
			frappe.db.rollback(save_point="xpos_test_request")
			raise

	return keep_writes(run)


class FiscalTestCase(HardeningTestCase):
	"""FBR's HTTP endpoint is mocked; invoices are real and roll back.

	The fiscal ledger commits on its own connection, as it must, so its rows for the test
	POS ID are deleted after each test. ``frappe.db.commit`` is mocked to prove the sale's own
	transaction is never committed early.
	"""

	def setUp(self):
		super().setUp()
		self.pos = make_profile(enable_fbr_integration=1, fbr_pos_id=FBR_POS_ID, fbr_bearer_token="token")
		ensure("Customs Tariff Number", "0101.2100", {"tariff_number": "0101.2100"})
		frappe.db.set_value("Item", ITEM_A, "customs_tariff_number", "0101.2100")
		frappe.db.set_value("Item", ITEM_B, "customs_tariff_number", "0101.2100")
		self.local_id = "inv_" + frappe.generate_hash(length=32)
		clear_ledger()
		self.addCleanup(clear_ledger)
		commit = patch.object(frappe.db, "commit")
		self.commit = commit.start()
		self.addCleanup(commit.stop)

	def post(self, **kwargs):
		return patch("xpos.x_pos.integrations.fbr.requests.post", **kwargs)

	def state(self, name):
		return frappe.db.get_value(
			"Sales Invoice", name, ["docstatus", "xpos_fiscal_state", "fbr_invoice_number"]
		)

	def resolve(self, resolution, number=None, usin=None, evidence=EVIDENCE):
		from xpos.api.invoices import resolve_fiscal_check

		return resolve_fiscal_check(usin or self.local_id, PROFILE, resolution, evidence, number)


class TestFiscalizationRetry(FiscalTestCase):
	"""5. A sale waiting for FBR keeps its id and draft; an unknown FBR outcome is held, never resent."""

	def test_cloud_timeout_is_held_and_never_sent_again(self):
		import requests

		from xpos.api.invoices import discard_draft_invoice, retry_fiscalization

		with self.post(side_effect=requests.ReadTimeout("no answer")) as post:
			first = sale([line()], local_id=self.local_id)
			self.assertEqual(first["status"], "fbr_uncertain")
			retry = sale([line()], local_id=self.local_id)
			# Retrying the draft before an FBR check is recorded does not send it either.
			self.assertEqual(retry_fiscalization(first["name"])["status"], "fbr_uncertain")
		self.assertEqual(post.call_count, 1)
		self.assertEqual(
			(retry["status"], retry["name"], retry["duplicate"]), ("fbr_uncertain", first["name"], True)
		)
		self.assertEqual(self.state(first["name"]), (0, "Uncertain", None))
		self.assertEqual(ledger(self.local_id), [("Cloud", "Uncertain", "", None)])
		with self.assertRaisesRegex(frappe.ValidationError, "Resolve the FBR check"):
			discard_draft_invoice(first["name"])

		# Only after the check records that FBR has no record is it sent once more.
		self.resolve("Not Recorded")
		with self.post(return_value=fbr_answer(FBR_OK)) as post:
			done = sale([line()], local_id=self.local_id)
			again = sale([line()], local_id=self.local_id)
		self.assertEqual(post.call_count, 1)
		self.assertEqual(done["name"], first["name"])
		self.assertEqual(self.state(first["name"]), (1, "", "FBR-CLOUD-1"))
		self.assertTrue(again["duplicate"])
		self.assertEqual(len(invoices_for(self.local_id)), 1)
		self.assertEqual(
			ledger(self.local_id),
			[("Cloud", "Uncertain", "Not Recorded", None), ("Cloud", "Accepted", "", "FBR-CLOUD-1")],
		)
		self.commit.assert_not_called()

	def test_unreachable_cloud_waits_for_the_local_service_and_resumes(self):
		from xpos.api.invoices import finalize_fiscal_invoice

		with self.post(side_effect=unreachable()) as post:
			first = sale([line()], local_id=self.local_id)
			retry = sale([line()], local_id=self.local_id)
		self.assertEqual(post.call_count, 1)  # the retry does not call FBR's cloud again
		self.assertEqual((first["status"], retry["status"]), ("fbr_local_required", "fbr_local_required"))
		self.assertEqual(retry["name"], first["name"])
		self.assertEqual(retry["fbr_payload"]["USIN"], self.local_id)
		self.assertEqual(self.state(first["name"]), (0, "Awaiting Local", None))

		done = finalize_fiscal_invoice(first["name"], "FBR-LOCAL-1")
		self.assertEqual(self.state(done["name"]), (1, "", "FBR-LOCAL-1"))
		self.assertTrue(sale([line()], local_id=self.local_id)["duplicate"])
		self.assertEqual(len(invoices_for(self.local_id)), 1)
		self.assertEqual(
			ledger(self.local_id),
			[("Cloud", "Not Sent", "", None), ("Local Service", "Accepted", "", "FBR-LOCAL-1")],
		)

	def test_local_service_without_answer_is_held_then_resolved_with_the_found_number(self):
		from xpos.api.invoices import finalize_fiscal_invoice, mark_fiscalization_uncertain

		with self.post(side_effect=unreachable()):
			first = sale([line()], local_id=self.local_id)
		mark_fiscalization_uncertain(first["name"])
		with self.post() as post:
			self.assertEqual(sale([line()], local_id=self.local_id)["status"], "fbr_uncertain")
			# A number typed at the till is not enough for a sale FBR may already hold.
			with self.assertRaisesRegex(frappe.ValidationError, "Record the FBR check first"):
				finalize_fiscal_invoice(first["name"], "FBR-FOUND-1")
			self.resolve("Recorded", "FBR-FOUND-1")
			done = sale([line()], local_id=self.local_id)
		post.assert_not_called()
		self.assertEqual((done["name"], self.state(first["name"])), (first["name"], (1, "", "FBR-FOUND-1")))

	def test_local_number_survives_a_failed_submit_without_committing_the_sale(self):
		from xpos.api.invoices import finalize_fiscal_invoice

		with self.post(side_effect=unreachable()):
			first = sale([line()], local_id=self.local_id)
		with patch("frappe.model.document.Document.submit", side_effect=RuntimeError("submit failed")):
			with self.assertRaises(RuntimeError):
				as_request(lambda: finalize_fiscal_invoice(first["name"], "FBR-LOCAL-2"))
		self.commit.assert_not_called()
		# The draft is as it was; the number is kept only in the fiscal ledger.
		self.assertEqual(self.state(first["name"]), (0, "Awaiting Local", None))
		with self.post() as post:
			done = sale([line()], local_id=self.local_id)
		post.assert_not_called()
		self.assertEqual((done["name"], self.state(first["name"])), (first["name"], (1, "", "FBR-LOCAL-2")))

	def test_the_sales_creator_may_finalize_without_the_cashier_flag(self):
		from xpos.api.invoices import finalize_fiscal_invoice

		self.pos = make_profile(
			users=[(CASHIER, "Cashier", 0)],
			enable_fbr_integration=1,
			fbr_pos_id=FBR_POS_ID,
			fbr_bearer_token="t",
		)
		frappe.set_user(CASHIER)
		with self.post(side_effect=unreachable()):
			first = sale([line()], local_id=self.local_id)
		self.assertEqual(finalize_fiscal_invoice(first["name"], "FBR-OWN-1")["name"], first["name"])

	def test_only_a_cashier_of_the_profile_may_finalize(self):
		from xpos.api.invoices import finalize_fiscal_invoice, retry_fiscalization

		with self.post(side_effect=unreachable()):
			first = sale([line()], local_id=self.local_id)
		frappe.set_user(CASHIER)  # neither the sale's creator nor a cashier of this profile
		for call in (
			lambda: finalize_fiscal_invoice(first["name"], "X"),
			lambda: retry_fiscalization(first["name"]),
		):
			with self.assertRaises(frappe.PermissionError):
				call()


class TestFiscalRecovery(FiscalTestCase):
	"""FBR answered, then the sale failed locally and was rolled back: the retry reuses FBR's answer."""

	def test_fbr_success_then_failed_submit_is_recovered_without_a_second_fbr_request(self):
		with self.post(return_value=fbr_answer(FBR_OK)) as post:
			with patch("frappe.model.document.Document.submit", side_effect=RuntimeError("disk full")):
				with self.assertRaises(RuntimeError):
					as_request(lambda: sale([line()], local_id=self.local_id))
			self.assertEqual(invoices_for(self.local_id), [])  # nothing of the sale was kept
			self.assertEqual(ledger(self.local_id), [("Cloud", "Accepted", "", "FBR-CLOUD-1")])
			done = sale([line()], local_id=self.local_id)
		self.assertEqual(post.call_count, 1)
		self.assertEqual(self.state(done["name"]), (1, "", "FBR-CLOUD-1"))
		self.assertEqual(len(invoices_for(self.local_id)), 1)
		self.commit.assert_not_called()

	def test_a_different_sale_under_a_fiscalized_id_is_refused_without_sending(self):
		with self.post(return_value=fbr_answer(FBR_OK)) as post:
			with patch("frappe.model.document.Document.submit", side_effect=RuntimeError("disk full")):
				with self.assertRaises(RuntimeError):
					as_request(lambda: sale([line()], local_id=self.local_id))
			with self.assertRaisesRegex(frappe.ValidationError, "already holds sale"):
				as_request(lambda: sale([line(qty=2)], local_id=self.local_id))
		self.assertEqual(post.call_count, 1)
		self.assertEqual(invoices_for(self.local_id), [])

	def test_gateway_error_is_uncertain_and_not_resent(self):
		from unittest.mock import Mock

		with self.post(return_value=Mock(status_code=504, json=Mock(return_value={}), text="")) as post:
			first = sale([line()], local_id=self.local_id)
			sale([line()], local_id=self.local_id)
		self.assertEqual((first["status"], post.call_count), ("fbr_uncertain", 1))
		self.assertEqual(ledger(self.local_id), [("Cloud", "Uncertain", "", None)])

	def test_background_submit_failure_after_fbr_success_is_finished_by_a_retry(self):
		real_rollback = frappe.db.rollback
		with self.post(return_value=fbr_answer(FBR_OK)) as post:
			queued = sale([line()], local_id=self.local_id, submit_in_background=1)
			self.assertEqual(queued["status"], "Queued")
			frappe.db.savepoint("xpos_test_job")
			with (
				patch(
					"erpnext.accounts.doctype.sales_invoice.sales_invoice.SalesInvoice.on_submit",
					side_effect=RuntimeError("x"),
				),
				patch.object(
					frappe.db, "rollback", lambda *a, **k: real_rollback(save_point="xpos_test_job")
				),
			):
				_submit_invoice_job(queued["name"])
			self.assertEqual(self.state(queued["name"])[::2], (0, "FBR-CLOUD-1"))
			done = sale([line()], local_id=self.local_id)
		self.assertEqual(post.call_count, 1)
		self.assertEqual((done["name"], self.state(queued["name"])), (queued["name"], (1, "", "FBR-CLOUD-1")))


class TestFiscalCustomerCredit(FiscalTestCase):
	"""Customer credit with FBR: recoverable, never fiscalized twice, never half-allocated."""

	def setUp(self):
		super().setUp()
		self.pos = make_profile(
			use_customer_credit=1, enable_fbr_integration=1, fbr_pos_id=FBR_POS_ID, fbr_bearer_token="token"
		)

	def credit_sale(self, pe):
		return keep_writes(
			lambda: sale(
				[line(ITEM_B, rate=40)],
				paid=0,
				local_id=self.local_id,
				customer_credit=[credit("Payment Entry", pe, 40)],
			)
		)

	def test_failed_allocation_after_fbr_success_is_recovered_once(self):
		pe = make_receipt(CUSTOMER, 100)
		with self.post(return_value=fbr_answer(FBR_OK)) as post:
			with patch("erpnext.accounts.utils.reconcile_against_document", side_effect=RuntimeError("x")):
				with self.assertRaises(RuntimeError):
					as_request(lambda: self.credit_sale(pe))
			self.assertEqual((invoices_for(self.local_id), unallocated(pe)), ([], 100))
			done = self.credit_sale(pe)
		self.assertEqual(post.call_count, 1)
		self.assertEqual(self.state(done["name"]), (1, "", "FBR-CLOUD-1"))
		self.assertEqual(unallocated(pe), 60)

	def test_unknown_outcome_holds_nothing_keeps_the_attempt_and_resumes_after_the_check(self):
		import requests

		pe = make_receipt(CUSTOMER, 100)
		with self.post(side_effect=requests.ReadTimeout("no answer")) as post:
			held = self.credit_sale(pe)
			again = self.credit_sale(pe)
		self.assertEqual(post.call_count, 1)
		self.assertEqual((held["status"], held["name"], held["usin"]), ("fbr_uncertain", None, self.local_id))
		self.assertEqual(again["status"], "fbr_uncertain")
		self.assertEqual((invoices_for(self.local_id), unallocated(pe)), ([], 100))
		self.assertEqual(ledger(self.local_id), [("Cloud", "Uncertain", "", None)])

		self.resolve("Recorded", "FBR-CREDIT-1")
		with self.post() as post:
			done = self.credit_sale(pe)
		post.assert_not_called()
		self.assertEqual(self.state(done["name"]), (1, "", "FBR-CREDIT-1"))
		self.assertEqual(unallocated(pe), 60)

	def test_local_fiscalization_is_refused_before_anything_reaches_fbr(self):
		pe = make_receipt(CUSTOMER, 100)
		with self.post(side_effect=unreachable()):
			with self.assertRaisesRegex(frappe.ValidationError, "local FBR fiscalization"):
				as_request(lambda: self.credit_sale(pe))
		self.assertEqual(ledger(self.local_id), [("Cloud", "Not Sent", "", None)])
		self.assertEqual(unallocated(pe), 100)


class TestFiscalCheckResolution(FiscalTestCase):
	"""Recording an FBR check: permission, evidence, validation, one answer per attempt."""

	def held(self):
		import requests

		with self.post(side_effect=requests.ReadTimeout("no answer")):
			return sale([line()], local_id=self.local_id)

	def test_needs_the_permission_on_the_sales_profile(self):
		self.held()
		frappe.set_user(CASHIER)
		with self.assertRaises(frappe.PermissionError):
			self.resolve("Not Recorded")
		frappe.set_user("Administrator")
		ensure_pos_role("_Test PS Resolver", ["resolve_fiscal_check"])
		self.pos = make_profile(
			users=[(CASHIER, "_Test PS Resolver", 0)],
			enable_fbr_integration=1,
			fbr_pos_id=FBR_POS_ID,
			fbr_bearer_token="token",
		)
		frappe.set_user(CASHIER)
		self.assertEqual(self.resolve("Not Recorded")["resolved_by"], CASHIER)

	def test_validates_evidence_number_and_state(self):
		with self.assertRaisesRegex(frappe.ValidationError, "No FBR request"):
			self.resolve("Not Recorded")
		self.held()
		with self.assertRaisesRegex(frappe.ValidationError, "10 to 1000"):
			self.resolve("Not Recorded", evidence="looked")
		with self.assertRaisesRegex(frappe.ValidationError, "exactly as FBR"):
			self.resolve("Recorded", "12 34")
		with self.assertRaisesRegex(frappe.ValidationError, "Recorded or Not Recorded"):
			self.resolve("Maybe")

	def test_a_number_already_on_another_sale_is_refused(self):
		with self.post(return_value=fbr_answer(FBR_OK)):
			sale([line()])
		self.held()
		with self.assertRaisesRegex(frappe.ValidationError, "already belongs to"):
			self.resolve("Recorded", "FBR-CLOUD-1")

	def test_one_answer_per_attempt_and_repeats_are_idempotent(self):
		self.held()
		first = self.resolve("Recorded", "FBR-FOUND-7")
		self.assertEqual(self.resolve("Recorded", "FBR-FOUND-7")["attempt"], first["attempt"])
		with self.assertRaisesRegex(frappe.ValidationError, "already resolved"):
			self.resolve("Not Recorded")
		with self.assertRaisesRegex(frappe.ValidationError, "already resolved"):
			self.resolve("Recorded", "FBR-FOUND-8")
		with fiscal_ledger.ledger_db() as db:
			row = fiscal_ledger.latest(db, FBR_POS_ID, self.local_id)
		self.assertEqual(
			(row.resolution, row.resolved_by, row.resolution_evidence, row.fbr_invoice_number),
			("Recorded", "Administrator", EVIDENCE, "FBR-FOUND-7"),
		)

	def test_a_request_that_may_still_be_in_flight_cannot_be_resolved(self):
		doc = frappe._dict(doctype="Sales Invoice", name="X", pos_profile=PROFILE, company=COMPANY)
		known = fiscal_ledger.begin_cloud_attempt(
			doc, FBR_POS_ID, self.local_id, {"USIN": self.local_id}, False
		)
		self.assertEqual(known.kind, "none")
		with self.assertRaisesRegex(frappe.ValidationError, "still be waiting"):
			self.resolve("Not Recorded")
		# A second request for the same sale meanwhile is held, not sent.
		self.assertEqual(
			fiscal_ledger.begin_cloud_attempt(
				doc, FBR_POS_ID, self.local_id, {"USIN": self.local_id}, False
			).kind,
			"pending",
		)

	def test_a_draft_held_before_attempts_were_recorded_can_be_resolved(self):
		with self.post(side_effect=unreachable()):
			first = sale([line()], local_id=self.local_id)
		frappe.db.set_value("Sales Invoice", first["name"], "xpos_fiscal_state", "Uncertain")
		clear_ledger()
		with self.post() as post:
			self.assertEqual(sale([line()], local_id=self.local_id)["status"], "fbr_uncertain")
			self.resolve("Recorded", "FBR-LEGACY-1")
			done = sale([line()], local_id=self.local_id)
		post.assert_not_called()
		self.assertEqual(self.state(done["name"]), (1, "", "FBR-LEGACY-1"))
		self.assertEqual(ledger(self.local_id), [("Unknown", "Uncertain", "Recorded", "FBR-LEGACY-1")])


class TestConcurrentFiscalCheck(ERPNextTestSuite):
	"""Two supervisors record different answers for one held sale at the same moment."""

	def test_only_one_answer_is_recorded(self):
		usin = "inv_pstest" + frappe.generate_hash(length=12)
		doc = frappe._dict(doctype="Sales Invoice", name="X", pos_profile=PROFILE, company=COMPANY)
		known = fiscal_ledger.begin_cloud_attempt(doc, FBR_POS_ID, usin, {"USIN": usin}, False)
		fiscal_ledger.finish_attempt(known.attempt, "Uncertain")
		self.addCleanup(clear_ledger)
		site, start, outcome = frappe.local.site, threading.Barrier(2), {}

		def resolver(index, resolution, number):
			frappe.init(site)
			frappe.connect()
			frappe.set_user("Administrator")
			try:
				start.wait(30)
				outcome[index] = fiscal_ledger.resolve(FBR_POS_ID, usin, resolution, number, EVIDENCE)
			except Exception as error:
				outcome[index] = error
			finally:
				frappe.destroy()

		threads = [
			threading.Thread(target=resolver, args=(0, "Recorded", "FBR-RACE-1")),
			threading.Thread(target=resolver, args=(1, "Not Recorded", None)),
		]
		for thread in threads:
			thread.start()
		for thread in threads:
			thread.join(60)
		errors = [r for r in outcome.values() if isinstance(r, Exception)]
		self.assertEqual(len(errors), 1, outcome)
		self.assertIn("already resolved", str(errors[0]))
		self.assertEqual(len(ledger(usin)), 1)


class TestPurchasePrices(HardeningTestCase):
	"""7. Purchase lines price in their own UOM first, else the converted stock-UOM price, in company currency."""

	def setUp(self):
		super().setUp()
		item = frappe.get_doc("Item", ITEM_B)
		item.purchase_uom = "Box"
		if not any(u.uom == "Box" for u in item.uoms):
			item.append("uoms", {"uom": "Box", "conversion_factor": 12})
		item.save(ignore_permissions=True)
		frappe.clear_document_cache("Item", ITEM_B)
		self.list = "_Test PS Buying List"
		ensure(
			"Price List",
			self.list,
			{"price_list_name": self.list, "currency": "INR", "buying": 1, "enabled": 1},
		)
		frappe.db.set_single_value("Buying Settings", "buying_price_list", self.list)

	def details(self):
		from xpos.x_pos.api.purchase_orders import get_item_purchase_details

		return get_item_purchase_details(ITEM_B, PROFILE)

	def price(self, rate, uom, price_list=None):
		frappe.get_doc(
			{
				"doctype": "Item Price",
				"item_code": ITEM_B,
				"price_list": price_list or self.list,
				"price_list_rate": rate,
				"uom": uom,
				"buying": 1,
			}
		).insert(ignore_permissions=True)

	def test_stock_uom_price_is_converted_when_the_uom_has_none(self):
		self.price(10, "Nos")
		details = self.details()
		self.assertEqual((details["purchase_uom"], details["purchase_cf"]), ("Box", 12))
		self.assertEqual(details["buying_rate"], 120)

	def test_uom_specific_price_takes_precedence(self):
		self.price(10, "Nos")
		self.price(100, "Box")
		self.assertEqual(self.details()["buying_rate"], 100)

	def test_foreign_currency_list_is_converted_to_company_currency(self):
		usd = "_Test PS USD Buying List"
		ensure("Price List", usd, {"price_list_name": usd, "currency": "USD", "buying": 1, "enabled": 1})
		frappe.db.set_single_value("Buying Settings", "buying_price_list", usd)
		frappe.get_doc(
			{
				"doctype": "Currency Exchange",
				"date": add_days(nowdate(), -1),
				"from_currency": "USD",
				"to_currency": "INR",
				"exchange_rate": 80,
				"for_buying": 1,
			}
		).insert(ignore_permissions=True)
		self.price(1, "Nos", usd)
		self.assertEqual(self.details()["buying_rate"], 960)
		self.price(10, "Box", usd)
		self.assertEqual(self.details()["buying_rate"], 800)
