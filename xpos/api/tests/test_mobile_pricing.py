# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""XPOS Mobile selling against a real database: what the quote says is what the invoice becomes.

Every test prices through ``mobile_quote.quote_sale``, builds the sale body the way the app does and posts it
through ``create_invoice``, then compares the saved invoice with the quote. Nothing is mocked.
"""

import json
from unittest.mock import patch

import frappe
from erpnext.tests.utils import ERPNextTestSuite
from frappe.utils import add_days, nowdate

from xpos.api import customers, gift_cards, mobile, shifts
from xpos.api.invoices import create_invoice
from xpos.api.mobile_quote import quote_sale
from xpos.api.tests.mobile_fixtures import (
	CASE,
	CASHIER,
	COMPANY,
	GADGET,
	GIFT_MODE,
	MANAGER,
	PROFILE,
	RETAIL,
	STANDARD,
	WALKIN,
	WHOLE,
	WHOLESALE,
	WIDGET,
	ensure,
	ensure_user,
	setup_fixtures,
	setup_gift_cards,
)
from xpos.x_pos.gift_cards import hash_code


def sale_body(quote, customer, payments, local_id=None):
	"""The create_invoice body, built from a quote exactly as the app builds it."""
	items = [
		{
			"item_code": line["item_code"],
			"qty": line["qty"],
			"uom": line["uom"],
			"rate": line["send_rate"],
			**(
				{"discount_percentage": line["send_discount_percentage"]}
				if line["send_discount_percentage"]
				else {}
			),
			**({"discount_amount": line["send_discount_amount"]} if line["send_discount_amount"] else {}),
			**({"item_tax_template": line["item_tax_template"]} if line.get("item_tax_template") else {}),
		}
		for line in quote["lines"]
	]
	items += [{**free, "is_free_item": 1} for free in quote.get("free_lines", [])]
	body = {
		"pos_profile": PROFILE,
		"customer": customer,
		"items": items,
		"payments": payments,
		"local_id": local_id or frappe.generate_hash(length=12),
	}
	if quote.get("discount_amount"):
		body["discount_amount"] = quote["discount_amount"]
		body["apply_discount_on"] = "Grand Total"
	if quote.get("coupons_detail"):
		body["coupons_detail"] = quote["coupons_detail"]
	if quote.get("offers_detail"):
		body["offers_detail"] = quote["offers_detail"]
	return body


def cart(*rows):
	"""(item, qty, extra) tuples to quote_sale lines."""
	return [
		{"row_id": str(i), "item_code": r[0], "qty": r[1], **(r[2] if len(r) > 2 else {})}
		for i, r in enumerate(rows)
	]


class MobileTestCase(ERPNextTestSuite):
	def setUp(self):
		frappe.set_user("Administrator")
		setup_fixtures()
		for key in ("Administrator", CASHIER, MANAGER):
			frappe.cache.delete_value(gift_cards.failed_lookup_key(key))

	def tearDown(self):
		frappe.set_user("Administrator")
		super().tearDown()

	def post(self, quote, customer, local_id=None):
		"""Pay the quote in cash and post it; returns the saved invoice."""
		body = sale_body(quote, customer, [{"mode_of_payment": "Cash", "amount": quote["payable"]}], local_id)
		result = create_invoice(body)
		self.assertNotEqual(result.get("status"), "reprice_required", result)
		return frappe.get_doc("Sales Invoice", result["name"]), result


class TestCustomerPricing(MobileTestCase):
	def test_two_customers_get_different_prices(self):
		retail = quote_sale(PROFILE, cart((WIDGET, 1)), RETAIL)
		wholesale = quote_sale(PROFILE, cart((WIDGET, 1)), WHOLE)
		self.assertEqual(retail["price_list"], STANDARD)
		self.assertEqual(wholesale["price_list"], WHOLESALE)
		self.assertEqual(retail["lines"][0]["rate"], 100)
		self.assertEqual(wholesale["lines"][0]["rate"], 80)
		# the wholesale customer also carries a 5% customer discount, as the web POS applies it
		self.assertEqual(retail["payable"], 100)
		self.assertEqual(wholesale["discount_amount"], 4)
		self.assertEqual(wholesale["payable"], 76)
		self.assertNotEqual(retail["quote_id"], wholesale["quote_id"])

		for quote, customer in ((retail, RETAIL), (wholesale, WHOLE)):
			invoice, _ = self.post(quote, customer)
			self.assertEqual(invoice.selling_price_list, quote["price_list"])
			self.assertEqual(invoice.items[0].rate, quote["lines"][0]["rate"])
			self.assertEqual(invoice.grand_total, quote["grand_total"])
			self.assertEqual(invoice.discount_amount, quote["discount_amount"])
			self.assertEqual(invoice.rounded_total or invoice.grand_total, quote["payable"])

	def test_changing_the_customer_requotes_with_the_new_context(self):
		lines = cart((WIDGET, 2), (GADGET, 1))
		first = quote_sale(PROFILE, lines, RETAIL)
		second = quote_sale(PROFILE, lines, WHOLE)
		self.assertEqual(first["payable"], 400)
		# 2 x 80 + 150 = 310, less the 5% customer discount
		self.assertEqual(second["grand_total"], 294.5)
		self.assertEqual(second["discount_amount"], 15.5)
		# ERPNext rounds the total to a whole unit (half to even), and that is what is collected
		self.assertEqual(second["payable"], 294)
		self.assertNotEqual(first["quote_id"], second["quote_id"])
		self.assertEqual(second["customer"], WHOLE)

	def test_quantity_threshold_and_pricing_rule_promotion(self):
		tier = quote_sale(PROFILE, cart((WIDGET, 10)), RETAIL)
		self.assertEqual(tier["lines"][0]["rate"], 90)
		self.assertEqual(tier["payable"], 900)

		few = quote_sale(PROFILE, cart((GADGET, 2)), RETAIL)
		self.assertEqual(few["payable"], 400)
		promo = quote_sale(PROFILE, cart((GADGET, 3)), RETAIL)
		line = promo["lines"][0]
		self.assertEqual((line["price_list_rate"], line["rate"], line["discount_pct"]), (200, 180, 10))
		self.assertTrue(line["pricing_rules"])
		self.assertEqual(promo["payable"], 540)

		invoice, _ = self.post(promo, RETAIL)
		self.assertEqual(invoice.items[0].rate, 180)
		self.assertEqual(invoice.items[0].price_list_rate, 200)
		self.assertEqual(invoice.grand_total, 540)

	def test_uom_and_barcode_pricing(self):
		box = quote_sale(PROFILE, cart((CASE, 2, {"uom": "Box"})), RETAIL)
		line = box["lines"][0]
		self.assertEqual((line["uom"], line["rate"]), ("Box", 115))
		self.assertEqual(box["payable"], 230)
		invoice, _ = self.post(box, RETAIL)
		self.assertEqual(
			(invoice.items[0].uom, invoice.items[0].conversion_factor, invoice.items[0].qty), ("Box", 12, 2)
		)
		self.assertEqual(invoice.grand_total, 230)
		# a unit sold by the each price
		self.assertEqual(quote_sale(PROFILE, cart((CASE, 5)), RETAIL)["payable"], 50)

	def test_unsupported_lines_block_the_quote_instead_of_guessing(self):
		frappe.db.set_value("Item", WIDGET, "has_serial_no", 1)
		frappe.clear_cache(doctype="Item")
		quote = quote_sale(PROFILE, cart((WIDGET, 1)), RETAIL)
		self.assertEqual(len(quote["unsupported"]), 1)
		self.assertNotIn("payable", quote)
		frappe.db.set_value("Item", WIDGET, "has_serial_no", 0)

	def test_unpriced_item_is_reported_not_sold_for_nothing(self):
		ensure(
			"Item",
			"MP-NOPRICE",
			{
				"item_code": "MP-NOPRICE",
				"item_name": "x",
				"item_group": "All Item Groups",
				"stock_uom": "Nos",
				"is_stock_item": 0,
			},
		)
		quote = quote_sale(PROFILE, cart(("MP-NOPRICE", 1)), RETAIL)
		self.assertEqual(quote["price_unavailable"], ["MP-NOPRICE"])
		self.assertNotIn("payable", quote)


class TestOverrides(MobileTestCase):
	def test_cashier_cannot_discount_or_reprice(self):
		frappe.set_user(CASHIER)
		discount = quote_sale(PROFILE, cart((WIDGET, 1, {"discount_percentage": 5})), RETAIL)
		self.assertIn("not permitted to discount", discount["refusals"][0]["reason"])
		self.assertNotIn("payable", discount)
		reprice = quote_sale(PROFILE, cart((WIDGET, 1, {"rate_override": 50})), RETAIL)
		self.assertIn("not permitted to change the price", reprice["refusals"][0]["reason"])
		extra = quote_sale(PROFILE, cart((WIDGET, 1)), RETAIL, additional_discount_percentage=5)
		self.assertIn("not permitted to give an additional discount", extra["refusals"][0]["reason"])

	def test_manager_discount_within_cap_posts_and_over_cap_is_refused(self):
		frappe.set_user(MANAGER)
		ok = quote_sale(PROFILE, cart((WIDGET, 1, {"discount_percentage": 5})), RETAIL)
		self.assertEqual(ok["refusals"], [])
		self.assertEqual(ok["lines"][0]["rate"], 95)
		invoice, _ = self.post(ok, RETAIL)
		self.assertEqual(invoice.grand_total, 95)
		self.assertEqual(invoice.items[0].discount_percentage, 5)

		over = quote_sale(PROFILE, cart((WIDGET, 1, {"discount_percentage": 15})), RETAIL)
		self.assertIn("exceeds maximum allowed", over["refusals"][0]["reason"])
		self.assertNotIn("payable", over)

	def test_manager_invoice_discount_and_price_change(self):
		frappe.set_user(MANAGER)
		extra = quote_sale(PROFILE, cart((WIDGET, 1)), RETAIL, additional_discount_percentage=10)
		self.assertEqual(extra["refusals"], [])
		self.assertEqual(extra["payable"], 90)
		invoice, _ = self.post(extra, RETAIL)
		self.assertEqual(invoice.grand_total, 90)

		repriced = quote_sale(PROFILE, cart((WIDGET, 1, {"rate_override": 70})), RETAIL)
		self.assertEqual(repriced["refusals"], [])
		self.assertEqual(repriced["payable"], 70)
		invoice, _ = self.post(repriced, RETAIL)
		self.assertEqual(invoice.items[0].rate, 70)

	def test_cashier_who_posts_a_forged_discount_is_refused_by_the_server(self):
		frappe.set_user(CASHIER)
		quote = quote_sale(PROFILE, cart((WIDGET, 1)), RETAIL)
		body = sale_body(quote, RETAIL, [{"mode_of_payment": "Cash", "amount": 90}])
		body["items"][0]["rate"] = 100
		body["items"][0]["discount_percentage"] = 10
		with self.assertRaises(frappe.PermissionError):
			create_invoice(body)

	def test_manual_discount_cannot_stack_on_a_promotion(self):
		frappe.set_user(MANAGER)
		quote = quote_sale(PROFILE, cart((GADGET, 3, {"discount_percentage": 5})), RETAIL)
		self.assertIn("already has a promotion", quote["refusals"][0]["reason"])


class TestCoupons(MobileTestCase):
	def make_coupon(self, code="MP10", percent=10):
		ensure(
			"POS Offer",
			f"MP {code} offer",
			{
				"title": f"MP {code} offer",
				"description": "10 percent off the sale",
				"apply_on": "Transaction",
				"offer": "Grand Total",
				"company": COMPANY,
				"valid_from": add_days(nowdate(), -1),
				"coupon_based": 1,
				"discount_percentage": percent,
			},
		)
		offer = frappe.db.get_value("POS Offer", {"title": f"MP {code} offer"})
		ensure(
			"POS Coupon",
			f"MP {code}",
			{
				"coupon_name": f"MP {code}",
				"coupon_type": "Promotional",
				"coupon_code": code,
				"company": COMPANY,
				"pos_offer": offer,
				"maximum_use": 5,
				"valid_from": add_days(nowdate(), -1),
			},
		)

	def test_coupon_discount_is_quoted_and_posted(self):
		self.make_coupon()
		quote = quote_sale(PROFILE, cart((WIDGET, 2)), RETAIL, coupons=["MP10"])
		self.assertEqual(quote["refusals"], [])
		self.assertEqual(quote["discount_amount"], 20)
		self.assertEqual(quote["payable"], 180)
		invoice, _ = self.post(quote, RETAIL)
		self.assertEqual(invoice.grand_total, 180)
		self.assertEqual([c.coupon_code for c in invoice.coupons], ["MP10"])

	def test_bad_coupon_is_refused_with_the_reason(self):
		quote = quote_sale(PROFILE, cart((WIDGET, 1)), RETAIL, coupons=["NOPE"])
		self.assertTrue(quote["refusals"])
		self.assertNotIn("payable", quote)


class TestTaxes(MobileTestCase):
	def tax_template(self):
		account = frappe.db.get_value("Account", {"company": COMPANY, "account_type": "Tax", "is_group": 0})
		ensure(
			"Sales Taxes and Charges Template",
			"MP Tax - _TC",
			{
				"title": "MP Tax",
				"company": COMPANY,
				"taxes": [
					{"charge_type": "On Net Total", "account_head": account, "description": "Tax", "rate": 10}
				],
			},
		)

	def test_exclusive_and_inclusive_taxes_match_the_invoice(self):
		self.tax_template()
		for inclusive, total in ((0, 110), (1, 100)):
			frappe.db.set_value(
				"POS Profile", PROFILE, {"taxes_and_charges": "MP Tax - _TC", "tax_inclusive": inclusive}
			)
			frappe.clear_cache()
			quote = quote_sale(PROFILE, cart((WIDGET, 1)), RETAIL)
			self.assertEqual(quote["grand_total"], total)
			invoice, _ = self.post(quote, RETAIL)
			self.assertEqual(invoice.grand_total, total)
			self.assertEqual(invoice.total_taxes_and_charges, quote["total_taxes_and_charges"])
		frappe.db.set_value("POS Profile", PROFILE, {"taxes_and_charges": None, "tax_inclusive": 0})


class TestCustomersAndAccess(MobileTestCase):
	def test_search_returns_only_customers_the_user_may_sell_to(self):
		frappe.set_user("Administrator")
		if not frappe.db.exists(
			"User Permission", {"user": CASHIER, "allow": "Customer", "for_value": RETAIL}
		):
			frappe.get_doc(
				{"doctype": "User Permission", "user": CASHIER, "allow": "Customer", "for_value": RETAIL}
			).insert(ignore_permissions=True)
		frappe.set_user(CASHIER)
		found = {c["name"] for c in customers.search_customers_mobile(PROFILE, "MP")}
		self.assertEqual(found, {RETAIL})
		self.assertEqual({c["name"] for c in customers.get_customers("MP", 20, PROFILE)}, {RETAIL})
		with self.assertRaises(frappe.PermissionError):
			quote_sale(PROFILE, cart((WIDGET, 1)), WHOLE)
		with self.assertRaises(frappe.PermissionError):
			customers.get_customer_for_sale(PROFILE, WHOLE)
		self.assertEqual(customers.get_customer_for_sale(PROFILE, RETAIL)["name"], RETAIL)

	def test_search_is_bounded_and_matches_mobile_and_name(self):
		page = customers.search_customers_mobile(PROFILE, "MP", limit=500)
		self.assertLessEqual(len(page), customers.MAX_CUSTOMER_SEARCH)
		mobile_no = frappe.db.get_value("Customer", RETAIL, "mobile_no")
		self.assertEqual([c["name"] for c in customers.search_customers_mobile(PROFILE, mobile_no)], [RETAIL])
		row = customers.search_customers_mobile(PROFILE, WHOLE)[0]
		self.assertEqual((row["price_list"], row["discount"]), (WHOLESALE, 5))

	def test_profile_customer_groups_limit_search_and_creation(self):
		frappe.set_user("Administrator")
		pos = frappe.get_doc("POS Profile", PROFILE)
		pos.set("customer_groups", [{"customer_group": "MP Retail"}])
		pos.save(ignore_permissions=True)
		try:
			self.assertEqual(
				{c["name"] for c in customers.search_customers_mobile(PROFILE, "MP")}, {WALKIN, RETAIL}
			)
			with self.assertRaises(frappe.PermissionError):
				customers.create_customer_mobile(PROFILE, "Outside Group", "03001234567", "MP Wholesale")
		finally:
			pos.set("customer_groups", [])
			pos.save(ignore_permissions=True)

	def test_create_and_edit_customer_needs_rights_and_retries_are_safe(self):
		frappe.set_user(MANAGER)
		first = customers.create_customer_mobile(PROFILE, "New MP Person", "03111111111", "MP Retail")
		again = customers.create_customer_mobile(PROFILE, "New MP Person", "03111111111", "MP Retail")
		self.assertEqual(first["name"], again["name"])
		with self.assertRaises(frappe.ValidationError):
			customers.create_customer_mobile(PROFILE, "Someone Else", "03111111111", "MP Retail")
		edited = customers.update_customer_mobile(
			PROFILE, first["name"], {"customer_name": "Renamed MP Person", "customer_group": "MP Wholesale"}
		)
		self.assertEqual(edited["customer_name"], "Renamed MP Person")
		self.assertEqual(edited["customer_group"], "MP Retail")  # group is not editable from mobile

		with patch("xpos.api.customers.can_manage_customers", return_value=False):
			with self.assertRaises(frappe.PermissionError):
				customers.create_customer_mobile(PROFILE, "Cashier Made", "03222222222", "MP Retail")
			with self.assertRaises(frappe.PermissionError):
				customers.update_customer_mobile(PROFILE, first["name"], {"customer_name": "x"})

	def test_profile_access_and_shift_guards(self):
		ensure_user("mp-stranger@example.com", ["Sales User", "Stock User"])
		frappe.set_user("mp-stranger@example.com")
		with self.assertRaises(frappe.PermissionError):
			quote_sale(PROFILE, cart((WIDGET, 1)), RETAIL)
		with self.assertRaises(frappe.PermissionError):
			mobile.bootstrap(PROFILE)
		with self.assertRaises(frappe.PermissionError):
			shifts.open_shift(PROFILE, COMPANY, [])

	def test_returns_need_the_permission_and_the_profile_switch(self):
		body = {
			"pos_profile": PROFILE,
			"customer": RETAIL,
			"is_return": 1,
			"return_against": "NO-SUCH-INVOICE",
			"items": [{"item_code": WIDGET, "qty": -1, "rate": 100, "uom": "Nos"}],
			"payments": [],
		}
		frappe.set_user(CASHIER)
		with self.assertRaises(frappe.PermissionError):
			create_invoice(json.loads(json.dumps(body)))
		frappe.set_user(MANAGER)
		with self.assertRaises(frappe.ValidationError):  # allowed to try; the invoice it names does not exist
			create_invoice(json.loads(json.dumps(body)))
		frappe.set_user("Administrator")
		pos = frappe.get_doc("POS Profile", PROFILE)
		pos.allow_return = 0
		pos.save(ignore_permissions=True)
		frappe.set_user(MANAGER)
		with self.assertRaises(frappe.PermissionError):
			create_invoice(json.loads(json.dumps(body)))

	def test_open_shift_is_not_duplicated(self):
		frappe.set_user(CASHIER)
		first = shifts.open_shift(PROFILE, COMPANY, [{"mode_of_payment": "Cash", "opening_amount": 0}])
		again = shifts.open_shift(PROFILE, COMPANY, [{"mode_of_payment": "Cash", "opening_amount": 0}])
		self.assertEqual(first["pos_opening_shift"]["name"], again["pos_opening_shift"]["name"])

	def test_bootstrap_reports_account_and_customer_rights(self):
		frappe.set_user(CASHIER)
		info = mobile.bootstrap(PROFILE)
		self.assertEqual((info["user"], info["pos_profile"], info["customer"]), (CASHIER, PROFILE, WALKIN))
		self.assertEqual(info["customer_name"], WALKIN)
		self.assertFalse(info["permissions"]["allow_change_price"])
		frappe.set_user(MANAGER)
		self.assertTrue(mobile.bootstrap(PROFILE)["permissions"]["allow_change_price"])


class TestGiftCards(MobileTestCase):
	def setUp(self):
		super().setUp()
		setup_gift_cards()

	def issue(self, value, local_id=None):
		"""Returns (body as sent, reply). The body is serialised each time, as the app does, so a retry is byte-identical."""
		body = {
			"pos_profile": PROFILE,
			"customer": WALKIN,
			"items": [{"gift_card_issue": 1, "qty": 1, "rate": value, "uom": "Nos"}],
			"payments": [{"mode_of_payment": "Cash", "amount": value}],
			"local_id": local_id or frappe.generate_hash(length=12),
		}
		return body, create_invoice(json.loads(json.dumps(body)))

	def test_issue_redeem_and_retry_are_duplicate_safe(self):
		frappe.set_user(MANAGER)
		body, bought = self.issue(100, "mp-issue-1")
		code = bought["issued_gift_cards"][0]["code"]
		card = frappe.db.get_value(
			"Gift Card", {"code_hash": hash_code(code)}, ["name", "balance"], as_dict=True
		)
		self.assertEqual(card.balance, 100)

		# a retry of the same sale is the same invoice and the same single card
		retry = create_invoice(json.loads(json.dumps(body)))
		self.assertTrue(retry.get("duplicate"))
		self.assertEqual(retry["name"], bought["name"])
		self.assertEqual(frappe.db.count("Gift Card", {"issue_voucher": bought["name"]}), 1)

		check = gift_cards.check_gift_card(code, PROFILE)
		self.assertEqual(check["balance"], 100)
		self.assertTrue(check["masked_code"].endswith(code[-4:]))
		quote = quote_sale(PROFILE, cart((WIDGET, 1)), RETAIL)
		pay = [{"mode_of_payment": GIFT_MODE, "amount": 100, "gift_card_auth": check["auth"]}]
		spend = sale_body(quote, RETAIL, pay, "mp-spend-1")
		spent = create_invoice(json.loads(json.dumps(spend)))
		self.assertEqual(frappe.db.get_value("Gift Card", card.name, "balance"), 0)
		again = create_invoice(json.loads(json.dumps(spend)))
		self.assertTrue(again.get("duplicate"))
		self.assertEqual(frappe.db.get_value("Gift Card", card.name, "balance"), 0)
		self.assertEqual(
			frappe.db.count("Gift Card Transaction", {"gift_card": card.name, "transaction_type": "Redeem"}),
			1,
		)
		self.assertEqual(spent["gift_cards"][0]["balance_after"], 0)
		# the app never sees more than the masked code on the receipt data
		self.assertNotIn(code.replace("-", ""), frappe.as_json(spent))

	def test_cashier_without_the_permission_cannot_sell_or_redeem(self):
		frappe.set_user(CASHIER)
		with self.assertRaises(frappe.PermissionError):
			self.issue(50)
		with self.assertRaises(frappe.PermissionError):
			gift_cards.check_gift_card("AAAA-BBBB-CCCC-DDDD", PROFILE)
