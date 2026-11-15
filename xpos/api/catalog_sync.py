# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""Catalogue snapshot and delta feed for the browser till's offline cache."""

import base64
import hashlib
import hmac
import json
import time

import frappe
from frappe.query_builder.functions import Count, Sum
from frappe.utils import add_to_date, cint, flt, now, now_datetime
from frappe.utils.password import get_encryption_key
from pypika.terms import Function

from xpos.api import catalog_log
from xpos.api.items import (
	ITEM_PAGE_FIELDS,
	MAX_PAGE_LENGTH,
	barcode_pricing,
	build_item_filters,
	check_pos_profile_access,
	get_price_map,
	get_stock_qty_map,
	item_query,
	uom_conversion_map,
	uom_price_map,
)

OVERLAP_SECONDS = 120
DEFAULT_PAGE = 200
STOCK_PAGE_MAX = 2000
TOKEN_VERSION = 1
FEED_VERSION = 2


class Crc32(Function):
	def __init__(self, term):
		super().__init__("CRC32", term)


def clamp_limit(limit, maximum: int = MAX_PAGE_LENGTH) -> int:
	return min(max(cint(limit) or DEFAULT_PAGE, 1), maximum)


def resync(reason: str) -> dict:
	return {"resync": reason}


def price_list_of(pos) -> str | None:
	return pos.selling_price_list or frappe.db.get_single_value("Selling Settings", "selling_price_list")


def digest_of(value) -> str:
	return hashlib.sha256(json.dumps(value, sort_keys=True, default=str).encode()).hexdigest()


def build_scope(pos) -> dict:
	from xpos.api.customers import allowed_customer_groups

	user = frappe.session.user
	permissions = frappe.get_all(
		"User Permission",
		filters={"user": user},
		fields=["allow", "for_value", "applicable_for", "apply_to_all_doctypes"],
		order_by="allow, for_value, applicable_for",
		ignore_permissions=True,
	)
	return {
		"site": frappe.local.site,
		"user": user,
		"profile": pos.name,
		"company": pos.company,
		"warehouse": pos.warehouse,
		"price_list": price_list_of(pos),
		"currency": pos.currency,
		"item_groups": sorted(row.item_group for row in pos.get("item_groups") or []),
		"customer_groups": allowed_customer_groups(pos),
		"templates": [cint(pos.get("show_template_items")), cint(pos.get("hide_variants_items"))],
		"roles": sorted(frappe.get_roles(user)),
		"permissions": digest_of(permissions),
		"feed": FEED_VERSION,
	}


def public_scope(scope: dict) -> dict:
	keys = ("user", "profile", "company", "warehouse", "price_list", "currency")
	return {key: scope[key] for key in keys}


def sign(body: bytes) -> str:
	return hmac.new(get_encryption_key().encode(), body, hashlib.sha256).hexdigest()


def scope_hash(scope: dict) -> str:
	return sign(json.dumps(scope, sort_keys=True, default=str).encode())[:32]


def issue(scope_digest: str, phase: str, **fields) -> str:
	payload = {"v": TOKEN_VERSION, "sh": scope_digest, "ph": phase, "iat": time.time(), **fields}
	body = base64.urlsafe_b64encode(json.dumps(payload, sort_keys=True).encode()).decode()
	return f"{body}.{sign(body.encode())}"


def read_cursor(cursor: str, scope_digest: str, phase: str) -> dict:
	try:
		body, signature = (cursor or "").split(".", 1)
		if not hmac.compare_digest(signature, sign(body.encode())):
			return resync("invalid_cursor")
		payload = json.loads(base64.urlsafe_b64decode(body.encode()))
	except Exception:
		return resync("invalid_cursor")
	if payload.get("v") != TOKEN_VERSION or payload.get("ph") != phase:
		return resync("invalid_cursor")
	if payload.get("sh") != scope_digest:
		return resync("scope_changed")
	age_limit = catalog_log.retention_days() * 86400
	if (
		time.time() - flt(payload.get("iat")) > age_limit
		or cint(payload.get("wm")) < catalog_log.pruned_through()
	):
		return resync("cursor_expired")
	return payload


def open_profile(pos_profile: str):
	check_pos_profile_access(pos_profile)
	pos = frappe.get_cached_doc("POS Profile", pos_profile)
	scope = build_scope(pos)
	return pos, scope, scope_hash(scope)


def catalog_filters(pos, extra: dict | None = None) -> dict:
	return build_item_filters(pos, "", False, extra)


def attach_rates(pos, items: list) -> None:
	prices = get_price_map([item.item_code for item in items], price_list_of(pos))
	for item in items:
		item.rate = prices.get(item.item_code, 0)
		item.price_missing = int(item.item_code not in prices)


