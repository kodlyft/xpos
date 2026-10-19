# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

import unittest
from unittest.mock import patch

from xpos.api import tender

# LBP is quoted in whole units, USD in cents. Everything here depends on that asymmetry.
PRECISION = {"LBP": 0, "USD": 2}
USD_RATE = 90000.0
RATE_DATE = "2026-08-17"

_rounding_patch = None


def setUpModule():
	"""Give frappe.utils.flt a rounding method so it can round without a site.

	`flt(value, precision)` delegates to `rounded()`, which reads
	`frappe.get_system_settings("rounding_method")`. With no site that read raises, and `flt`
	catches broadly and returns 0.0, which would make every assertion here vacuously wrong.
	Returning None reproduces an unconfigured site: `rounded` falls back to legacy banker's
	rounding, the same behaviour production gets by default.
	"""
	global _rounding_patch
	_rounding_patch = patch("frappe.get_system_settings", return_value=None)
	_rounding_patch.start()


def tearDownModule():
	_rounding_patch.stop()


class Doc(dict):
	"""Stands in for a frappe document: dict access plus attribute access, like frappe._dict."""

	def __getattr__(self, key):
		try:
			return self[key]
		except KeyError as exc:
			raise AttributeError(key) from exc

	def __setattr__(self, key, value):
		self[key] = value


def invoice(currency="LBP", **fields):
	return Doc(currency=currency, company="Kajo", posting_date=RATE_DATE, **fields)


def fake_precision(currency):
	return PRECISION.get(currency, 2)


def fake_rate(currency, base_currency, posting_date=None, cache=None):
	if currency == base_currency:
		return 1.0, RATE_DATE
	return (USD_RATE, RATE_DATE) if currency == "USD" else (0.0, RATE_DATE)


def cash_modes(usd_type="Cash", lbp_type="Cash"):
	return {
		"Cash USD": {"currency": "USD", "type": usd_type},
		"Cash LBP": {"currency": None, "type": lbp_type},
		"Card": {"currency": None, "type": "Bank"},
	}


def tender_patches(func):
	"""Patch the three exchange helpers plus frappe and the translator.

	Applied in this order so the mocks arrive as ``(mock_frappe, mock_modes, mock_rate,
	mock_prec)``: patch passes mocks in the order the decorators are applied, and the ``_``
	patch supplies no argument because it is given a ``new``.
	"""
	func = patch("xpos.api.tender.frappe")(func)
	func = patch("xpos.api.tender._", new=lambda message: message)(func)
	func = patch("xpos.api.tender.reference_required_modes", new=lambda company: set())(func)
	func = patch("xpos.api.tender.gift_card_mode", new=lambda company: None)(func)
	func = patch("xpos.api.tender.get_mode_tender_currencies", return_value=cash_modes())(func)
	func = patch("xpos.api.tender.resolve_tender_rate", side_effect=fake_rate)(func)
	func = patch("xpos.api.tender.get_currency_precision", side_effect=fake_precision)(func)
	return func


