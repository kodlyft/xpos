# Copyright (c) 2026, Ali Raza and Contributors
# See license.txt

import threading
from unittest.mock import patch

import frappe
from erpnext.accounts.doctype.pos_profile.test_pos_profile import make_pos_profile
from erpnext.tests.utils import ERPNextTestSuite
from frappe.utils import add_days, flt, nowdate

from xpos.api import gift_cards as api
from xpos.api.invoices import _submit_invoice_job, create_invoice, get_invoice_for_return
from xpos.api.shifts import get_shift_expected_amounts, get_shift_invoices, open_shift
from xpos.x_pos.gift_cards import (
	SETTINGS,
	DuplicateGiftCardOperation,
	GiftCardAuthError,
	add_transaction,
	get_company_setting,
	hash_code,
	issue_auth_token,
	ledger_balance,
	lock_card,
)
from xpos.x_pos.report.gift_card_liability.gift_card_liability import execute as liability_report

COMPANY = "_Test Company"
PROFILE = "_Test Gift Card Profile"
LIABILITY = "_Test Gift Card Liability - _TC"
GIFT_MODE = "_Test Gift Card"
GIFT_ITEM = "_Test Gift Card Item"
MERCH = "_Test Gift Card Merch"
BUYER = "_Test Customer"
HOLDER = "_Test Customer 1"
CASHIER = "gift-card-cashier@example.com"


def ensure(doctype, name, values):
	if not frappe.db.exists(doctype, name):
		frappe.get_doc({"doctype": doctype, **values}).insert(ignore_permissions=True)


def setup_gift_cards(company=COMPANY, profile=PROFILE):
	ensure(
		"Account",
		LIABILITY,
		{
			"account_name": "_Test Gift Card Liability",
			"parent_account": "Current Liabilities - _TC",
			"company": COMPANY,
		},
	)
	if not frappe.db.exists("Mode of Payment", GIFT_MODE):
		frappe.get_doc(
			{
				"doctype": "Mode of Payment",
				"mode_of_payment": GIFT_MODE,
				"type": "General",
				"accounts": [{"company": COMPANY, "default_account": LIABILITY}],
			}
		).insert(ignore_permissions=True)
	for code in (GIFT_ITEM, MERCH):
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
	settings = frappe.get_single(SETTINGS)
	settings.set(
		"companies",
		[
			{
				"company": COMPANY,
				"liability_account": LIABILITY,
				"mode_of_payment": GIFT_MODE,
				"issue_item": GIFT_ITEM,
				"min_amount": 1,
				"max_amount": 1000,
			}
		],
	)
	settings.save(ignore_permissions=True)

	pos = make_pos_profile(name=profile, do_not_insert=1)
	pos.append("payments", {"mode_of_payment": GIFT_MODE})
	pos.xpos_enable_gift_cards = 1
	pos.append("applicable_for_users", {"user": "Administrator", "default": 1})
	pos.insert(ignore_permissions=True)
	return pos


def sale(customer, items, payments, local_id=None, **extra):
	data = {
		"pos_profile": PROFILE,
		"customer": customer,
		"items": items,
		"payments": payments,
		"local_id": local_id or frappe.generate_hash(length=12),
	}
	data.update(extra)
	return create_invoice(data)


def merch(rate):
	return [{"item_code": MERCH, "item_name": MERCH, "qty": 1, "rate": rate, "uom": "Nos"}]


def gift_line(value):
	return [{"gift_card_issue": 1, "qty": 1, "rate": value, "uom": "Nos"}]


def cash(amount):
	return {"mode_of_payment": "Cash", "amount": amount}


def gift(code, amount):
	auth = api.check_gift_card(code, PROFILE)["auth"]
	return {"mode_of_payment": GIFT_MODE, "amount": amount, "gift_card_auth": auth}


def buy_card(value, customer=BUYER, **extra):
	result = sale(customer, gift_line(value), [cash(value)], **extra)
	return result["issued_gift_cards"][0]["code"], result


def card_of(code):
	return frappe.db.get_value(
		"Gift Card",
		{"code_hash": hash_code(code)},
		["name", "balance", "status", "issued_value"],
		as_dict=True,
	)


