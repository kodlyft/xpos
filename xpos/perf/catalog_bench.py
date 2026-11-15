# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""Query counting for the catalogue, stock and price-read endpoints."""

import frappe


class Probe:
	"""Counts the SQL statements issued inside the ``with`` block."""

	def __enter__(self):
		self.count = 0
		self.original = frappe.db.sql
		probe = self

		def counting(*args, **kwargs):
			probe.count += 1
			return probe.original(*args, **kwargs)

		frappe.db.sql = counting
		return self

	def __exit__(self, *exc):
		frappe.db.sql = self.original
		return False
