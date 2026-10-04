"""A retry without an explicit warehouse returns the already submitted sale."""

import unittest
from types import SimpleNamespace
from unittest.mock import patch

from xpos.api.invoices import create_invoice


class TestInvoiceRetry(unittest.TestCase):
	def test_profile_warehouse_is_resolved_before_deduplication(self):
		for supplied, expected in [(None, "Profile Store"), ("Explicit Store", "Explicit Store")]:
			with (
				patch("xpos.api.invoices.frappe") as api,
				patch(
					"xpos.api.invoices.find_invoice_by_local_id", return_value=("Sales Invoice", "INV-1")
				) as find,
				patch("xpos.api.invoices._build_invoice_response", return_value={"name": "INV-1"}),
			):
				api.get_cached_doc.return_value = SimpleNamespace(warehouse="Profile Store")
				result = create_invoice(
					{"pos_profile": "Till", "local_id": "same-sale", "warehouse": supplied}
				)
				self.assertEqual(result, {"name": "INV-1", "duplicate": True})
				find.assert_called_once_with("same-sale", expected)
				api.new_doc.assert_not_called()
