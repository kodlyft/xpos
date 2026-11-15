# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

import unittest
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import patch

import frappe

from xpos.api import mobile


def profile(**over):
	data = {"name": "Main", "company": "Acme", "warehouse": "Stores - A", "currency": "KWD"}
	data.update(over)

	class P(SimpleNamespace):
		def get(self, key, default=None):
			return getattr(self, key, default)

	return P(**data)


@contextmanager
def extras():
	with (
		patch("xpos.api.mobile.frappe.db.get_single_value", return_value="Standard Selling"),
		patch("xpos.api.mobile.profile_choices", return_value=[{"name": "Main"}]),
		patch(
			"xpos.api.mobile.payment_modes_for", return_value=[{"mode_of_payment": "Cash", "default": True}]
		),
		patch("xpos.api.mobile.open_shift_for", return_value="SHIFT-1"),
	):
		yield


class TestMobileBootstrap(unittest.TestCase):
	def tearDown(self):
		frappe.set_user("Administrator")

	def test_guest_is_denied(self):
		frappe.set_user("Guest")
		with self.assertRaises(frappe.PermissionError):
			mobile.bootstrap()

	def test_profile_boundary_is_the_existing_resolver(self):
		"""A user the profile does not list gets the resolver's PermissionError, nothing else."""
		with patch(
			"xpos.api.mobile.resolve_pos_profile", side_effect=frappe.PermissionError("no")
		) as resolve:
			with self.assertRaises(frappe.PermissionError):
				mobile.bootstrap("Other Branch")
		resolve.assert_called_once()
		self.assertEqual(resolve.call_args.args[0], "Other Branch")

	def test_returns_only_authorized_context_for_the_resolved_profile(self):
		with (
			patch("xpos.api.mobile.resolve_pos_profile", return_value=profile()),
			patch("xpos.api.mobile.get_my_pos_permissions", return_value={"can_sell": True}) as perms,
			patch("xpos.api.mobile.minor_digits_for", return_value=3),
			patch("xpos.api.mobile.erpnext_version", return_value="16.4.0"),
			extras(),
		):
			out = mobile.bootstrap()
		perms.assert_called_once_with("Main")
		self.assertEqual(out["pos_profile"], "Main")
		self.assertEqual(
			(out["company"], out["warehouse"], out["currency"], out["minor_digits"]),
			("Acme", "Stores - A", "KWD", 3),
		)
		self.assertEqual(out["permissions"], {"can_sell": True})
		self.assertEqual(out["profiles"], [{"name": "Main"}])
		self.assertEqual(out["open_shift"], "SHIFT-1")
		self.assertEqual(out["price_list"], "Standard Selling")
		self.assertLessEqual(out["lease_ttl_seconds"], 24 * 3600)
		# nothing role- or secret-shaped leaks out
		for key in out:
			self.assertNotIn(key, {"roles", "api_key", "api_secret", "csrf_token", "sid", "password"})

	def test_version_gate_flags_non_16(self):
		for version, supported in (("16.4.0", True), ("15.9.1", False), ("17.0.0", False), (None, False)):
			with (
				patch("xpos.api.mobile.resolve_pos_profile", return_value=profile()),
				patch("xpos.api.mobile.get_my_pos_permissions", return_value={}),
				patch("xpos.api.mobile.minor_digits_for", return_value=2),
				patch("xpos.api.mobile.erpnext_version", return_value=version),
				extras(),
				patch("xpos.api.mobile.frappe.__version__", version or "0", create=True),
			):
				self.assertEqual(mobile.bootstrap()["supported"], supported, version)

	def test_minor_digits_come_from_the_currency_fraction(self):
		for fraction, digits in ((0.01, 2), (0.001, 3), (1, 0), (0.0001, 4), (0.00001, 4), (None, 2), (0, 2)):
			with patch("xpos.api.mobile.frappe.get_cached_value", return_value=fraction):
				self.assertEqual(mobile.minor_digits_for("X"), digits, fraction)
		self.assertEqual(mobile.minor_digits_for(None), 2)

	def test_major_version_parsing(self):
		self.assertEqual(mobile.major_version("16.4.1-beta"), 16)
		self.assertIsNone(mobile.major_version("dev"))
		self.assertIsNone(mobile.major_version(None))