def gl(voucher):
	rows = frappe.get_all(
		"GL Entry",
		filters={"voucher_no": voucher, "is_cancelled": 0},
		fields=["account", "debit", "credit"],
	)
	totals = {}
	for row in rows:
		totals[row.account] = flt(totals.get(row.account, 0) + row.debit - row.credit, 2)
	return {account: amount for account, amount in totals.items() if amount}


def ledger_rows(card):
	return frappe.get_all(
		"Gift Card Transaction",
		filters={"gift_card": card},
		fields=["transaction_type", "amount", "balance_after", "voucher_no", "reverses"],
		order_by="creation asc",
	)


class GiftCardTestCase(ERPNextTestSuite):
	def setUp(self):
		frappe.set_user("Administrator")
		frappe.cache.delete_value(api.failed_lookup_key("Administrator"))
		frappe.db.set_single_value("POS Settings", "invoice_type", "Sales Invoice")
		self.pos = setup_gift_cards()


class TestGiftCardScenario(GiftCardTestCase):
	def test_walk_in_buyer_and_another_customer_spend_the_card(self):
		code, bought = buy_card(100.50)
		card = card_of(code)
		self.assertEqual((card.issued_value, card.balance, card.status), (100.50, 100.50, "Active"))
		self.assertEqual(len(code), 19)
		self.assertNotIn(
			code.replace("-", ""), frappe.as_json(frappe.get_doc("Gift Card", card.name).as_dict())
		)

		# cash in, liability up, no income recognised
		self.assertEqual(gl(bought["name"]), {"Cash - _TC": 100.50, LIABILITY: -100.50})
		invoice = frappe.get_doc("Sales Invoice", bought["name"])
		self.assertEqual(invoice.items[0].xpos_gift_card, card.name)
		self.assertFalse(invoice.taxes)

		# a different customer redeems part of it; nobody is enrolled in anything
		check = api.check_gift_card(code, PROFILE)
		self.assertEqual((check["balance"], check["masked_code"]), (100.50, f"••••-{code[-4:]}"))
		spent = sale(HOLDER, merch(30.25), [gift(code, 30.25)])
		self.assertEqual(card_of(code).balance, 70.25)
		self.assertEqual(gl(spent["name"]), {LIABILITY: 30.25, "Sales - _TC": -30.25})
		self.assertEqual(spent["gift_cards"][0]["balance_after"], 70.25)
		self.assertEqual(spent["gift_cards"][0]["masked_code"], f"••••-{code[-4:]}")

		# receipts show the card masked, with what is left on it, and never the code
		masked = f"••••-{code[-4:]}"
		for voucher in (bought["name"], spent["name"]):
			html = frappe.get_print("Sales Invoice", voucher, print_format="XPOS Thermal Receipt")
			self.assertIn(masked, html)
			self.assertNotIn(code, html)
		self.assertIn(
			"70.25", frappe.get_print("Sales Invoice", spent["name"], print_format="XPOS Thermal Receipt")
		)

		# later the rest of it, exactly to zero
		sale(HOLDER, merch(70.25), [gift(code, 70.25)])
		card = card_of(code)
		self.assertEqual((card.balance, card.status), (0, "Depleted"))
		self.assertEqual(ledger_balance(card.name), 0)
		self.assertEqual([r.transaction_type for r in ledger_rows(card.name)], ["Issue", "Redeem", "Redeem"])
		self.assertRaises(frappe.ValidationError, api.check_gift_card, code, PROFILE)

	def test_split_payment_card_plus_cash(self):
		code, _bought = buy_card(100)
		spent = sale(HOLDER, merch(120), [gift(code, 100), cash(20)])
		self.assertEqual(card_of(code).balance, 0)
		self.assertEqual(gl(spent["name"]), {LIABILITY: 100, "Cash - _TC": 20, "Sales - _TC": -120})

	def test_taxes_follow_the_merchandise_not_the_card(self):
		frappe.db.set_value(
			"POS Profile", PROFILE, "taxes_and_charges", "_Test Sales Taxes and Charges Template - _TC"
		)
		code, bought = buy_card(500)
		self.assertFalse(frappe.get_doc("Sales Invoice", bought["name"]).taxes)
		# the template charges 6.36% + 6% on the goods, which the card pays like any tender
		spent = sale(HOLDER, merch(100), [gift(code, 112.36)], local_id="tax-sale")
		invoice = frappe.get_doc("Sales Invoice", spent["name"])
		self.assertEqual(invoice.total_taxes_and_charges, 12.36)
		self.assertEqual(invoice.grand_total, 112.36)
		self.assertEqual(card_of(code).balance, 387.64)
		self.assertEqual(gl(spent["name"])[LIABILITY], 112.36)