def attach_barcodes(pos, items: list) -> None:
	"""Every barcode of each item with the UOM it sells in, its factor and its rate.

	``conversion_factor`` is None for a barcode whose UOM the item cannot convert; the till refuses
	that scan instead of guessing. Barcode edits touch the parent Item, so the delta feed carries them.
	"""
	codes = [item.item_code for item in items]
	for item in items:
		item.barcodes = []
	if not codes:
		return
	rows = frappe.get_all(
		"Item Barcode",
		filters={"parent": ["in", codes], "parenttype": "Item"},
		fields=["parent", "barcode", "uom"],
		order_by="parent asc, idx asc",
	)
	by_item: dict[str, list] = {}
	for row in rows:
		if row.barcode:
			by_item.setdefault(row.parent, []).append(row)
	factors = uom_conversion_map(codes)
	prices = uom_price_map(codes, price_list_of(pos))
	for item in items:
		for row in by_item.get(item.item_code, []):
			priced = barcode_pricing(item.item_code, item.stock_uom, row.uom, flt(item.rate), factors, prices)
			item.barcodes.append({"barcode": row.barcode, **priced})


def attach_attributes(items: list) -> None:
	"""Variant attributes of each variant item as {attribute: value}, e.g. {"Colour": "Red", "Size": "M"}.

	Plain items and templates get {}. Lets a client offer explicit colour/size selection without guessing
	from item names. Additive: clients that do not know the field ignore it.
	"""
	for item in items:
		item.attributes = {}
	by_code = {item.item_code: item for item in items if item.get("variant_of")}
	if not by_code:
		return
	rows = frappe.get_all(
		"Item Variant Attribute",
		filters={"parent": ["in", list(by_code)], "parenttype": "Item"},
		fields=["parent", "attribute", "attribute_value"],
		order_by="parent asc, idx asc",
	)
	for row in rows:
		if row.attribute and row.attribute_value is not None:
			by_code[row.parent].attributes[row.attribute] = row.attribute_value


def overlap_from(moment: str | None = None) -> str:
	return str(add_to_date(moment or now_datetime(), seconds=-OVERLAP_SECONDS, as_string=False))


@frappe.whitelist(methods=["POST"])
def catalog_begin(pos_profile: str):
	pos, scope, digest = open_profile(pos_profile)
	watermark = catalog_log.last_seq()
	overlap = overlap_from()
	delta_fields = {"wm": watermark, "ow": overlap, "rt": None}
	started = int(time.time())
	return {
		"snapshot_id": f"{digest[:8]}-{watermark}-{started}",
		"scope": public_scope(scope),
		"scope_hash": digest,
		"watermark": watermark,
		"total": count_catalog(pos),
		"page_limit": MAX_PAGE_LENGTH,
		"stock_page_limit": STOCK_PAGE_MAX,
		"retention_days": catalog_log.retention_days(),
		"server_time": now(),
		"cursors": {
			"items": issue(digest, "items", lk="", wm=watermark),
			"stock": issue(digest, "stock", lk="", wm=watermark),
			"customers": issue(digest, "customers", lk="", wm=watermark),
			"delta": issue(digest, "delta", lk="", **delta_fields),
		},
	}


def count_catalog(pos) -> int:
	inner = item_query(catalog_filters(pos), ["name"], [], False, None, False, order_by="name")
	rows = frappe.qb.from_(inner.as_("matched")).select(Count("*")).run()
	return cint(rows[0][0]) if rows else 0


def next_keyset_page(pos, last_key: str, limit: int, fields: list[str]):
	extra = {"name": [">", last_key]} if last_key else None
	rows = item_query(
		catalog_filters(pos, extra),
		fields,
		[],
		False,
		None,
		False,
		order_by="name asc",
		limit_start=0,
		limit_page_length=limit + 1,
	).run(as_dict=True)
	return rows[:limit], len(rows) > limit


@frappe.whitelist(methods=["POST"])
def catalog_page(pos_profile: str, cursor: str, limit: int = DEFAULT_PAGE):
	pos, scope, digest = open_profile(pos_profile)
	state = read_cursor(cursor, digest, "items")
	if "resync" in state:
		return state
	limit = clamp_limit(limit)
	items, more = next_keyset_page(pos, state.get("lk") or "", limit, ITEM_PAGE_FIELDS)
	attach_rates(pos, items)
	attach_barcodes(pos, items)
	attach_attributes(items)
	next_cursor = issue(digest, "items", lk=items[-1].item_code, wm=state["wm"]) if more and items else None
	return {"items": items, "next_cursor": next_cursor}


@frappe.whitelist(methods=["POST"])
def catalog_stock_page(pos_profile: str, cursor: str, limit: int = DEFAULT_PAGE):
	pos, scope, digest = open_profile(pos_profile)
	state = read_cursor(cursor, digest, "stock")
	if "resync" in state:
		return state
	limit = clamp_limit(limit, STOCK_PAGE_MAX)
	items, more = next_keyset_page(pos, state.get("lk") or "", limit, ["name as item_code"])
	codes = [item.item_code for item in items]
	quantities = get_stock_qty_map(codes, pos.warehouse, pos.name)
	rows = [{"item_code": code, "actual_qty": flt(quantities.get(code, 0))} for code in codes]
	next_cursor = issue(digest, "stock", lk=codes[-1], wm=state["wm"]) if more and codes else None
	return {"rows": rows, "next_cursor": next_cursor, "as_of": now()}


