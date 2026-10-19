# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

import unittest

import frappe

from xpos.utils import read_latest_on_lock


def snapshot_isolation():
	row = frappe.db.sql("SHOW SESSION VARIABLES LIKE 'innodb_snapshot_isolation'")
	return row[0][1] if row else None


class TestReadLatestOnLock(unittest.TestCase):
	"""Row locks must read the latest committed row on every MariaDB, 11.6+ included."""

	def setUp(self):
		frappe.db.rollback()  # end any earlier transaction so its restore has run

	def tearDown(self):
		frappe.db.rollback()

	def test_switched_off_for_the_transaction_and_restored_after_it(self):
		before = snapshot_isolation()
		read_latest_on_lock()
		self.assertEqual(snapshot_isolation(), "OFF" if before == "ON" else before)
		read_latest_on_lock()  # a second lock in the same transaction changes nothing
		frappe.db.rollback()
		self.assertEqual(snapshot_isolation(), before)

	def test_restored_after_a_commit_too(self):
		before = snapshot_isolation()
		read_latest_on_lock()
		frappe.db.commit()  # nosemgrep
		self.assertEqual(snapshot_isolation(), before)