class TestGiftCardRejections(GiftCardTestCase):
	def test_unknown_code(self):
		self.assertRaises(frappe.ValidationError, api.check_gift_card, "AAAA-BBBB-CCCC-DDDD", PROFILE)
		self.assertRaises(frappe.ValidationError, api.check_gift_card, "short", PROFILE)

	def test_overdraw(self):
		code, _bought = buy_card(50)
		self.assertRaises(frappe.ValidationError, sale, HOLDER, merch(80), [gift(code, 80)])
		self.assertEqual(card_of(code).balance, 50)

	def test_card_cannot_pay_more_than_due_or_become_change(self):
		code, _bought = buy_card(50)
		self.assertRaises(frappe.ValidationError, sale, HOLDER, merch(30), [gift(code, 40)])
		self.assertEqual(card_of(code).balance, 50)
		# change is paid out of the cash leg only
		paid = sale(HOLDER, merch(30), [gift(code, 28), cash(10)])
		self.assertEqual(paid["change_amount"], 8)
		self.assertEqual(card_of(code).balance, 22)

	def test_expired_voided_wrong_company_and_currency(self):
		code, _bought = buy_card(50)
		name = card_of(code).name
		for change in (
			{"valid_upto": add_days(nowdate(), -1)},
			{"status": "Voided"},
			{"company": "_Test Company 1"},
			{"currency": "USD"},
		):
			original = frappe.db.get_value("Gift Card", name, list(change), as_dict=True)
			frappe.db.set_value("Gift Card", name, change)
			self.assertRaises(frappe.ValidationError, api.check_gift_card, code, PROFILE)
			token = issue_auth_token(name, "Administrator", PROFILE)
			self.assertRaises(
				frappe.ValidationError,
				sale,
				HOLDER,
				merch(10),
				[{"mode_of_payment": GIFT_MODE, "amount": 10, "gift_card_auth": token}],
			)
			frappe.db.set_value("Gift Card", name, original)
		self.assertEqual(card_of(code).balance, 50)

	def test_missing_or_expired_token_is_an_offline_replay(self):
		code, _bought = buy_card(50)
		payment = gift(code, 10)
		frappe.cache.delete_value(f"xpos_gc_auth:{payment['gift_card_auth']}")
		with self.assertRaises(GiftCardAuthError):
			sale(HOLDER, merch(10), [payment])
		with self.assertRaises(GiftCardAuthError):
			sale(HOLDER, merch(10), [{"mode_of_payment": GIFT_MODE, "amount": 10}])
		self.assertEqual(card_of(code).balance, 50)

	def test_desk_invoice_cannot_name_a_card_without_a_token(self):
		code, _bought = buy_card(50)
		invoice = frappe.new_doc("Sales Invoice")
		invoice.update({"company": COMPANY, "customer": HOLDER, "is_pos": 1, "pos_profile": PROFILE})
		invoice.append("items", {"item_code": MERCH, "qty": 1, "rate": 10})
		invoice.append("payments", {"mode_of_payment": GIFT_MODE, "amount": 10})
		self.assertRaises(frappe.ValidationError, invoice.insert)
		invoice.payments[0].xpos_gift_card = card_of(code).name
		invoice.insert()
		self.assertRaises(GiftCardAuthError, invoice.submit)
		self.assertEqual(card_of(code).balance, 50)

	def test_gift_card_sale_rules(self):
		code, _bought = buy_card(50)
		self.assertRaises(frappe.ValidationError, sale, BUYER, gift_line(20) + merch(5), [cash(25)])
		self.assertRaises(frappe.ValidationError, sale, BUYER, gift_line(20), [gift(code, 20)])
		self.assertRaises(frappe.ValidationError, sale, BUYER, gift_line(5000), [cash(5000)])
		self.assertRaises(frappe.ValidationError, sale, BUYER, gift_line(20), [cash(5)])

	def test_cards_and_ledger_cannot_be_edited(self):
		code, _bought = buy_card(50)
		card = frappe.get_doc("Gift Card", card_of(code).name)
		card.balance = 5000
		self.assertRaises(frappe.ValidationError, card.save)
		txn = frappe.get_doc("Gift Card Transaction", {"gift_card": card.name})
		txn.amount = 5000
		self.assertRaises(frappe.ValidationError, txn.save)
		self.assertRaises(frappe.ValidationError, frappe.delete_doc, "Gift Card Transaction", txn.name)
		self.assertRaises(
			frappe.ValidationError,
			frappe.get_doc(
				{
					"doctype": "Gift Card Transaction",
					"gift_card": card.name,
					"company": COMPANY,
					"transaction_type": "Adjustment",
					"amount": 10,
				}
			).insert,
		)


