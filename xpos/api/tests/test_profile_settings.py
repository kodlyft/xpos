# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""POS Profile settings that used to be stored but ignored (mocked unit tests).

See docs/features/pos-profile-settings-status.md for the rules under test.
"""

import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import frappe

from xpos.api import invoices, profile_rules
from xpos.api.tests.test_invoices import tender_legs_from_payments
from xpos.x_pos.api.invoice_processing import stock as stock_module


class Thrown(Exception):
	"""Stands in for frappe.throw when frappe is mocked."""


def raise_thrown(*args, **kwargs):
	raise Thrown(args[0] if args else "")


class FakeProfile(dict):
	"""POS Profile stand-in answering both `.get()` and attribute access."""

	def __getattr__(self, key):
		return self.get(key)


def profile(**values):
	base = {"name": "POS-1", "company": "Test Co", "warehouse": "Store - TC", "currency": "USD"}
	base["selling_price_list"] = "Standard Selling"
	# Mocked invoices have no real totals; keep the unpaid-balance guard out of the way.
	base["allow_partial_payment"] = 1
	base.update(values)
	return FakeProfile(base)


class TestShouldBlock(unittest.TestCase):
	"""A1: an explicit 0 disables the XPOS pre-check; only a missing value defaults to blocking."""

	def check(self, global_negative, stored, pos_profile="POS-1"):
		with patch.object(stock_module, "frappe") as mock_frappe:
			mock_frappe.db.get_single_value.return_value = global_negative
			mock_frappe.db.get_value.return_value = stored
			return stock_module._should_block(pos_profile)

	def test_matrix(self):
		self.assertTrue(self.check(0, 1))
		self.assertFalse(self.check(0, 0), "explicit 0 used to be turned into 1")
		self.assertTrue(self.check(0, None), "missing value keeps the blocking default")
		self.assertTrue(self.check(0, None, pos_profile=None))
		for stored in (0, 1, None):
			self.assertFalse(self.check(1, stored), "global negative stock always wins")

	def test_returns_and_non_stock_invoices_are_never_checked(self):
		with patch.object(stock_module, "_collect_stock_errors") as collect:
			stock_module.validate_stock_on_invoice(
				SimpleNamespace(doctype="Sales Invoice", update_stock=0, items=[], pos_profile="POS-1")
			)
			collect.assert_not_called()


class TestCustomerPriceList(unittest.TestCase):
	"""A2: resolution order customer → customer group → profile."""

	def test_force_off_uses_profile_list(self):
		pos = profile(force_price_from_customer_price_list=0)
		with patch.object(profile_rules, "customer_price_list") as customer_list:
			self.assertEqual(profile_rules.resolve_selling_price_list(pos, "CUST-1"), "Standard Selling")
			customer_list.assert_not_called()

	def test_force_on_uses_usable_customer_list(self):
		pos = profile(force_price_from_customer_price_list=1)
		with (
			patch.object(profile_rules, "customer_price_list", return_value="Wholesale"),
			patch.object(profile_rules, "price_list_usable", return_value=True),
			patch.object(profile_rules.frappe.db, "get_value", return_value="USD"),
		):
			self.assertEqual(profile_rules.resolve_selling_price_list(pos, "CUST-1"), "Wholesale")

	def test_force_on_falls_back_when_list_unusable(self):
		pos = profile(force_price_from_customer_price_list=1)
		with (
			patch.object(profile_rules, "customer_price_list", return_value="EUR List"),
			patch.object(profile_rules, "price_list_usable", return_value=False),
			patch.object(profile_rules.frappe.db, "get_value", return_value="USD"),
		):
			self.assertEqual(profile_rules.resolve_selling_price_list(pos, "CUST-1"), "Standard Selling")

	def test_no_customer_uses_profile_list(self):
		pos = profile(force_price_from_customer_price_list=1)
		self.assertEqual(profile_rules.resolve_selling_price_list(pos, None), "Standard Selling")

	def test_customer_group_tree_fallback(self):
		values = {
			("Customer", "CUST-1"): frappe._dict(default_price_list=None, customer_group="Retail North"),
			("Customer Group", "Retail North"): None,
			("Customer Group", "Retail"): "Retail List",
		}
		with (
			patch.object(
				profile_rules.frappe.db,
				"get_value",
				side_effect=lambda dt, name, *a, **k: values.get((dt, name)),
			),
			patch.object(profile_rules, "get_ancestors_of", return_value=["Retail", "All Customer Groups"]),
		):
			self.assertEqual(profile_rules.customer_price_list("CUST-1"), "Retail List")

	def test_customer_own_list_wins(self):
		row = frappe._dict(default_price_list="VIP", customer_group="Retail")
		with patch.object(profile_rules.frappe.db, "get_value", return_value=row):
			self.assertEqual(profile_rules.customer_price_list("CUST-1"), "VIP")


class TestZeroPriceAndFreeLines(unittest.TestCase):
	"""A3: zero-price sale lines and server-verified free lines."""

	def test_zero_payable_rejected_unless_allowed(self):
		"""``net_amount`` already carries the invoice discount, so 100% / fixed invoice discounts count."""
		row = lambda net: frappe._dict(item_code="ITEM", net_amount=net)  # noqa: E731
		doc = lambda total: frappe._dict(grand_total=total)  # noqa: E731
		with patch.object(profile_rules.frappe, "throw", side_effect=raise_thrown):
			with self.assertRaises(Thrown):
				profile_rules.check_zero_payable(profile(allow_zero_rated_items=0), doc(10), [row(0)])
			with self.assertRaises(Thrown):
				profile_rules.check_zero_payable(profile(allow_zero_rated_items=0), doc(0), [row(5)])
			profile_rules.check_zero_payable(profile(allow_zero_rated_items=1), doc(0), [row(0)])
			profile_rules.check_zero_payable(profile(allow_zero_rated_items=0), doc(5), [row(5)])
			# Only verified free promotion lines (not passed as sale rows) may be free.
			profile_rules.check_zero_payable(profile(allow_zero_rated_items=0), doc(0), [])

	def offer(self, **values):
		base = dict(
			name="OFFER-1",
			disabled=0,
			offer="Give Product",
			given_qty=1,
			company="Test Co",
			pos_profile=None,
			valid_from=None,
			valid_upto=None,
			coupon_based=0,
			apply_on="Item Code",
			item="BUY-ITEM",
			min_qty=2,
			max_qty=0,
			min_amt=0,
			max_amt=0,
			replace_item=0,
			replace_cheapest_item=0,
			apply_type="Item Code",
			apply_item_code="FREE-ITEM",
		)
		base.update(values)
		return frappe._dict(base)

	def verify(self, offer, line=None, paid=None, coupons=()):
		line = line or {"item_code": "FREE-ITEM", "qty": 1, "offers": "OFFER-1", "is_offer": 1}
		paid = paid if paid is not None else [{"item_code": "BUY-ITEM", "qty": 2, "rate": 10}]
		with (
			patch.object(profile_rules.frappe.db, "exists", return_value=True),
			patch.object(profile_rules.frappe, "get_cached_doc", return_value=offer),
		):
			return profile_rules.verified_offer_free_line(profile(), line, paid, set(coupons), "2026-10-16")

	def test_valid_offer_line(self):
		self.assertTrue(self.verify(self.offer()))

	def test_crafted_offer_lines_are_rejected(self):
		self.assertFalse(self.verify(self.offer(disabled=1)))
		self.assertFalse(self.verify(self.offer(company="Other Co")), "cross-company offer")
		self.assertFalse(self.verify(self.offer(pos_profile="POS-2")), "other profile's offer")
		self.assertFalse(self.verify(self.offer(valid_upto="2026-01-01")), "expired")
		self.assertFalse(self.verify(self.offer(coupon_based=1)), "coupon offer without its coupon")
		self.assertTrue(self.verify(self.offer(coupon_based=1), coupons=["OFFER-1"]))
		self.assertFalse(self.verify(self.offer(), paid=[{"item_code": "BUY-ITEM", "qty": 1, "rate": 10}]))
		self.assertFalse(
			self.verify(self.offer(), line={"item_code": "PRICEY", "qty": 1, "offers": "OFFER-1"}),
			"different item than the offer gives",
		)
		self.assertFalse(
			self.verify(self.offer(), line={"item_code": "FREE-ITEM", "qty": 5, "offers": "OFFER-1"}),
			"more free units than the offer gives",
		)
		self.assertFalse(self.verify(self.offer(offer="Item Price")))

	def test_pricing_rule_free_line(self):
		rule = frappe._dict(
			disable=0,
			selling=1,
			price_or_product_discount="Product",
			company="Test Co",
			same_item=0,
			free_item="FREE",
		)
		with patch.object(profile_rules.frappe.db, "get_value", return_value=rule):
			line = {"item_code": "FREE", "pricing_rules": '["PRLE-1"]'}
			self.assertTrue(profile_rules.verified_pricing_rule_free_line(profile(), line))
			self.assertFalse(
				profile_rules.verified_pricing_rule_free_line(
					profile(), {"item_code": "OTHER", "pricing_rules": "PRLE-1"}
				)
			)
		with patch.object(profile_rules.frappe.db, "get_value", return_value=None):
			self.assertFalse(
				profile_rules.verified_pricing_rule_free_line(
					profile(), {"item_code": "FREE", "pricing_rules": "FAKE"}
				)
			)


class TestCreateInvoicePricing(unittest.TestCase):
	"""A2/A3 through create_invoice: crafted payloads cannot set their own prices."""

	def setUp(self):
		for name, kwargs in {
			"build_tender_legs": {"side_effect": tender_legs_from_payments},
			"build_change_legs": {"return_value": ([], 0.0)},
			"invoice_currency_of": {"return_value": "USD"},
			"get_currency_precision": {"return_value": 2},
			"get_invoice_type": {"return_value": "Sales Invoice"},
			"_validate_return_invoice": {"side_effect": lambda against, customer, items: items},
		}.items():
			patcher = patch(f"xpos.api.invoices.{name}", **kwargs)
			patcher.start()
			self.addCleanup(patcher.stop)

		patcher = patch("xpos.api.invoices.frappe")
		self.mock_frappe = patcher.start()
		self.addCleanup(patcher.stop)
		self.mock_frappe.throw.side_effect = raise_thrown
		self.mock_frappe.db.get_value.return_value = "Debtors - TC"
		self.mock_frappe.db.get_default.return_value = "2"

		self.rows = []
		self.invoice = MagicMock()
		self.invoice.name = "INV-1"
		self.invoice.as_dict.return_value = {"name": "INV-1"}

		def append(table, data):
			row = MagicMock()
			if table == "items":
				self.rows.append(row)
			return row

		self.invoice.append.side_effect = append
		self.mock_frappe.new_doc.return_value = self.invoice

		patcher = patch("xpos.api.auth.user_has_pos_permission", return_value=False)
		self.can_change_price = patcher.start()
		self.addCleanup(patcher.stop)

		# Checks that need ERPNext's real totals run live (test_profile_settings_hardening).
		for name in ("repricing_changes", "validate_sale_discounts"):
			patcher = patch(f"xpos.api.invoices.{name}", return_value=None)
			patcher.start()
			self.addCleanup(patcher.stop)
		patcher = patch("xpos.api.invoices.check_zero_payable")
		self.zero_check = patcher.start()
		self.addCleanup(patcher.stop)

	def sale_rows(self):
		return self.zero_check.call_args.args[2]

	def run_invoice(self, pos, items, prices=None, **data):
		prices = prices or {}
		with (
			patch.object(invoices, "resolve_pos_profile", return_value=pos),
			patch.object(invoices, "resolve_selling_price_list", return_value="Customer List"),
			patch.object(invoices, "get_line_rate", side_effect=lambda pl, code, *a: prices.get(code)),
			patch.object(invoices, "verified_offer_free_line", return_value=False),
			patch.object(invoices, "verified_pricing_rule_free_line", return_value=False),
		):
			payload = {"pos_profile": "POS-1", "customer": "CUST-1", "items": items}
			payload.update(data)
			invoices.create_invoice(payload)

	def test_crafted_rate_is_reset_to_listed_price(self):
		self.run_invoice(profile(), [{"item_code": "A", "qty": 1, "rate": 1}], prices={"A": 80})
		self.assertEqual(self.rows[0].rate, 80)
		self.assertEqual(self.invoice.selling_price_list, "Customer List")

	def test_missing_price_blocks_when_forced(self):
		with self.assertRaisesRegex(frappe.ValidationError, "Price unavailable"):
			self.run_invoice(
				profile(force_price_from_customer_price_list=1, allow_zero_rated_items=1),
				[{"item_code": "A", "qty": 1, "rate": 50}],
			)

	def test_missing_price_cannot_be_invented_without_price_rights(self):
		with self.assertRaisesRegex(frappe.ValidationError, "Price unavailable"):
			self.run_invoice(profile(allow_zero_rated_items=1), [{"item_code": "A", "qty": 1, "rate": 50}])

	def test_missing_price_keeps_rate_with_price_rights(self):
		self.can_change_price.return_value = True
		self.run_invoice(profile(allow_zero_rated_items=1), [{"item_code": "A", "qty": 1, "rate": 50}])
		self.assertEqual(self.rows[0].rate, 50)

	def test_manual_price_kept_with_permission(self):
		self.can_change_price.return_value = True
		self.run_invoice(profile(), [{"item_code": "A", "qty": 1, "rate": 55}], prices={"A": 80})
		self.assertEqual(self.rows[0].rate, 55)

	def test_crafted_free_line_is_checked_as_a_sale_line(self):
		self.run_invoice(
			profile(allow_zero_rated_items=0),
			[
				{"item_code": "A", "qty": 1, "rate": 80},
				{"item_code": "B", "qty": 1, "rate": 0, "is_free_item": 1, "is_offer": 1, "offers": "X"},
			],
			prices={"A": 80, "B": 0},
		)
		self.assertEqual(self.sale_rows(), self.rows)
		self.assertFalse(self.rows[1].is_free_item == 1)

	def test_discounted_line_is_checked_as_a_sale_line(self):
		self.can_change_price.return_value = True
		self.run_invoice(
			profile(allow_zero_rated_items=0),
			[{"item_code": "A", "qty": 1, "rate": 80, "discount_percentage": 100}],
		)
		self.assertEqual(self.sale_rows(), self.rows)

	def test_zero_price_allowed_when_enabled(self):
		self.run_invoice(
			profile(allow_zero_rated_items=1), [{"item_code": "A", "qty": 1, "rate": 0}], prices={"A": 0}
		)
		self.assertEqual(self.rows[0].rate, 0)

	def test_return_keeps_original_rate(self):
		self.run_invoice(
			profile(force_price_from_customer_price_list=1),
			[{"item_code": "A", "qty": -1, "rate": 40}],
			prices={"A": 80},
			is_return=1,
			return_against="INV-0",
		)
		self.assertEqual(self.rows[0].rate, 40)


class TestDeliveryChargeSwitch(unittest.TestCase):
	"""B1: use_delivery_charges is the master switch, enforced on the server."""

	def doc(self, **values):
		base = dict(
			pos_profile="POS-1",
			company="Test Co",
			pos_delivery_charges="Home Delivery",
			is_return=0,
			is_consolidated=0,
		)
		base.update(values)
		new = base.pop("new", True)
		changed = base.pop("changed", True)
		return SimpleNamespace(
			get=lambda key, default=None: base.get(key, default),
			is_new=lambda: new,
			has_value_changed=lambda field: changed,
			**base,
		)

	def run_check(self, doc, use_delivery=1, eligible=("Home Delivery",)):
		with (
			patch.object(
				profile_rules.frappe,
				"get_cached_doc",
				return_value=profile(use_delivery_charges=use_delivery),
			),
			patch.object(profile_rules.frappe, "throw", side_effect=raise_thrown),
			patch(
				"xpos.x_pos.doctype.delivery_charges.delivery_charges.get_applicable_delivery_charges",
				return_value=[SimpleNamespace(name=n) for n in eligible],
			),
		):
			profile_rules.validate_delivery_charge(doc)

	def test_disabled_profile_rejects_new_charge(self):
		with self.assertRaises(Thrown):
			self.run_check(self.doc(), use_delivery=0)

	def test_ineligible_charge_rejected(self):
		with self.assertRaises(Thrown):
			self.run_check(self.doc(pos_delivery_charges="Other Company Charge"))

	def test_eligible_charge_passes(self):
		self.run_check(self.doc())

	def test_existing_unchanged_draft_and_returns_untouched(self):
		self.run_check(self.doc(new=False, changed=False), use_delivery=0)
		self.run_check(self.doc(is_return=1), use_delivery=0)
		self.run_check(self.doc(pos_delivery_charges=None), use_delivery=0)


class TestActivationPatch(unittest.TestCase):
	"""Migration: existing profiles keep their effective behaviour; reruns change nothing."""

	def test_sets_current_behaviour_once(self):
		from xpos.patches.v2 import activate_pos_profile_settings as patch_module

		with patch.object(patch_module, "frappe") as mock_frappe:
			mock_frappe.db.get_default.return_value = None
			mock_frappe.get_all.return_value = [
				frappe._dict(name="P1", company="C"),
				frappe._dict(name="P2", company="C"),
			]
			with patch.object(patch_module, "delivery_was_available", side_effect=[True, False]):
				patch_module.execute()
			calls = mock_frappe.db.set_value.call_args_list
			self.assertEqual(
				calls[0].args[2],
				{
					"force_price_from_customer_price_list": 0,
					"allow_zero_rated_items": 1,
					"use_delivery_charges": 1,
				},
			)
			self.assertNotIn("use_delivery_charges", calls[1].args[2])
			mock_frappe.db.set_default.assert_called_once()

			mock_frappe.reset_mock()
			mock_frappe.db.get_default.return_value = "1"
			patch_module.execute()
			mock_frappe.db.set_value.assert_not_called()


class TestBlindClosing(unittest.TestCase):
	"""B2: blind closing hides expected amounts from the API, not just the UI."""

	def test_blind_rule(self):
		with (
			patch.object(profile_rules.frappe, "get_cached_value", return_value=1),
			patch("xpos.api.auth.user_has_pos_permission", return_value=False),
		):
			self.assertTrue(profile_rules.is_blind_closing("POS-1"))
		with (
			patch.object(profile_rules.frappe, "get_cached_value", return_value=1),
			patch("xpos.api.auth.user_has_pos_permission", return_value=True),
		):
			self.assertFalse(profile_rules.is_blind_closing("POS-1"), "supervisor sees expected")
		with patch.object(profile_rules.frappe, "get_cached_value", return_value=0):
			self.assertFalse(profile_rules.is_blind_closing("POS-1"))

	def opening(self):
		return SimpleNamespace(
			name="OPEN-1",
			pos_profile="POS-1",
			company="Test Co",
			user="cashier@test.com",
			period_start_date="2026-10-16 09:00:00",
			balance_details=[SimpleNamespace(mode_of_payment="Cash", amount=100, currency="USD")],
		)

	def summary(self, blind, user="cashier@test.com", may_close=False):
		from xpos.api import shifts

		with (
			patch.object(shifts.frappe, "get_doc", return_value=self.opening()),
			patch.object(shifts.frappe, "session", SimpleNamespace(user=user)),
			patch.object(shifts, "user_may_use_profile", return_value=True),
			patch.object(shifts, "can_close_shift", return_value=may_close),
			patch.object(shifts, "get_invoice_type", return_value="Sales Invoice"),
			patch.object(
				shifts, "get_shift_invoices", return_value=[frappe._dict(name="INV-1", grand_total=500)]
			),
			patch.object(
				shifts,
				"get_shift_expected_amounts",
				return_value={"Cash": {"amount": 600, "currency": "USD"}},
			),
			patch.object(shifts, "get_shift_payment_totals", return_value={"Cash": {"amount": 500}}),
			patch.object(shifts, "resolve_cash_mode_of_payment", return_value="Cash"),
			patch.object(shifts, "_get_shift_tax_summary", return_value=[]),
			patch.object(shifts, "is_blind_closing", return_value=blind),
		):
			return shifts.get_shift_summary("OPEN-1")

	def test_blind_summary_has_no_expected_or_totals(self):
		result = self.summary(blind=True)
		self.assertTrue(result["blind_closing"])
		self.assertNotIn("600", repr(result))
		self.assertNotIn("500", repr(result))
		for leak in (
			"expected_amounts",
			"payment_summary",
			"grand_total",
			"net_total",
			"invoices",
			"tax_summary",
		):
			self.assertNotIn(leak, result)
		self.assertEqual(result["payment_modes"], {"Cash": {"currency": "USD"}})

	def test_supervisor_summary_keeps_expected(self):
		result = self.summary(blind=False)
		self.assertEqual(result["expected_amounts"]["Cash"]["amount"], 600)

	def test_other_cashier_cannot_read_shift(self):
		with self.assertRaises(frappe.PermissionError):
			self.summary(blind=False, user="someone@test.com")
		self.summary(blind=False, user="manager@test.com", may_close=True)

	def test_electron_push_recomputes_expected(self):
		from xpos.api import shifts

		appended = []
		closing = MagicMock()
		closing.append.side_effect = lambda table, row: appended.append(row)
		with (
			patch.object(shifts, "can_close_shift", return_value=True),
			patch.object(shifts, "frappe") as mock_frappe,
			patch.object(shifts, "get_invoice_type", return_value="Sales Invoice"),
			patch.object(shifts, "get_shift_invoices", return_value=[]),
			patch.object(
				shifts,
				"get_shift_expected_amounts",
				return_value={"Cash": {"amount": 600, "currency": "USD"}},
			),
		):
			mock_frappe.db.get_value.return_value = None
			mock_frappe.get_doc.side_effect = (
				lambda *a, **k: self.opening() if a and a[0] == "POS Opening Shift" else closing
			)
			shifts.create_closing_shift(
				{
					"pos_opening_shift": "OPEN-1",
					"payment_reconciliation": [
						{
							"mode_of_payment": "Cash",
							"expected_amount": 450,
							"closing_amount": 450,
							"difference": 0,
						}
					],
				}
			)
		self.assertEqual(appended[0]["expected_amount"], 600)
		self.assertEqual(appended[0]["difference"], -150)

	def test_reconciliation_report_blocked_for_blind_profiles(self):
		from xpos.x_pos.report.pos_shift_reconciliation import pos_shift_reconciliation as report

		with (
			patch.object(report.frappe, "has_permission", return_value=False),
			patch.object(report, "is_blind_closing", return_value=True),
		):
			with self.assertRaises(frappe.PermissionError):
				report.ensure_not_blind({"POS-1"})
		with (
			patch.object(report.frappe, "has_permission", return_value=True),
			patch.object(report, "is_blind_closing", return_value=True),
		):
			report.ensure_not_blind({"POS-1"})


class TestSaleDiscountAuthority(unittest.TestCase):
	"""C1/A: discount authority is derived on the server; ``discount_source`` is never consulted."""

	def check(
		self,
		rows,
		discount=0,
		grand_total=100,
		perms=(),
		cap=100.0,
		customer_pct=0,
		rule_pct=0,
		offers=(0, 0),
	):
		doc = frappe._dict(
			discount_amount=discount,
			grand_total=grand_total,
			total=grand_total + discount,
			apply_discount_on="Grand Total",
			customer="CUST-1",
			posting_date="2026-10-17",
			pricing_rules=[],
		)
		with (
			patch.object(profile_rules.frappe, "throw", side_effect=raise_thrown),
			patch("xpos.api.auth.user_has_pos_permission", side_effect=lambda key, **kw: key in perms),
			patch.object(profile_rules, "manual_discount_cap", return_value=cap),
			patch.object(profile_rules, "rule_line_discount_pct", return_value=rule_pct),
			patch.object(profile_rules, "customer_discount_rate", return_value=customer_pct),
			patch.object(profile_rules, "offer_discounts", return_value=offers),
			patch.object(profile_rules, "transaction_rule_discount", return_value=0),
		):
			profile_rules.validate_sale_discounts(profile(), doc, rows, [], [], set())

	def line(self, plr=100, rate=100):
		return frappe._dict(name="row1", idx=1, item_code="A", price_list_rate=plr, rate=rate)

	def test_customer_discount_needs_no_manual_permission(self):
		# 10% customer discount on a 100 sale (grand total 90 after it).
		self.check([self.line()], discount=10, grand_total=90, customer_pct=10)

	def test_forged_customer_discount_is_manual_and_rejected(self):
		with self.assertRaises(Thrown):
			self.check([self.line()], discount=50, grand_total=50, customer_pct=10)

	def test_manual_invoice_discount_needs_permission_and_cap(self):
		with self.assertRaises(Thrown):
			self.check([self.line()], discount=10, grand_total=90)
		self.check([self.line()], discount=10, grand_total=90, perms=("apply_additional_discount",), cap=10)
		with self.assertRaises(Thrown):
			self.check(
				[self.line()], discount=20, grand_total=80, perms=("apply_additional_discount",), cap=10
			)

	def test_manual_line_discount_needs_permission_and_cap(self):
		with self.assertRaises(Thrown):
			self.check([self.line(rate=90)])
		self.check([self.line(rate=90)], perms=("show_edit_discount_field",), cap=10)
		with self.assertRaises(Thrown):
			self.check([self.line(rate=80)], perms=("show_edit_discount_field",), cap=10)

	def test_verified_pricing_rule_line_discount_is_not_manual(self):
		self.check([self.line(rate=50)], rule_pct=50)

	def test_offer_discount_is_not_manual(self):
		# 20 item-level offer discount plus a 10% grand-total offer on the remaining 80 = 28.
		self.check([self.line()], discount=28, grand_total=72, offers=(20, 10))

	def test_line_and_invoice_manual_discounts_cannot_stack_past_cap(self):
		perms = ("apply_additional_discount", "show_edit_discount_field")
		with self.assertRaises(Thrown):
			self.check([self.line(rate=90)], discount=9, grand_total=81, perms=perms, cap=10)
		self.check([self.line(rate=95)], discount=4.75, grand_total=90.25, perms=perms, cap=10)


class TestPurchaseUom(unittest.TestCase):
	"""C2: explicit UOM → profile default_purchase_uom → item purchase UOM → stock UOM."""

	def resolve(self, uom=None, profile_uom=None, purchase_uom=None):
		from xpos.x_pos.api import purchase_orders

		item = SimpleNamespace(
			stock_uom="Nos",
			purchase_uom=purchase_uom,
			uoms=[
				SimpleNamespace(uom="Box", conversion_factor=12),
				SimpleNamespace(uom="Nos", conversion_factor=1),
			],
		)
		with (
			patch.object(purchase_orders.frappe, "get_cached_doc", return_value=item),
			patch.object(purchase_orders.frappe.db, "get_value", return_value=profile_uom),
			patch.object(purchase_orders.frappe, "throw", side_effect=raise_thrown),
		):
			return purchase_orders.resolve_purchase_uom("ITEM", uom, "POS-1" if profile_uom else None)

	def test_order(self):
		self.assertEqual(self.resolve(uom="Nos", profile_uom="Box")[:3], ("Nos", "Nos", 1))
		self.assertEqual(self.resolve(profile_uom="Box", purchase_uom="Nos")[:3], ("Box", "Nos", 12))
		self.assertEqual(self.resolve(purchase_uom="Box")[:3], ("Box", "Nos", 12))
		self.assertEqual(self.resolve()[:3], ("Nos", "Nos", 1))

	def test_unsupported_profile_uom_falls_back_with_note(self):
		uom, _stock, factor, note = self.resolve(profile_uom="Pallet", purchase_uom="Box")
		self.assertEqual((uom, factor), ("Box", 12))
		self.assertIn("Pallet", note)

	def test_explicit_unsupported_uom_rejected_not_invented(self):
		with self.assertRaises(Thrown):
			self.resolve(uom="Pallet")


class TestCustomerCredit(unittest.TestCase):
	"""D1: spending existing customer credit is gated, locked and re-checked on the server."""

	def lock(self, requested, rows, flag=1, invoice_type="Sales Invoice", currency_ok=True):
		from xpos.api import customer_credit

		pos = profile(use_customer_credit=flag)
		with (
			patch.object(customer_credit, "get_invoice_type", return_value=invoice_type),
			patch.object(customer_credit, "credit_account_supported", return_value=currency_ok),
			patch.object(
				customer_credit.frappe.db, "sql", side_effect=lambda q, name, as_dict: rows.get(name, [])
			),
			patch.object(customer_credit.frappe.db, "get_value", return_value="CUST-1"),
			patch.object(customer_credit.frappe.db, "rollback"),
		):
			return customer_credit.lock_credit_sources(pos, "CUST-1", "Debtors - TC", requested)

	def receipt(self, **values):
		base = dict(
			docstatus=1,
			payment_type="Receive",
			party_type="Customer",
			party="CUST-1",
			company="Test Co",
			paid_from="Debtors - TC",
			unallocated_amount=100,
		)
		base.update(values)
		return [frappe._dict(base)]

	def test_valid_partial_allocation(self):
		locked = self.lock(
			[{"source_type": "Payment Entry", "source_name": "PE-1", "amount": 40}], {"PE-1": self.receipt()}
		)
		self.assertEqual(locked[0]["amount"], 40)
		self.assertEqual(locked[0]["available"], 100)

	def test_disabled_profile_rejected(self):
		with self.assertRaises(frappe.ValidationError):
			self.lock([{"source_type": "Payment Entry", "source_name": "PE-1", "amount": 40}], {}, flag=0)

	def test_pos_invoice_mode_rejected(self):
		with self.assertRaises(frappe.ValidationError):
			self.lock(
				[{"source_type": "Payment Entry", "source_name": "PE-1", "amount": 40}],
				{},
				invoice_type="POS Invoice",
			)

	def test_overspend_and_duplicate_rows_rejected(self):
		with self.assertRaisesRegex(frappe.ValidationError, "Only 100"):
			self.lock(
				[
					{"source_type": "Payment Entry", "source_name": "PE-1", "amount": 60},
					{"source_type": "Payment Entry", "source_name": "PE-1", "amount": 60},
				],
				{"PE-1": self.receipt()},
			)

	def test_other_customer_or_company_rejected(self):
		for row in (
			self.receipt(party="CUST-2"),
			self.receipt(company="Other Co"),
			self.receipt(docstatus=2),
		):
			with self.assertRaises(frappe.ValidationError):
				self.lock(
					[{"source_type": "Payment Entry", "source_name": "PE-1", "amount": 10}], {"PE-1": row}
				)

	def test_crafted_source_types_rejected(self):
		with self.assertRaises(frappe.ValidationError):
			self.lock([{"source_type": "Journal Entry", "source_name": "JV-1", "amount": 10}], {})
		with self.assertRaises(frappe.ValidationError):
			self.lock(
				[{"source_type": "Payment Entry", "source_name": "PE-1", "amount": -5}],
				{"PE-1": self.receipt()},
			)

	def test_credit_note_source(self):
		note = [
			frappe._dict(
				docstatus=1,
				is_return=1,
				customer="CUST-1",
				company="Test Co",
				debit_to="Debtors - TC",
				outstanding_amount=-30,
			)
		]
		locked = self.lock(
			[{"source_type": "Sales Invoice", "source_name": "RET-1", "amount": 30}], {"RET-1": note}
		)
		self.assertEqual(locked[0]["available"], 30)

	def test_allocation_uses_erpnext_reconciliation(self):
		from xpos.api import customer_credit

		invoice = frappe._dict(
			doctype="Sales Invoice",
			name="SINV-1",
			debit_to="Debtors - TC",
			customer="CUST-1",
			company="Test Co",
			currency="USD",
			party_account_currency="USD",
		)
		credits = [
			{"source_type": "Payment Entry", "source_name": "PE-1", "amount": 40, "available": 100},
			{"source_type": "Sales Invoice", "source_name": "RET-1", "amount": 30, "available": 30},
		]
		with (
			patch("erpnext.accounts.utils.reconcile_against_document") as reconcile_pe,
			patch(
				"erpnext.accounts.doctype.payment_reconciliation.payment_reconciliation.reconcile_dr_cr_note"
			) as reconcile_note,
		):
			customer_credit.allocate_customer_credit(invoice, credits)
		pe_row = reconcile_pe.call_args.args[0][0]
		self.assertEqual(
			(pe_row.voucher_no, pe_row.against_voucher, pe_row.allocated_amount), ("PE-1", "SINV-1", 40)
		)
		note_row = reconcile_note.call_args.args[0][0]
		self.assertEqual((note_row.voucher_no, note_row.allocated_amount), ("RET-1", 30))

	def test_credit_counts_as_settled_and_cannot_exceed_due(self):
		invoice = SimpleNamespace(is_return=0, outstanding_amount=50, paid_amount=50, write_off_amount=0)
		pos = profile(allow_partial_payment=0, allow_credit_sale=0)
		invoices._validate_unpaid_balance_permissions(invoice, pos, {}, customer_credit=50)
		with self.assertRaises(frappe.ValidationError):
			invoices._validate_unpaid_balance_permissions(invoice, pos, {}, customer_credit=80)

	def test_helpers_are_not_endpoints(self):
		from xpos.api import customer_credit

		self.assertNotIn(customer_credit.lock_credit_sources, frappe.whitelisted)
		self.assertNotIn(customer_credit.allocate_customer_credit, frappe.whitelisted)
		self.assertIn(customer_credit.get_customer_credit, frappe.whitelisted)


class TestPrintFormatRules(unittest.TestCase):
	"""E1: first matching customer-group rule, then default, then the XPOS receipt."""

	def resolve(self, rules, default=None, group="Retail North", usable=None):
		from xpos.api import print_formats

		usable = usable if usable is not None else {"Retail Receipt", "VIP Receipt", "Default A4"}
		pos = SimpleNamespace(
			get=lambda key, d=None: {
				"print_format_rules": [
					SimpleNamespace(idx=i + 1, customer_group=g, print_format=f)
					for i, (g, f) in enumerate(rules)
				],
				"default_print_format": default,
			}.get(key, d)
		)
		with (
			patch.object(print_formats.frappe, "get_cached_doc", return_value=pos),
			patch.object(print_formats.frappe.db, "get_value", return_value=group),
			patch.object(print_formats, "get_ancestors_of", return_value=["Retail", "All Customer Groups"]),
			patch.object(print_formats, "usable_print_format", side_effect=lambda name: name in usable),
		):
			return print_formats.resolve_print_format("POS-1", "CUST-1")

	def test_first_matching_row_wins(self):
		self.assertEqual(
			self.resolve([("Retail", "Retail Receipt"), ("Retail North", "VIP Receipt")]), "Retail Receipt"
		)

	def test_no_match_uses_default_then_fallback(self):
		self.assertEqual(self.resolve([("Wholesale", "VIP Receipt")], default="Default A4"), "Default A4")
		self.assertEqual(self.resolve([("Wholesale", "VIP Receipt")]), "XPOS Thermal Receipt")

	def test_disabled_or_missing_format_skipped(self):
		self.assertEqual(
			self.resolve(
				[("Retail", "Gone Format"), ("Retail North", "VIP Receipt")], usable={"VIP Receipt"}
			),
			"VIP Receipt",
		)
		self.assertEqual(
			self.resolve([("Retail", "Gone Format")], default="Also Gone", usable=set()),
			"XPOS Thermal Receipt",
		)


class TestReferralOnCreate(unittest.TestCase):
	"""E2: referral identity only for XPOS-created customers, never duplicated."""

	def run_create(self, flag=1, offer="OFFER-REF", existing=None, shift_profile="POS-1"):
		from xpos.api import customers

		company = frappe._dict(name="Test Co", final_customer_offer=offer, referral_campaign=None)
		created = MagicMock(referral_code="ABC123")

		def get_value(doctype, filters, field=None, **kwargs):
			if doctype == "Referral Code":
				return existing
			if doctype == "POS Offer":
				return frappe._dict(disabled=0, company="Test Co")
			return "CUST-1"

		with (
			patch.object(customers.frappe.db, "get_value", side_effect=get_value),
			patch.object(customers.frappe, "get_all", return_value=[shift_profile] if shift_profile else []),
			patch.object(
				customers.frappe,
				"get_cached_doc",
				side_effect=lambda dt, name: profile(auto_create_referral_for_new_customers=flag)
				if dt == "POS Profile"
				else company,
			),
			patch(
				"xpos.x_pos.doctype.referral_code.referral_code.create_referral_code", return_value=created
			) as create,
		):
			return customers.create_pos_referral_code("CUST-1"), create

	def test_created_when_enabled(self):
		result, create = self.run_create()
		self.assertEqual(result, {"referral_code": "ABC123"})
		create.assert_called_once()

	def test_not_created_when_disabled_or_no_shift(self):
		for kwargs in ({"flag": 0}, {"shift_profile": None}):
			result, create = self.run_create(**kwargs)
			self.assertEqual(result, {})
			create.assert_not_called()

	def test_retry_keeps_existing_code(self):
		result, create = self.run_create(existing="OLD999")
		self.assertEqual(result, {"referral_code": "OLD999"})
		create.assert_not_called()

	def test_missing_offer_explained(self):
		result, create = self.run_create(offer=None)
		self.assertIn("referral_note", result)
		create.assert_not_called()
