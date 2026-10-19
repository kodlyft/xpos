# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from xpos.api import shifts


class TestGetOpeningData(unittest.TestCase):
	"""Tests for get_opening_data function."""

	@patch("xpos.api.shifts.frappe")
	def test_get_opening_data_returns_pos_profiles_for_user(self, mock_frappe):
		"""Test that get_opening_data returns POS profiles assigned to user."""
		mock_frappe.session.user = "cashier@test.com"
		mock_frappe.db.sql.return_value = [
			{
				"name": "POS-PROFILE-1",
				"company": "Test Company",
				"currency": "USD",
				"warehouse": "Store - TC",
			}
		]
		mock_frappe.get_list.return_value = [
			{"parent": "POS-PROFILE-1", "mode_of_payment": "Cash", "default": 1}
		]

		result = shifts.get_opening_data()

		self.assertIn("pos_profiles", result)
		self.assertIn("companies", result)
		self.assertIn("payment_methods", result)
		self.assertEqual(len(result["pos_profiles"]), 1)
		self.assertEqual(result["pos_profiles"][0]["name"], "POS-PROFILE-1")

	@patch("xpos.api.shifts.frappe")
	def test_get_opening_data_returns_empty_when_no_profiles(self, mock_frappe):
		"""Test that get_opening_data returns empty lists when user has no profiles."""
		mock_frappe.session.user = "newuser@test.com"
		mock_frappe.db.sql.return_value = []

		result = shifts.get_opening_data()

		self.assertEqual(result["pos_profiles"], [])
		self.assertEqual(result["companies"], [])
		self.assertEqual(result["payment_methods"], [])

	@patch("xpos.api.shifts.frappe")
	def test_get_opening_data_extracts_unique_companies(self, mock_frappe):
		"""Test that companies are deduplicated from multiple profiles."""
		mock_frappe.session.user = "cashier@test.com"
		mock_frappe.db.sql.return_value = [
			{"name": "POS-PROFILE-1", "company": "Test Company 1", "currency": "USD", "warehouse": "W1"},
			{"name": "POS-PROFILE-2", "company": "Test Company 1", "currency": "USD", "warehouse": "W2"},
			{"name": "POS-PROFILE-3", "company": "Test Company 2", "currency": "EUR", "warehouse": "W3"},
		]
		mock_frappe.get_list.return_value = []

		result = shifts.get_opening_data()

		company_names = [c["name"] for c in result["companies"]]
		self.assertEqual(len(company_names), 2)
		self.assertIn("Test Company 1", company_names)
		self.assertIn("Test Company 2", company_names)


class TestOpenShift(unittest.TestCase):
	"""Tests for open_shift function."""

	@patch("xpos.api.shifts._enrich_shift_data")
	@patch("xpos.api.shifts.frappe")
	def test_open_shift_creates_new_shift(self, mock_frappe, mock_enrich):
		"""Test that open_shift creates a new POS Opening Shift."""
		mock_shift_doc = MagicMock()
		mock_shift_doc.as_dict.return_value = {"name": "POS-OPEN-001"}
		mock_frappe.get_doc.return_value = mock_shift_doc
		mock_frappe.session.user = "cashier@test.com"

		result = shifts.open_shift(
			pos_profile="POS-PROFILE-1",
			company="Test Company",
			balance_details='[{"mode_of_payment": "Cash", "opening_amount": 100}]',
		)

		mock_frappe.get_doc.assert_called_once()
		mock_shift_doc.insert.assert_called_once_with(ignore_permissions=True)
		self.assertIn("pos_opening_shift", result)

	@patch("xpos.api.shifts._enrich_shift_data")
	@patch("xpos.api.shifts.frappe")
	def test_open_shift_handles_empty_balance(self, mock_frappe, mock_enrich):
		"""Test that open_shift works with no balance details."""
		mock_shift_doc = MagicMock()
		mock_shift_doc.as_dict.return_value = {"name": "POS-OPEN-002"}
		mock_frappe.get_doc.return_value = mock_shift_doc
		mock_frappe.session.user = "cashier@test.com"

		result = shifts.open_shift(
			pos_profile="POS-PROFILE-1",
			company="Test Company",
			balance_details="[]",
		)

		self.assertIn("pos_opening_shift", result)