class TestGiftCardIdempotency(GiftCardTestCase):
	def test_retried_sale_does_not_spend_twice(self):
		code, _bought = buy_card(50)
		payment = gift(code, 20)
		first = sale(HOLDER, merch(20), [payment], local_id="retry-me")
		second = sale(HOLDER, merch(20), [payment], local_id="retry-me")
		self.assertTrue(second["duplicate"])
		self.assertEqual(first["name"], second["name"])
		self.assertEqual(card_of(code).balance, 30)

	def test_retried_issue_creates_one_card(self):
		first = sale(BUYER, gift_line(40), [cash(40)], local_id="issue-once")
		second = sale(BUYER, gift_line(40), [cash(40)], local_id="issue-once")
		self.assertTrue(second["duplicate"])
		self.assertEqual(frappe.db.count("Gift Card", {"issue_voucher": first["name"]}), 1)

	def test_code_reaches_only_its_cashier_once_even_after_a_timeout(self):
		first = sale(BUYER, gift_line(25), [cash(25)], local_id="lost-response")
		code = first["issued_gift_cards"][0]["code"]
		frappe.db.after_commit.run()  # the sale commits; the response is lost on the wire

		frappe.set_user("Guest")
		self.assertEqual(api.claim_issued_gift_cards(first["name"]), [])
		frappe.set_user("Administrator")

		retry = sale(BUYER, gift_line(25), [cash(25)], local_id="lost-response")
		self.assertTrue(retry["duplicate"])
		self.assertEqual(retry["issued_gift_cards"][0]["code"], code)
		self.assertEqual(api.claim_issued_gift_cards(first["name"]), [])

	def test_operation_is_recorded_once(self):
		code, bought = buy_card(50)
		invoice = frappe.get_doc("Sales Invoice", bought["name"])
		self.assertRaises(
			DuplicateGiftCardOperation,
			add_transaction,
			lock_card(card_of(code).name),
			"Issue",
			50,
			invoice,
			invoice.items[0].name,
			f"issue:Sales Invoice:{invoice.name}:{invoice.items[0].name}",
		)

	def test_failure_after_the_ledger_write_rolls_everything_back(self):
		code, _bought = buy_card(50)
		payment = gift(code, 20)
		frappe.db.savepoint("before_sale")
		with patch(
			"xpos.x_pos.api.invoice.fiscalize_invoice", side_effect=frappe.ValidationError("FBR down")
		):
			self.assertRaises(frappe.ValidationError, sale, HOLDER, merch(20), [payment], local_id="fails")
		frappe.db.rollback(save_point="before_sale")
		self.assertEqual(card_of(code).balance, 50)
		self.assertEqual(len(ledger_rows(card_of(code).name)), 1)
		self.assertFalse(frappe.db.exists("Sales Invoice", {"xpos_local_id": "fails"}))
		# the same tender then goes through
		sale(HOLDER, merch(20), [payment], local_id="fails")
		self.assertEqual(card_of(code).balance, 30)

	def test_drafts_do_not_spend_until_submitted_on_any_path(self):
		code, _bought = buy_card(50)
		card = card_of(code).name
		invoice = frappe.new_doc("Sales Invoice")
		invoice.update({"company": COMPANY, "customer": HOLDER, "is_pos": 1, "pos_profile": PROFILE})
		invoice.append("items", {"item_code": MERCH, "qty": 1, "rate": 15})
		invoice.append(
			"payments",
			{
				"mode_of_payment": GIFT_MODE,
				"amount": 15,
				"xpos_gift_card": card,
				"xpos_gift_card_auth": issue_auth_token(card, "Administrator", PROFILE),
			},
		)
		invoice.insert()
		self.assertEqual(card_of(code).balance, 50)
		# the background submit job runs the same hooks in its own transaction
		with patch("xpos.api.invoices.frappe.db.commit"):
			_submit_invoice_job(invoice.name)
		self.assertEqual(card_of(code).balance, 35)


