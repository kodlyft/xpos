# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

import unittest
from types import SimpleNamespace
from unittest.mock import patch

import frappe

from xpos.api import auth
from xpos.www import xpos as xpos_page


class TestXposPageCsrfToken(unittest.TestCase):
	"""The /xpos page must embed the token the session keeps, not a throwaway one."""

	def _context(self):
		return SimpleNamespace()

	@patch("xpos.www.xpos.get", return_value={})
	@patch("xpos.www.xpos.get_csrf_token", return_value="saved-token")
	@patch("xpos.www.xpos.frappe")
	def test_logged_in_page_uses_the_saved_session_token(self, mock_frappe, mock_get_token, _get):
		mock_frappe.session.user = "cashier@example.com"
		mock_frappe.local.lang = "en"
		context = self._context()

		xpos_page.get_context(context)

		self.assertEqual(context.csrf_token, "saved-token")
		mock_get_token.assert_called_once_with()
		mock_frappe.generate_hash.assert_not_called()

	@patch("xpos.www.xpos.get", return_value={})
	@patch("xpos.www.xpos.get_csrf_token")
	@patch("xpos.www.xpos.frappe")
	def test_guest_page_gets_no_token(self, mock_frappe, mock_get_token, _get):
		mock_frappe.session.user = "Guest"
		mock_frappe.local.lang = "en"
		context = self._context()

		xpos_page.get_context(context)

		self.assertEqual(context.csrf_token, "")
		mock_get_token.assert_not_called()


class TestGetCsrfToken(unittest.TestCase):
	@patch("xpos.api.auth.session_csrf_token", return_value="saved-token")
	@patch("xpos.api.auth.frappe")
	def test_returns_the_session_token(self, mock_frappe, mock_get_token):
		mock_frappe.session.user = "cashier@example.com"

		self.assertEqual(auth.get_csrf_token(), "saved-token")

	@patch("xpos.api.auth.session_csrf_token")
	@patch("xpos.api.auth.frappe")
	def test_refuses_guests(self, mock_frappe, mock_get_token):
		mock_frappe.session.user = "Guest"
		mock_frappe.AuthenticationError = frappe.AuthenticationError
		mock_frappe.throw.side_effect = frappe.AuthenticationError

		with self.assertRaises(frappe.AuthenticationError):
			auth.get_csrf_token()
		mock_get_token.assert_not_called()

	def test_is_whitelisted_for_get_only(self):
		self.assertIn(auth.get_csrf_token, frappe.whitelisted)
		self.assertEqual(frappe.allowed_http_methods_for_whitelisted_func[auth.get_csrf_token], ["GET"])