class TestBuildTenderLegs(unittest.TestCase):
	"""Payment rows carry the invoice-currency amount plus the native figure and frozen rate."""

	@tender_patches
	def test_untagged_mode_produces_a_legacy_row(self, mock_frappe, mock_modes, mock_rate, mock_prec):
		"""Stores that do not use this feature must see byte-identical behaviour."""
		rows, total = build([{"mode_of_payment": "Cash LBP", "amount": 5892300}])

		self.assertEqual(rows, [{"mode_of_payment": "Cash LBP", "amount": 5892300.0}])
		self.assertEqual(total, 5892300.0)
		mock_rate.assert_not_called()

	@tender_patches
	def test_reference_number_rides_on_the_payment_row(self, mock_frappe, mock_modes, mock_rate, mock_prec):
		rows, _total = build(
			[
				{"mode_of_payment": "Card", "amount": 100, "reference_no": "  TRF-881  "},
				{
					"mode_of_payment": "Cash USD",
					"amount": 9000000,
					"pos_tender_amount": 100,
					"reference_no": "N1",
				},
			]
		)

		self.assertEqual(rows[0]["reference_no"], "TRF-881")
		self.assertEqual(rows[1]["reference_no"], "N1")

	@tender_patches
	def test_per_payment_mode_needs_a_reference_on_a_sale(
		self, mock_frappe, mock_modes, mock_rate, mock_prec
	):
		mock_frappe.throw.side_effect = Exception("no reference")
		with patch("xpos.api.tender.reference_required_modes", return_value={"Card"}):
			with self.assertRaises(Exception):
				build([{"mode_of_payment": "Card", "amount": 100}])
			mock_frappe.throw.reset_mock()
			rows, _total = build([{"mode_of_payment": "Card", "amount": -100}], invoice(is_return=1))

		mock_frappe.throw.assert_not_called()
		self.assertEqual(rows, [{"mode_of_payment": "Card", "amount": -100.0}])

	@tender_patches
	def test_account_and_type_are_never_emitted(self, mock_frappe, mock_modes, mock_rate, mock_prec):
		"""before_save overwrites account, and type is fetched from the master, so both are dead."""
		rows, _total = build(
			[{"mode_of_payment": "Cash LBP", "amount": 100, "account": "Cash - K", "type": "Cash"}]
		)

		self.assertNotIn("account", rows[0])
		self.assertNotIn("type", rows[0])

	@tender_patches
	def test_foreign_leg_is_converted_and_tagged(self, mock_frappe, mock_modes, mock_rate, mock_prec):
		"""$100 at 90,000 becomes 9,000,000 LBP in amount, with the native figure preserved."""
		rows, total = build([{"mode_of_payment": "Cash USD", "pos_tender_amount": 100, "amount": 9000000}])

		self.assertEqual(
			rows,
			[
				{
					"mode_of_payment": "Cash USD",
					"amount": 9000000.0,
					"pos_tender_currency": "USD",
					"pos_tender_amount": 100.0,
					"pos_exchange_rate": USD_RATE,
				}
			],
		)
		self.assertEqual(total, 9000000.0)

	@tender_patches
	def test_converted_amount_uses_invoice_precision_not_two(
		self, mock_frappe, mock_modes, mock_rate, mock_prec
	):
		"""34.53 x 90000 is 3107700.0000000005 in IEEE754; LBP has no cents to keep."""
		rows, _total = build([{"mode_of_payment": "Cash USD", "pos_tender_amount": 34.53}])

		self.assertEqual(rows[0]["amount"], 3107700.0)

	@tender_patches
	def test_native_amount_rounds_to_its_own_currency(self, mock_frappe, mock_modes, mock_rate, mock_prec):
		"""A USD leg keeps cents even though the invoice currency has none."""
		rows, _total = build([{"mode_of_payment": "Cash USD", "pos_tender_amount": 34.5349}])

		self.assertEqual(rows[0]["pos_tender_amount"], 34.53)

	@tender_patches
	def test_stale_client_rate_is_rejected(self, mock_frappe, mock_modes, mock_rate, mock_prec):
		"""The client's amount is a checksum. A mismatch means the till had an old rate."""
		mock_frappe.throw.side_effect = Exception("drift")

		with self.assertRaises(Exception):
			build([{"mode_of_payment": "Cash USD", "pos_tender_amount": 100, "amount": 8900000}])

		mock_frappe.throw.assert_called_once()

	@tender_patches
	def test_client_amount_within_one_minor_unit_is_accepted(
		self, mock_frappe, mock_modes, mock_rate, mock_prec
	):
		"""One LBP of float noise must not block a sale, but the server figure is persisted."""
		rows, _total = build([{"mode_of_payment": "Cash USD", "pos_tender_amount": 100, "amount": 8999999}])

		self.assertEqual(rows[0]["amount"], 9000000.0)
		mock_frappe.throw.assert_not_called()

	@tender_patches
	def test_missing_rate_is_refused(self, mock_frappe, mock_modes, mock_rate, mock_prec):
		"""Better to stop the sale than to value a tender leg at nothing."""
		mock_modes.return_value = {"Cash EUR": {"currency": "EUR", "type": "Cash"}}
		mock_frappe.throw.side_effect = Exception("no rate")

		with self.assertRaises(Exception):
			build([{"mode_of_payment": "Cash EUR", "pos_tender_amount": 50}])

	@tender_patches
	def test_client_supplied_currency_must_match_the_master(
		self, mock_frappe, mock_modes, mock_rate, mock_prec
	):
		"""The Mode of Payment master is authoritative; disagreement is a tamper signal."""
		mock_frappe.throw.side_effect = Exception("mismatch")

		with self.assertRaises(Exception):
			build(
				[
					{
						"mode_of_payment": "Cash USD",
						"pos_tender_currency": "EUR",
						"pos_tender_amount": 100,
					}
				]
			)

	@tender_patches
	def test_return_leg_keeps_its_negative_sign(self, mock_frappe, mock_modes, mock_rate, mock_prec):
		rows, total = build([{"mode_of_payment": "Cash USD", "pos_tender_amount": -100}])

		self.assertEqual(rows[0]["amount"], -9000000.0)
		self.assertEqual(total, -9000000.0)

	@tender_patches
	def test_zero_and_modeless_rows_are_skipped(self, mock_frappe, mock_modes, mock_rate, mock_prec):
		rows, total = build(
			[
				{"mode_of_payment": "Cash LBP", "amount": 0},
				{"mode_of_payment": "Cash USD", "pos_tender_amount": 0},
				{"mode_of_payment": None, "amount": 100},
			]
		)

		self.assertEqual(rows, [])
		self.assertEqual(total, 0.0)

	@tender_patches
	def test_two_legs_on_different_currencies_both_survive(
		self, mock_frappe, mock_modes, mock_rate, mock_prec
	):
		"""Acceptance criterion 2: $50 plus 500,000 LBP toward one invoice."""
		rows, total = build(
			[
				{"mode_of_payment": "Cash USD", "pos_tender_amount": 50},
				{"mode_of_payment": "Cash LBP", "amount": 500000},
			]
		)

		self.assertEqual(len(rows), 2)
		self.assertEqual(total, 5000000.0)