class TestCheckOpenShift(unittest.TestCase):
	"""Tests for check_open_shift function."""

	@patch("xpos.api.shifts._enrich_shift_data")
	@patch("xpos.api.shifts.frappe")
	def test_check_open_shift_returns_existing_shift(self, mock_frappe, mock_enrich):
		"""Test that check_open_shift returns active shift for user."""
		mock_frappe.session.user = "cashier@test.com"
		mock_frappe.db.get_all.return_value = [
			{"name": "POS-OPEN-001", "pos_profile": "POS-PROFILE-1", "company": "Test Company"}
		]
		mock_shift_doc = MagicMock()
		mock_shift_doc.as_dict.return_value = {"name": "POS-OPEN-001"}
		mock_frappe.get_doc.return_value = mock_shift_doc

		result = shifts.check_open_shift()

		self.assertIsNotNone(result)
		self.assertIn("pos_opening_shift", result)

	@patch("xpos.api.shifts.frappe")
	def test_check_open_shift_returns_none_when_no_active_shift(self, mock_frappe):
		"""Test that check_open_shift returns None when no active shift."""
		mock_frappe.session.user = "cashier@test.com"
		mock_frappe.db.get_all.return_value = []

		result = shifts.check_open_shift()

		self.assertIsNone(result)

	@patch("xpos.api.shifts._enrich_shift_data")
	@patch("xpos.api.shifts.frappe")
	def test_check_open_shift_uses_provided_user(self, mock_frappe, mock_enrich):
		"""Test that check_open_shift can check for specific user."""
		mock_frappe.db.get_all.return_value = [
			{"name": "POS-OPEN-003", "pos_profile": "POS-PROFILE-2", "company": "Test Company"}
		]
		mock_shift_doc = MagicMock()
		mock_shift_doc.as_dict.return_value = {"name": "POS-OPEN-003"}
		mock_frappe.get_doc.return_value = mock_shift_doc

		shifts.check_open_shift(user="manager@test.com")

		mock_frappe.db.get_all.assert_called_once()
		call_args = mock_frappe.db.get_all.call_args
		self.assertEqual(call_args.kwargs["filters"]["user"], "manager@test.com")
		self.assertEqual(
			call_args.kwargs["or_filters"],
			[
				{"pos_closing_shift": ["is", "not set"]},
				{"pos_closing_shift": ""},
			],
		)


class MigratedSchemaMixin:
	"""Pretend the tender columns and the change leg table have been migrated.

	Both guards call ``frappe.db`` through ``xpos.api.exchange``, which patching
	``xpos.api.shifts.frappe`` does not reach, so they are replaced by name instead.
	"""

	def setUp(self):
		super().setUp()
		schema = patch.multiple(
			"xpos.api.shifts",
			payment_tender_fields_exist=lambda: True,
			change_leg_table_exists=lambda: True,
		)
		schema.start()
		self.addCleanup(schema.stop)


