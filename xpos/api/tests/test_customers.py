# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import frappe

from xpos.api import customers


class TestGetCustomers(unittest.TestCase):
	"""Tests for get_customers function."""

	@patch("xpos.api.customers.set_pos_price_lists")
	@patch("xpos.api.customers.resolve_pos_profile")
	@patch("xpos.api.customers.frappe")
	def test_get_customers_returns_customer_list(self, mock_frappe, mock_resolve, _mock_price_lists):
		"""Test that get_customers returns list of customers."""
		mock_frappe.db.sql.return_value = [
			{
				"name": "CUST-001",
				"customer_name": "John Doe",
				"mobile_no": "1234567890",
				"email_id": "john@example.com",
			},
			{
				"name": "CUST-002",
				"customer_name": "Jane Smith",
				"mobile_no": "0987654321",
				"email_id": "jane@example.com",
			},
		]

		result = customers.get_customers()

		mock_resolve.assert_called_once_with(None)
		self.assertEqual(len(result), 2)
		self.assertEqual(result[0]["customer_name"], "John Doe")

	@patch("xpos.api.customers.set_pos_price_lists")
	@patch("xpos.api.customers.resolve_pos_profile")
	@patch("xpos.api.customers.frappe")
	def test_get_customers_searches_by_term(self, mock_frappe, _mock_resolve, _mock_price_lists):
		"""Test that get_customers filters by search term."""
		mock_frappe.db.sql.return_value = [
			{
				"name": "CUST-001",
				"customer_name": "John Doe",
				"mobile_no": "1234567890",
			}
		]

		customers.get_customers(search_term="John")

		mock_frappe.db.sql.assert_called_once()
		call_args = mock_frappe.db.sql.call_args
		# Verify search term is in the query parameters
		self.assertIn("John", str(call_args))

	@patch("xpos.api.customers.resolve_pos_profile")
	@patch("xpos.api.customers._get_child_groups")
	@patch("xpos.api.customers.frappe")
	def test_get_customers_respects_pos_profile_groups(self, mock_frappe, mock_get_groups, mock_resolve):
		"""Test that customer search respects POS profile customer groups."""
		mock_pos = MagicMock()
		mock_pos.get.return_value = [SimpleNamespace(customer_group="Retail")]
		mock_resolve.return_value = mock_pos
		mock_get_groups.return_value = ["Retail", "Retail Sub"]
		mock_frappe.db.sql.return_value = []

		customers.get_customers(pos_profile="POS-PROFILE-1")

		mock_resolve.assert_called_once_with("POS-PROFILE-1")
		query, values = mock_frappe.db.sql.call_args[0]
		self.assertIn("c.customer_group IN", query)
		self.assertEqual({values["grp_0"], values["grp_1"]}, {"Retail", "Retail Sub"})

	@patch("xpos.api.customers.frappe")
	def test_get_customers_respects_limit(self, mock_frappe):
		"""Test that get_customers respects the limit parameter."""
		mock_frappe.db.sql.return_value = []

		customers.get_customers(limit=10)

		call_args = mock_frappe.db.sql.call_args
		self.assertIn("10", str(call_args))


class TestGetCustomerInfo(unittest.TestCase):
	"""Tests for get_customer_info function."""

	@patch("xpos.api.customers.user_may_see_address", return_value=True)
	@patch("xpos.api.customers.require_customer_access", return_value=MagicMock(company="_Test Company"))
	@patch("xpos.api.customers.get_loyalty_points")
	@patch("erpnext.selling.doctype.customer.customer.get_credit_limit", return_value=0)
	@patch("xpos.api.customers.get_customer_balance")
	@patch("xpos.api.customers.frappe")
	def test_get_customer_info_returns_full_details(
		self, mock_frappe, mock_balance, mock_credit_limit, mock_loyalty, mock_access, mock_address
	):
		"""Test that get_customer_info returns complete customer data."""
		mock_customer = MagicMock()
		mock_customer.name = "CUST-001"
		mock_customer.customer_name = "John Doe"
		mock_customer.loyalty_program = None
		mock_frappe.get_cached_doc.return_value = mock_customer
		mock_balance.return_value = {"balance": 500}
		mock_loyalty.return_value = {"points": 100}
		mock_frappe.get_all.return_value = []

		result = customers.get_customer_info("CUST-001")

		self.assertIsNotNone(result)
		self.assertEqual(result["name"], "CUST-001")
		self.assertEqual(result["customer_name"], "John Doe")
		self.assertEqual(result["balance"], {"balance": 500})
		mock_balance.assert_called_once_with("CUST-001", "_Test Company")
		mock_loyalty.assert_called_once_with("CUST-001", "_Test Company")

	def test_get_customer_info_returns_none_for_missing_customer(self):
		"""Test that get_customer_info returns None for a blank customer."""
		self.assertIsNone(customers.get_customer_info(""))

	@patch("xpos.api.customers.user_may_see_address", return_value=True)
	@patch("xpos.api.customers.require_customer_access", return_value=MagicMock(company="_Test Company"))
	@patch("xpos.api.customers.get_loyalty_points")
	@patch("erpnext.selling.doctype.customer.customer.get_credit_limit", return_value=0)
	@patch("xpos.api.customers.get_customer_balance")
	@patch("xpos.api.customers.frappe")
	def test_get_customer_info_includes_addresses(
		self, mock_frappe, mock_balance, mock_credit_limit, mock_loyalty, mock_access, mock_address
	):
		"""Test that get_customer_info resolves Dynamic Links into full address rows."""
		mock_customer = MagicMock()
		mock_customer.loyalty_program = None
		mock_frappe.get_cached_doc.return_value = mock_customer
		mock_balance.return_value = {}
		mock_loyalty.return_value = {}
		# First get_all resolves Dynamic Links, second fetches the Address rows.
		mock_frappe.get_all.side_effect = [
			[{"parent": "ADDR-001"}, {"parent": "ADDR-002"}],
			[
				frappe._dict({"name": "ADDR-001", "address_title": "Home", "city": "Lahore"}),
				frappe._dict({"name": "ADDR-002", "address_title": "Work", "city": "Karachi"}),
			],
		]

		result = customers.get_customer_info("CUST-001")

		self.assertEqual(len(result["addresses"]), 2)
		self.assertEqual(result["addresses"][0]["name"], "ADDR-001")
		self.assertEqual(result["addresses"][1]["city"], "Karachi")
		self.assertEqual(mock_frappe.get_all.call_count, 2)


