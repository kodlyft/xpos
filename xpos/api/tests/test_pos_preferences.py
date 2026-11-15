# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""Layout preference tests.

Run on a disposable test site::

    bench --site <site> run-tests --module xpos.api.tests.test_pos_preferences
"""

import json
import unittest

import frappe
from erpnext.tests.utils import ERPNextTestSuite

from xpos.api import pos_preferences as prefs
from xpos.api.tests.test_endpoint_exposure import is_whitelisted
from xpos.api.tests.test_profile_settings_hardening import (
	ITEM_A,
	ITEM_B,
	ensure,
	ensure_user,
	make_profile,
	setup_fixtures,
)

PROFILE = "_Test Layout Profile"
OTHER_PROFILE = "_Test Layout Other Profile"
ALICE = "layout-alice@example.com"
BOB = "layout-bob@example.com"
OUTSIDER = "layout-outsider@example.com"
DISABLED_ITEM = "_Test Layout Disabled Item"


def policy(**changes):
	value = json.loads(json.dumps(prefs.DEFAULT_POLICY))
	value.update(changes)
	return value


class TestRules(unittest.TestCase):
	def test_unreadable_data_is_recovered_not_raised(self):
		for bad in ("{not json", "[1, 2]", 5, {"version": 99}):
			layout, recovered = prefs.migrate(bad)
			self.assertEqual(layout, {})
			self.assertTrue(recovered, bad)

	def test_empty_is_not_a_recovery(self):
		self.assertEqual(prefs.migrate(None), ({}, False))

	def test_unversioned_layout_is_migrated(self):
		layout, recovered = prefs.migrate({"pinned": ["A"], "density": "touch", "view": "list"})
		self.assertFalse(recovered)
		clean = prefs.sanitize(layout, policy())
		self.assertEqual(clean["shared"]["pinnedItems"], ["A"])
		self.assertEqual(clean["shared"]["view"], "list")
		self.assertEqual(clean["device"]["desktop"]["density"], "touch")

	def test_sanitize_drops_unknown_and_bounds_values(self):
		clean = prefs.sanitize(
			{
				"version": 1,
				"shared": {
					"pinnedItems": ["A", "A", 5, "", "B"],
					"view": "cards",
					"productDisplay": ["image", "price", "stock"],
					"quickActions": {"footer": ["hold", "nope", "pay"], "row": "remove"},
					"rate": 5,
				},
				"device": {
					"desktop": {"density": "huge", "cartSide": "left", "cartWidth": 99999},
					"watch": {"density": "touch"},
				},
			},
			policy(),
		)
		self.assertEqual(clean["shared"]["pinnedItems"], ["A", "B"])
		self.assertNotIn("view", clean["shared"])
		self.assertEqual(clean["shared"]["productDisplay"], ["image", "stock"])
		self.assertEqual(clean["shared"]["quickActions"], {"footer": ["hold"], "row": []})
		self.assertNotIn("rate", clean["shared"])
		self.assertEqual(clean["device"], {"desktop": {"cartSide": "left", "cartWidth": 900}})

	def test_cart_tabs_placement_is_top_or_bottom_only(self):
		self.assertEqual(prefs.builtin_layout("grid")["device"]["phone"]["cartTabs"], "top")
		clean = prefs.sanitize(
			{"device": {"desktop": {"cartTabs": "bottom"}, "tablet": {"cartTabs": "hidden"}}}, policy()
		)
		self.assertEqual(clean["device"], {"desktop": {"cartTabs": "bottom"}})

		defaults = prefs.builtin_layout("grid")
		open_policy = policy()
		self.assertEqual(
			prefs.effective_layout(clean, defaults, open_policy)["device"]["desktop"]["cartTabs"], "bottom"
		)
		locked = policy(locks={**open_policy["locks"], "cart_layout": True})
		self.assertEqual(
			prefs.effective_layout(clean, defaults, locked)["device"]["desktop"]["cartTabs"], "top"
		)

	def test_no_prices_stock_or_permissions_survive(self):
		clean = prefs.sanitize(
			{"shared": {"pinnedItems": ["A"], "prices": {"A": 1}, "stock": 5, "permissions": ["x"]}},
			policy(),
		)
		self.assertEqual(set(clean["shared"]), {"pinnedItems"})

	def test_caps_truncate(self):
		clean = prefs.sanitize(
			{"shared": {"pinnedItems": [f"I{n}" for n in range(30)]}}, policy(max_pinned_items=3)
		)
		self.assertEqual(len(clean["shared"]["pinnedItems"]), 3)

	def test_precedence_personal_over_default_and_locks_over_personal(self):
		defaults = prefs.builtin_layout("grid")
		personal = prefs.sanitize(
			{
				"shared": {"view": "list", "favoriteCategories": ["Drinks"]},
				"device": {"desktop": {"density": "touch", "cartSide": "left"}},
			},
			policy(),
		)
		open_policy = policy()
		result = prefs.effective_layout(personal, defaults, open_policy)
		self.assertEqual(result["shared"]["view"], "list")
		self.assertEqual(result["device"]["tablet"]["density"], "touch")  # falls back to desktop
		self.assertEqual(result["device"]["desktop"]["cartSide"], "left")

		locked = policy(locks={**open_policy["locks"], "view_and_density": True, "cart_layout": True})
		result = prefs.effective_layout(personal, defaults, locked)
		self.assertEqual(result["shared"]["view"], "grid")
		self.assertEqual(result["device"]["desktop"]["density"], "comfortable")
		self.assertEqual(result["device"]["desktop"]["cartSide"], "right")
		self.assertEqual(result["shared"]["favoriteCategories"], ["Drinks"])  # not locked

	def test_customization_off_ignores_personal_layout(self):
		personal = prefs.sanitize({"shared": {"view": "list"}}, policy())
		result = prefs.effective_layout(
			personal, prefs.builtin_layout("grid"), policy(allow_customization=False)
		)
		self.assertEqual(result["shared"]["view"], "grid")

	def test_actions_outside_the_allow_list_never_appear_and_none_are_lost(self):
		allowed = ["hold", "discount", "coupon", "clear_cart", "gift_card", "quotation"]
		personal = prefs.sanitize(
			{"shared": {"quickActions": {"footer": ["quotation", "sales_order", "hold"]}}},
			policy(allowed_footer_actions=allowed),
		)
		result = prefs.effective_layout(
			personal, prefs.builtin_layout(), policy(allowed_footer_actions=allowed)
		)
		footer = result["shared"]["quickActions"]["footer"]
		self.assertEqual(footer[:2], ["quotation", "hold"])
		self.assertEqual(sorted(footer), sorted(allowed))

	def test_image_hidden_by_profile_stays_default_but_user_may_not_force_it_on_when_disallowed(self):
		result = prefs.effective_layout(
			prefs.sanitize({"shared": {"productDisplay": ["image", "stock"]}}, policy()),
			prefs.builtin_layout("grid", ["stock"]),
			policy(allowed_display_fields=["stock", "item_code"]),
		)
		self.assertEqual(result["shared"]["productDisplay"], ["stock"])


class TestEndpoints(unittest.TestCase):
	def test_exposed(self):
		for name in ("get_layout", "save_layout", "reset_layout", "get_pinned_items"):
			self.assertTrue(is_whitelisted("xpos.api.pos_preferences", name), name)

	def test_no_user_argument(self):
		import inspect

		for name in ("get_layout", "save_layout", "reset_layout", "get_pinned_items"):
			params = inspect.signature(getattr(prefs, name)).parameters
			self.assertNotIn("user", params, name)


class TestStoredLayouts(ERPNextTestSuite):
	def setUp(self):
		frappe.set_user("Administrator")
		setup_fixtures()
		for email in (ALICE, BOB, OUTSIDER):
			ensure_user(email, ["Sales User", "Accounts User"])
		ensure(
			"Item",
			DISABLED_ITEM,
			{
				"item_code": DISABLED_ITEM,
				"item_name": DISABLED_ITEM,
				"item_group": "All Item Groups",
				"stock_uom": "Nos",
				"is_stock_item": 0,
				"is_sales_item": 1,
				"disabled": 1,
			},
		)
		make_profile(PROFILE, users=[(ALICE, "Cashier", 10), (BOB, "Cashier", 10)])
		make_profile(OTHER_PROFILE, users=[(ALICE, "Cashier", 10)])
		frappe.db.delete("XPOS User Layout")
		frappe.db.delete("XPOS Layout Policy")

	def tearDown(self):
		frappe.set_user("Administrator")

	def save(self, user, layout, revision=0, profile=PROFILE):
		frappe.set_user(user)
		return prefs.save_layout(profile, json.dumps(layout), revision)

	def test_each_user_has_their_own_layout_on_a_shared_terminal(self):
		self.save(ALICE, {"shared": {"view": "list", "pinnedItems": [ITEM_A]}})
		self.save(BOB, {"shared": {"view": "grid", "pinnedItems": [ITEM_B]}})
		frappe.set_user(ALICE)
		alice = prefs.get_layout(PROFILE)["layout"]["shared"]
		frappe.set_user(BOB)
		bob = prefs.get_layout(PROFILE)["layout"]["shared"]
		self.assertEqual((alice["view"], alice["pinnedItems"]), ("list", [ITEM_A]))
		self.assertEqual((bob["view"], bob["pinnedItems"]), ("grid", [ITEM_B]))

	def test_profiles_are_separate_for_one_user(self):
		self.save(ALICE, {"shared": {"view": "list"}})
		frappe.set_user(ALICE)
		self.assertEqual(prefs.get_layout(OTHER_PROFILE)["layout"]["shared"]["view"], "grid")

	def test_user_outside_the_profile_is_refused(self):
		frappe.set_user(OUTSIDER)
		with self.assertRaises(frappe.PermissionError):
			prefs.get_layout(PROFILE)
		with self.assertRaises(frappe.PermissionError):
			prefs.save_layout(PROFILE, "{}", 0)

	def test_user_cannot_read_anothers_row_directly(self):
		self.save(ALICE, {"shared": {"view": "list"}})
		frappe.set_user(BOB)
		with self.assertRaises(frappe.PermissionError):
			frappe.get_list("XPOS User Layout")
		name = frappe.db.get_value("XPOS User Layout", {"user": ALICE}, "name")
		self.assertFalse(frappe.has_permission("XPOS User Layout", "read", name))

	def test_saved_layout_never_carries_client_supplied_owner(self):
		result = self.save(ALICE, {"user": BOB, "shared": {"view": "list"}})
		self.assertEqual(result["status"], "saved")
		self.assertFalse(frappe.db.exists("XPOS User Layout", {"user": BOB}))

	def test_stale_revision_conflicts_and_returns_the_server_copy(self):
		first = self.save(ALICE, {"shared": {"view": "list"}})
		self.assertEqual(first["revision"], 1)
		second = self.save(ALICE, {"shared": {"view": "grid"}}, revision=1)
		self.assertEqual(second["revision"], 2)
		stale = self.save(ALICE, {"shared": {"view": "list"}}, revision=1)
		self.assertEqual(stale["status"], "conflict")
		self.assertEqual(stale["revision"], 2)
		self.assertEqual(stale["layout"]["shared"]["view"], "grid")

	def test_second_create_with_revision_zero_conflicts(self):
		self.save(ALICE, {"shared": {"view": "list"}})
		again = self.save(ALICE, {"shared": {"view": "grid"}}, revision=0)
		self.assertEqual(again["status"], "conflict")

	def test_removed_and_unsellable_products_drop_out_of_favorites(self):
		self.save(ALICE, {"shared": {"pinnedItems": [ITEM_A, DISABLED_ITEM, "_No Such Item"]}})
		frappe.set_user(ALICE)
		self.assertEqual(prefs.get_layout(PROFILE)["layout"]["shared"]["pinnedItems"], [ITEM_A])
		frappe.db.set_value("Item", ITEM_A, "disabled", 1)
		self.assertEqual(prefs.get_layout(PROFILE)["layout"]["shared"]["pinnedItems"], [])
		self.assertEqual(prefs.get_pinned_items(PROFILE), [])
		frappe.db.set_value("Item", ITEM_A, "disabled", 0)

	def test_pinned_items_return_current_price_and_stock_not_stored_values(self):
		self.save(ALICE, {"shared": {"pinnedItems": [ITEM_A]}})
		frappe.set_user(ALICE)
		rows = prefs.get_pinned_items(PROFILE)
		self.assertEqual([row.item_code for row in rows], [ITEM_A])
		self.assertEqual(rows[0].rate, 100)
		stored = frappe.db.get_value("XPOS User Layout", {"user": ALICE}, "data")
		self.assertNotIn("100", stored)

	def test_corrupt_stored_data_recovers_to_defaults(self):
		self.save(ALICE, {"shared": {"view": "list"}})
		frappe.db.set_value("XPOS User Layout", {"user": ALICE}, "data", "{{broken")
		frappe.set_user(ALICE)
		result = prefs.get_layout(PROFILE)
		self.assertTrue(result["recovered"])
		self.assertEqual(result["layout"]["shared"]["view"], "grid")

	def test_future_schema_is_recovered_not_trusted(self):
		self.save(ALICE, {"shared": {"view": "list"}})
		frappe.db.set_value("XPOS User Layout", {"user": ALICE}, "data", '{"version": 7, "shared": {}}')
		frappe.set_user(ALICE)
		self.assertTrue(prefs.get_layout(PROFILE)["recovered"])

	def test_profile_policy_overrides_personal_choice(self):
		frappe.get_doc(
			{
				"doctype": "XPOS Layout Policy",
				"pos_profile": PROFILE,
				"lock_view_and_density": 1,
				"max_pinned_items": 1,
				"allowed_footer_actions": "hold\ndiscount\ncoupon\nclear_cart\ngift_card",
				"default_layout": json.dumps({"version": 1, "shared": {"view": "list"}}),
			}
		).insert(ignore_permissions=True)
		self.save(ALICE, {"shared": {"view": "grid", "pinnedItems": [ITEM_A, ITEM_B]}})
		frappe.set_user(ALICE)
		result = prefs.get_layout(PROFILE)
		self.assertEqual(result["layout"]["shared"]["view"], "list")
		self.assertEqual(result["layout"]["shared"]["pinnedItems"], [ITEM_A])
		self.assertEqual(len(result["layout"]["shared"]["quickActions"]["footer"]), 5)

	def test_customization_switched_off_blocks_saves(self):
		frappe.get_doc(
			{"doctype": "XPOS Layout Policy", "pos_profile": PROFILE, "allow_customization": 0}
		).insert(ignore_permissions=True)
		with self.assertRaises(frappe.PermissionError):
			self.save(ALICE, {"shared": {"view": "list"}})

	def test_reset_clears_only_the_callers_layout(self):
		self.save(ALICE, {"shared": {"view": "list"}})
		self.save(BOB, {"shared": {"view": "list"}})
		frappe.set_user(ALICE)
		result = prefs.reset_layout(PROFILE)
		self.assertEqual(result["layout"]["shared"]["view"], "grid")
		self.assertEqual(result["personal"]["shared"], {})
		frappe.set_user(BOB)
		self.assertEqual(prefs.get_layout(PROFILE)["layout"]["shared"]["view"], "list")

	def test_a_stale_save_after_reset_conflicts_instead_of_overwriting(self):
		first = self.save(ALICE, {"shared": {"view": "list"}})
		self.assertEqual(first["revision"], 1)
		frappe.set_user(ALICE)
		reset = prefs.reset_layout(PROFILE)
		self.assertEqual(reset["revision"], 2)
		stale = self.save(ALICE, {"shared": {"view": "list"}}, revision=1)
		self.assertEqual(stale["status"], "conflict")
		self.assertEqual(stale["revision"], 2)
		self.assertEqual(self.save(ALICE, {"shared": {"view": "list"}}, revision=2)["revision"], 3)

	def test_a_partial_profile_default_keeps_the_other_quick_action_row(self):
		frappe.get_doc(
			{
				"doctype": "XPOS Layout Policy",
				"pos_profile": PROFILE,
				"default_layout": json.dumps(
					{"version": 1, "shared": {"quickActions": {"footer": ["hold"]}}}
				),
			}
		).insert(ignore_permissions=True)
		frappe.set_user(ALICE)
		result = prefs.get_layout(PROFILE)
		actions = result["layout"]["shared"]["quickActions"]
		self.assertEqual(actions["footer"][0], "hold")
		self.assertTrue(actions["row"])
		self.assertEqual(result["defaults"]["shared"]["quickActions"]["row"], actions["row"])

		frappe.get_doc("XPOS Layout Policy", PROFILE).db_set(
			"default_layout", json.dumps({"version": 1, "shared": {"quickActions": {"row": ["remove"]}}})
		)
		frappe.clear_cache(doctype="XPOS Layout Policy")
		actions = prefs.get_layout(PROFILE)["layout"]["shared"]["quickActions"]
		self.assertEqual(actions["row"][0], "remove")
		self.assertTrue(actions["footer"])
