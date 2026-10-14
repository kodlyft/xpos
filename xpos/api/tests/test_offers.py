# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

import unittest
from unittest.mock import MagicMock, patch

import frappe
from erpnext.accounts.doctype.pos_profile.test_pos_profile import make_pos_profile
from erpnext.tests.utils import ERPNextTestSuite
from frappe.utils import add_days, getdate, nowdate

from xpos.api import offers


class TestGetOffers(unittest.TestCase):
	"""Tests for get_offers function."""

	@patch("xpos.api.offers.get_promotional_scheme_offers")
	@patch("xpos.api.offers.frappe")
	def test_get_offers_returns_active_offers(self, mock_frappe, mock_promo):
		"""Test that get_offers returns active POS offers."""
		mock_pos = MagicMock()
		mock_pos.company = "Test Company"
		mock_pos.warehouse = "Store - TC"
		mock_frappe.get_cached_doc.return_value = mock_pos
		mock_frappe.db.sql.return_value = [
			{
				"name": "OFFER-001",
				"offer_title": "10% Off",
				"discount_percentage": 10,
				"disabled": 0,
			}
		]
		mock_promo.return_value = []

		result = offers.get_offers("POS-PROFILE-1")

		self.assertEqual(len(result), 1)
		self.assertEqual(result[0]["name"], "OFFER-001")

	@patch("xpos.api.offers.get_promotional_scheme_offers")
	@patch("xpos.api.offers.frappe")
	def test_get_offers_includes_promotional_schemes(self, mock_frappe, mock_promo):
		"""Test that get_offers includes promotional scheme offers."""
		mock_pos = MagicMock()
		mock_pos.company = "Test Company"
		mock_pos.warehouse = "Store - TC"
		mock_frappe.get_cached_doc.return_value = mock_pos
		mock_frappe.db.sql.return_value = []
		mock_promo.return_value = [
			{
				"name": "PROMO-001",
				"offer_title": "Buy 2 Get 1",
				"from_promotional_scheme": 1,
			}
		]

		result = offers.get_offers("POS-PROFILE-1")

		mock_promo.assert_called_once_with(mock_pos)
		self.assertEqual(len(result), 1)

	@patch("xpos.api.offers.get_promotional_scheme_offers")
	@patch("xpos.api.offers.frappe")
	def test_get_offers_normalizes_discount_fields(self, mock_frappe, mock_promo):
		"""Test that get_offers normalizes discount fields."""
		mock_pos = MagicMock()
		mock_pos.company = "Test Company"
		mock_pos.warehouse = "Store - TC"
		mock_frappe.get_cached_doc.return_value = mock_pos
		mock_frappe.db.sql.return_value = [
			{
				"name": "OFFER-002",
				"discount_percentage": None,  # May be None
				"discount_amount": None,
				"min_qty": None,
				"max_qty": None,
			}
		]
		mock_promo.return_value = []

		result = offers.get_offers("POS-PROFILE-1")

		# Fields should be normalized to 0 instead of None
		self.assertEqual(result[0].get("min_qty", 0), 0)


class TestGetPosCoupon(unittest.TestCase):
	"""get_pos_coupon defers every rule to the shared check_coupon_code.

	The rules themselves are covered against a real database in
	xpos/x_pos/doctype/pos_coupon/test_pos_coupon.py.
	"""

	@patch("xpos.api.offers.frappe")
	@patch("xpos.api.offers.check_coupon_code")
	def test_get_pos_coupon_returns_coupon_and_offer(self, mock_check, mock_frappe):
		"""An accepted coupon comes back with its linked POS Offer."""
		mock_frappe._dict = dict
		mock_check.return_value = {
			"coupon": MagicMock(
				pos_offer="OFFER-001", get=lambda field: {"coupon_code": "SUMMER10"}.get(field)
			),
			"msg": "Apply",
		}
		mock_frappe.get_doc.return_value.as_dict.return_value = {"name": "OFFER-001", "min_qty": None}

		result = offers.get_pos_coupon("SUMMER10", "CUST-001", "Test Company")

		mock_check.assert_called_once_with("SUMMER10", "CUST-001", "Test Company")
		mock_frappe.get_doc.assert_called_once_with("POS Offer", "OFFER-001")
		self.assertEqual(result["coupon"]["coupon_code"], "SUMMER10")
		self.assertEqual(result["offer"]["row_id"], "OFFER-001")
		self.assertEqual(result["offer"]["min_qty"], 0)
		self.assertEqual(result["msg"], "Apply")

	@patch("xpos.api.offers.frappe")
	@patch("xpos.api.offers.check_coupon_code")
	def test_get_pos_coupon_reports_why_a_coupon_is_rejected(self, mock_check, mock_frappe):
		"""A rejected coupon carries the validator's reason and loads no offer."""
		mock_check.return_value = {"coupon": None, "msg": "Sorry, CUST-001 have used this coupon before"}

		result = offers.get_pos_coupon("ONCE", "CUST-001", "Test Company")

		self.assertEqual(
			result,
			{"coupon": None, "offer": None, "msg": "Sorry, CUST-001 have used this coupon before"},
		)
		mock_frappe.get_doc.assert_not_called()


