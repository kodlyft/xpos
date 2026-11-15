# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

import json

import frappe
from frappe import _
from frappe.utils import cint, flt

from xpos.api import items as items_api
from xpos.api.profiles import resolve_pos_profile
from xpos.utils import read_latest_on_lock

SCHEMA_VERSION = 1
DEVICE_CLASSES = ("desktop", "tablet", "phone")
DENSITIES = ("compact", "comfortable", "touch")
VIEWS = ("grid", "list")
CART_SIDES = ("left", "right")
CART_WIDTH_RANGE = (320, 900)
MIN_VISIBLE_ACTIONS = 5

FOOTER_ACTIONS = (
	"hold",
	"discount",
	"coupon",
	"clear_discounts",
	"delivery_charge",
	"restore_draft",
	"gift_card",
	"sales_order",
	"quotation",
	"clear_cart",
)
CART_TABS = ("top", "bottom")
ROW_ACTIONS = ("uom", "tracking", "item_discount", "remove")
DISPLAY_FIELDS = ("image", "item_code", "stock", "uom")
DEFAULT_DISPLAY = ("image", "item_code", "stock")

SECTIONS = {
	"pinned_items": "lock_pinned_items",
	"favorite_categories": "lock_favorite_categories",
	"view_and_density": "lock_view_and_density",
	"product_display": "lock_product_display",
	"cart_layout": "lock_cart_layout",
	"quick_actions": "lock_quick_actions",
}

DEFAULT_POLICY = {
	"allow_customization": True,
	"max_pinned_items": 24,
	"max_favorite_categories": 12,
	"min_visible_actions": MIN_VISIBLE_ACTIONS,
	"locks": dict.fromkeys(SECTIONS, False),
	"allowed_footer_actions": list(FOOTER_ACTIONS),
	"allowed_row_actions": list(ROW_ACTIONS),
	"allowed_display_fields": list(DISPLAY_FIELDS),
}


def builtin_layout(view: str = "grid", display: list[str] | None = None) -> dict:
	return {
		"version": SCHEMA_VERSION,
		"shared": {
			"pinnedItems": [],
			"favoriteCategories": [],
			"quickActions": {"footer": list(FOOTER_ACTIONS), "row": list(ROW_ACTIONS)},
			"productDisplay": list(DEFAULT_DISPLAY) if display is None else display,
			"view": view,
		},
		"device": {
			name: {"density": "comfortable", "cartSide": "right", "cartWidth": None, "cartTabs": "top"}
			for name in DEVICE_CLASSES
		},
	}


def text_list(
	value, allowed: tuple[str, ...] | list[str] | None = None, limit: int | None = None
) -> list[str]:
	"""Distinct strings in their given order, restricted to ``allowed`` when given."""
	if not isinstance(value, list):
		return []
	seen: list[str] = []
	for entry in value:
		if not isinstance(entry, str) or not entry or len(entry) > 140 or entry in seen:
			continue
		if allowed is not None and entry not in allowed:
			continue
		seen.append(entry)
		if limit is not None and len(seen) >= limit:
			break
	return seen


def migrate(data) -> tuple[dict, bool]:
	"""Bring stored preferences to the current schema. Returns (layout, recovered).

	Anything unreadable or from a newer schema than this code understands is dropped
	rather than guessed at, and ``recovered`` tells the client to say so.
	"""
	if isinstance(data, str):
		try:
			data = json.loads(data)
		except ValueError:
			return {}, True
	if data in (None, "", {}):
		return {}, False
	if not isinstance(data, dict):
		return {}, True
	version = data.get("version")
	if version == SCHEMA_VERSION or (version is None and ("shared" in data or "device" in data)):
		return data, False
	if version == 0 or version is None:
		# Pre-versioned shape: flat keys, no device split.
		legacy = {
			"version": SCHEMA_VERSION,
			"shared": {
				"pinnedItems": data.get("pinned") or data.get("pinnedItems"),
				"favoriteCategories": data.get("favorites") or data.get("favoriteCategories"),
				"view": data.get("view"),
			},
			"device": {"desktop": {"density": data.get("density"), "cartWidth": data.get("cartWidth")}},
		}
		return legacy, False
	return {}, True