def build(payments, invoice_doc=None):
	return tender.build_tender_legs(payments, invoice_doc or invoice())


class TestBuildChangeLegs(unittest.TestCase):
	"""Change legs mirror tender legs, stored positive so consumers subtract them."""

	@tender_patches
	def test_mixed_currency_change_converts_each_leg(self, mock_frappe, mock_modes, mock_rate, mock_prec):
		rows, total = tender.build_change_legs(
			[
				{"mode_of_payment": "Cash USD", "amount": 30},
				{"mode_of_payment": "Cash LBP", "amount": 407700},
			],
			invoice(),
		)

		self.assertEqual(rows[0]["base_amount"], 2700000.0)
		self.assertEqual(rows[0]["currency"], "USD")
		self.assertEqual(rows[1]["base_amount"], 407700.0)
		self.assertEqual(rows[1]["currency"], "LBP")
		self.assertEqual(total, 3107700.0)

	@tender_patches
	def test_amounts_are_stored_positive(self, mock_frappe, mock_modes, mock_rate, mock_prec):
		"""A negative sign here would double-count against the drawer."""
		rows, total = tender.build_change_legs([{"mode_of_payment": "Cash USD", "amount": -30}], invoice())

		self.assertEqual(rows[0]["amount"], 30.0)
		self.assertEqual(total, 2700000.0)

	@tender_patches
	def test_non_cash_mode_is_refused(self, mock_frappe, mock_modes, mock_rate, mock_prec):
		"""You cannot hand back change through a card terminal."""
		mock_frappe.throw.side_effect = Exception("not cash")

		with self.assertRaises(Exception):
			tender.build_change_legs([{"mode_of_payment": "Card", "amount": 100}], invoice())

	@tender_patches
	def test_currency_must_match_the_mode(self, mock_frappe, mock_modes, mock_rate, mock_prec):
		mock_frappe.throw.side_effect = Exception("mismatch")

		with self.assertRaises(Exception):
			tender.build_change_legs(
				[{"mode_of_payment": "Cash USD", "currency": "LBP", "amount": 30}], invoice()
			)

	@tender_patches
	def test_missing_mode_is_refused(self, mock_frappe, mock_modes, mock_rate, mock_prec):
		mock_frappe.throw.side_effect = Exception("no mode")

		with self.assertRaises(Exception):
			tender.build_change_legs([{"amount": 30}], invoice())