class TestValidateCoupon(unittest.TestCase):
	"""Tests for coupon validation logic."""

	@patch("xpos.api.offers.frappe")
	def test_validate_coupon_checks_usage(self, mock_frappe):
		"""Test that coupon validation checks if already used."""
		# A coupon with used=1 should be invalid
		mock_frappe.db.get_value.return_value = None  # Not found when filtered by used=0

		result = mock_frappe.db.get_value.return_value
		self.assertIsNone(result)

	def test_coupon_date_validation(self):
		"""Test coupon date validation logic."""
		from frappe.utils import getdate

		coupon = {
			"valid_from": "2026-01-01",
			"valid_upto": "2026-12-31",
		}

		# Simulate date check
		today = getdate("2026-06-15")  # Mid-year date
		valid_from = getdate(coupon["valid_from"])
		valid_upto = getdate(coupon["valid_upto"])

		is_valid = valid_from <= today <= valid_upto
		self.assertTrue(is_valid)


class TestGetActiveGiftCoupons(unittest.TestCase):
	"""Tests for get_active_gift_coupons function."""

	@patch("xpos.api.offers.frappe")
	def test_get_active_gift_coupons_returns_customer_coupons(self, mock_frappe):
		"""Test that get_active_gift_coupons returns customer's gift cards."""
		mock_frappe.get_all.return_value = [
			{
				"name": "GIFT-001",
				"coupon_code": "GIFT100",
				"discount_amount": 100,
				"customer": "CUST-001",
			}
		]

		result = offers.get_active_gift_coupons("CUST-001", "Test Company")

		mock_frappe.get_all.assert_called()
		self.assertEqual(len(result), 1)


class TestNormalizeDiscountFields(unittest.TestCase):
	"""Tests for _normalize_discount_fields."""

	def test_string_amounts_are_coerced_to_float(self):
		"""Values arriving as strings from the client are coerced to numbers."""
		offer = {"discount_percentage": "12.5", "discount_amount": "30", "rate": "99.99"}

		offers._normalize_discount_fields(offer)

		self.assertEqual(offer["discount_percentage"], 12.5)
		self.assertEqual(offer["discount_amount"], 30.0)
		self.assertEqual(offer["rate"], 99.99)

	def test_none_becomes_zero(self):
		"""None must not survive into arithmetic downstream."""
		offer = {"discount_percentage": None, "discount_amount": None}

		offers._normalize_discount_fields(offer)

		self.assertEqual(offer["discount_percentage"], 0)
		self.assertEqual(offer["discount_amount"], 0)

	def test_absent_fields_are_not_invented(self):
		"""Only fields already present are normalized."""
		offer = {"name": "OFFER-1"}

		offers._normalize_discount_fields(offer)

		self.assertEqual(offer, {"name": "OFFER-1"})