class TestGiftCardReversals(GiftCardTestCase):
	def test_cancelled_sale_gives_the_value_back_once(self):
		code, _bought = buy_card(50)
		spent = sale(HOLDER, merch(20), [gift(code, 20)])
		invoice = frappe.get_doc("Sales Invoice", spent["name"])
		invoice.cancel()
		card = card_of(code)
		self.assertEqual(card.balance, 50)
		rows = ledger_rows(card.name)
		self.assertEqual([r.transaction_type for r in rows], ["Issue", "Redeem", "Refund"])
		self.assertTrue(rows[2].reverses)
		self.assertEqual(gl(spent["name"]), {})

	def test_returns_are_capped_by_what_the_card_paid(self):
		code, _bought = buy_card(100)
		two = [{"item_code": MERCH, "item_name": MERCH, "qty": 2, "rate": 30, "uom": "Nos"}]
		spent = sale(HOLDER, two, [gift(code, 40), cash(20)])
		card = card_of(code).name
		original = get_invoice_for_return(spent["name"])
		self.assertEqual([p["gift_card"] for p in original["payments"] if p["gift_card"]], [card])
		self.assertEqual(original["gift_card_refunds"][0]["amount"], 40)

		def refund(to_card, to_cash=0, local_id=None):
			payments = [{"mode_of_payment": GIFT_MODE, "amount": -to_card, "gift_card": card}]
			if to_cash:
				payments.append(cash(-to_cash))
			return sale(
				HOLDER,
				[{"item_code": MERCH, "qty": -1, "rate": 30, "uom": "Nos"}],
				payments,
				local_id=local_id,
				is_return=1,
				return_against=spent["name"],
			)

		# the card paid 40, so one 30 unit cannot put 50 back on it
		self.assertRaises(frappe.ValidationError, refund, 50, -20)
		first = refund(30)
		self.assertEqual(card_of(code).balance, 90)
		# only 10 of the card's 40 is left to give back
		self.assertRaises(frappe.ValidationError, refund, 20, 10)
		refund(10, 20)
		self.assertEqual(card_of(code).balance, 100)
		self.assertEqual(get_invoice_for_return(spent["name"])["gift_card_refunds"], [])
		self.assertEqual(gl(first["name"]), {LIABILITY: -30, "Sales - _TC": 30})

		# cancelling a return takes the refund back off the card, exactly once
		frappe.get_doc("Sales Invoice", first["name"]).cancel()
		self.assertEqual(card_of(code).balance, 70)

	def test_sold_card_can_be_voided_only_while_unused(self):
		code, bought = buy_card(40)
		frappe.get_doc("Sales Invoice", bought["name"]).cancel()
		self.assertEqual(card_of(code).status, "Voided")
		self.assertEqual(card_of(code).balance, 0)
		self.assertRaises(frappe.ValidationError, api.check_gift_card, code, PROFILE)

		code, bought = buy_card(40)
		spent = sale(HOLDER, merch(10), [gift(code, 10)])
		self.assertRaises(frappe.ValidationError, frappe.get_doc("Sales Invoice", bought["name"]).cancel)
		self.assertEqual(card_of(code).balance, 30)

		# once every spend is reversed the card holds its full value again and may be voided
		frappe.get_doc("Sales Invoice", spent["name"]).cancel()
		frappe.get_doc("Sales Invoice", bought["name"]).cancel()
		self.assertEqual(card_of(code).status, "Voided")

	def test_returning_an_unused_card_refunds_the_buyer(self):
		code, bought = buy_card(40)
		card = card_of(code).name
		returned = sale(
			BUYER,
			[{"item_code": GIFT_ITEM, "qty": -1, "rate": 40, "uom": "Nos", "gift_card": card}],
			[cash(-40)],
			is_return=1,
			return_against=bought["name"],
		)
		self.assertEqual(card_of(code).status, "Voided")
		self.assertEqual(gl(returned["name"]), {"Cash - _TC": -40, LIABILITY: 40})

	def test_adjustment_needs_a_journal_entry_on_the_liability(self):
		code, _bought = buy_card(40)
		card = card_of(code).name
		je = frappe.get_doc(
			{
				"doctype": "Journal Entry",
				"company": COMPANY,
				"posting_date": nowdate(),
				"accounts": [
					{"account": LIABILITY, "debit_in_account_currency": 5},
					{
						"account": "_Test Account Cost for Goods Sold - _TC",
						"credit_in_account_currency": 5,
						"cost_center": "_Test Cost Center - _TC",
					},
				],
			}
		).insert()
		self.assertRaises(frappe.ValidationError, api.adjust_gift_card, card, je.name)
		je.submit()
		api.adjust_gift_card(card, je.name, "damaged card")
		self.assertEqual(card_of(code).balance, 35)
		self.assertRaises(frappe.ValidationError, api.adjust_gift_card, card, je.name)


