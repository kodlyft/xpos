# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

import unittest
from unittest.mock import MagicMock, patch

import frappe

from xpos.api import catalog_sync


class TestCatalogPriceFlag(unittest.TestCase):
	def test_missing_zero_and_positive_prices_are_distinguished(self):
		items = [frappe._dict(item_code=c) for c in ("MISSING", "ZERO", "POSITIVE")]
		with (
			patch("xpos.api.catalog_sync.price_list_of", return_value="Standard Selling"),
			patch("xpos.api.catalog_sync.get_price_map", return_value={"ZERO": 0.0, "POSITIVE": 7.5}),
		):
			catalog_sync.attach_rates(MagicMock(), items)
		self.assertEqual([i.rate for i in items], [0, 0.0, 7.5])
		self.assertEqual([i.price_missing for i in items], [1, 0, 0])