class TestValidateTenderCurrencyLegs(unittest.TestCase):
	"""Runs after the controller, so change_amount is final by then."""

	@tender_patches
	def test_returns_and_consolidated_invoices_are_skipped(
		self, mock_frappe, mock_modes, mock_rate, mock_prec
	):
		for flag in ("is_return", "is_consolidated"):
			doc = invoice(**{flag: 1})
			doc["payments"] = [Doc(pos_tender_currency="USD", pos_tender_amount=1, pos_exchange_rate=1)]
			tender.validate_tender_currency_legs(doc)

		mock_frappe.throw.assert_not_called()

	@tender_patches
	def test_single_currency_invoice_is_untouched(self, mock_frappe, mock_modes, mock_rate, mock_prec):
		"""No tagged rows and no change legs means this feature is not in play."""
		doc = invoice(payments=[Doc(mode_of_payment="Cash LBP", amount=100)], change_amount=0)

		tender.validate_tender_currency_legs(doc)

		mock_frappe.throw.assert_not_called()

	@tender_patches
	def test_row_amount_must_match_its_native_figure_and_rate(
		self, mock_frappe, mock_modes, mock_rate, mock_prec
	):
		"""Catches a draft whose amount was edited after the rate was frozen."""
		mock_frappe.throw.side_effect = Exception("row drift")
		doc = invoice(
			payments=[
				Doc(
					idx=1,
					mode_of_payment="Cash USD",
					amount=8000000,
					pos_tender_currency="USD",
					pos_tender_amount=100,
					pos_exchange_rate=USD_RATE,
				)
			],
			change_amount=0,
		)

		with self.assertRaises(Exception):
			tender.validate_tender_currency_legs(doc)

	@tender_patches
	def test_change_legs_must_sum_to_change_amount(self, mock_frappe, mock_modes, mock_rate, mock_prec):
		mock_frappe.throw.side_effect = Exception("unallocated")
		doc = acceptance_invoice(change_amount=3107700)
		doc["pos_change_legs"] = [Doc(base_amount=2700000)]

		with self.assertRaises(Exception):
			tender.validate_tender_currency_legs(doc)

	@tender_patches
	def test_allocation_within_one_minor_unit_passes(self, mock_frappe, mock_modes, mock_rate, mock_prec):
		doc = acceptance_invoice(change_amount=3107700)
		doc["pos_change_legs"] = [Doc(base_amount=2700000), Doc(base_amount=407699)]
		mock_frappe.db.get_single_value.return_value = 1

		tender.validate_tender_currency_legs(doc)

		mock_frappe.throw.assert_not_called()


class TestChangeGlSafetyGuard(unittest.TestCase):
	"""ERPNext's skip path only posts change correctly with exactly one matching payment row."""

	@tender_patches
	def test_no_change_needs_no_guard(self, mock_frappe, mock_modes, mock_rate, mock_prec):
		tender.validate_change_gl_safety(invoice(change_amount=0))

		mock_frappe.throw.assert_not_called()

	@tender_patches
	def test_setting_enabled_is_always_safe(self, mock_frappe, mock_modes, mock_rate, mock_prec):
		"""With ledger entries on, change posts its own balanced pair regardless of row count."""
		mock_frappe.db.get_single_value.return_value = 1
		doc = invoice(
			change_amount=3107700,
			account_for_change_amount="Cash - K",
			payments=[Doc(account="Cash - K"), Doc(account="Cash - K")],
		)

		tender.validate_change_gl_safety(doc)

		mock_frappe.throw.assert_not_called()

	@tender_patches
	def test_exactly_one_matching_row_is_allowed(self, mock_frappe, mock_modes, mock_rate, mock_prec):
		mock_frappe.db.get_single_value.return_value = 0
		doc = invoice(
			change_amount=3107700,
			account_for_change_amount="Cash - K",
			payments=[Doc(account="Cash - K"), Doc(account="Card - K")],
		)

		tender.validate_change_gl_safety(doc)

		mock_frappe.throw.assert_not_called()

	@tender_patches
	def test_two_matching_rows_would_subtract_change_twice(
		self, mock_frappe, mock_modes, mock_rate, mock_prec
	):
		mock_frappe.db.get_single_value.return_value = 0
		mock_frappe.throw.side_effect = Exception("double subtraction")
		doc = invoice(
			change_amount=3107700,
			account_for_change_amount="Cash - K",
			payments=[Doc(account="Cash - K"), Doc(account="Cash - K")],
		)

		with self.assertRaises(Exception):
			tender.validate_change_gl_safety(doc)

	@tender_patches
	def test_no_matching_row_leaves_a_dangling_debtors_credit(
		self, mock_frappe, mock_modes, mock_rate, mock_prec
	):
		"""The USD-only tender case: nothing matches, so the over-credit never clears."""
		mock_frappe.db.get_single_value.return_value = 0
		mock_frappe.throw.side_effect = Exception("dangling credit")
		doc = invoice(
			change_amount=3107700,
			account_for_change_amount="Cash LBP - K",
			payments=[Doc(account="Cash USD - K")],
		)

		with self.assertRaises(Exception):
			tender.validate_change_gl_safety(doc)