def sanitize(data, policy: dict) -> dict:
	"""A personal layout reduced to known, bounded values. Missing sections stay missing."""
	data, _recovered = migrate(data)
	shared = data.get("shared") if isinstance(data.get("shared"), dict) else {}
	device = data.get("device") if isinstance(data.get("device"), dict) else {}
	out: dict = {"version": SCHEMA_VERSION, "shared": {}, "device": {}}

	if "pinnedItems" in shared:
		out["shared"]["pinnedItems"] = text_list(shared["pinnedItems"], limit=policy["max_pinned_items"])
	if "favoriteCategories" in shared:
		out["shared"]["favoriteCategories"] = text_list(
			shared["favoriteCategories"], limit=policy["max_favorite_categories"]
		)
	if shared.get("view") in VIEWS:
		out["shared"]["view"] = shared["view"]
	if "productDisplay" in shared:
		out["shared"]["productDisplay"] = text_list(
			shared["productDisplay"], policy["allowed_display_fields"]
		)
	actions = shared.get("quickActions")
	if isinstance(actions, dict):
		clean = {}
		if "footer" in actions:
			clean["footer"] = text_list(actions["footer"], policy["allowed_footer_actions"])
		if "row" in actions:
			clean["row"] = text_list(actions["row"], policy["allowed_row_actions"])
		out["shared"]["quickActions"] = clean

	for name in DEVICE_CLASSES:
		entry = device.get(name)
		if not isinstance(entry, dict):
			continue
		clean = {}
		if entry.get("density") in DENSITIES:
			clean["density"] = entry["density"]
		if entry.get("cartSide") in CART_SIDES:
			clean["cartSide"] = entry["cartSide"]
		if entry.get("cartTabs") in CART_TABS:
			clean["cartTabs"] = entry["cartTabs"]
		width = entry.get("cartWidth")
		if isinstance(width, (int, float)) and not isinstance(width, bool):
			clean["cartWidth"] = int(min(max(width, CART_WIDTH_RANGE[0]), CART_WIDTH_RANGE[1]))
		if clean:
			out["device"][name] = clean
	return out


def complete_actions(chosen: list[str], allowed: list[str], order: tuple[str, ...]) -> list[str]:
	"""Chosen actions first, then every other allowed action, so none is lost from the menu."""
	rest = [name for name in order if name in allowed and name not in chosen]
	return [name for name in chosen if name in allowed] + rest


def effective_layout(personal: dict, defaults: dict, policy: dict) -> dict:
	"""Precedence: locked section -> profile default; else personal; else profile default."""
	locks = policy["locks"]
	off = not policy["allow_customization"]
	shared_personal = {} if off else personal.get("shared", {})
	device_personal = {} if off else personal.get("device", {})
	base = defaults["shared"]

	def pick(section: str, key: str, fallback):
		if locks[section]:
			return fallback
		return shared_personal.get(key, fallback)

	shared = {
		"pinnedItems": pick("pinned_items", "pinnedItems", base["pinnedItems"])[: policy["max_pinned_items"]],
		"favoriteCategories": pick("favorite_categories", "favoriteCategories", base["favoriteCategories"])[
			: policy["max_favorite_categories"]
		],
		"view": base["view"] if locks["view_and_density"] else shared_personal.get("view", base["view"]),
		"productDisplay": text_list(
			pick("product_display", "productDisplay", base["productDisplay"]),
			policy["allowed_display_fields"],
		),
	}
	chosen = base["quickActions"] if locks["quick_actions"] else shared_personal.get("quickActions", {})
	shared["quickActions"] = {
		"footer": complete_actions(
			chosen.get("footer", base["quickActions"]["footer"]),
			policy["allowed_footer_actions"],
			FOOTER_ACTIONS,
		),
		"row": complete_actions(
			chosen.get("row", base["quickActions"]["row"]), policy["allowed_row_actions"], ROW_ACTIONS
		),
	}

	device = {}
	for name in DEVICE_CLASSES:
		default = defaults["device"][name]
		mine = device_personal.get(name) or device_personal.get("desktop") or {}
		device[name] = {
			"density": default["density"]
			if locks["view_and_density"]
			else mine.get("density", default["density"]),
			"cartSide": default["cartSide"]
			if locks["cart_layout"]
			else mine.get("cartSide", default["cartSide"]),
			"cartWidth": default["cartWidth"]
			if locks["cart_layout"]
			else mine.get("cartWidth", default["cartWidth"]),
			"cartTabs": default["cartTabs"]
			if locks["cart_layout"]
			else mine.get("cartTabs", default["cartTabs"]),
		}
	return {"version": SCHEMA_VERSION, "shared": shared, "device": device}