class TestGiftCardReporting(GiftCardTestCase):
	def test_ledger_reconciles_to_gl_and_shift_cash(self):
		shift = open_shift(PROFILE, COMPANY, [{"mode_of_payment": "Cash", "opening_amount": 10}])[
			"pos_opening_shift"
		]["name"]
		code, _bought = buy_card(100, customer=BUYER)
		frappe.db.set_value("Sales Invoice", _bought["name"], "pos_opening_shift", shift)
		spent = sale(HOLDER, merch(120), [gift(code, 100), cash(20)], pos_opening_shift=shift)
		sale(
			HOLDER,
			[{"item_code": MERCH, "qty": -1, "rate": 120, "uom": "Nos"}],
			[{"mode_of_payment": GIFT_MODE, "amount": -100, "gift_card": card_of(code).name}, cash(-20)],
			is_return=1,
			return_against=spent["name"],
			pos_opening_shift=shift,
		)

		opening_doc = frappe.get_doc("POS Opening Shift", shift)
		invoices = get_shift_invoices(opening_doc, "Sales Invoice", ["name", "change_amount", "currency"])
		expected = get_shift_expected_amounts(opening_doc, "Sales Invoice", invoices)
		# the card was sold for cash: that cash is in the till; spending it added none
		self.assertEqual(flt(expected["Cash"]["amount"]), 110)
		self.assertEqual(flt(expected[GIFT_MODE]["amount"]), 0)

		result = liability_report({"company": COMPANY})
		summary = {row["label"]: row["value"] for row in result[4]}
		row = next(r for r in result[1] if r["gift_card"] == card_of(code).name)
		self.assertEqual(
			(row["issue"], row["redeem"], row["refund"], row["outstanding"]), (100, -100, 100, 100)
		)
		self.assertEqual(flt(summary["Ledger outstanding"]), flt(summary["GL balance"]))
		self.assertEqual(flt(summary["Difference"]), 0)


class TestGiftCardOnPOSInvoice(GiftCardTestCase):
	def setUp(self):
		super().setUp()
		frappe.db.set_single_value("POS Settings", "invoice_type", "POS Invoice")
		self.shift = open_shift(PROFILE, COMPANY, [{"mode_of_payment": "Cash", "opening_amount": 0}])[
			"pos_opening_shift"
		]["name"]

	def test_consolidation_posts_the_gl_once_and_leaves_the_card_alone(self):
		code, bought = buy_card(100, customer=HOLDER, pos_opening_shift=self.shift)
		spent = sale(HOLDER, merch(60), [gift(code, 60)], pos_opening_shift=self.shift)
		self.assertEqual(card_of(code).balance, 40)
		self.assertEqual(gl(spent["name"]), {})

		pos_invoice = frappe.get_doc("POS Invoice", spent["name"])
		merge_log = frappe.new_doc("POS Invoice Merge Log")
		merge_log.update(
			{
				"posting_date": pos_invoice.posting_date,
				"posting_time": pos_invoice.posting_time,
				"company": COMPANY,
				"customer": pos_invoice.customer,
			}
		)
		for name in (bought["name"], spent["name"]):
			doc = frappe.get_doc("POS Invoice", name)
			merge_log.append(
				"pos_invoices",
				{
					"pos_invoice": name,
					"posting_date": doc.posting_date,
					"grand_total": doc.grand_total,
					"customer": doc.customer,
				},
			)
		merge_log.insert()
		merge_log.submit()

		pos_invoice.reload()
		consolidated = pos_invoice.consolidated_invoice
		self.assertTrue(consolidated)
		self.assertEqual(card_of(code).balance, 40)
		self.assertEqual(len(ledger_rows(card_of(code).name)), 2)
		liability = frappe.db.sql(
			"select sum(credit) - sum(debit) from `tabGL Entry` where account=%s and voucher_no=%s and is_cancelled=0",
			(LIABILITY, consolidated),
		)[0][0]
		self.assertEqual(flt(liability), 40)  # 100 issued less 60 spent, posted once

		merge_log.cancel()
		self.assertEqual(card_of(code).balance, 40)

	def test_cancelled_pos_invoice_gives_the_value_back(self):
		code, _bought = buy_card(50, customer=HOLDER, pos_opening_shift=self.shift)
		spent = sale(HOLDER, merch(20), [gift(code, 20)], pos_opening_shift=self.shift)
		self.assertEqual(card_of(code).balance, 30)
		frappe.get_doc("POS Invoice", spent["name"]).cancel()
		self.assertEqual(card_of(code).balance, 50)