def acceptance_invoice(**fields):
	"""The client's own receipt: 5,892,300 LBP settled with $100 at 90,000."""
	return invoice(
		payments=[
			Doc(
				idx=1,
				mode_of_payment="Cash USD",
				amount=9000000,
				account="Cash - K",
				pos_tender_currency="USD",
				pos_tender_amount=100,
				pos_exchange_rate=USD_RATE,
			)
		],
		account_for_change_amount="Cash - K",
		**fields,
	)


class TestAcceptanceCriterionOne(unittest.TestCase):
	"""Invoice 5,892,300 LBP; tender $100; change $30 plus 407,700 LBP; zero variance."""

	GRAND_TOTAL = 5892300.0

	@tender_patches
	def test_the_clients_receipt_reconciles_exactly(self, mock_frappe, mock_modes, mock_rate, mock_prec):
		invoice_doc = invoice()

		tender_rows, tendered = tender.build_tender_legs(
			[{"mode_of_payment": "Cash USD", "pos_tender_amount": 100, "amount": 9000000}], invoice_doc
		)
		change_rows, change_total = tender.build_change_legs(
			[
				{"mode_of_payment": "Cash USD", "amount": 30},
				{"mode_of_payment": "Cash LBP", "amount": 407700},
			],
			invoice_doc,
		)

		self.assertEqual(tendered, 9000000.0)
		self.assertEqual(change_total, 3107700.0)
		self.assertEqual(tendered - change_total, self.GRAND_TOTAL)

		# ERPNext derives change_amount as paid_amount minus the grand total.
		self.assertEqual(tendered - self.GRAND_TOTAL, change_total)

		doc = invoice(
			payments=[Doc(idx=1, account="Cash - K", **row) for row in tender_rows],
			pos_change_legs=[Doc(**row) for row in change_rows],
			change_amount=change_total,
			account_for_change_amount="Cash - K",
		)
		mock_frappe.db.get_single_value.return_value = 1

		tender.validate_tender_currency_legs(doc)

		mock_frappe.throw.assert_not_called()

	@tender_patches
	def test_net_drawer_position_is_seventy_dollars_less_the_lbp(
		self, mock_frappe, mock_modes, mock_rate, mock_prec
	):
		"""The cashier counts $70 in and 407,700 LBP out, which is the invoice total."""
		_rows, tendered_usd = tender.build_tender_legs(
			[{"mode_of_payment": "Cash USD", "pos_tender_amount": 100}], invoice()
		)
		usd_change, _usd_base = tender.build_change_legs(
			[{"mode_of_payment": "Cash USD", "amount": 30}], invoice()
		)
		lbp_change, _lbp_base = tender.build_change_legs(
			[{"mode_of_payment": "Cash LBP", "amount": 407700}], invoice()
		)

		net_usd = 100 - usd_change[0]["amount"]
		net_lbp = -lbp_change[0]["amount"]

		self.assertEqual(net_usd, 70.0)
		self.assertEqual(net_usd * USD_RATE + net_lbp, self.GRAND_TOTAL)
		self.assertEqual(tendered_usd, 9000000.0)
