# Copyright (c) 2026, Kodlyft and contributors
# For license information, please see license.txt

"""
Regression tests for the POS oversell / negative stock guards.

These cover the three places the guard used to leak: the cart-level
availability check (UOM conversion), the invoice-level check (which was dead
code), and POS shift consolidation (which switched the negative stock guard
off wholesale).
"""

import unittest
from unittest.mock import patch

import frappe

from xpos.x_pos.api.invoice_processing import stock as stock_module
from xpos.x_pos.overrides.pos_invoice_merge_log import CustomPOSInvoiceMergeLog


class NegativeStockRaised(Exception):
	"""Sentinel standing in for ``frappe.throw`` when frappe itself is mocked."""


class FakeDoc:
	"""Minimal stand-in for a POS Invoice document."""

	def __init__(self, items=None, packed_items=None, doctype="POS Invoice", **attrs):
		self._tables = {"items": items or [], "packed_items": packed_items or []}
		self.doctype = doctype
		self.items = self._tables["items"]
		self.packed_items = self._tables["packed_items"]
		for key, value in attrs.items():
			setattr(self, key, value)

	def get(self, key, default=None):
		if key in self._tables:
			return self._tables[key]
		return getattr(self, key, default)


class FakeRow(dict):
	"""Invoice item row that also exposes ``as_dict`` like a child Document."""

	def as_dict(self):
		return dict(self)


class TestCollectStockErrors(unittest.TestCase):
	"""``collect_stock_errors`` is what decides whether a sale is blocked."""

	def setUp(self):
		patcher = patch.object(stock_module, "frappe")
		self.mock_frappe = patcher.start()
		self.addCleanup(patcher.stop)
		# Negative stock disabled globally, and not allowed per item.
		self.mock_frappe.db.get_single_value.return_value = 0
		self.mock_frappe.get_cached_value.return_value = 0

	def _collect(self, items, available):
		with patch.object(stock_module, "get_bulk_stock_availability", return_value=available):
			return stock_module.collect_stock_errors(items)

	def test_qty_within_stock_is_allowed(self):
		items = [{"item_code": "IT-1", "warehouse": "WH", "qty": 3, "is_stock_item": 1}]
		errors = self._collect(items, {("IT-1", "WH", ""): 5.0})
		self.assertEqual(errors, [])

	def test_qty_beyond_stock_is_blocked(self):
		items = [{"item_code": "IT-1", "warehouse": "WH", "qty": 8, "is_stock_item": 1}]
		errors = self._collect(items, {("IT-1", "WH", ""): 5.0})
		self.assertEqual(len(errors), 1)
		self.assertEqual(errors[0]["requested_qty"], 8)
		self.assertEqual(errors[0]["available_qty"], 5.0)

	def test_uom_conversion_is_applied(self):
		"""1 carton of 24 must not pass against 5 pieces on hand.

		The cart works in the selected UOM while stock is held in the stock
		UOM; comparing the two directly was how a carton slipped through.
		"""
		items = [
			{
				"item_code": "IT-1",
				"warehouse": "WH",
				"qty": 1,
				"conversion_factor": 24,
				"is_stock_item": 1,
			}
		]
		errors = self._collect(items, {("IT-1", "WH", ""): 5.0})
		self.assertEqual(len(errors), 1)
		self.assertEqual(errors[0]["requested_qty"], 24)

	def test_explicit_stock_qty_wins_over_qty(self):
		items = [
			{
				"item_code": "IT-1",
				"warehouse": "WH",
				"qty": 1,
				"stock_qty": 24,
				"conversion_factor": 24,
				"is_stock_item": 1,
			}
		]
		errors = self._collect(items, {("IT-1", "WH", ""): 5.0})
		self.assertEqual(errors[0]["requested_qty"], 24)

	def test_return_rows_are_skipped(self):
		items = [{"item_code": "IT-1", "warehouse": "WH", "qty": -3, "is_stock_item": 1}]
		errors = self._collect(items, {("IT-1", "WH", ""): 0.0})
		self.assertEqual(errors, [])