class TestGiftCardAccess(GiftCardTestCase):
	def setUp(self):
		super().setUp()
		if not frappe.db.exists("User", CASHIER):
			frappe.get_doc(
				{
					"doctype": "User",
					"email": CASHIER,
					"first_name": "Gift Cashier",
					"send_welcome_email": 0,
					"roles": [{"role": "Sales User"}],
				}
			).insert(ignore_permissions=True)
		self.code, _bought = buy_card(50)

	def as_cashier(self, fn, *args):
		frappe.set_user(CASHIER)
		try:
			return fn(*args)
		finally:
			frappe.set_user("Administrator")

	def test_user_not_on_profile_or_without_permission_is_refused(self):
		self.assertRaises(frappe.PermissionError, self.as_cashier, api.check_gift_card, self.code, PROFILE)
		profile = frappe.get_doc("POS Profile", PROFILE)
		profile.append("applicable_for_users", {"user": CASHIER, "pos_role": "Cashier"})
		profile.save()
		self.assertRaises(frappe.PermissionError, self.as_cashier, api.check_gift_card, self.code, PROFILE)
		self.assertRaises(frappe.PermissionError, self.as_cashier, sale, BUYER, gift_line(20), [cash(20)])
		self.assertRaises(
			frappe.PermissionError, self.as_cashier, api.adjust_gift_card, card_of(self.code).name, "x"
		)

		role = frappe.get_doc("POS Role", "Cashier")
		for row in role.permissions:
			if row.permission == "redeem_gift_card":
				row.enabled = 1
		role.save()
		from xpos.api.auth import clear_role_permission_cache

		clear_role_permission_cache()
		self.assertEqual(self.as_cashier(api.check_gift_card, self.code, PROFILE)["balance"], 50)

	def test_profile_without_gift_cards_is_refused(self):
		frappe.db.set_value("POS Profile", PROFILE, "xpos_enable_gift_cards", 0)
		self.assertRaises(frappe.PermissionError, api.check_gift_card, self.code, PROFILE)

	def test_token_is_bound_to_its_cashier(self):
		payment = gift(self.code, 10)
		invoice = frappe.new_doc("Sales Invoice")
		invoice.update({"company": COMPANY, "customer": HOLDER, "is_pos": 1, "pos_profile": PROFILE})
		invoice.append("items", {"item_code": MERCH, "qty": 1, "rate": 10})
		invoice.append(
			"payments",
			{
				"mode_of_payment": GIFT_MODE,
				"amount": 10,
				"xpos_gift_card": card_of(self.code).name,
				"xpos_gift_card_auth": payment["gift_card_auth"],
			},
		)
		invoice.insert()
		invoice.flags.ignore_permissions = True
		frappe.set_user(CASHIER)
		try:
			self.assertRaises(GiftCardAuthError, invoice.submit)
		finally:
			frappe.set_user("Administrator")

	def test_failed_lookups_lock_the_cashier_out(self):
		frappe.cache.delete_value(api.failed_lookup_key("Administrator"))
		for _ in range(api.MAX_FAILED_LOOKUPS):
			self.assertRaises(frappe.ValidationError, api.check_gift_card, "AAAA-BBBB-CCCC-DDDD", PROFILE)
		self.assertRaises(frappe.RateLimitExceededError, api.check_gift_card, self.code, PROFILE)
		frappe.cache.delete_value(api.failed_lookup_key("Administrator"))


