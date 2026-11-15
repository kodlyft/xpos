# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""Live checks of historical sales reporting, currency grouping, blind closing and report scope.

Run on a disposable test site::

    bench --site <site> run-tests --module xpos.api.tests.test_report_integrity
"""

import frappe
from frappe.utils import add_days, today

from xpos.api.auth import clear_role_permission_cache
from xpos.api.tests.test_profile_settings_hardening import ensure_pos_role, ensure_user, make_profile
from xpos.api.tests.test_report_catalog import (
	PROFILE,
	WH_ONE,
	WH_TWO,
	ReportCatalogTestCase,
	as_dicts,
	as_user,
)
from xpos.reports import catalog, execute, scope

COMPANY = "_Test Company"
ITEM = "_Test Item"
CASHIER = "ri-cashier@example.com"
WAITER = "ri-waiter@example.com"
SUPERVISOR = "ri-supervisor@example.com"
CASHIER_ROLE = "_Test RI Cashier"
SUPERVISOR_ROLE = "_Test RI Supervisor"
FRAPPE_ROLES = ["Sales User", "Sales Manager", "Accounts User", "Accounts Manager"]


def set_invoice_type(doctype):
	frappe.db.set_single_value("POS Settings", "invoice_type", doctype)
	frappe.clear_cache(doctype="POS Settings")


def seed_invoice(name, *, doctype="POS Invoice", lines=(("Nos", 1, 100),), **values):
	"""A submitted invoice written straight to the tables the reports read."""
	row = {
		"name": name,
		"docstatus": 1,
		"company": COMPANY,
		"posting_date": today(),
		"currency": "INR",
		"grand_total": sum(amount for _uom, _qty, amount in lines),
		"is_return": 0,
		"is_pos": 1,
		"pos_profile": PROFILE,
		"owner": "Administrator",
		"modified_by": "Administrator",
		**values,
	}
	columns = ", ".join(f"`{c}`" for c in row)
	frappe.db.sql(
		f"insert into `tab{doctype}` ({columns}, creation, modified) values ({', '.join(['%s'] * len(row))}, now(6), now(6))",
		tuple(row.values()),
	)
	for idx, (uom, qty, amount) in enumerate(lines, 1):
		frappe.db.sql(
			f"insert into `tab{doctype} Item` (name, parent, parenttype, parentfield, idx, item_code, item_name,"
			" uom, qty, amount, docstatus, creation, modified, owner, modified_by)"
			" values (%s,%s,%s,'items',%s,%s,%s,%s,%s,%s,1,now(6),now(6),'Administrator','Administrator')",
			(f"{name}-{idx}", name, doctype, idx, ITEM, ITEM, uom, qty, amount),
		)


def run(report, **filters):
	filters = {
		"company": COMPANY,
		"pos_profile": PROFILE,
		"from_date": add_days(today(), -30),
		"to_date": today(),
		**filters,
	}
	return as_dicts(execute.run(report, filters))


class ReportIntegrityTestCase(ReportCatalogTestCase):
	def setUp(self):
		super().setUp()
		set_invoice_type("POS Invoice")
		for user, roles in (
			(CASHIER, FRAPPE_ROLES),
			(WAITER, FRAPPE_ROLES),
			(SUPERVISOR, FRAPPE_ROLES),
		):
			ensure_user(user, roles)
		ensure_pos_role(CASHIER_ROLE, ["shift_report"])
		ensure_pos_role(SUPERVISOR_ROLE, ["shift_report", "view_expected_amount"])
		make_profile(
			PROFILE,
			WH_ONE,
			users=[(CASHIER, CASHIER_ROLE, 0), (SUPERVISOR, SUPERVISOR_ROLE, 0), (WAITER, CASHIER_ROLE, 0)],
		)
		catalog.bump_version()
		as_user("Administrator")

	def tearDown(self):
		set_invoice_type("Sales Invoice")
		super().tearDown()


class TestHistoricalSales(ReportIntegrityTestCase):
	def seed_sale_and_return(self, consolidated=None):
		seed_invoice("RI-SALE-1", lines=(("Nos", 3, 300),), consolidated_invoice=consolidated)
		seed_invoice(
			"RI-RET-1",
			lines=(("Nos", -1, -100),),
			is_return=1,
			grand_total=-100,
			consolidated_invoice=consolidated,
		)

	def item_totals(self):
		return [(r["uom"], r["qty"], r["amount"]) for r in run("Sales By Item")]

	def test_a_sale_and_return_are_reported_once_before_and_after_consolidation(self):
		self.seed_sale_and_return()
		before = self.item_totals()
		frappe.db.set_value("POS Invoice", {"name": ("like", "RI-%")}, "consolidated_invoice", "ACC-SINV-RI")
		self.assertEqual(self.item_totals(), before)
		self.assertEqual(before, [("Nos", 2, 200)])

	def test_consolidated_invoices_stay_in_cashier_and_payment_reports(self):
		self.seed_sale_and_return(consolidated="ACC-SINV-RI")
		cashier = run("Sales By Cashier")
		self.assertEqual([(r["invoices"], r["returns"], r["grand_total"]) for r in cashier], [(2, 1, 200)])

	def test_shifts_across_a_date_range_all_count(self):
		seed_invoice("RI-D1", posting_date=add_days(today(), -3), consolidated_invoice="ACC-SINV-1")
		seed_invoice("RI-D2", posting_date=add_days(today(), -1), consolidated_invoice="ACC-SINV-2")
		seed_invoice("RI-D3")
		self.assertEqual(self.item_totals(), [("Nos", 3, 300)])
		self.assertEqual(run("Sales By Item", from_date=add_days(today(), -2))[0]["qty"], 2)

	def test_sales_invoice_mode_reads_pos_sales_invoices_only(self):
		set_invoice_type("Sales Invoice")
		seed_invoice("RI-SI-1", doctype="Sales Invoice")
		seed_invoice("RI-SI-2", doctype="Sales Invoice", is_pos=0)
		seed_invoice("RI-PI-IGNORED")
		self.assertEqual(self.item_totals(), [("Nos", 1, 100)])

	def test_a_date_range_is_required(self):
		with self.assertRaises(frappe.ValidationError):
			execute.run("Sales By Item", {"company": COMPANY})


class TestCurrencyGrouping(ReportIntegrityTestCase):
	def test_item_amounts_in_different_currencies_are_never_added(self):
		seed_invoice("RI-USD", currency="USD", lines=(("Nos", 1, 100),))
		seed_invoice("RI-PKR", currency="PKR", lines=(("Nos", 1, 100),))
		rows = run("Sales By Item")
		self.assertEqual(sorted((r["currency"], r["amount"]) for r in rows), [("PKR", 100), ("USD", 100)])

	def test_units_of_measure_are_never_added(self):
		seed_invoice("RI-UOM", lines=(("Nos", 6, 60), ("Box", 1, 55)))
		self.assertEqual(
			sorted((r["uom"], r["qty"], r["amount"]) for r in run("Sales By Item")),
			[("Box", 1, 55), ("Nos", 6, 60)],
		)

	def test_cashier_totals_are_per_currency(self):
		seed_invoice("RI-USD", currency="USD", grand_total=100)
		seed_invoice("RI-PKR", currency="PKR", grand_total=100)
		rows = run("Sales By Cashier")
		self.assertEqual(
			sorted((r["currency"], r["grand_total"]) for r in rows), [("PKR", 100), ("USD", 100)]
		)

	def test_the_cashier_is_who_held_the_till_not_the_document_owner(self):
		frappe.db.sql(
			"insert into `tabPOS Opening Shift` (name, user, pos_profile, company, creation, modified, owner,"
			" modified_by) values ('RI-SHIFT', %s, %s, %s, now(6), now(6), 'Administrator', 'Administrator')",
			(CASHIER, PROFILE, COMPANY),
		)
		seed_invoice("RI-SETTLED", owner=WAITER, pos_opening_shift="RI-SHIFT")
		seed_invoice("RI-NO-SHIFT", owner=WAITER)
		self.assertEqual(
			sorted((r["cashier"], r["invoices"]) for r in run("Sales By Cashier")),
			[(CASHIER, 1), (WAITER, 1)],
		)

	def test_shift_reconciliation_splits_items_and_grand_totals_by_currency(self):
		seed_invoice("RI-USD", currency="USD", grand_total=100)
		seed_invoice("RI-PKR", currency="PKR", grand_total=100)
		result = execute.run(
			"POS Shift Reconciliation",
			{"company": COMPANY, "pos_profile": PROFILE, "from_date": today(), "to_date": today()},
		)
		self.assertEqual(sorted(r["currency"] for r in as_dicts(result)), ["PKR", "USD"])
		labels = [s["label"] for s in result["report_summary"]]
		self.assertIn("Grand Total (USD)", labels)
		self.assertIn("Grand Total (PKR)", labels)


class TestBlindClosing(ReportIntegrityTestCase):
	def blind(self, on=1):
		frappe.db.set_value("POS Profile", PROFILE, "hide_expected_amount", on)
		frappe.clear_cache(doctype="POS Profile")

	def run_as(self, user, report, **filters):
		as_user(user)
		return execute.run(
			report,
			{"company": COMPANY, "from_date": today(), "to_date": today(), "pos_profile": PROFILE, **filters},
		)

	def test_a_blind_cashier_is_refused_every_expected_total_even_with_no_sales(self):
		self.blind()
		for report in ("Sales By Payment Mode", "POS Shift Reconciliation"):
			with self.assertRaises(frappe.PermissionError, msg=report):
				self.run_as(CASHIER, report)

	def test_the_direct_desk_runner_is_refused_too(self):
		self.blind()
		seed_invoice("RI-BLIND")
		from frappe.desk.query_report import run as desk_run

		as_user(CASHIER)
		for report in ("Sales By Payment Mode", "POS Shift Reconciliation"):
			with self.assertRaises(frappe.PermissionError, msg=report):
				desk_run(report, {"company": COMPANY, "from_date": today(), "to_date": today()})

	def test_a_supervisor_with_the_expected_amount_right_is_served(self):
		self.blind()
		seed_invoice("RI-BLIND")
		for report in ("Sales By Payment Mode", "POS Shift Reconciliation"):
			self.run_as(SUPERVISOR, report)

	def test_revoking_the_right_applies_to_the_next_call_of_the_same_session(self):
		self.blind()
		self.run_as(SUPERVISOR, "Sales By Payment Mode")
		as_user("Administrator")
		ensure_pos_role(SUPERVISOR_ROLE, ["shift_report"])
		clear_role_permission_cache()
		with self.assertRaises(frappe.PermissionError):
			self.run_as(SUPERVISOR, "Sales By Payment Mode")

	def test_profiles_that_do_not_hide_expected_amounts_are_unaffected(self):
		self.blind(0)
		self.run_as(CASHIER, "Sales By Payment Mode")


class TestReportRowScope(ReportIntegrityTestCase):
	"""A custom Query Report that never looks at the caller's scope must not run for restricted users."""

	UNSCOPED = "_Test RI Unscoped Sales"

	def make_unscoped(self, verified=0):
		frappe.get_doc(
			{
				"doctype": "Report",
				"report_name": self.UNSCOPED,
				"report_type": "Query Report",
				"ref_doctype": "Warehouse",
				"is_standard": "No",
				"query": "select warehouse, sum(actual_qty) as qty from `tabBin` where item_code = 'ri-none' or 1=1 group by warehouse",
				"roles": [{"role": "Stock User"}],
			}
		).insert()
		frappe.get_doc(
			{
				"doctype": "XPOS Report Setting",
				"report": self.UNSCOPED,
				"enabled": 1,
				"category": "Inventory",
				"scope_verified": verified,
			}
		).insert()
		catalog.bump_version()

	def test_a_restricted_user_cannot_see_or_run_an_unverified_report(self):
		self.make_unscoped()
		as_user("Administrator")
		self.assertIsNotNone(catalog.resolve_entry(self.UNSCOPED))
		as_user(self.restricted())
		self.assertTrue(scope.get_scope().restricted)
		self.assertIsNone(catalog.resolve_entry(self.UNSCOPED))
		with self.assertRaises(frappe.PermissionError):
			execute.run(self.UNSCOPED, {})

	def test_the_desk_runner_is_refused_for_the_same_report(self):
		self.make_unscoped()
		from frappe.desk.query_report import run as desk_run

		as_user(self.restricted())
		had_request = hasattr(frappe.local, "request")
		previous = getattr(frappe.local, "request", None)
		frappe.local.request = frappe._dict(path="/api/method/frappe.desk.query_report.run")
		frappe.form_dict.report_name = self.UNSCOPED
		try:
			with self.assertRaises(frappe.PermissionError):
				execute.guard_direct_request()
		finally:
			if had_request:
				frappe.local.request = previous
			else:
				del frappe.local.request
			frappe.form_dict.pop("report_name", None)
		self.assertTrue(desk_run)

	def test_an_unrestricted_user_and_a_verified_report_still_run(self):
		self.make_unscoped()
		as_user("Administrator")
		self.assertTrue(execute.run(self.UNSCOPED, {})["result"])

		as_user("Administrator")
		frappe.db.set_value("XPOS Report Setting", self.UNSCOPED, "scope_verified", 1)
		catalog.bump_version()
		as_user(self.restricted())
		self.assertIsNotNone(catalog.resolve_entry(self.UNSCOPED))

	def test_bundled_reports_hold_a_restricted_user_to_their_warehouse(self):
		as_user(self.restricted())
		self.assertEqual(scope.get_scope().warehouses, {WH_ONE})
		with self.assertRaises(frappe.PermissionError):
			execute.run("Stock Audit Report", {"company": COMPANY, "warehouse": [WH_TWO]})

	def test_a_company_filter_is_filled_in_when_only_one_company_is_permitted(self):
		as_user(self.restricted())
		entry = catalog.resolve_entry("Stock Audit Report")
		filters = {}
		execute.apply_scope(entry, filters)
		self.assertEqual(filters.get("company"), COMPANY)

	def restricted(self):
		ensure_user(CASHIER, [*FRAPPE_ROLES, "Stock User"])
		return CASHIER


class TestResultSize(ReportIntegrityTestCase):
	def test_a_result_over_the_cap_is_refused_not_clipped(self):
		from unittest.mock import patch

		rows = [{"warehouse": "w"}] * (execute.MAX_RESULT_ROWS + 1)
		with patch.object(execute, "_run", return_value={"result": rows, "columns": []}):
			with self.assertRaises(frappe.ValidationError):
				execute.run("Sales By Item", {"company": COMPANY})
		with patch.object(execute, "_run", return_value={"result": rows[:5], "columns": []}):
			self.assertEqual(len(execute.run("Sales By Item", {"company": COMPANY})["result"]), 5)
