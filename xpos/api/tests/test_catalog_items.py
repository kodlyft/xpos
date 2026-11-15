# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""Live checks for the catalogue, stock and price reads behind the v3 POS.

Run on a disposable test site::

    bench --site <site> run-tests --module xpos.api.tests.test_catalog_items
"""

import json

import frappe
from erpnext.tests.utils import ERPNextTestSuite

from xpos.api import items as items_api
from xpos.api.tests.test_profile_settings_hardening import ensure, ensure_user, make_profile, setup_fixtures
from xpos.perf.catalog_bench import Probe

PREFIX = "_TCI"
GROUP = "_Test CI Group"
CHILD_GROUP = "_Test CI Child Group"
OTHER_GROUP = "_Test CI Other Group"
STORE = "_Test CI Store"
PRICE_LIST = "_Test CI Prices"
CASHIER = "ci-cashier@example.com"
OUTSIDER = "ci-outsider@example.com"
PROFILE = "_Test CI Profile"
RESTRICTED = "_Test CI Restricted Profile"


def code(n):
	return f"{PREFIX}-{n:03d}"


def insert_bin(item_code, warehouse, qty):
	frappe.db.delete("Bin", {"item_code": item_code, "warehouse": warehouse})
	frappe.db.sql(
		"insert into tabBin (name, item_code, warehouse, actual_qty, creation, modified, owner, modified_by)"
		" values (%s,%s,%s,%s,now(6),now(6),'Administrator','Administrator')",
		(f"{item_code}-{warehouse}", item_code, warehouse, qty),
	)


def insert_pos_invoice(name, status, item_code, warehouse, qty, consolidated=None):
	frappe.db.sql(
		"insert into `tabPOS Invoice` (name, docstatus, consolidated_invoice, creation, modified, owner, modified_by)"
		" values (%s,%s,%s,now(6),now(6),'Administrator','Administrator')",
		(name, status, consolidated),
	)
	frappe.db.sql(
		"insert into `tabPOS Invoice Item` (name, parent, parenttype, parentfield, idx, item_code, warehouse,"
		" qty, stock_qty, docstatus, creation, modified, owner, modified_by)"
		" values (%s,%s,'POS Invoice','items',1,%s,%s,%s,%s,%s,now(6),now(6),'Administrator','Administrator')",
		(f"{name}-1", name, item_code, warehouse, qty, qty, status),
	)


class CatalogItemsTestCase(ERPNextTestSuite):
	def setUp(self):
		frappe.set_user("Administrator")
		setup_fixtures()
		company, abbr = "_Test Company", "_TC"
		for name, parent, is_group in (
			(GROUP, "All Item Groups", 1),
			(CHILD_GROUP, GROUP, 0),
			(OTHER_GROUP, "All Item Groups", 0),
		):
			ensure(
				"Item Group",
				name,
				{"item_group_name": name, "parent_item_group": parent, "is_group": is_group},
			)
		ensure(
			"Warehouse",
			f"{STORE} - {abbr}",
			{"warehouse_name": STORE, "company": company, "is_group": 1},
		)
		self.group_wh = f"{STORE} - {abbr}"
		self.leaves = []
		for n in (1, 2):
			ensure(
				"Warehouse",
				f"{STORE} {n} - {abbr}",
				{"warehouse_name": f"{STORE} {n}", "company": company, "parent_warehouse": self.group_wh},
			)
			self.leaves.append(f"{STORE} {n} - {abbr}")
		ensure("Price List", PRICE_LIST, {"price_list_name": PRICE_LIST, "selling": 1, "currency": "PKR"})

		# 6 items: two share a name (paging tie-break), one non-stock, one in another group.
		spec = {
			1: ("Alpha Bolt", CHILD_GROUP, 1),
			2: ("Alpha Bolt", CHILD_GROUP, 1),
			3: ("Bravo Nut", CHILD_GROUP, 1),
			4: ("Charlie Service", CHILD_GROUP, 0),
			5: ("Delta Washer", OTHER_GROUP, 1),
			6: ("Echo 50%_Off", CHILD_GROUP, 1),
		}
		for n, (name, group, stock) in spec.items():
			ensure(
				"Item",
				code(n),
				{
					"item_code": code(n),
					"item_name": name,
					"item_group": group,
					"stock_uom": "Nos",
					"is_stock_item": stock,
					"is_sales_item": 1,
				},
			)
		frappe.db.delete("Item Price", {"item_code": ["like", f"{PREFIX}-%"]})
		for n, rate in ((1, 10), (2, 20), (3, 30)):
			frappe.get_doc(
				{
					"doctype": "Item Price",
					"item_code": code(n),
					"price_list": PRICE_LIST,
					"price_list_rate": rate,
					"selling": 1,
				}
			).insert(ignore_permissions=True)
		# a newer row wins, as with the per-item lookup this batches
		frappe.get_doc(
			{
				"doctype": "Item Price",
				"item_code": code(3),
				"price_list": PRICE_LIST,
				"price_list_rate": 33,
				"selling": 1,
				"valid_from": "2020-01-01",
			}
		).insert(ignore_permissions=True)

		frappe.db.delete("POS Invoice Item", {"parent": ["like", f"{PREFIX}-PI-%"]})
		frappe.db.delete("POS Invoice", {"name": ["like", f"{PREFIX}-PI-%"]})
		frappe.db.delete("Bin", {"item_code": ["like", f"{PREFIX}-%"]})
		for n in (1, 3, 5, 6):
			insert_bin(code(n), self.leaves[0], 10)
		insert_bin(code(1), self.leaves[1], 5)
		insert_bin(code(6), self.leaves[0], 0)

		frappe.db.set_single_value("POS Settings", "invoice_type", "POS Invoice")
		ensure_user(CASHIER, ["Sales User"])
		ensure_user(OUTSIDER, ["Sales User"])
		self.profile = make_profile(
			PROFILE, warehouse=self.group_wh, selling_price_list=PRICE_LIST, users=[(CASHIER, None, 0)]
		)
		self.restricted = make_profile(
			RESTRICTED, warehouse=self.leaves[0], selling_price_list=PRICE_LIST, users=[(CASHIER, None, 0)]
		)

	def tearDown(self):
		frappe.set_user("Administrator")

	def page(self, **kw):
		return items_api.get_pos_items(PROFILE, **kw)

	def codes(self, rows):
		return [r.item_code for r in rows if r.item_code.startswith(PREFIX)]

	# paging ---------------------------------------------------------------

	def test_paging_is_deterministic_and_gapless(self):
		everything = self.codes(self.page(page_length=100, item_group=CHILD_GROUP))
		self.assertEqual(
			everything, sorted(everything, key=lambda c: (frappe.db.get_value("Item", c, "item_name"), c))
		)
		paged = []
		for start in range(0, len(everything), 2):
			paged += self.codes(self.page(start=start, page_length=2, item_group=CHILD_GROUP))
		self.assertEqual(paged, everything)

	def test_page_length_is_capped(self):
		self.assertLessEqual(len(self.page(page_length=10**6)), items_api.MAX_PAGE_LENGTH)

	# prices ---------------------------------------------------------------

	def test_rate_is_latest_selling_price_or_zero(self):
		rates = {r.item_code: r.rate for r in self.page(page_length=100)}
		self.assertEqual(rates[code(1)], 10)
		self.assertEqual(rates[code(3)], 33)
		self.assertEqual(rates[code(5)], 0)

	def test_price_read_is_one_query_regardless_of_page_size(self):
		self.page(page_length=1)  # warm the document and meta caches
		with Probe() as small:
			self.page(page_length=1)
		with Probe() as large:
			self.page(page_length=100)
		self.assertEqual(small.count, large.count)

	# search ---------------------------------------------------------------

	def test_prefix_search_matches_name_and_code(self):
		self.assertEqual(self.codes(self.page(search_term="Alpha")), [code(1), code(2)])
		self.assertEqual(self.codes(self.page(search_term=code(4))), [code(4)])

	def test_substring_fallback_after_prefix(self):
		self.assertEqual(self.codes(self.page(search_term="Bolt")), [code(1), code(2)])
		# below MIN_SUBSTRING_LENGTH only prefixes match
		self.assertEqual(self.codes(self.page(search_term="ol")), [])

	def test_wildcards_in_the_term_are_literal(self):
		self.assertEqual(self.codes(self.page(search_term="50%_Off")), [code(6)])
		self.assertEqual(self.codes(self.page(search_term="%")), [])
		self.assertEqual(self.codes(self.page(search_term="a\\b")), [])

	def test_prefix_hits_fill_the_page_before_substring_hits(self):
		rows = self.codes(self.page(search_term="Alpha", page_length=1))
		self.assertEqual(rows, [code(1)])
		rows = self.codes(self.page(search_term="Alpha", start=1, page_length=1))
		self.assertEqual(rows, [code(2)])

	# groups / stock ---------------------------------------------------------

	def test_item_group_filter_includes_descendants(self):
		self.assertEqual(
			set(self.codes(self.page(item_group=GROUP, page_length=100))),
			{code(1), code(2), code(3), code(4), code(6)},
		)

	def test_stock_sums_group_warehouse_and_subtracts_pending_pos(self):
		insert_pos_invoice(f"{PREFIX}-PI-1", 1, code(1), self.leaves[0], 4)
		insert_pos_invoice(f"{PREFIX}-PI-2", 0, code(1), self.leaves[0], 100)  # draft
		insert_pos_invoice(f"{PREFIX}-PI-3", 2, code(1), self.leaves[0], 100)  # cancelled
		insert_pos_invoice(f"{PREFIX}-PI-4", 1, code(1), self.leaves[0], 100, "CONSOLIDATED")
		stock = {r.item_code: r.actual_qty for r in self.page(page_length=100)}
		self.assertEqual(stock[code(1)], 15 - 4)
		got = items_api.get_stock_availability(
			json.dumps([code(1), code(5)]), warehouse=self.group_wh, pos_profile=PROFILE
		)
		self.assertEqual({r["item_code"]: r["actual_qty"] for r in got}, {code(1): 11, code(5): 10})

	def test_stock_availability_query_count_is_flat(self):
		codes = [code(n) for n in range(1, 7)]
		items_api.get_stock_availability(json.dumps(codes), warehouse=self.group_wh, pos_profile=PROFILE)
		with Probe() as few:
			items_api.get_stock_availability(
				json.dumps(codes[:1]), warehouse=self.group_wh, pos_profile=PROFILE
			)
		with Probe() as many:
			items_api.get_stock_availability(
				json.dumps(codes * 20), warehouse=self.group_wh, pos_profile=PROFILE
			)
		self.assertEqual(few.count, many.count)

	def test_hide_unavailable_keeps_non_stock_and_in_stock_only(self):
		frappe.db.set_value("POS Profile", PROFILE, "hide_unavailable_items", 1)
		frappe.get_cached_doc("POS Profile", PROFILE).reload()
		try:
			got = set(self.codes(self.page(page_length=100)))
			# 4 is a service; 6 has only a zero Bin; 2 has no Bin at all
			self.assertEqual(got, {code(1), code(3), code(4), code(5)})
			insert_pos_invoice(f"{PREFIX}-PI-5", 1, code(3), self.leaves[0], 10)
			got = set(self.codes(self.page(page_length=100)))
			self.assertNotIn(code(3), got)
			self.assertEqual(
				items_api.get_items_count(PROFILE, item_group=""),
				len(self.page(page_length=items_api.MAX_PAGE_LENGTH)),
			)
		finally:
			frappe.db.set_value("POS Profile", PROFILE, "hide_unavailable_items", 0)

	# scoping ----------------------------------------------------------------

	def test_stock_warehouse_must_belong_to_the_profile(self):
		with self.assertRaises(frappe.PermissionError):
			items_api.get_stock_availability(
				json.dumps([code(1)]), warehouse=self.leaves[1], pos_profile=RESTRICTED
			)
		with self.assertRaises(frappe.PermissionError):
			items_api.get_stock_availability(
				json.dumps([{"item_code": code(1), "warehouse": self.leaves[1]}]),
				warehouse=self.leaves[0],
				pos_profile=RESTRICTED,
			)
		items_api.get_stock_availability(
			json.dumps([code(1)]), warehouse=self.leaves[0], pos_profile=RESTRICTED
		)

	def test_profile_that_lists_users_rejects_others(self):
		frappe.db.delete("Has Role", {"parent": OUTSIDER, "role": ["in", ["Sales User", "Accounts User"]]})
		frappe.clear_cache(user=OUTSIDER)
		frappe.set_user(OUTSIDER)
		with self.assertRaises(frappe.PermissionError):
			items_api.get_pos_items(PROFILE)
		with self.assertRaises(frappe.PermissionError):
			items_api.get_item_groups(PROFILE)
		frappe.set_user(CASHIER)
		self.assertTrue(items_api.get_item_groups(PROFILE))

	def test_item_permissions_still_apply(self):
		frappe.set_user(CASHIER)
		before = set(self.codes(items_api.get_pos_items(PROFILE, page_length=100)))
		frappe.set_user("Administrator")
		frappe.get_doc(
			{
				"doctype": "User Permission",
				"user": CASHIER,
				"allow": "Item Group",
				"for_value": OTHER_GROUP,
				"apply_to_all_doctypes": 1,
			}
		).insert(ignore_permissions=True)
		try:
			frappe.clear_cache(user=CASHIER)
			frappe.set_user(CASHIER)
			after = set(self.codes(items_api.get_pos_items(PROFILE, page_length=100)))
		finally:
			frappe.set_user("Administrator")
			frappe.db.delete("User Permission", {"user": CASHIER})
			frappe.clear_cache(user=CASHIER)
		self.assertGreater(len(before), len(after))
		self.assertEqual(after, {code(5)})