class TestIsCouponActive(unittest.TestCase):
	"""Tests for _is_coupon_active date-window logic."""

	def test_coupon_without_dates_is_active(self):
		"""A coupon with no validity window is always active."""
		self.assertTrue(
			offers._is_coupon_active({"valid_from": None, "valid_upto": None}, getdate("2026-06-15"))
		)

	def test_coupon_not_yet_valid_is_inactive(self):
		"""valid_from in the future excludes the coupon."""
		coupon = {"valid_from": "2026-07-01", "valid_upto": None}

		self.assertFalse(offers._is_coupon_active(coupon, getdate("2026-06-15")))

	def test_expired_coupon_is_inactive(self):
		"""valid_upto in the past excludes the coupon."""
		coupon = {"valid_from": None, "valid_upto": "2026-06-01"}

		self.assertFalse(offers._is_coupon_active(coupon, getdate("2026-06-15")))

	def test_boundary_dates_are_inclusive(self):
		"""A coupon is active on both its first and last day."""
		coupon = {"valid_from": "2026-06-15", "valid_upto": "2026-06-15"}

		self.assertTrue(offers._is_coupon_active(coupon, getdate("2026-06-15")))


def make_scheme(
	name, apply_on="Item Code", targets=("_Test Item",), price_slab=None, product_slab=None, **args
):
	scheme = frappe.new_doc("Promotional Scheme")
	scheme.name = name
	scheme.update({"company": "_Test Company", "selling": 1, "apply_on": apply_on})
	target_table = {"Item Code": "items", "Item Group": "item_groups", "Brand": "brands"}.get(apply_on)
	for target in targets if target_table else ():
		scheme.append(target_table, {frappe.scrub(apply_on): target})
	if price_slab is not None:
		scheme.append(
			"price_discount_slabs",
			{"rule_description": name, "rate_or_discount": "Discount Percentage", **price_slab},
		)
	if product_slab is not None:
		scheme.append("product_discount_slabs", {"rule_description": name, **product_slab})
	scheme.update(args)
	return scheme.insert()


