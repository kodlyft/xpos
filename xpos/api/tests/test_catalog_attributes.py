# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

import unittest
from unittest.mock import patch

import frappe

from xpos.api import catalog_sync


class TestAttachAttributes(unittest.TestCase):
	def items(self):
		return [
			frappe._dict(item_code="TEE-RED-M", variant_of="TEE"),
			frappe._dict(item_code="TEE-RED-L", variant_of="TEE"),
			frappe._dict(item_code="PEN", variant_of=None),
		]

	def test_variants_get_their_attributes_and_plain_items_an_empty_dict(self):
		rows = [
			frappe._dict(parent="TEE-RED-M", attribute="Colour", attribute_value="Red"),
			frappe._dict(parent="TEE-RED-M", attribute="Size", attribute_value="M"),
			frappe._dict(parent="TEE-RED-L", attribute="Colour", attribute_value="Red"),
			frappe._dict(parent="TEE-RED-L", attribute="Size", attribute_value="L"),
		]
		items = self.items()
		with patch.object(catalog_sync.frappe, "get_all", return_value=rows) as get_all:
			catalog_sync.attach_attributes(items)
		self.assertEqual(items[0].attributes, {"Colour": "Red", "Size": "M"})
		self.assertEqual(items[1].attributes, {"Colour": "Red", "Size": "L"})
		self.assertEqual(items[2].attributes, {})
		# one query for the whole page, only for variant items
		get_all.assert_called_once()
		self.assertEqual(sorted(get_all.call_args.kwargs["filters"]["parent"][1]), ["TEE-RED-L", "TEE-RED-M"])

	def test_no_query_when_the_page_has_no_variants(self):
		items = [frappe._dict(item_code="PEN", variant_of=None)]
		with patch.object(catalog_sync.frappe, "get_all") as get_all:
			catalog_sync.attach_attributes(items)
		get_all.assert_not_called()
		self.assertEqual(items[0].attributes, {})