def load_policy(pos_profile: str) -> tuple[dict, dict]:
	"""The profile's policy and its (sanitised) default layout."""
	policy = json.loads(json.dumps(DEFAULT_POLICY))
	profile = frappe.get_cached_doc("POS Profile", pos_profile)
	view = "list" if (profile.get("default_view") or "").lower() == "list" else "grid"
	display = [name for name in DEFAULT_DISPLAY if not (name == "image" and cint(profile.get("hide_images")))]
	defaults = builtin_layout(view, display)

	if not frappe.db.exists("XPOS Layout Policy", pos_profile):
		return policy, defaults
	row = frappe.get_cached_doc("XPOS Layout Policy", pos_profile)

	policy["allow_customization"] = bool(cint(row.allow_customization))
	policy["max_pinned_items"] = max(cint(row.max_pinned_items), 0)
	policy["max_favorite_categories"] = max(cint(row.max_favorite_categories), 0)
	policy["min_visible_actions"] = max(cint(row.min_visible_actions), MIN_VISIBLE_ACTIONS)
	for section, field in SECTIONS.items():
		policy["locks"][section] = bool(cint(row.get(field)))
	for field, key, known in (
		("allowed_footer_actions", "allowed_footer_actions", FOOTER_ACTIONS),
		("allowed_row_actions", "allowed_row_actions", ROW_ACTIONS),
		("allowed_display_fields", "allowed_display_fields", DISPLAY_FIELDS),
	):
		listed = text_list(
			[line.strip() for line in (row.get(field) or "").replace(",", "\n").split("\n")], known
		)
		if listed:
			policy[key] = listed

	profile_default = sanitize(row.default_layout, policy)
	chosen_actions = profile_default["shared"].pop("quickActions", {})
	defaults["shared"].update(profile_default["shared"])
	defaults["shared"]["quickActions"] = {**defaults["shared"]["quickActions"], **chosen_actions}
	for name, entry in profile_default["device"].items():
		defaults["device"][name].update(entry)
	defaults["shared"]["quickActions"] = {
		"footer": complete_actions(
			defaults["shared"]["quickActions"]["footer"], policy["allowed_footer_actions"], FOOTER_ACTIONS
		),
		"row": complete_actions(
			defaults["shared"]["quickActions"]["row"], policy["allowed_row_actions"], ROW_ACTIONS
		),
	}
	return policy, defaults


def sellable_codes(pos, codes: list[str]) -> list[str]:
	"""``codes`` that this profile can sell, in the given order."""
	if not codes:
		return []
	filters = items_api.build_item_filters(pos, "", False, {"item_code": ["in", codes]})
	found = set(frappe.get_list("Item", filters=filters, pluck="name", limit_page_length=len(codes)))
	return [code for code in codes if code in found]


def layout_name(user: str, company: str, pos_profile: str) -> str | None:
	return frappe.db.get_value(
		"XPOS User Layout", {"user": user, "company": company, "pos_profile": pos_profile}, "name"
	)