class TestValidateStockOnInvoice(unittest.TestCase):
	"""The row filter here used to drop every item, disabling the check."""

	def test_items_are_not_dropped_by_missing_is_stock_item_field(self):
		"""``is_stock_item`` is not a field on Sales/POS Invoice Item.

		Filtering rows on it silently emptied the list and turned the whole
		validation into a no-op, so rows must reach ``collect_stock_errors``
		even when they carry no such key.
		"""
		invoice = FakeDoc(
			items=[FakeRow(item_code="IT-1", warehouse="WH", qty=8)],
			doctype="POS Invoice",
			pos_profile="POS-1",
		)

		with patch.object(stock_module, "collect_stock_errors", return_value=[]) as collect:
			stock_module.validate_stock_on_invoice(invoice)

		collect.assert_called_once()
		passed_items = collect.call_args[0][0]
		self.assertEqual(len(passed_items), 1)
		self.assertEqual(passed_items[0]["item_code"], "IT-1")

	def test_blocking_raises_insufficient_stock(self):
		invoice = FakeDoc(
			items=[FakeRow(item_code="IT-1", warehouse="WH", qty=8)],
			doctype="POS Invoice",
			pos_profile="POS-1",
		)
		errors = [{"item_code": "IT-1", "warehouse": "WH", "requested_qty": 8, "available_qty": 5}]

		with (
			patch.object(stock_module, "collect_stock_errors", return_value=errors),
			patch.object(stock_module, "_should_block", return_value=True),
			self.assertRaises(stock_module.XPosInsufficientStockError),
		):
			stock_module.validate_stock_on_invoice(invoice)

	def test_profile_can_opt_out_of_blocking(self):
		invoice = FakeDoc(
			items=[FakeRow(item_code="IT-1", warehouse="WH", qty=8)],
			doctype="POS Invoice",
			pos_profile="POS-1",
		)
		errors = [{"item_code": "IT-1", "warehouse": "WH", "requested_qty": 8, "available_qty": 5}]

		with (
			patch.object(stock_module, "collect_stock_errors", return_value=errors),
			patch.object(stock_module, "_should_block", return_value=False),
		):
			stock_module.validate_stock_on_invoice(invoice)  # must not raise


class TestConsolidationStockGuard(unittest.TestCase):
	"""POS Invoices post no stock ledger entries until consolidation.

	Consolidation is therefore the only place stock actually moves, and it used
	to run with the negative stock guard switched off unconditionally.
	"""

	def setUp(self):
		self.log = object.__new__(CustomPOSInvoiceMergeLog)

		patcher = patch("xpos.x_pos.overrides.pos_invoice_merge_log.frappe.get_cached_value", return_value=1)
		patcher.start()
		self.addCleanup(patcher.stop)

		negative_patcher = patch(
			"xpos.x_pos.overrides.pos_invoice_merge_log.negative_stock_allowed", return_value=False
		)
		negative_patcher.start()
		self.addCleanup(negative_patcher.stop)

	@staticmethod
	def _sale(item_code, warehouse, stock_qty):
		return FakeDoc(items=[{"item_code": item_code, "warehouse": warehouse, "stock_qty": stock_qty}])

	def test_returns_net_off_against_sales(self):
		"""Return rows carry negative stock_qty, so summing gives the net."""
		docs = [
			self._sale("IT-1", "WH", 1),
			self._sale("IT-1", "WH", -1),  # customer returned it
			self._sale("IT-1", "WH", 1),  # sold again
		]
		movement = self.log.collect_net_stock_movement(docs)
		self.assertEqual(movement[("IT-1", "WH")], 1)

	def test_same_shift_sell_return_sell_is_allowed_with_one_on_hand(self):
		"""The case that rules out reordering returns before sales.

		Gross sales are 2 against 1 on hand, but the same-shift return brings
		the net to 1. This must consolidate, since the credit note restores the
		stock moments later in the same transaction.
		"""
		docs = [
			self._sale("IT-1", "WH", 1),
			self._sale("IT-1", "WH", -1),
			self._sale("IT-1", "WH", 1),
		]

		with patch("xpos.x_pos.overrides.pos_invoice_merge_log.get_stock_availability", return_value=1.0):
			self.log.validate_net_stock(docs)  # must not raise

	def test_genuine_shortfall_is_blocked(self):
		docs = [self._sale("IT-1", "WH", 2)]

		with (
			patch("xpos.x_pos.overrides.pos_invoice_merge_log.get_stock_availability", return_value=1.0),
			self.assertRaises(frappe.ValidationError),
		):
			self.log.validate_net_stock(docs)

	def test_packed_items_are_counted(self):
		docs = [
			FakeDoc(
				items=[{"item_code": "BUNDLE", "warehouse": "WH", "stock_qty": 1}],
				packed_items=[{"item_code": "IT-1", "warehouse": "WH", "qty": 10}],
			)
		]
		movement = self.log.collect_net_stock_movement(docs)
		self.assertEqual(movement[("IT-1", "WH")], 10)

	def test_check_is_skipped_when_negative_stock_is_allowed(self):
		docs = [self._sale("IT-1", "WH", 999)]

		with (
			patch(
				"xpos.x_pos.overrides.pos_invoice_merge_log.negative_stock_allowed",
				return_value=True,
			),
			patch("xpos.x_pos.overrides.pos_invoice_merge_log.get_stock_availability", return_value=0.0),
		):
			self.log.validate_net_stock(docs)  # must not raise

	def test_post_submit_assertion_catches_negative_bin(self):
		docs = [self._sale("IT-1", "WH", 1)]

		with patch("xpos.x_pos.overrides.pos_invoice_merge_log.frappe") as mock_frappe:
			mock_frappe.get_cached_value.return_value = 1
			mock_frappe.db.get_value.return_value = -3
			mock_frappe.bold.side_effect = lambda v: str(v)
			mock_frappe.throw.side_effect = NegativeStockRaised

			with self.assertRaises(NegativeStockRaised):
				self.log.assert_no_negative_stock(docs)
