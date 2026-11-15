# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

import importlib
import unittest

import frappe


def is_whitelisted(module_path: str, function_name: str) -> bool:
	"""Whether `module_path.function_name` is exposed over HTTP."""
	module = importlib.import_module(module_path)
	function = getattr(module, function_name, None)
	return function is not None and function in frappe.whitelisted


def function_exists(module_path: str, function_name: str) -> bool:
	return hasattr(importlib.import_module(module_path), function_name)


class TestPrivilegedHelpersAreNotExposed(unittest.TestCase):
	"""Helpers that write with ignore_permissions must not be whitelisted."""

	def test_create_payment_entry_exists_but_is_not_an_endpoint(self):
		"""It inserts and submits a Payment Entry with no permission or amount check.

		`settle_outstanding_invoice` is the gated entry point: it verifies the
		POS right and caps the amount at the invoice outstanding. Exposing the
		helper would let a caller skip both.
		"""
		self.assertTrue(function_exists("xpos.api.payments", "create_payment_entry"))
		self.assertFalse(is_whitelisted("xpos.api.payments", "create_payment_entry"))

	def test_settle_outstanding_invoice_remains_the_public_entry_point(self):
		"""The gated wrapper stays reachable so the feature keeps working."""
		self.assertTrue(is_whitelisted("xpos.api.payments", "settle_outstanding_invoice"))


class TestExchangeRateHelpersAreNotExposed(unittest.TestCase):
	"""The rate resolver must stay server-side only."""

	def test_resolve_tender_rate_exists_but_is_not_an_endpoint(self):
		"""Exposing it would let a caller pick which rate a tender leg is valued at.

		The whole point of resolving rates server-side is that a client cannot choose
		one. `get_tender_rates` is the read-only public view of the same data.
		"""
		self.assertTrue(function_exists("xpos.api.exchange", "resolve_tender_rate"))
		self.assertFalse(is_whitelisted("xpos.api.exchange", "resolve_tender_rate"))

	def test_rate_payload_builder_is_not_an_endpoint(self):
		"""It takes a doc rather than a name, so it performs no permission check."""
		self.assertTrue(function_exists("xpos.api.exchange", "build_tender_rate_payload"))
		self.assertFalse(is_whitelisted("xpos.api.exchange", "build_tender_rate_payload"))

	def test_get_tender_rates_remains_the_public_entry_point(self):
		"""The POS needs to read the current rate per payment mode."""
		self.assertTrue(is_whitelisted("xpos.api.exchange", "get_tender_rates"))


class TestLegacyApiModulesAreGone(unittest.TestCase):
	"""The unused `xpos.x_pos.api` facades are removed, so none of them stays reachable over HTTP."""

	def test_legacy_modules_are_removed(self):
		"""`invoices.get_draft_invoice_doc` loaded any doctype by name with no permission check,
		and `customers` read and wrote any customer."""
		for module in (
			"xpos.x_pos.api.invoices",
			"xpos.x_pos.api.customers",
			"xpos.x_pos.api.invoice_processing.creation",
			"xpos.x_pos.api.payment_processing.processor",
			"xpos.x_pos.api.cash_movement.service",
			"xpos.x_pos.api.qz",
		):
			with self.subTest(module), self.assertRaises(ImportError):
				importlib.import_module(module)

	def test_legacy_customer_wrappers_are_removed(self):
		for name in ("get_customer_balance", "create_customer"):
			self.assertFalse(function_exists("xpos.x_pos.api.customer", name), name)

	def test_address_helper_is_not_an_endpoint(self):
		"""Only `create_customer` uses it, after the customer has been created."""
		self.assertTrue(function_exists("xpos.api.customers", "make_address"))
		self.assertFalse(is_whitelisted("xpos.api.customers", "make_address"))


class TestRepricingEndpointIsGone(unittest.TestCase):
	"""Arbitrary Item Price rewriting has been removed."""

	def test_update_price_list_rate_is_removed(self):
		"""It let any user rewrite the Item Price that `allow_change_price` reads.

		`create_invoice` enforces the price lock by re-reading Item Price, so an
		ungated repricing endpoint defeated that control entirely.
		"""
		self.assertFalse(function_exists("xpos.api.items", "update_price_list_rate"))


class TestGiftCardHelpersAreNotExposed(unittest.TestCase):
	"""Only the gated gift card endpoints are reachable over HTTP."""

	def test_ledger_writers_are_not_endpoints(self):
		for name in ("add_transaction", "create_card", "issue_auth_token", "lock_card", "claim_issued_codes"):
			self.assertTrue(function_exists("xpos.x_pos.gift_cards", name), name)
			self.assertFalse(is_whitelisted("xpos.x_pos.gift_cards", name), name)

	def test_gated_endpoints_remain_public(self):
		for name in ("check_gift_card", "claim_issued_gift_cards", "adjust_gift_card"):
			self.assertTrue(is_whitelisted("xpos.api.gift_cards", name), name)


class TestMobileBootstrapExposure(unittest.TestCase):
	"""Only the named mobile endpoints are public; their helpers stay server-side."""

	def test_bootstrap_is_whitelisted_without_guest_access(self):
		self.assertTrue(is_whitelisted("xpos.api.mobile", "bootstrap"))
		from xpos.api.mobile import bootstrap

		self.assertNotIn(bootstrap, frappe.guest_methods)

	def test_quote_sale_is_whitelisted_without_guest_access(self):
		self.assertTrue(is_whitelisted("xpos.api.mobile_quote", "quote_sale"))
		from xpos.api.mobile_quote import quote_sale

		self.assertNotIn(quote_sale, frappe.guest_methods)

	def test_customer_endpoints_are_whitelisted_without_guest_access(self):
		from xpos.api import customers

		for name in (
			"search_customers_mobile",
			"get_customer_for_sale",
			"create_customer_mobile",
			"update_customer_mobile",
		):
			self.assertTrue(is_whitelisted("xpos.api.customers", name), name)
			self.assertNotIn(getattr(customers, name), frappe.guest_methods, name)

	def test_quote_internals_are_not_endpoints(self):
		for name in ("Quote", "context_hash", "parse_list"):
			self.assertTrue(function_exists("xpos.api.mobile_quote", name), name)
			self.assertFalse(is_whitelisted("xpos.api.mobile_quote", name), name)

	def test_helpers_are_not_endpoints(self):
		for name in (
			"minor_digits_for",
			"erpnext_version",
			"major_version",
			"profile_choices",
			"payment_modes_for",
			"open_shift_for",
		):
			self.assertTrue(function_exists("xpos.api.mobile", name))
			self.assertFalse(is_whitelisted("xpos.api.mobile", name))