class TestShiftPaymentTotals(MigratedSchemaMixin, unittest.TestCase):
	"""Per-mode drawer totals, each denominated in that mode's own tender currency."""

	@patch("xpos.api.shifts.frappe")
	def test_tagged_rows_report_their_native_amount(self, mock_frappe):
		"""The canonical receipt: $100 in, $30 + 407,700 LBP out, so the drawer nets +$70."""
		mock_frappe.get_all.side_effect = [
			[
				{
					"parent": "INV-001",
					"mode_of_payment": "Cash USD",
					"amount": 9000000,
					"pos_tender_currency": "USD",
					"pos_tender_amount": 100,
				}
			],
			[
				{"parent": "INV-001", "mode_of_payment": "Cash USD", "currency": "USD", "amount": 30},
				{
					"parent": "INV-001",
					"mode_of_payment": "Cash LBP",
					"currency": "LBP",
					"amount": 407700,
				},
			],
		]

		totals = shifts.get_shift_payment_totals(
			"Sales Invoice",
			[{"name": "INV-001", "currency": "LBP", "change_amount": 3107700}],
		)

		self.assertEqual(totals["Cash USD"], {"amount": 70.0, "currency": "USD"})
		self.assertEqual(totals["Cash LBP"], {"amount": -407700.0, "currency": "LBP"})

	@patch("xpos.api.shifts.frappe")
	def test_untagged_rows_report_the_invoice_currency(self, mock_frappe):
		"""An untagged mode is collected in whatever currency the invoice is denominated in."""
		mock_frappe.get_all.side_effect = [
			[{"parent": "INV-001", "mode_of_payment": "Card", "amount": 250}],
			[],
		]

		totals = shifts.get_shift_payment_totals(
			"Sales Invoice", [{"name": "INV-001", "currency": "LBP", "change_amount": 0}]
		)

		self.assertEqual(totals["Card"], {"amount": 250.0, "currency": "LBP"})

	@patch("xpos.api.shifts.frappe")
	def test_change_legs_subtract_from_their_own_mode(self, mock_frappe):
		"""Change comes off the mode that handed it back, not off every mode used."""
		mock_frappe.get_all.side_effect = [
			[
				{"parent": "INV-001", "mode_of_payment": "Card", "amount": 300},
				{"parent": "INV-001", "mode_of_payment": "Cash", "amount": 700},
			],
			[{"parent": "INV-001", "mode_of_payment": "Cash", "currency": "LBP", "amount": 100}],
		]

		totals = shifts.get_shift_payment_totals(
			"Sales Invoice", [{"name": "INV-001", "currency": "LBP", "change_amount": 100}], "Cash"
		)

		self.assertEqual(totals["Card"]["amount"], 300)
		self.assertEqual(totals["Cash"]["amount"], 600)

	@patch("xpos.api.shifts.frappe")
	def test_legacy_change_comes_off_the_cash_mode_only(self, mock_frappe):
		"""With no legs the whole change leaves the cash drawer, never the card terminal.

		The old pro-ration would have charged the card 30 of this 100.
		"""
		mock_frappe.get_all.side_effect = [
			[
				{"parent": "INV-001", "mode_of_payment": "Card", "amount": 300},
				{"parent": "INV-001", "mode_of_payment": "Cash", "amount": 700},
			],
			[],
		]

		totals = shifts.get_shift_payment_totals(
			"Sales Invoice", [{"name": "INV-001", "currency": "LBP", "change_amount": 100}], "Cash"
		)

		self.assertEqual(totals["Card"]["amount"], 300)
		self.assertEqual(totals["Cash"]["amount"], 600)

	@patch("xpos.api.shifts.frappe")
	def test_single_cash_mode_matches_the_old_proration(self, mock_frappe):
		"""A one-mode invoice is arithmetically unchanged by dropping the pro-ration."""
		mock_frappe.get_all.side_effect = [
			[{"parent": "INV-001", "mode_of_payment": "Cash", "amount": 500}],
			[],
		]

		totals = shifts.get_shift_payment_totals(
			"Sales Invoice", [{"name": "INV-001", "currency": "LBP", "change_amount": 100}], "Cash"
		)

		# Old formula: 500 - 500 / 500 * 100.
		self.assertEqual(totals["Cash"]["amount"], 400)

	@patch("xpos.api.shifts.frappe")
	def test_legacy_change_falls_back_to_the_only_mode_used(self, mock_frappe):
		"""When the profile's cash mode was not used, a sole payment mode gave the change."""
		mock_frappe.get_all.side_effect = [
			[{"parent": "INV-001", "mode_of_payment": "Cash Drawer", "amount": 500}],
			[],
		]

		totals = shifts.get_shift_payment_totals(
			"Sales Invoice", [{"name": "INV-001", "currency": "LBP", "change_amount": 100}], "Cash"
		)

		self.assertEqual(totals, {"Cash Drawer": {"amount": 400.0, "currency": "LBP"}})

	@patch("xpos.api.shifts.frappe")
	def test_payment_totals_use_one_query_per_child_table(self, mock_frappe):
		"""Rows are fetched in one query each, not one query per invoice."""
		mock_frappe.get_all.side_effect = [
			[
				{"parent": "INV-001", "mode_of_payment": "Cash", "amount": 100},
				{"parent": "INV-002", "mode_of_payment": "Cash", "amount": 200},
				{"parent": "INV-003", "mode_of_payment": "Card", "amount": 300},
			],
			[],
		]

		totals = shifts.get_shift_payment_totals(
			"Sales Invoice",
			[
				{"name": "INV-001", "currency": "LBP", "change_amount": 0},
				{"name": "INV-002", "currency": "LBP", "change_amount": 0},
				{"name": "INV-003", "currency": "LBP", "change_amount": 0},
			],
		)

		self.assertEqual(mock_frappe.get_all.call_count, 2)
		self.assertEqual(
			totals,
			{
				"Cash": {"amount": 300.0, "currency": "LBP"},
				"Card": {"amount": 300.0, "currency": "LBP"},
			},
		)