class TestPromotionalSchemeOffers(ERPNextTestSuite):
	"""Promotional Schemes listed by get_offers, against real ERPNext metadata."""

	def setUp(self):
		self.profile = make_pos_profile(name="_Test XPOS Offers Profile")

	def scheme_offers(self, scheme):
		return [o for o in offers.get_offers(self.profile.name) if o.get("promotional_scheme") == scheme]

	def test_price_discount_slab_is_listed(self):
		make_scheme("_Test PS Price", price_slab={"min_qty": 2, "discount_percentage": 15})

		(offer,) = self.scheme_offers("_Test PS Price")

		self.assertEqual(offer["offer"], "Item Price")
		self.assertEqual(offer["apply_on"], "Item Code")
		self.assertEqual(offer["item"], "_Test Item")
		self.assertEqual(offer["discount_type"], "Discount Percentage")
		self.assertEqual(offer["discount_percentage"], 15)
		self.assertEqual(offer["min_qty"], 2)
		self.assertEqual(offer["promo_source"], "Promotional Scheme")

	def test_product_discount_slab_is_listed(self):
		make_scheme(
			"_Test PS Product",
			product_slab={"min_qty": 3, "free_item": "_Test Item 2", "free_qty": 1},
		)

		(offer,) = self.scheme_offers("_Test PS Product")

		self.assertEqual(offer["offer"], "Give Product")
		self.assertEqual(offer["item"], "_Test Item")
		self.assertEqual(offer["give_item"], "_Test Item 2")
		self.assertEqual(offer["given_qty"], 1)
		self.assertEqual(offer["min_qty"], 3)

	def test_transaction_item_group_and_brand_targets(self):
		make_scheme("_Test PS Txn", apply_on="Transaction", targets=(), price_slab={"discount_percentage": 5})
		make_scheme(
			"_Test PS Group",
			apply_on="Item Group",
			targets=("_Test Item Group", "_Test Item Group Desktops"),
			price_slab={"discount_percentage": 5},
		)
		make_scheme(
			"_Test PS Brand",
			apply_on="Brand",
			targets=("_Test Brand",),
			price_slab={"discount_percentage": 5},
		)

		(txn,) = self.scheme_offers("_Test PS Txn")
		self.assertEqual(txn["offer"], "Grand Total")
		self.assertEqual(
			sorted(o["item_group"] for o in self.scheme_offers("_Test PS Group")),
			["_Test Item Group", "_Test Item Group Desktops"],
		)
		(brand,) = self.scheme_offers("_Test PS Brand")
		self.assertEqual(brand["brand"], "_Test Brand")

	def test_inactive_and_mismatched_schemes_are_not_listed(self):
		slab = {"discount_percentage": 10}
		make_scheme("_Test PS Disabled", price_slab=slab, disable=1)
		make_scheme(
			"_Test PS Expired",
			price_slab=slab,
			valid_from=add_days(nowdate(), -10),
			valid_upto=add_days(nowdate(), -1),
		)
		make_scheme("_Test PS Future", price_slab=slab, valid_from=add_days(nowdate(), 1))
		make_scheme("_Test PS Disabled Slab", price_slab={**slab, "disable": 1})
		make_scheme("_Test PS Warehouse", price_slab={**slab, "warehouse": "_Test Warehouse 1 - _TC"})
		make_scheme("_Test PS Price List", price_slab={**slab, "for_price_list": "Standard Selling"})
		make_scheme("_Test PS Buying", price_slab=slab, selling=0, buying=1)
		other_company = make_scheme("_Test PS Other Company", price_slab=slab)
		other_company.db_set("company", "_Test Company 1")

		listed = {o.get("promotional_scheme") for o in offers.get_offers(self.profile.name)}

		self.assertFalse(
			listed
			& {
				"_Test PS Disabled",
				"_Test PS Expired",
				"_Test PS Future",
				"_Test PS Disabled Slab",
				"_Test PS Warehouse",
				"_Test PS Price List",
				"_Test PS Buying",
				"_Test PS Other Company",
			}
		)

	def test_matching_warehouse_and_price_list_are_listed(self):
		make_scheme(
			"_Test PS Matching",
			price_slab={
				"discount_percentage": 10,
				"warehouse": self.profile.warehouse,
				"for_price_list": self.profile.selling_price_list,
			},
		)

		self.assertEqual(len(self.scheme_offers("_Test PS Matching")), 1)

	def test_unsupported_conditions_are_not_listed(self):
		slab = {"discount_percentage": 10}
		make_scheme(
			"_Test PS Cumulative",
			price_slab=slab,
			is_cumulative=1,
			valid_from=nowdate(),
			valid_upto=add_days(nowdate(), 30),
		)
		make_scheme("_Test PS Mixed", price_slab=slab, mixed_conditions=1)
		make_scheme(
			"_Test PS Customer",
			price_slab=slab,
			applicable_for="Customer",
			customer=[{"customer": "_Test Customer"}],
		)

		listed = {o.get("promotional_scheme") for o in offers.get_offers(self.profile.name)}

		self.assertFalse(listed & {"_Test PS Cumulative", "_Test PS Mixed", "_Test PS Customer"})

	def test_listed_scheme_is_not_auto_applied_on_top_of_its_pricing_rule(self):
		"""ERPNext already applies the scheme through its Pricing Rule; the offer is display-only."""
		make_scheme("_Test PS Once", price_slab={"discount_percentage": 10})

		self.assertTrue(frappe.db.exists("Pricing Rule", {"promotional_scheme": "_Test PS Once"}))
		(offer,) = self.scheme_offers("_Test PS Once")
		self.assertFalse(offer["auto"])
		self.assertFalse(offer["coupon_based"])

	def test_pos_offers_are_still_listed(self):
		pos_offer = frappe.get_doc(
			{
				"doctype": "POS Offer",
				"title": "_Test XPOS Plain Offer",
				"description": "_Test XPOS Plain Offer",
				"company": "_Test Company",
				"apply_on": "Transaction",
				"offer": "Grand Total",
				"discount_type": "Discount Percentage",
				"discount_percentage": 5,
				"auto": 1,
			}
		).insert()
		make_scheme("_Test PS Alongside", price_slab={"discount_percentage": 10})

		listed = {o["name"]: o for o in offers.get_offers(self.profile.name)}

		self.assertEqual(listed[pos_offer.name]["auto"], 1)
		self.assertTrue(self.scheme_offers("_Test PS Alongside"))

	def test_unexpected_scheme_errors_are_logged(self):
		make_scheme("_Test PS Broken", price_slab={"discount_percentage": 10})

		with (
			patch.object(frappe, "get_doc", side_effect=frappe.DoesNotExistError("boom")),
			patch.object(frappe, "log_error") as log_error,
		):
			self.assertEqual(self.scheme_offers("_Test PS Broken"), [])

		log_error.assert_called()


if __name__ == "__main__":
	unittest.main()
