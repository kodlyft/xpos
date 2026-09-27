"""A cashier gets a bounded, deterministic selection without limiting online search."""

import unittest
from unittest.mock import patch

import frappe

from xpos.api.customers import get_customers


class TestCustomerPreload(unittest.TestCase):
	def query(self, order="Alphabetical", cap=5, **kwargs):
		with patch("xpos.api.customers.frappe") as api:
			api.get_cached_doc.return_value = frappe._dict(
				company="Shop", xpos_customer_order=order, xpos_customer_preload_limit=cap
			)
			api.db.sql.return_value = []
			get_customers(pos_profile="Till", **kwargs)
			return api.db.sql.call_args.args

	def test_limit_only_applies_to_preload(self):
		self.assertEqual(self.query(preload=1)[1]["limit"], 5)
		self.assertEqual(self.query(limit=100)[1]["limit"], 100)

	def test_zero_loads_all(self):
		self.assertNotIn("LIMIT", self.query(cap=0, preload=1)[0])

	def test_unknown_sort_cannot_inject_sql(self):
		sql, _ = self.query(order="DROP TABLE Customer")
		self.assertNotIn("DROP TABLE", sql)

	def test_purchase_rankings_have_ties_and_exclude_consolidation_duplicates(self):
		for order, metric in [
			("Most Recent Purchase", "last_purchase"),
			("Most Revenue", "revenue"),
			("Most Transactions", "transactions"),
		]:
			sql, values = self.query(order=order)
			self.assertIn("history." + metric + " DESC, c.customer_name ASC, c.name ASC", sql)
			self.assertIn("IFNULL(is_consolidated, 0) = 0", sql)
			self.assertEqual(values["company"], "Shop")