class TestShiftExpectedAmounts(MigratedSchemaMixin, unittest.TestCase):
	"""Tests that shift reconciliation figures are derived server-side."""

	@staticmethod
	def _opening(balance_details):
		opening = MagicMock()
		opening.name = "POS-OPEN-001"
		opening.pos_profile = "POS-PROFILE-1"
		opening.balance_details = [
			SimpleNamespace(mode_of_payment=mode, amount=amount, currency=currency)
			for mode, amount, currency in balance_details
		]
		return opening

	@patch("xpos.api.shifts.frappe")
	def test_expected_amount_deducts_cash_movements(self, mock_frappe):
		"""Cash taken out of the drawer lowers the expected cash on hand."""
		mock_frappe.get_all.side_effect = [
			[{"parent": "INV-001", "mode_of_payment": "Cash", "amount": 1000}],  # payments
			[],  # POS Change Leg
			[{"amount": 250}, {"amount": 150}],  # POS Cash Movement
		]
		mock_frappe.db.get_value.return_value = "Cash"

		expected = shifts.get_shift_expected_amounts(
			self._opening([("Cash", 500, "LBP")]),
			"Sales Invoice",
			[{"name": "INV-001", "currency": "LBP", "change_amount": 0}],
		)

		# 500 opening float + 1000 collected - 400 moved out
		self.assertEqual(expected["Cash"], {"amount": 1100.0, "currency": "LBP"})

	@patch("xpos.api.shifts.frappe")
	def test_expected_amount_includes_opening_float_for_unused_modes(self, mock_frappe):
		"""A mode with an opening float but no sales still reports that float."""
		mock_frappe.get_all.side_effect = [[], []]
		mock_frappe.db.get_value.return_value = "Cash LBP"

		expected = shifts.get_shift_expected_amounts(
			self._opening([("Cash LBP", 1000000, "LBP"), ("Cash USD", 200, "USD")]),
			"Sales Invoice",
			[],
		)

		self.assertEqual(
			expected,
			{
				"Cash LBP": {"amount": 1000000.0, "currency": "LBP"},
				"Cash USD": {"amount": 200.0, "currency": "USD"},
			},
		)

	@patch("xpos.api.shifts.frappe")
	def test_expected_amount_keeps_each_mode_in_its_own_currency(self, mock_frappe):
		"""The count sheet asks for $70 and -407,700 LBP separately, never a blended figure."""
		mock_frappe.get_all.side_effect = [
			[
				{
					"parent": "INV-001",
					"mode_of_payment": "Cash USD",
					"amount": 9000000,
					"pos_tender_currency": "USD",
					"pos_tender_amount": 100,
				}
			],
			[
				{"parent": "INV-001", "mode_of_payment": "Cash USD", "currency": "USD", "amount": 30},
				{
					"parent": "INV-001",
					"mode_of_payment": "Cash LBP",
					"currency": "LBP",
					"amount": 407700,
				},
			],
			[],
		]
		mock_frappe.db.get_value.return_value = "Cash LBP"

		expected = shifts.get_shift_expected_amounts(
			self._opening([("Cash LBP", 1000000, "LBP"), ("Cash USD", 200, "USD")]),
			"Sales Invoice",
			[{"name": "INV-001", "currency": "LBP", "change_amount": 3107700}],
		)

		self.assertEqual(expected["Cash USD"], {"amount": 270.0, "currency": "USD"})
		self.assertEqual(expected["Cash LBP"], {"amount": 592300.0, "currency": "LBP"})