@frappe.whitelist(methods=["POST"])
def catalog_customers_page(pos_profile: str, cursor: str, limit: int = DEFAULT_PAGE):
	from xpos.api.customers import allowed_customer_groups, set_pos_price_lists
	from xpos.api.profiles import resolve_pos_profile

	pos, scope, digest = open_profile(pos_profile)
	resolve_pos_profile(pos_profile)
	state = read_cursor(cursor, digest, "customers")
	if "resync" in state:
		return state
	limit = clamp_limit(limit)
	conditions = "c.disabled = 0 AND c.name > %(last)s"
	values: dict = {"last": state.get("lk") or "", "limit": limit + 1}
	groups = allowed_customer_groups(pos)
	if groups:
		values.update({f"grp_{i}": group for i, group in enumerate(groups)})
		conditions += (
			" AND c.customer_group IN (" + ", ".join(f"%(grp_{i})s" for i in range(len(groups))) + ")"
		)
	rows = frappe.db.sql(  # nosemgrep: frappe-sql-format-injection - conditions are fixed text, values are parameterized
		f"""
		SELECT c.name, c.customer_name, c.mobile_no, c.email_id, c.customer_group, c.territory,
			c.default_currency, c.image, c.tax_id, c.customer_type, c.gender, c.discount
		FROM `tabCustomer` c
		WHERE {conditions}
		ORDER BY c.name ASC
		LIMIT %(limit)s
		""",
		values,
		as_dict=True,
	)
	more = len(rows) > limit
	rows = rows[:limit]
	if rows:
		set_pos_price_lists(rows, pos.name)
	next_cursor = issue(digest, "customers", lk=rows[-1].name, wm=state["wm"]) if more and rows else None
	return {"customers": rows, "next_cursor": next_cursor}


@frappe.whitelist(methods=["POST"])
def catalog_delta(pos_profile: str, cursor: str, limit: int = DEFAULT_PAGE):
	"""Items that changed since the cursor: rows to store, and codes to drop."""
	pos, scope, digest = open_profile(pos_profile)
	state = read_cursor(cursor, digest, "delta")
	if "resync" in state:
		return state
	limit = clamp_limit(limit)
	watermark = cint(state.get("wm"))

	if frappe.db.sql(
		"SELECT 1 FROM `tabXPOS Catalog Change` WHERE kind = 'reset' AND name > %s LIMIT 1", watermark
	):
		return resync("reset_required")

	run_started = state.get("rt") or now()
	run_watermark = cint(state.get("ws")) or catalog_log.last_seq()
	rows = frappe.db.sql(
		"""
		SELECT code FROM (
			SELECT ref AS code FROM `tabXPOS Catalog Change`
			WHERE kind = 'item' AND (name > %(wm)s OR logged_at >= %(ow)s)
			UNION
			SELECT name FROM `tabItem` WHERE modified >= %(ow)s
			UNION
			SELECT item_code FROM `tabItem Price` WHERE modified >= %(ow)s
		) candidates
		WHERE code <> '' AND code > %(last)s
		ORDER BY code ASC LIMIT %(limit)s
		""",
		{"wm": watermark, "ow": state.get("ow"), "last": state.get("lk") or "", "limit": limit + 1},
	)
	codes = [row[0] for row in rows]
	more = len(codes) > limit
	codes = codes[:limit]

	upserts = []
	if codes:
		upserts = item_query(
			catalog_filters(pos, {"name": ["in", codes]}),
			ITEM_PAGE_FIELDS,
			[],
			False,
			None,
			False,
			order_by="name asc",
			limit_start=0,
			limit_page_length=len(codes),
		).run(as_dict=True)
		attach_rates(pos, upserts)
		attach_barcodes(pos, upserts)
		attach_attributes(upserts)
	present = {item.item_code for item in upserts}
	removed = [code for code in codes if code not in present]

	if more:
		next_cursor = issue(
			digest, "delta", lk=codes[-1], wm=watermark, ow=state.get("ow"), ws=run_watermark, rt=run_started
		)
	else:
		next_cursor = issue(
			digest, "delta", lk="", wm=max(watermark, run_watermark), ow=overlap_from(run_started), rt=None
		)
	return {"upserts": upserts, "removed": removed, "next_cursor": next_cursor, "has_more": more}


@frappe.whitelist(methods=["POST"])
def catalog_digest(pos_profile: str):
	pos, scope, digest = open_profile(pos_profile)
	inner = item_query(catalog_filters(pos), ["name"], [], False, None, False, order_by="name")
	matched = inner.as_("matched")
	rows = frappe.qb.from_(matched).select(Count("*"), Sum(Crc32(matched.name))).run()
	count, checksum = rows[0] if rows else (0, 0)
	return {"count": cint(count), "checksum": cint(checksum), "scope_hash": digest, "server_time": now()}