class TestConcurrentGiftCardRedemption(ERPNextTestSuite):
	"""Two terminals spending the last of one card. These tests commit; everything is removed after."""

	def setUp(self):
		frappe.db.rollback()
		frappe.set_user("Administrator")
		frappe.db.set_single_value("POS Settings", "invoice_type", "Sales Invoice")
		if not frappe.db.exists("POS Profile", PROFILE) or not get_company_setting(COMPANY):
			setup_gift_cards()
		frappe.db.commit()  # nosemgrep
		self.invoices = []
		self.addCleanup(self.remove_committed_records)

	def remove_committed_records(self):
		frappe.db.rollback()
		frappe.set_user("Administrator")
		frappe.db.set_single_value("Accounts Settings", "delete_linked_ledger_entries", 1)
		cards = set()
		for name in reversed(self.invoices):
			invoice = frappe.get_doc("Sales Invoice", name)
			cards.update(i.xpos_gift_card for i in invoice.items if i.xpos_gift_card)
			if invoice.docstatus == 1:
				invoice.cancel()
		frappe.flags.xpos_purge_gift_cards = True
		try:
			for card in cards:
				for txn in frappe.get_all("Gift Card Transaction", {"gift_card": card}, pluck="name"):
					frappe.delete_doc("Gift Card Transaction", txn, force=True, ignore_permissions=True)
				frappe.delete_doc("Gift Card", card, force=True, ignore_permissions=True)
			for name in self.invoices:
				frappe.delete_doc("Sales Invoice", name, force=True)
		finally:
			frappe.flags.xpos_purge_gift_cards = False
		frappe.db.set_single_value("Accounts Settings", "delete_linked_ledger_entries", 0)
		frappe.db.commit()  # nosemgrep

	def draft(self, card, amount):
		invoice = frappe.new_doc("Sales Invoice")
		invoice.update({"company": COMPANY, "customer": HOLDER, "is_pos": 1, "pos_profile": PROFILE})
		invoice.append("items", {"item_code": MERCH, "qty": 1, "rate": amount})
		invoice.append(
			"payments",
			{
				"mode_of_payment": GIFT_MODE,
				"amount": amount,
				"xpos_gift_card": card,
				"xpos_gift_card_auth": issue_auth_token(card, "Administrator", PROFILE),
			},
		)
		invoice.insert()
		self.invoices.append(invoice.name)
		return invoice.name

	def test_last_balance_cannot_be_spent_twice(self):
		code, bought = buy_card(30)
		self.invoices.append(bought["name"])
		card = card_of(code).name
		first, second = self.draft(card, 30), self.draft(card, 30)
		frappe.db.commit()  # nosemgrep

		site = frappe.local.site
		first_locked = threading.Event()
		outcome = {}

		def session(name, work):
			frappe.init(site)
			frappe.connect()
			frappe.set_user("Administrator")
			frappe.flags.in_test = True
			try:
				work()
				frappe.db.commit()  # nosemgrep
				outcome[name] = None
			except Exception as error:
				frappe.db.rollback()
				outcome[name] = error
			finally:
				first_locked.set()
				frappe.destroy()

		def submit_first():
			frappe.get_doc("Sales Invoice", first).submit()
			first_locked.set()
			# hold the card lock while the other terminal tries
			threading.Event().wait(1.5)

		def submit_second():
			invoice = frappe.get_doc("Sales Invoice", second)
			first_locked.wait(30)
			invoice.submit()

		threads = [
			threading.Thread(target=session, args=("first", submit_first)),
			threading.Thread(target=session, args=("second", submit_second)),
		]
		for thread in threads:
			thread.start()
		for thread in threads:
			thread.join(120)
		frappe.db.rollback()

		self.assertIsNone(outcome["first"])
		self.assertIsInstance(outcome["second"], frappe.ValidationError)
		self.assertEqual(
			frappe.db.count("Sales Invoice", {"name": ("in", [first, second]), "docstatus": 1}), 1
		)
		self.assertEqual(card_of(code).balance, 0)
		self.assertEqual(ledger_balance(card), 0)