class TestCloseShift(unittest.TestCase):
	"""Tests for close_shift function."""

	@patch(
		"xpos.api.shifts.get_shift_expected_amounts",
		return_value={"Cash": {"amount": 400, "currency": "LBP"}},
	)
	@patch("xpos.api.shifts.frappe")
	def test_close_shift_ignores_client_supplied_expected_amount(self, mock_frappe, mock_expected):
		"""A client-sent expected_amount must not be able to mask a cash shortfall."""
		opening = MagicMock()
		opening.name = "POS-OPEN-001"
		opening.pos_profile = "POS-PROFILE-1"
		opening.company = "Test Company"
		opening.posting_date = "2026-01-15"
		opening.period_start_date = "2026-01-15 09:00:00"
		opening.user = "cashier@test.com"
		opening.balance_details = [SimpleNamespace(mode_of_payment="Cash", amount=100)]

		closing = MagicMock()
		closing.name = "POS-CLOSE-001"
		closing.as_dict.return_value = {"name": "POS-CLOSE-001"}
		appended = []
		closing.append.side_effect = lambda table, row: appended.append((table, row))

		mock_frappe.get_doc.side_effect = lambda *a, **kw: (
			opening if a and a[0] == "POS Opening Shift" else closing
		)
		mock_frappe.get_all.return_value = []
		mock_frappe.session.user = "cashier@test.com"

		shifts.close_shift(
			opening_shift="POS-OPEN-001",
			# Cashier claims 300 was expected and 300 counted, i.e. no variance.
			closing_details='[{"mode_of_payment": "Cash", "opening_amount": 999, '
			'"expected_amount": 300, "closing_amount": 300, "difference": 0}]',
		)

		rows = [row for table, row in appended if table == "payment_reconciliation"]
		self.assertEqual(len(rows), 1)
		# Server figure wins, exposing the 100 shortfall the client tried to hide.
		self.assertEqual(rows[0]["expected_amount"], 400)
		self.assertEqual(rows[0]["closing_amount"], 300)
		self.assertEqual(rows[0]["difference"], -100)
		self.assertEqual(rows[0]["opening_amount"], 100)
		self.assertEqual(rows[0]["currency"], "LBP")

	@patch("xpos.api.shifts.frappe")
	def test_close_shift_creates_closing_shift(self, mock_frappe):
		"""Test that close_shift creates POS Closing Shift."""
		# Setup mocks
		mock_opening_doc = MagicMock()
		mock_opening_doc.name = "POS-OPEN-001"
		mock_opening_doc.pos_profile = "POS-PROFILE-1"
		mock_opening_doc.company = "Test Company"
		mock_opening_doc.posting_date = "2026-01-15"
		mock_opening_doc.period_start_date = "2026-01-15 09:00:00"
		mock_opening_doc.user = "cashier@test.com"

		mock_closing_doc = MagicMock()
		mock_closing_doc.name = "POS-CLOSE-001"
		mock_closing_doc.as_dict.return_value = {"name": "POS-CLOSE-001"}

		def get_doc_side_effect(*args, **kwargs):
			if args[0] == "POS Opening Shift":
				return mock_opening_doc
			return mock_closing_doc

		mock_frappe.get_doc.side_effect = get_doc_side_effect
		mock_frappe.get_all.return_value = [
			{
				"name": "INV-001",
				"grand_total": 500,
				"net_total": 450,
				"total_taxes_and_charges": 50,
				"customer": "C1",
				"is_return": 0,
			}
		]
		mock_frappe.session.user = "cashier@test.com"

		result = shifts.close_shift(
			opening_shift="POS-OPEN-001",
			closing_details='[{"mode_of_payment": "Cash", "expected_amount": 500, "closing_amount": 500}]',
		)

		self.assertIn("pos_closing_shift", result)

	@patch("xpos.api.shifts.frappe")
	def test_close_shift_handles_no_invoices(self, mock_frappe):
		"""Test that close_shift works when no invoices in shift."""
		mock_opening_doc = MagicMock()
		mock_opening_doc.name = "POS-OPEN-002"
		mock_opening_doc.pos_profile = "POS-PROFILE-1"
		mock_opening_doc.company = "Test Company"
		mock_opening_doc.posting_date = "2026-01-15"
		mock_opening_doc.period_start_date = "2026-01-15 09:00:00"
		mock_opening_doc.user = "cashier@test.com"

		mock_closing_doc = MagicMock()
		mock_closing_doc.name = "POS-CLOSE-002"
		mock_closing_doc.as_dict.return_value = {"name": "POS-CLOSE-002"}

		def get_doc_side_effect(*args, **kwargs):
			if args[0] == "POS Opening Shift":
				return mock_opening_doc
			return mock_closing_doc

		mock_frappe.get_doc.side_effect = get_doc_side_effect
		mock_frappe.get_all.return_value = []  # No invoices
		mock_frappe.session.user = "cashier@test.com"

		result = shifts.close_shift(
			opening_shift="POS-OPEN-002",
			closing_details="[]",
		)

		self.assertIn("pos_closing_shift", result)