def payload(pos_profile: str, user: str) -> dict:
	pos = resolve_pos_profile(pos_profile, user)
	policy, defaults = load_policy(pos.name)
	name = layout_name(user, pos.company, pos.name)
	stored = (
		frappe.db.get_value("XPOS User Layout", name, ["data", "revision"], as_dict=True) if name else None
	)
	personal, recovered = migrate(stored.data if stored else None)
	personal = sanitize(personal, policy)
	shared = personal["shared"]
	if "pinnedItems" in shared:
		shared["pinnedItems"] = sellable_codes(pos, shared["pinnedItems"])
	effective = effective_layout(personal, defaults, policy)
	effective["shared"]["pinnedItems"] = sellable_codes(pos, effective["shared"]["pinnedItems"])
	return {
		"pos_profile": pos.name,
		"company": pos.company,
		"revision": cint(stored.revision) if stored else 0,
		"recovered": recovered,
		"policy": policy,
		"defaults": defaults,
		"personal": personal,
		"layout": effective,
	}


@frappe.whitelist()
def get_layout(pos_profile: str):
	return payload(pos_profile, frappe.session.user)


@frappe.whitelist()
def save_layout(pos_profile: str, layout: str, base_revision: int = 0):
	"""Save the caller's own layout. The user is always the session user."""
	user = frappe.session.user
	pos = resolve_pos_profile(pos_profile, user)
	policy, _defaults = load_policy(pos.name)
	if not policy["allow_customization"]:
		frappe.throw(_("Layout customization is turned off for this POS Profile."), frappe.PermissionError)

	clean = sanitize(layout, policy)
	if "pinnedItems" in clean["shared"]:
		clean["shared"]["pinnedItems"] = sellable_codes(pos, clean["shared"]["pinnedItems"])
	base_revision = cint(base_revision)

	read_latest_on_lock()
	name = layout_name(user, pos.company, pos.name)
	if name:
		current = frappe.db.get_value("XPOS User Layout", name, "revision", for_update=True)
		if cint(current) != base_revision:
			return {"status": "conflict", **payload(pos.name, user)}
		doc = frappe.get_doc("XPOS User Layout", name)
	else:
		if base_revision:
			return {"status": "conflict", **payload(pos.name, user)}
		doc = frappe.new_doc("XPOS User Layout")
		doc.update({"user": user, "company": pos.company, "pos_profile": pos.name})

	doc.schema_version = SCHEMA_VERSION
	doc.revision = base_revision + 1
	doc.data = json.dumps(clean, separators=(",", ":"))
	try:
		doc.save(ignore_permissions=True)
	except frappe.DuplicateEntryError:
		frappe.db.rollback()
		return {"status": "conflict", **payload(pos.name, user)}
	return {"status": "saved", **payload(pos.name, user)}


@frappe.whitelist()
def reset_layout(pos_profile: str):
	user = frappe.session.user
	pos = resolve_pos_profile(pos_profile, user)
	read_latest_on_lock()
	name = layout_name(user, pos.company, pos.name)
	if name:
		revision = frappe.db.get_value("XPOS User Layout", name, "revision", for_update=True)
		frappe.db.set_value(
			"XPOS User Layout", name, {"data": "{}", "revision": cint(revision) + 1}, update_modified=True
		)
	return {"status": "reset", **payload(pos.name, user)}


@frappe.whitelist()
def get_pinned_items(pos_profile: str):
	"""Rows for the caller's pinned items. Codes come from the stored layout, never the client."""
	user = frappe.session.user
	result = payload(pos_profile, user)
	pos = resolve_pos_profile(pos_profile, user)
	codes = result["layout"]["shared"]["pinnedItems"]
	if not codes:
		return []
	filters = items_api.build_item_filters(pos, "", False, {"item_code": ["in", codes]})
	rows = frappe.get_list(
		"Item",
		filters=filters,
		fields=items_api.ITEM_PAGE_FIELDS,
		limit_page_length=len(codes),
	)
	price_list = pos.selling_price_list or frappe.db.get_single_value(
		"Selling Settings", "selling_price_list"
	)
	stock = items_api.get_stock_qty_map(codes, pos.warehouse, pos.name)
	prices = items_api.get_price_map(codes, price_list)
	for row in rows:
		row.rate = flt(prices.get(row.item_code, 0))
		row.actual_qty = stock.get(row.item_code, 0)
	by_code = {row.item_code: row for row in rows}
	return [by_code[code] for code in codes if code in by_code]
