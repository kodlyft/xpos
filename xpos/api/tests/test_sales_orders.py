# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

import importlib
import unittest
from unittest.mock import patch

import frappe

from xpos.api import sales_orders


def profile(**overrides):
	return frappe._dict({"name": "P", "company": "C", "allow_sales_order": 1, **overrides})


class TestSalesOrderGates(unittest.TestCase):
	"""The Sales Order endpoints need a profile the user may use, with Allow Sales Order on (#181)."""

	@patch("xpos.api.sales_orders.resolve_pos_profile", return_value=profile(allow_sales_order=0))
	def test_refused_when_the_profile_does_not_allow_sales_orders(self, _resolve):
		for call in (
			lambda: sales_orders.search_orders("C", pos_profile="P"),
			lambda: sales_orders.create_sales_order({"pos_profile": "P", "customer": "X", "items": [{}]}),
			lambda: sales_orders.create_quotation({"pos_profile": "P", "customer": "X", "items": [{}]}),
			lambda: sales_orders.create_sales_invoice_from_order("SO-1", "P"),
		):
			with self.assertRaises(frappe.ValidationError):
				call()

	@patch("xpos.api.sales_orders.resolve_pos_profile", return_value=profile())
	def test_orders_of_another_company_are_not_listed(self, _resolve):
		with self.assertRaises(frappe.PermissionError):
			sales_orders.search_orders("Other Co", pos_profile="P")

	def test_the_unguarded_legacy_module_is_gone(self):
		"""It saved any document type from request data with ignore_permissions."""
		with self.assertRaises(ImportError):
			importlib.import_module("xpos.x_pos.api.sales_orders")