class TestCountedAmount(unittest.TestCase):
	"""Till counts that cannot be stored are refused with a message, not a database error (#179)."""

	def test_accepts_a_storable_count(self):
		self.assertEqual(shifts.counted_amount("1500.5", "Cash"), 1500.5)
		self.assertEqual(shifts.counted_amount(None, "Cash"), 0)

	@patch("xpos.api.shifts.frappe")
	def test_refuses_negative_and_overflowing_counts(self, mock_frappe):
		mock_frappe.throw.side_effect = ValueError
		for value in (-1, 52944125294000):
			with self.assertRaises(ValueError):
				shifts.counted_amount(value, "Cash")

	@patch("xpos.api.shifts.get_shift_expected_amounts", return_value={})
	@patch("xpos.api.shifts.frappe")
	def test_close_shift_refuses_before_saving(self, mock_frappe, mock_expected):
		mock_frappe.throw.side_effect = ValueError
		opening = MagicMock(balance_details=[])
		closing = MagicMock()
		mock_frappe.get_doc.side_effect = lambda *a, **kw: (
			opening if a and a[0] == "POS Opening Shift" else closing
		)
		mock_frappe.get_all.return_value = []

		with self.assertRaises(ValueError):
			shifts.close_shift(
				opening_shift="POS-OPEN-001",
				closing_details='[{"mode_of_payment": "Cash", "closing_amount": 52944125294000}]',
			)
		closing.insert.assert_not_called()
		closing.submit.assert_not_called()


class TestShiftAmountCalculations(unittest.TestCase):
	"""Tests for shift amount calculation helpers."""

	def test_total_calculation_with_returns(self):
		"""Test that return invoices are properly calculated."""
		invoices = [
			{"grand_total": 100, "is_return": 0},
			{"grand_total": 200, "is_return": 0},
			{"grand_total": -50, "is_return": 1},  # Return
		]

		from frappe.utils import flt

		grand_total = sum(flt(inv["grand_total"]) for inv in invoices)
		returns_count = sum(1 for inv in invoices if inv.get("is_return"))

		self.assertEqual(grand_total, 250)  # 100 + 200 - 50
		self.assertEqual(returns_count, 1)


if __name__ == "__main__":
	unittest.main()