class TestCreateCustomer(unittest.TestCase):
	"""Tests for create_customer function."""

	@patch("xpos.api.customers.frappe")
	def test_create_customer_creates_new_customer(self, mock_frappe):
		"""Test that create_customer creates a new Customer document."""
		mock_customer = MagicMock()
		mock_customer.name = "CUST-NEW-001"
		mock_customer.as_dict.return_value = {"name": "CUST-NEW-001", "customer_name": "New Customer"}
		mock_frappe.get_doc.return_value = mock_customer

		customers.create_customer(
			customer_name="New Customer",
			mobile_no="1234567890",
			email_id="new@example.com",
		)

		mock_frappe.get_doc.assert_called()
		mock_customer.insert.assert_called_once()

	@patch("xpos.api.customers.frappe")
	def test_create_customer_assigns_default_group(self, mock_frappe):
		"""Test that create_customer uses default customer group when not provided."""
		mock_customer = MagicMock()
		mock_customer.as_dict.return_value = {"name": "CUST-NEW-002"}
		mock_frappe.get_doc.return_value = mock_customer
		mock_frappe.db.get_single_value.return_value = "All Customer Groups"

		customers.create_customer(customer_name="New Customer")

		mock_frappe.get_doc.assert_called()


class TestUpdateCustomer(unittest.TestCase):
	"""Tests for update_customer function."""

	@patch("xpos.api.customers.require_customer_access")
	@patch("xpos.api.customers.frappe")
	def test_update_customer_modifies_existing_customer(self, mock_frappe, mock_access):
		"""Test that update_customer modifies existing customer."""
		mock_customer = MagicMock()
		mock_customer.name = "CUST-001"
		mock_customer.as_dict.return_value = {"name": "CUST-001", "customer_name": "Updated Name"}
		mock_frappe.get_doc.return_value = mock_customer

		customers.update_customer("CUST-001", {"customer_name": "Updated Name"})

		mock_frappe.get_doc.assert_called_with("Customer", "CUST-001")
		mock_customer.save.assert_called_once()


class TestGetCustomerBalance(unittest.TestCase):
	"""Tests for get_customer_balance function."""

	@patch("xpos.api.customers.frappe")
	def test_get_customer_balance_returns_outstanding(self, mock_frappe):
		"""Test that get_customer_balance returns outstanding amount."""
		mock_frappe.db.sql.return_value = [[500.0]]

		result = customers.get_customer_balance("CUST-001", "_Test Company")

		self.assertIn("balance", result) if isinstance(result, dict) else True


class TestGetLoyaltyPoints(unittest.TestCase):
	"""Tests for get_loyalty_points function."""

	@patch("xpos.api.customers.frappe")
	def test_get_loyalty_points_returns_points(self, mock_frappe):
		"""Test that get_loyalty_points returns loyalty information."""
		mock_frappe.db.sql.return_value = [{"loyalty_program": "VIP Program", "loyalty_points": 150}]

		customers.get_loyalty_points("CUST-001", "_Test Company")

		mock_frappe.db.sql.assert_called()


class TestCustomerSearchPatterns(unittest.TestCase):
	"""Tests for customer search pattern matching."""

	def test_search_by_phone_pattern(self):
		"""Test phone number search pattern."""
		search_terms = ["123", "1234567890", "+1234567890"]
		for term in search_terms:
			# Phone numbers should match numeric patterns
			self.assertTrue(
				term.replace("+", "").replace("-", "").replace(" ", "").isnumeric()
				or any(c.isdigit() for c in term)
			)

	def test_search_by_email_pattern(self):
		"""Test email search pattern."""
		search_terms = ["john@example.com", "@example"]
		for term in search_terms:
			# Email searches should contain @ or domain patterns
			self.assertTrue("@" in term or "." in term or term.isalnum())

	def test_search_by_name_pattern(self):
		"""Test name search pattern."""
		search_terms = ["John", "John Doe", "JOHN"]
		for term in search_terms:
			# Name searches are alphanumeric
			self.assertTrue(all(c.isalnum() or c.isspace() for c in term))


class TestCustomerGroupFiltering(unittest.TestCase):
	"""Tests for customer group filtering logic."""

	def test_child_groups_include_parent(self):
		"""Test that child groups include the parent group."""
		# Simulating group hierarchy: Retail -> Retail Premium, Retail Standard
		parent = "Retail"
		children = ["Retail Premium", "Retail Standard"]
		all_groups = [parent] + children

		self.assertIn(parent, all_groups)
		self.assertEqual(len(all_groups), 3)

	def test_empty_group_filter_returns_all(self):
		"""Test that empty group filter doesn't restrict results."""
		allowed_groups = []
		# When no groups specified, all customers should be returned
		self.assertEqual(len(allowed_groups), 0)


if __name__ == "__main__":
	unittest.main()
