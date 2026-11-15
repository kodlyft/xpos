# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""Live checks of the server-driven POS report catalog, its access rules and row scope.

Run on a disposable test site::

    bench --site <site> run-tests --module xpos.api.tests.test_report_catalog
"""

import frappe
from erpnext.stock.utils import get_or_make_bin
from erpnext.tests.utils import ERPNextTestSuite

from xpos.api import reports as reports_api
from xpos.api.tests.test_profile_settings_hardening import ensure_pos_role, ensure_user, make_profile
from xpos.reports import catalog, execute, scope
from xpos.reports import filters as report_filters

WH_ONE = "_Test Warehouse - _TC"
WH_TWO = "_Test Warehouse 2 - _TC"
ITEM = "_Test Item"
STOCK_USER = "rc-stock@example.com"
BOUND_USER = "rc-bound@example.com"
ACCOUNTS_USER = "rc-accounts@example.com"
OUTSIDER = "rc-outsider@example.com"
LIABILITY_ROLE = "_Test RC Liability"
PLAIN_ROLE = "_Test RC Plain"
OUTSIDER_ROLE = "_Test RC Outsider"
PROFILE = "_Test RC Profile"
AUDIT = "Stock Audit Report"
GIFT = "Gift Card Liability"
DEMO = "_Test RC Demo Report"
CUSTOM = "_Test RC Custom Audit"
DEMO_SQL = "select name as item_code, item_name from `tabItem` where name = %(item)s"


def as_user(user):
	frappe.set_user(user)
	frappe.local.xpos_report_scopes = {}


def seed_bin(warehouse, qty):
	bin_name = get_or_make_bin(ITEM, warehouse)
	frappe.db.set_value("Bin", bin_name, {"actual_qty": qty, "stock_value": qty * 10})


def as_dicts(result):
	names = [column["fieldname"] for column in result["columns"]]
	return [row if isinstance(row, dict) else dict(zip(names, row, strict=False)) for row in result["result"]]


def warehouses_of(result):
	return {
		row["warehouse"]
		for row in as_dicts(result)
		if row.get("warehouse") in (WH_ONE, WH_TWO) and row.get("item_code", ITEM) == ITEM
	}


def audit_warehouses(filters=None):
	return sorted(warehouses_of(execute.run(AUDIT, {"company": "_Test Company", **(filters or {})})))


class ReportCatalogTestCase(ERPNextTestSuite):
	def setUp(self):
		frappe.set_user("Administrator")
		frappe.local.xpos_report_scopes = {}
		if not frappe.db.exists("Role", OUTSIDER_ROLE):
			frappe.get_doc({"doctype": "Role", "role_name": OUTSIDER_ROLE}).insert()
		for user, roles in (
			(STOCK_USER, ["Stock User"]),
			(BOUND_USER, ["Stock User"]),
			(ACCOUNTS_USER, ["Accounts User"]),
			(OUTSIDER, [OUTSIDER_ROLE]),
		):
			ensure_user(user, roles)
		ensure_pos_role(LIABILITY_ROLE, ["gift_card_liability_report"])
		ensure_pos_role(PLAIN_ROLE, [])
		make_profile(PROFILE, WH_ONE, users=[(BOUND_USER, PLAIN_ROLE, 0), (ACCOUNTS_USER, PLAIN_ROLE, 0)])
		seed_bin(WH_ONE, 5)
		seed_bin(WH_TWO, 7)
		catalog.bump_version()

	def tearDown(self):
		frappe.set_user("Administrator")
		frappe.db.rollback()
		for name in (DEMO, CUSTOM, "_Test RC Odd Filter", "Low Qty Sales Report"):
			frappe.clear_document_cache("Report", name)
		frappe.local.xpos_report_scopes = {}
		catalog.bump_version()


class TestCatalogAccess(ReportCatalogTestCase):
	def ids(self):
		return {entry["id"] for entry in catalog.get_catalog()}

	def test_module_reports_are_offered_without_declarations(self):
		as_user("Administrator")
		ids = self.ids()
		self.assertTrue({AUDIT, GIFT, "POS Shift Reconciliation", "Low Qty Sales Report"} <= ids)
		self.assertEqual(
			{e["capability"]["state"] for e in catalog.get_catalog() if e["id"] in ids}, {"supported"}
		)

	def test_permitted_user_sees_only_what_their_roles_allow(self):
		as_user(STOCK_USER)
		ids = self.ids()
		self.assertIn(AUDIT, ids)
		self.assertNotIn(GIFT, ids)

	def test_denied_user_has_no_reports_and_cannot_run_one(self):
		as_user(OUTSIDER)
		self.assertEqual(self.ids(), set())
		with self.assertRaises(frappe.PermissionError):
			execute.run(AUDIT, {"company": "_Test Company"})

	def test_unknown_and_forbidden_reports_are_refused_alike(self):
		as_user(STOCK_USER)
		for name in (GIFT, "No Such Report"):
			with self.assertRaises(frappe.PermissionError) as ctx:
				reports_api.get_report_meta(name)
			self.assertIn("do not have access", str(ctx.exception))

	def test_gift_card_liability_needs_report_access_and_pos_permission(self):
		frappe.db.set_value(
			"POS Profile User", {"parent": PROFILE, "user": ACCOUNTS_USER}, "pos_role", PLAIN_ROLE
		)
		catalog.bump_version()
		as_user(ACCOUNTS_USER)
		self.assertNotIn(GIFT, self.ids())

		as_user("Administrator")
		frappe.db.set_value(
			"POS Profile User", {"parent": PROFILE, "user": ACCOUNTS_USER}, "pos_role", LIABILITY_ROLE
		)
		catalog.bump_version()
		as_user(ACCOUNTS_USER)
		self.assertIn(GIFT, self.ids())
		meta = reports_api.get_report_meta("gift-card-liability")
		self.assertEqual(
			[f["fieldname"] for f in meta["filters"]], ["company", "from_date", "to_date", "gift_card"]
		)

	def test_legacy_slugs_and_aliases_resolve_to_the_canonical_report(self):
		as_user("Administrator")
		for slug, name in (
			("pos-shift-reconciliation", "POS Shift Reconciliation"),
			("current-stock-with-levels", "Current Stock with Levels"),
			("stock-value-by-warehouse", "Stock Value by Warehouse"),
			("stock-audit-report", AUDIT),
		):
			self.assertEqual(catalog.resolve_entry(slug)["id"], name)
		self.assertEqual(catalog.resolve_entry("Stock Audit Report")["slug"], "stock-audit-report")

		frappe.get_doc(
			{
				"doctype": "XPOS Report Setting",
				"report": AUDIT,
				"enabled": 1,
				"aliases": "old-audit\nstocktake",
			}
		).insert()
		as_user("Administrator")
		self.assertEqual(catalog.resolve_entry("stocktake")["id"], AUDIT)

	def test_disabling_a_report_removes_it_at_once(self):
		as_user(STOCK_USER)
		self.assertIn(AUDIT, self.ids())
		as_user("Administrator")
		frappe.get_doc({"doctype": "XPOS Report Setting", "report": AUDIT, "enabled": 0}).insert()
		as_user(STOCK_USER)
		self.assertNotIn(AUDIT, self.ids())
		with self.assertRaises(frappe.PermissionError):
			execute.run(AUDIT, {"company": "_Test Company"})

		as_user("Administrator")
		frappe.db.set_value("Report", "Low Qty Sales Report", "disabled", 1)
		frappe.clear_document_cache("Report", "Low Qty Sales Report")
		catalog.bump_version()
		as_user("Administrator")
		self.assertIsNone(catalog.resolve_entry("low-qty-sales-report"))

	def test_export_needs_the_export_right_and_the_declaration(self):
		as_user("Administrator")
		frappe.get_doc(
			{"doctype": "XPOS Report Setting", "report": AUDIT, "enabled": 1, "allow_export": 0}
		).insert()
		as_user("Administrator")
		self.assertFalse(catalog.resolve_entry(AUDIT)["export"]["allowed"])
		with self.assertRaises(frappe.PermissionError):
			execute.run(AUDIT, {"company": "_Test Company"}, purpose="export")
		execute.run(AUDIT, {"company": "_Test Company"})

	def test_custom_report_follows_its_reference_report(self):
		as_user("Administrator")
		custom = frappe.get_doc(
			{
				"doctype": "Report",
				"report_name": CUSTOM,
				"report_type": "Custom Report",
				"reference_report": AUDIT,
				"ref_doctype": "Item",
				"is_standard": "No",
				"json": frappe.as_json({"filters": {"company": "_Test Company"}, "columns": []}),
			}
		).insert()
		frappe.get_doc({"doctype": "XPOS Report Setting", "report": custom.name, "enabled": 1}).insert()
		as_user("Administrator")
		entry = catalog.resolve_entry(custom.name)
		self.assertEqual(entry["ref_doctype"], "Item")
		defaults = {
			f["fieldname"]: f.get("defaultValue") for f in reports_api.get_report_meta(custom.name)["filters"]
		}
		self.assertEqual(defaults["company"], "_Test Company")
		as_user(OUTSIDER)
		self.assertIsNone(catalog.resolve_entry(custom.name))


SHIFT_REPORTS = ("Sales By Item", "Sales By Payment Mode", "Sales By Cashier", "Low Stock Items")


class TestShiftReports(ReportCatalogTestCase):
	def test_shift_reports_are_offered_with_structured_filters_and_run(self):
		as_user("Administrator")
		today = frappe.utils.today()
		for name in SHIFT_REPORTS:
			entry = catalog.resolve_entry(name)
			self.assertEqual(entry["capability"]["state"], "supported", name)
			fields = [f["fieldname"] for f in reports_api.get_report_meta(name)["filters"]]
			self.assertEqual(fields[0], "company")
			result = execute.run(name, {"company": "_Test Company", "from_date": today, "to_date": today})
			self.assertIn("columns", result)

	def test_low_stock_items_lists_only_items_at_their_reorder_level(self):
		item = frappe.get_doc("Item", ITEM)
		item.set("reorder_levels", [])
		item.append(
			"reorder_levels",
			{"warehouse": WH_ONE, "warehouse_reorder_level": 10, "warehouse_reorder_qty": 20},
		)
		item.append(
			"reorder_levels", {"warehouse": WH_TWO, "warehouse_reorder_level": 3, "warehouse_reorder_qty": 20}
		)
		item.reorder_levels[0].material_request_type = item.reorder_levels[1].material_request_type = (
			"Purchase"
		)
		item.save()
		as_user("Administrator")
		self.assertEqual(
			warehouses_of(execute.run("Low Stock Items", {"company": "_Test Company"})), {WH_ONE}
		)

		as_user(BOUND_USER)
		with self.assertRaises(frappe.PermissionError):
			execute.run("Low Stock Items", {"company": "_Test Company", "warehouse": WH_TWO})

	def test_sales_reports_refuse_a_profile_outside_the_users_scope(self):
		as_user(BOUND_USER)
		other = "_Test RC Other Profile"
		make_profile(other, WH_TWO)
		as_user(BOUND_USER)
		today = frappe.utils.today()
		with self.assertRaises(frappe.PermissionError):
			execute.run(
				"Sales By Item",
				{"company": "_Test Company", "from_date": today, "to_date": today, "pos_profile": other},
			)


class TestFilterContract(ReportCatalogTestCase):
	def test_unsupported_filter_type_needs_an_adapter(self):
		report = frappe.get_doc(
			{
				"doctype": "Report",
				"report_name": "_Test RC Odd Filter",
				"report_type": "Query Report",
				"ref_doctype": "Item",
				"is_standard": "No",
				"query": DEMO_SQL,
				"filters": [{"fieldname": "stamp", "label": "Stamp", "fieldtype": "Datetime"}],
			}
		).insert()
		state, reasons, _filters = catalog.assess(report, {})
		self.assertEqual(state, "adapter_required")
		self.assertTrue(reasons[0].startswith("unsupported_filter_type:stamp"))

	def test_script_only_filters_are_adapter_required_and_never_run(self):
		report = frappe.get_doc("Report", "Stock Ledger")
		state, reasons, _filters = catalog.assess(report, {})
		self.assertEqual((state, reasons), ("adapter_required", ["js_only_filters"]))

	def test_prepared_reports_are_unsupported(self):
		report = frappe.get_doc("Report", AUDIT)
		report.prepared_report = 1
		self.assertEqual(catalog.assess(report, {})[0], "unsupported")

	def test_provider_output_must_be_plain_known_data(self):
		for bad in (
			[{"fieldname": "x", "label": "X", "type": "script", "required": False}],
			[{"fieldname": "Bad Name", "label": "X", "type": "text"}],
			[{"fieldname": "x", "label": "X", "type": "text", "defaultValue": {"eval": "1"}}],
			[
				{
					"fieldname": "x",
					"label": "X",
					"type": "link",
					"doctype": "Item",
					"getQueryFilters": {"a": "$nope"},
				}
			],
			"not a list",
		):
			with self.assertRaises(report_filters.FilterError):
				report_filters.validate_provider_output(bad)

	def test_only_registered_providers_are_called(self):
		report = frappe.get_doc("Report", AUDIT)
		with self.assertRaises(report_filters.FilterError):
			report_filters.provider_filters(report, "frappe.utils.now")


class TestReportScope(ReportCatalogTestCase):
	def test_unrestricted_user_sees_every_warehouse(self):
		as_user(STOCK_USER)
		self.assertFalse(scope.get_scope().restricted)
		self.assertEqual(audit_warehouses(), [WH_ONE, WH_TWO])

	def test_profile_bound_user_is_held_to_the_profile_warehouse(self):
		as_user(BOUND_USER)
		self.assertEqual(scope.get_scope().warehouses, {WH_ONE})
		self.assertEqual(audit_warehouses(), [WH_ONE])
		with self.assertRaises(frappe.PermissionError):
			audit_warehouses({"warehouse": [WH_TWO]})

	def test_user_permissions_take_precedence_over_the_profile(self):
		as_user("Administrator")
		frappe.get_doc(
			{"doctype": "User Permission", "user": BOUND_USER, "allow": "Warehouse", "for_value": WH_TWO}
		).insert()
		as_user(BOUND_USER)
		self.assertEqual(audit_warehouses(), [WH_TWO])

	def test_company_user_permission_limits_company_and_its_warehouses(self):
		as_user("Administrator")
		frappe.get_doc(
			{
				"doctype": "User Permission",
				"user": STOCK_USER,
				"allow": "Company",
				"for_value": "_Test Company 1",
			}
		).insert()
		as_user(STOCK_USER)
		with self.assertRaises(frappe.PermissionError):
			audit_warehouses()
		self.assertNotIn(WH_ONE, scope.get_scope().warehouses)

	def test_direct_report_runner_is_scoped_too(self):
		as_user(BOUND_USER)
		from frappe.desk.query_report import run

		result = run(AUDIT, {"company": "_Test Company"})
		self.assertEqual(warehouses_of(result), {WH_ONE})
		with self.assertRaises(frappe.PermissionError):
			run(AUDIT, {"company": "_Test Company", "warehouse": [WH_TWO]})

	def test_stock_value_by_warehouse_is_scoped(self):
		as_user(BOUND_USER)
		result = execute.run("Stock Value by Warehouse", {"company": "_Test Company"})
		self.assertEqual(warehouses_of(result), {WH_ONE})


class TestAddingAReportWithoutFrontendChanges(ReportCatalogTestCase):
	def test_an_enabled_query_report_appears_with_filters_and_runs(self):
		frappe.get_doc(
			{
				"doctype": "Report",
				"report_name": DEMO,
				"report_type": "Query Report",
				"ref_doctype": "Item",
				"is_standard": "No",
				"query": DEMO_SQL.replace("%(item)s", "%(item)s"),
				"filters": [
					{
						"fieldname": "item",
						"label": "Item",
						"fieldtype": "Link",
						"options": "Item",
						"mandatory": 1,
					}
				],
				"roles": [{"role": "Stock User"}],
			}
		).insert()
		as_user(STOCK_USER)
		self.assertIsNone(catalog.resolve_entry(DEMO))

		as_user("Administrator")
		frappe.get_doc(
			{"doctype": "XPOS Report Setting", "report": DEMO, "enabled": 1, "category": "Inventory"}
		).insert()

		as_user(STOCK_USER)
		entry = catalog.resolve_entry(DEMO)
		self.assertEqual((entry["category"], entry["capability"]["state"]), ("Inventory", "supported"))
		meta = reports_api.get_report_meta("-test-rc-demo-report")
		self.assertEqual(
			[(f["fieldname"], f["type"], f["doctype"], f["required"]) for f in meta["filters"]],
			[("item", "link", "Item", True)],
		)
		rows = as_dicts(reports_api.run_report(DEMO, {"item": ITEM}))
		self.assertEqual(rows[0]["item_code"], ITEM)
