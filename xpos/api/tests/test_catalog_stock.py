"""A catalog page retains stock semantics while avoiding per-item stock queries."""

import unittest
from unittest.mock import patch

import frappe

from xpos.api.items import get_stock_qty_map


class TestCatalogStock(unittest.TestCase):
	def test_empty_page_does_not_query(self):
		with patch("xpos.api.items.frappe") as api:
			self.assertEqual(get_stock_qty_map([], "Store"), {})
			api.db.get_value.assert_not_called()

	def test_group_stock_and_pending_sales_are_combined_once(self):
		with (
			patch("xpos.api.items.frappe") as api,
			patch("xpos.api.items.get_invoice_type", return_value="POS Invoice"),
			patch("xpos.api.items._get_pending_pos_qty_map", return_value={"A": 3, "B": 2}) as pending,
		):
			api.db.get_value.return_value = 1
			api.db.get_descendants.return_value = ["One", "Two"]
			query = api.qb.from_.return_value
			query.select.return_value.where.return_value.where.return_value.groupby.return_value.run.return_value = [
				frappe._dict(item_code="A", actual_qty=10)
			]
			self.assertEqual(get_stock_qty_map(["A", "B"], "Group", "Till"), {"A": 7, "B": -2})
			pending.assert_called_once_with(["One", "Two"], item_codes=["A", "B"])
