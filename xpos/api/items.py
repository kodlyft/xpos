# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

import json

import frappe
from frappe import _
from frappe.query_builder import DocType
from frappe.query_builder.functions import Count, Max, Sum
from frappe.utils import cint, flt, getdate, nowdate
from pypika.terms import ExistsCriterion

from xpos.api.utilities import get_invoice_type, get_item_search_settings


def resolve_scanned_item_code(term: str, config: dict) -> str | None:
	"""Resolve a typed or scanned value to an item code via serial or batch lookup.

	Returns None when neither lookup is enabled: plain barcodes are already covered
	by the LIKE on item_code.
	"""
	if not (config["search_serial_no"] or config["search_batch_no"]):
		return None

	from xpos.x_pos.api.item_processing.barcode import search_serial_or_batch_or_barcode_number

	scan = search_serial_or_batch_or_barcode_number(
		term, config["search_serial_no"], config["search_batch_no"]
	)
	return scan.get("item_code")


MAX_PAGE_LENGTH = 500
MIN_SUBSTRING_LENGTH = 3


def escape_like(term: str) -> str:
	"""Make user text literal inside a LIKE pattern."""
	return term.replace("\\", "\\\\\\\\").replace("%", "\\%").replace("_", "\\_")


def get_warehouse_list(warehouse: str | None) -> list[str]:
	"""``warehouse`` plus its descendants when it is a group, resolved once per request."""
	if not warehouse:
		return []
	memo = getattr(frappe.local, "xpos_warehouse_lists", None)
	if memo is None:
		memo = frappe.local.xpos_warehouse_lists = {}
	if warehouse not in memo:
		if frappe.db.get_value("Warehouse", warehouse, "is_group"):
			memo[warehouse] = frappe.db.get_descendants("Warehouse", warehouse) or []
		else:
			memo[warehouse] = [warehouse]
	return memo[warehouse]


def get_item_group_names(item_groups: list[str]) -> list[str]:
	"""The given item groups and all their descendants, in one nested-set query."""
	if not item_groups:
		return []
	Parent = DocType("Item Group").as_("parent_group")
	Child = DocType("Item Group").as_("child_group")
	rows = (
		frappe.qb.from_(Child)
		.join(Parent)
		.on((Child.lft >= Parent.lft) & (Child.rgt <= Parent.rgt))
		.select(Child.name)
		.where(Parent.name.isin(item_groups))
		.distinct()
		.run()
	)
	return [row[0] for row in rows]


def get_price_map(item_codes: list[str], price_list: str | None) -> dict[str, float]:
	"""Selling rate per item on ``price_list``, read in one query.

	Mirrors the per-item ``get_value`` it replaces: same filters, and the most recently
	created matching row wins.
	"""
	if not item_codes or not price_list:
		return {}
	ItemPrice = DocType("Item Price")
	rows = (
		frappe.qb.from_(ItemPrice)
		.select(ItemPrice.item_code, ItemPrice.price_list_rate)
		.where(ItemPrice.item_code.isin(item_codes))
		.where(ItemPrice.price_list == price_list)
		.where(ItemPrice.selling == 1)
		.orderby(ItemPrice.creation, order=frappe.qb.desc)
		.orderby(ItemPrice.name, order=frappe.qb.desc)
		.run(as_dict=True)
	)
	prices: dict[str, float] = {}
	for row in rows:
		prices.setdefault(row.item_code, flt(row.price_list_rate))
	return prices


def check_pos_profile_access(pos_profile: str) -> None:
	"""Raise unless the session user may use ``pos_profile``.

	A profile that lists users is limited to them (and to anyone with read access to
	POS Profile); a profile that lists nobody stays open, as it was before this check.
	"""
	user = frappe.session.user
	if user == "Administrator" or frappe.has_permission("POS Profile", "read", pos_profile):
		return
	cache = getattr(frappe.local, "xpos_profile_access", None)
	if cache is None:
		cache = frappe.local.xpos_profile_access = {}
	key = (user, pos_profile)
	if key not in cache:
		users = frappe.get_all(
			"POS Profile User",
			filters={"parent": pos_profile, "parenttype": "POS Profile"},
			pluck="user",
			ignore_permissions=True,
		)
		cache[key] = not users or user in users
	if not cache[key]:
		frappe.throw(
			frappe._("You are not allowed to use POS Profile {0}").format(pos_profile), frappe.PermissionError
		)


def check_warehouse_in_profile(warehouse: str | None, pos) -> None:
	"""Stock lookups are limited to the profile's own warehouse tree."""
	if (
		warehouse
		and pos.warehouse
		and warehouse != pos.warehouse
		and warehouse not in get_warehouse_list(pos.warehouse)
	):
		frappe.throw(
			frappe._("Warehouse {0} does not belong to POS Profile {1}").format(warehouse, pos.name),
			frappe.PermissionError,
		)


def get_profile_item_group_names(pos, item_group: str = "") -> list[str]:
	"""Item groups a catalogue query is restricted to, empty when unrestricted."""
	if item_group and item_group != "All Item Groups":
		return get_item_group_names([item_group])
	if pos.item_groups:
		return get_item_group_names([ig.item_group for ig in pos.item_groups])
	return []


def get_unavailable_pending_items(warehouses: list[str]) -> list[str]:
	"""In-stock items whose Bin quantity is used up by unconsolidated POS Invoices."""
	pending = get_pending_pos_qty_map(warehouses)
	if not pending:
		return []
	Bin = DocType("Bin")
	rows = (
		frappe.qb.from_(Bin)
		.select(Bin.item_code, Sum(Bin.actual_qty).as_("total"), Max(Bin.actual_qty).as_("best"))
		.where(Bin.item_code.isin(list(pending)))
		.where(Bin.warehouse.isin(warehouses))
		.groupby(Bin.item_code)
		.run(as_dict=True)
	)
	return [r.item_code for r in rows if flt(r.best) > 0 and flt(r.total) - pending.get(r.item_code, 0) <= 0]


def apply_availability(query, warehouses: list[str], use_pos_deduction: bool):
	"""Keep non-stock items and stock items with quantity left in ``warehouses``.

	One correlated EXISTS on Bin, so the page query stays ordered and bounded instead
	of materialising every available item code first.
	"""
	Item = DocType("Item")
	if not warehouses:
		return query.where(Item.is_stock_item == 0)
	Bin = DocType("Bin")
	in_stock = (
		frappe.qb.from_(Bin)
		.select(1)
		.where(Bin.item_code == Item.name)
		.where(Bin.warehouse.isin(warehouses))
		.where(Bin.actual_qty > 0)
	)
	query = query.where((Item.is_stock_item == 0) | ExistsCriterion(in_stock))
	used_up = get_unavailable_pending_items(warehouses) if use_pos_deduction else []
	if used_up:
		query = query.where(Item.name.notin(used_up))
	return query


def search_conditions(term: str, config: dict):
	"""(prefix, substring) pypika terms for a typed search.

	Prefix matches run on indexed Item columns. The substring term also covers the
	extra fields configured in POS Settings and is only used for terms of
	MIN_SUBSTRING_LENGTH characters or more.
	"""
	Item = DocType("Item")
	escaped = escape_like(term)
	prefix = None
	for fieldname in ("name", "item_name", "item_code"):
		condition = Item[fieldname].like(f"{escaped}%")
		prefix = condition if prefix is None else prefix | condition
	substring = None
	for fieldname in config["fields"]:
		condition = Item[fieldname].like(f"%{escaped}%")
		substring = condition if substring is None else substring | condition
	return prefix, substring


ITEM_PAGE_FIELDS = [
	"name as item_code",
	"item_name",
	"local_item_name",
	"item_group",
	"stock_uom",
	"image",
	"description",
	"has_batch_no",
	"has_serial_no",
	"has_variants",
	"variant_of",
	"is_stock_item",
	"allow_negative_stock",
	"brand",
	"max_discount",
]


def build_item_filters(pos, item_group: str, include_templates: bool, extra: dict | None = None) -> dict:
	filters = {"disabled": 0, "is_sales_item": 1}
	if not (include_templates or pos.get("show_template_items")):
		filters["has_variants"] = 0
	elif pos.get("hide_variants_items"):
		filters["variant_of"] = ["in", ["", None]]

	groups = get_profile_item_group_names(pos, item_group)
	if groups:
		filters["item_group"] = ["in", groups]
	if extra:
		filters.update(extra)
	return filters


def item_query(filters, fields, warehouses, use_pos_deduction, term_filter=None, hide=False, **page):
	"""Item query with permissions applied by get_list, plus search and availability terms."""
	query = frappe.get_list("Item", filters=filters, fields=fields, run=False, **page)
	if term_filter is not None:
		query = query.where(term_filter)
	if hide:
		query = apply_availability(query, warehouses, use_pos_deduction)
	return query


def run_item_page(filters, start, length, warehouses, use_pos_deduction, term_filter=None, hide=False):
	"""One ordered, bounded page of Items."""
	return item_query(
		filters,
		ITEM_PAGE_FIELDS,
		warehouses,
		use_pos_deduction,
		term_filter,
		hide,
		order_by="item_name asc, name asc",
		limit_start=start,
		limit_page_length=length,
	).run(as_dict=True)


def count_items(filters, warehouses, use_pos_deduction, term_filter=None, hide=False) -> int:
	inner = item_query(filters, ["name"], warehouses, use_pos_deduction, term_filter, hide, order_by="name")
	rows = frappe.qb.from_(inner.as_("matched")).select(Count("*")).run()
	return cint(rows[0][0]) if rows else 0


@frappe.whitelist()
def get_pos_items(
	pos_profile: str,
	search_term: str = "",
	item_group: str = "",
	start: int = 0,
	page_length: int = 40,
	include_templates: bool = False,
	include_uoms: bool = False,
):
	check_pos_profile_access(pos_profile)
	pos = frappe.get_cached_doc("POS Profile", pos_profile)
	warehouse = pos.warehouse

	filters = build_item_filters(pos, item_group, include_templates)

	config = get_item_search_settings()
	prefix_filter = substring_filter = None
	term = (search_term or "").strip()
	if term:
		resolved_item_code = resolve_scanned_item_code(term, config)
		if resolved_item_code:
			filters["item_code"] = resolved_item_code
		else:
			prefix_filter, substring_filter = search_conditions(term, config)

	hide = bool(pos.get("hide_unavailable_items") and warehouse)
	use_pos_deduction = bool(get_invoice_type() == "POS Invoice")
	warehouses = get_warehouse_list(warehouse) if hide else []

	length = cint(page_length)
	search_limit = cint(config["item_search_limit"])
	if term and search_limit > 0:
		length = min(length, search_limit) if length > 0 else search_limit
	length = min(length, MAX_PAGE_LENGTH) if length > 0 else MAX_PAGE_LENGTH
	start = max(cint(start), 0)

	def page(offset, term_filter):
		return run_item_page(filters, offset, length, warehouses, use_pos_deduction, term_filter, hide)

	if prefix_filter is None:
		items = page(start, None)
	else:
		items = page(start, prefix_filter)
		exact = any(item.item_code.lower() == term.lower() for item in items)
		if len(items) < length and len(term) >= MIN_SUBSTRING_LENGTH and not exact:
			prefix_total = (
				start + len(items)
				if items
				else count_items(filters, warehouses, use_pos_deduction, prefix_filter, hide)
			)
			rest = page(max(start - prefix_total, 0), substring_filter & prefix_filter.negate())
			items += rest[: length - len(items)]

	price_list = pos.selling_price_list or frappe.db.get_single_value(
		"Selling Settings", "selling_price_list"
	)
	codes = [item.item_code for item in items]
	stock = get_stock_qty_map(codes, warehouse, pos_profile)
	prices = get_price_map(codes, price_list)
	for item in items:
		item.rate = prices.get(item.item_code, 0)
		item.actual_qty = stock.get(item.item_code, 0)

	if include_uoms and items:
		uom_rows = frappe.get_all(
			"UOM Conversion Detail",
			filters={"parent": ["in", codes]},
			fields=["parent as item_code", "uom", "conversion_factor"],
			order_by="parent asc",
		)
		uom_map: dict[str, list] = {}
		for row in uom_rows:
			uom_map.setdefault(row.item_code, []).append(
				{"uom": row.uom, "conversion_factor": flt(row.conversion_factor)}
			)
		for item in items:
			item.uoms = uom_map.get(item.item_code, [])

	return items


@frappe.whitelist()
def get_items_count(pos_profile: str, search_term: str = "", item_group: str = ""):
	"""Total of items matching the same filters as get_pos_items."""
	check_pos_profile_access(pos_profile)
	pos = frappe.get_cached_doc("POS Profile", pos_profile)
	filters = build_item_filters(pos, item_group, False)
	hide = bool(pos.get("hide_unavailable_items") and pos.warehouse)
	warehouses = get_warehouse_list(pos.warehouse) if hide else []
	use_pos_deduction = bool(get_invoice_type() == "POS Invoice")
	term = (search_term or "").strip()
	term_filter = None
	if term:
		prefix_filter, substring_filter = search_conditions(term, get_item_search_settings())
		term_filter = substring_filter if len(term) >= MIN_SUBSTRING_LENGTH else prefix_filter
	return count_items(filters, warehouses, use_pos_deduction, term_filter, hide)


@frappe.whitelist()
def get_item_groups(pos_profile: str | None = None):
	"""Get item groups, filtered to POS Profile item_groups when configured."""
	if pos_profile:
		check_pos_profile_access(pos_profile)
		pos = frappe.get_cached_doc("POS Profile", pos_profile)
		allowed_names = [ig.item_group for ig in (pos.item_groups or [])]
		if allowed_names:
			parent_groups = frappe.get_all(
				"Item Group",
				filters={"name": ["in", allowed_names]},
				fields=["name", "parent_item_group", "image"],
				order_by="lft asc",
				limit_page_length=0,
			)
			all_leaf_names = set(
				frappe.get_all(
					"Item Group",
					filters={"name": ["in", get_item_group_names(allowed_names)], "is_group": 0},
					pluck="name",
				)
			)
			groups = (
				frappe.get_all(
					"Item Group",
					filters={"name": ["in", list(all_leaf_names)]},
					fields=["name", "parent_item_group", "image"],
					order_by="name asc",
					limit_page_length=0,
				)
				if all_leaf_names
				else []
			)
			return {"groups": groups, "parent_groups": parent_groups}

	groups = frappe.get_all(
		"Item Group",
		filters={"is_group": 0},
		fields=["name", "parent_item_group", "image"],
		order_by="name asc",
		limit_page_length=0,
	)
	parent_groups = frappe.get_all(
		"Item Group",
		filters={"is_group": 1},
		fields=["name", "parent_item_group", "image"],
		order_by="lft asc",
		limit_page_length=0,
	)
	return {"groups": groups, "parent_groups": parent_groups}


def uom_conversion_map(item_codes: list[str]) -> dict[tuple[str, str], float]:
	"""(item, UOM) -> units of the stock UOM in one of that UOM, from the item's conversion table."""
	if not item_codes:
		return {}
	rows = frappe.get_all(
		"UOM Conversion Detail",
		filters={"parent": ["in", item_codes], "parenttype": "Item"},
		fields=["parent", "uom", "conversion_factor"],
	)
	return {(row.parent, row.uom): flt(row.conversion_factor) for row in rows}


def uom_price_map(item_codes: list[str], price_list: str | None) -> dict[tuple[str, str], float]:
	"""(item, UOM) -> the selling price set specifically for that UOM on the price list."""
	if not item_codes or not price_list:
		return {}
	rows = frappe.get_all(
		"Item Price",
		filters={
			"item_code": ["in", item_codes],
			"price_list": price_list,
			"selling": 1,
			"uom": ["is", "set"],
		},
		fields=["item_code", "uom", "price_list_rate"],
	)
	return {(row.item_code, row.uom): flt(row.price_list_rate) for row in rows}


def barcode_pricing(
	item_code: str,
	stock_uom: str,
	uom: str | None,
	base_rate: float,
	factors: dict[tuple[str, str], float],
	prices: dict[tuple[str, str], float],
) -> dict:
	"""The UOM a barcode sells in, its conversion factor and rate.

	The factor is None when the item has no conversion for that UOM; the caller must refuse the scan
	rather than sell a box at the price of a unit.
	"""
	uom = uom or stock_uom
	factor = 1.0 if uom == stock_uom else factors.get((item_code, uom)) or None
	rate = prices.get((item_code, uom))
	if rate is None:
		rate = flt(base_rate) * factor if factor else None
	return {"uom": uom, "conversion_factor": factor, "rate": rate}


@frappe.whitelist()
def search_barcode(barcode: str, pos_profile: str | None = None):
	"""Search item by barcode.

	Also supports scale barcodes (weighted items) if configured on the POS Profile.
	"""
	barcode = (barcode or "").strip()
	if not barcode:
		return None

	price_list = None
	pos = None
	warehouse = None
	if pos_profile:
		pos = frappe.get_cached_doc("POS Profile", pos_profile)
		price_list = pos.selling_price_list
		warehouse = pos.warehouse
	if not price_list:
		price_list = frappe.db.get_single_value("Selling Settings", "selling_price_list")

	def get_item_rate(item_code):
		rate = (
			frappe.db.get_value(
				"Item Price",
				{"item_code": item_code, "price_list": price_list, "selling": 1},
				"price_list_rate",
			)
			if price_list
			else 0
		)
		return flt(rate)

	barcode_data = frappe.db.get_value(
		"Item Barcode",
		{"barcode": barcode, "parenttype": "Item"},
		["parent as item_code", "barcode", "uom"],
		as_dict=True,
	)

	if barcode_data:
		item = frappe.get_cached_doc("Item", barcode_data.item_code)
		pricing = barcode_pricing(
			item.name,
			item.stock_uom,
			barcode_data.uom,
			get_item_rate(item.name),
			uom_conversion_map([item.name]),
			uom_price_map([item.name], price_list),
		)
		if not pricing["conversion_factor"]:
			frappe.throw(
				_("Barcode {0} is set to UOM {1}, which has no conversion factor on item {2}.").format(
					barcode, pricing["uom"], item.name
				)
			)
		return {
			"item_code": item.name,
			"item_name": item.item_name,
			"local_item_name": item.get("local_item_name"),
			"barcode": barcode_data.barcode,
			"uom": pricing["uom"],
			"conversion_factor": pricing["conversion_factor"],
			"stock_uom": item.stock_uom,
			"rate": pricing["rate"],
			"has_batch_no": item.has_batch_no,
			"has_serial_no": item.has_serial_no,
			"is_stock_item": item.is_stock_item,
			"image": item.image,
			"actual_qty": get_stock_qty(item.name, warehouse, pos_profile=pos_profile) if warehouse else 0,
		}

	if frappe.db.exists("Item", barcode):
		item = frappe.get_cached_doc("Item", barcode)
		return {
			"item_code": item.name,
			"item_name": item.item_name,
			"local_item_name": item.get("local_item_name"),
			"barcode": barcode,
			"uom": item.stock_uom,
			"stock_uom": item.stock_uom,
			"rate": get_item_rate(item.name),
			"has_batch_no": item.has_batch_no,
			"has_serial_no": item.has_serial_no,
			"is_stock_item": item.is_stock_item,
			"image": item.image,
			"actual_qty": get_stock_qty(item.name, warehouse, pos_profile=pos_profile) if warehouse else 0,
		}

	config = get_item_search_settings()
	if config["search_serial_no"] or config["search_batch_no"]:
		from xpos.x_pos.api.item_processing.barcode import search_serial_or_batch_or_barcode_number

		scan = search_serial_or_batch_or_barcode_number(
			barcode, config["search_serial_no"], config["search_batch_no"]
		)
		if scan.get("item_code"):
			item = frappe.get_cached_doc("Item", scan["item_code"])
			return {
				"item_code": item.name,
				"item_name": item.item_name,
				"local_item_name": item.get("local_item_name"),
				"barcode": scan.get("barcode") or barcode,
				"batch_no": scan.get("batch_no"),
				"serial_no": scan.get("serial_no"),
				"uom": item.stock_uom,
				"stock_uom": item.stock_uom,
				"rate": get_item_rate(item.name),
				"has_batch_no": item.has_batch_no,
				"has_serial_no": item.has_serial_no,
				"is_stock_item": item.is_stock_item,
				"image": item.image,
				"actual_qty": get_stock_qty(item.name, warehouse, pos_profile=pos_profile)
				if warehouse
				else 0,
			}

	result = resolve_scale_barcode(barcode)
	if result:
		scale_price = result.pop("scale_price", None)
		rate = get_item_rate(result["item_code"])
		if scale_price is not None and flt(result.get("qty")):
			rate = flt(scale_price) / flt(result["qty"])
		result["rate"] = rate
		result["actual_qty"] = (
			get_stock_qty(result["item_code"], warehouse, pos_profile=pos_profile) if warehouse else 0
		)
		return result

	return None


@frappe.whitelist()
def get_item_detail(
	item_code: str,
	pos_profile: str,
	warehouse: str | None = None,
	price_list: str | None = None,
	customer: str | None = None,
):
	"""Get detailed info for a single item including batches, serial nos, UOMs, and pricing."""
	pos = frappe.get_cached_doc("POS Profile", pos_profile)
	warehouse = warehouse or pos.warehouse
	price_list = price_list or pos.selling_price_list
	today = nowdate()

	item = frappe.get_cached_doc("Item", item_code)
	result = {
		"item_code": item.name,
		"item_name": item.item_name,
		"local_item_name": item.get("local_item_name"),
		"description": item.description,
		"stock_uom": item.stock_uom,
		"image": item.image,
		"item_group": item.item_group,
		"brand": item.brand,
		"has_batch_no": item.has_batch_no,
		"has_serial_no": item.has_serial_no,
		"has_variants": item.has_variants,
		"is_stock_item": item.is_stock_item,
		"max_discount": item.max_discount,
		"allow_negative_stock": item.allow_negative_stock,
	}

	rate = frappe.db.get_value(
		"Item Price",
		{
			"item_code": item_code,
			"price_list": price_list,
			"selling": 1,
		},
		"price_list_rate",
	)
	result["rate"] = flt(rate)
	result["price_list_rate"] = flt(rate)
	result["uom"] = item.stock_uom
	result["conversion_factor"] = 1.0

	result["actual_qty"] = get_stock_qty(item_code, warehouse, pos_profile=pos_profile) if warehouse else 0

	batches = []
	if item.has_batch_no and warehouse:
		pending_batches = get_pending_batch_qty(warehouse, pos_profile)
		for b in get_batch_data(item_code, warehouse, today):
			batch_no = b["batch_no"]
			batches.append(
				{
					"batch_no": batch_no,
					"qty": flt(b.get("batch_qty", 0)) - pending_batches.get(batch_no, 0.0),
					"expiry_date": b.get("expiry_date"),
				}
			)
	result["batches"] = batches

	serial_numbers = []
	if item.has_serial_no and warehouse:
		rows = frappe.get_all(
			"Serial No",
			filters={
				"item_code": item_code,
				"status": "Active",
				"warehouse": warehouse,
			},
			fields=["name"],
		)
		serial_numbers = [r.name for r in rows]
	result["serial_numbers"] = serial_numbers

	uoms = frappe.get_all(
		"UOM Conversion Detail",
		filters={"parent": item_code},
		fields=["uom", "conversion_factor"],
		order_by="idx asc",
	)
	stock_uom_exists = any(u.get("uom") == item.stock_uom for u in uoms)
	if not stock_uom_exists:
		uoms.insert(0, {"uom": item.stock_uom, "conversion_factor": 1.0})
	result["uoms"] = uoms

	barcodes = frappe.get_all(
		"Item Barcode",
		filters={"parent": item_code},
		fields=["barcode", "uom"],
	)
	result["item_barcode"] = barcodes

	return result


@frappe.whitelist()
def get_item_variants(
	pos_profile: str,
	parent_item_code: str,
	price_list: str | None = None,
	customer: str | None = None,
):
	"""Return all variants of a template item with attribute metadata."""
	check_pos_profile_access(pos_profile)
	pos = frappe.get_cached_doc("POS Profile", pos_profile)
	price_list = price_list or pos.selling_price_list
	warehouse = pos.warehouse

	variants = frappe.get_all(
		"Item",
		filters={"variant_of": parent_item_code, "disabled": 0},
		fields=[
			"name as item_code",
			"item_name",
			"local_item_name",
			"description",
			"stock_uom",
			"image",
			"item_group",
			"has_batch_no",
			"has_serial_no",
			"is_stock_item",
			"allow_negative_stock",
			"brand",
			"max_discount",
		],
		order_by="item_name asc",
	)

	if not variants:
		return {"variants": [], "attributes_meta": {}}

	variant_codes = [v["item_code"] for v in variants]
	prices = get_price_map(variant_codes, price_list)
	stock = get_stock_qty_map(variant_codes, warehouse, pos_profile)
	for v in variants:
		v["rate"] = flt(prices.get(v["item_code"]))
		v["actual_qty"] = stock.get(v["item_code"], 0)

	from collections import defaultdict

	attr_rows = frappe.get_all(
		"Item Variant Attribute",
		filters={"parent": ["in", variant_codes]},
		fields=["parent", "attribute", "attribute_value"],
	)

	attributes_meta = defaultdict(set)
	item_attr_map = defaultdict(list)
	for row in attr_rows:
		attributes_meta[row.attribute].add(row.attribute_value)
		item_attr_map[row.parent].append(
			{
				"attribute": row.attribute,
				"attribute_value": row.attribute_value,
			}
		)

	attributes_meta = {k: sorted(v) for k, v in attributes_meta.items()}
	for v in variants:
		v["item_attributes"] = item_attr_map.get(v["item_code"], [])

	return {"variants": variants, "attributes_meta": attributes_meta}


@frappe.whitelist()
def get_item_attributes(item_code: str):
	"""Get item attribute definitions for variant selection."""
	return frappe.get_all(
		"Item Attribute",
		fields=["name", "attribute_name"],
		filters={
			"name": [
				"in",
				[
					attr.attribute
					for attr in frappe.get_all(
						"Item Variant Attribute",
						fields=["attribute"],
						filters={"parent": item_code},
					)
				],
			]
		},
	)


@frappe.whitelist()
def get_stock_availability(items: str | list, warehouse: str | None = None, pos_profile: str | None = None):
	"""Bulk-fetch stock for multiple items.

	Accepts two calling conventions:
	1. items = JSON list of item-code strings + warehouse as a separate param.
	2. items = JSON list of dicts with item_code, warehouse, and optional batch_no.

	Returns:
	        list of {"item_code": str, "actual_qty": float}
	"""
	if isinstance(items, str):
		items = json.loads(items)
	if not items:
		return []

	if pos_profile:
		check_pos_profile_access(pos_profile)
		pos = frappe.get_cached_doc("POS Profile", pos_profile)
		check_warehouse_in_profile(warehouse, pos)
		for d in items:
			if isinstance(d, dict):
				check_warehouse_in_profile(d.get("warehouse"), pos)

	use_pos_deduction = bool(pos_profile and get_invoice_type() == "POS Invoice")

	requests = []
	for d in items:
		if isinstance(d, str):
			item_code, item_warehouse, batch_no = d, warehouse, ""
		else:
			item_code = d.get("item_code")
			item_warehouse = d.get("warehouse") or warehouse
			batch_no = d.get("batch_no", "")
		if item_code and item_warehouse:
			requests.append((item_code, item_warehouse, batch_no))

	pending_map: dict[str, float] = {}
	if use_pos_deduction and warehouse:
		pending_map = get_pending_pos_qty_map(
			get_warehouse_list(warehouse), item_codes=list({code for code, _, _ in requests})
		)

	codes_by_warehouse: dict[str, list[str]] = {}
	for item_code, item_warehouse, batch_no in requests:
		if not batch_no:
			codes_by_warehouse.setdefault(item_warehouse, []).append(item_code)
	bin_maps = {wh: get_bin_qty_map(codes, wh) for wh, codes in codes_by_warehouse.items()}
	pending_batches: dict[str, dict[str, float]] = {}

	results = []
	for item_code, item_warehouse, batch_no in requests:
		if batch_no:
			from erpnext.stock.doctype.batch.batch import get_batch_qty

			qty = flt(get_batch_qty(batch_no, item_warehouse))
			if use_pos_deduction:
				if item_warehouse not in pending_batches:
					pending_batches[item_warehouse] = get_pending_batch_qty(item_warehouse, pos_profile)
				qty -= pending_batches[item_warehouse].get(batch_no, 0.0)
		else:
			qty = flt(bin_maps[item_warehouse].get(item_code, 0))
			if use_pos_deduction:
				qty -= pending_map.get(item_code, 0.0)

		results.append({"item_code": item_code, "actual_qty": qty})

	return results


@frappe.whitelist()
def get_price_for_uom(
	item_code: str, uom: str, pos_profile: str | None = None, price_list: str | None = None
):
	"""Return Item Price for a specific UOM, falling back to base rate × conversion factor."""
	if not price_list and pos_profile:
		price_list = frappe.db.get_value("POS Profile", pos_profile, "selling_price_list")
	if not price_list:
		price_list = frappe.db.get_single_value("Selling Settings", "selling_price_list")

	rate = frappe.db.get_value(
		"Item Price",
		{"item_code": item_code, "price_list": price_list, "selling": 1, "uom": uom},
		"price_list_rate",
	)
	if rate:
		return {"rate": flt(rate)}

	base_rate = frappe.db.get_value(
		"Item Price",
		{"item_code": item_code, "price_list": price_list, "selling": 1},
		"price_list_rate",
	)
	conversion_factor = (
		frappe.db.get_value(
			"UOM Conversion Detail",
			{"parent": item_code, "uom": uom},
			"conversion_factor",
		)
		or 1.0
	)
	return {"rate": flt(base_rate) * flt(conversion_factor)}


def get_bin_qty_map(item_codes: list[str], warehouse: str | None) -> dict[str, float]:
	"""Bin quantity per item across ``warehouse`` (and its children when it is a group)."""
	warehouses = get_warehouse_list(warehouse)
	if not item_codes or not warehouses:
		return {}
	Bin = DocType("Bin")
	rows = (
		frappe.qb.from_(Bin)
		.select(Bin.item_code, Sum(Bin.actual_qty).as_("actual_qty"))
		.where(Bin.item_code.isin(list(set(item_codes))))
		.where(Bin.warehouse.isin(warehouses))
		.groupby(Bin.item_code)
		.run(as_dict=True)
	)
	return {row.item_code: flt(row.actual_qty) for row in rows}


def get_stock_qty_map(item_codes: list[str], warehouse: str, pos_profile: str | None = None):
	"""Read a catalog page's stock together, preserving pending POS deductions."""
	if not item_codes or not warehouse:
		return {}
	stock = get_bin_qty_map(item_codes, warehouse)
	if pos_profile and get_invoice_type() == "POS Invoice":
		pending = get_pending_pos_qty_map(get_warehouse_list(warehouse), item_codes=item_codes)
		for code in item_codes:
			stock[code] = stock.get(code, 0) - pending.get(code, 0)
	return stock


def get_stock_qty(item_code: str, warehouse: str, pos_profile: str | None = None):
	"""Get actual qty from Bin, supporting warehouse groups."""
	if not warehouse:
		return 0

	warehouses = get_warehouse_list(warehouse)

	Bin = DocType("Bin")
	rows = (
		frappe.qb.from_(Bin)
		.select(Sum(Bin.actual_qty).as_("actual_qty"))
		.where(Bin.item_code == item_code)
		.where(Bin.warehouse.isin(warehouses))
		.run(as_dict=True)
	)
	bin_qty = flt(rows[0].actual_qty) if rows else 0

	if pos_profile and get_invoice_type() == "POS Invoice":
		pending_map = get_pending_pos_qty_map(warehouses, item_codes=[item_code])
		bin_qty -= pending_map.get(item_code, 0.0)

	return bin_qty


def get_pending_batch_qty(warehouse: str, pos_profile: str | None) -> dict[str, float]:
	"""Return batch_no -> qty already sold on unconsolidated POS Invoices."""

	if not warehouse or not pos_profile or get_invoice_type() != "POS Invoice":
		return {}

	warehouses = get_warehouse_list(warehouse)

	pending: dict[str, float] = {}
	for (batch_no, _wh), qty in get_pending_pos_batch_qty_map(warehouses).items():
		pending[batch_no] = pending.get(batch_no, 0.0) + qty

	return pending


def get_pending_pos_qty_map(
	warehouses: list[str],
	item_codes: list[str] | None = None,
) -> dict[str, float]:
	"""Return qty sold in submitted but unconsolidated POS Invoices.

	Returns a dict mapping item_code -> total pending qty across the
	given warehouses.  Only submitted (docstatus=1) POS Invoices that
	have not yet been consolidated are considered.
	"""
	POSInv = DocType("POS Invoice")
	POSItem = DocType("POS Invoice Item")

	query = (
		frappe.qb.from_(POSItem)
		.join(POSInv)
		.on(POSItem.parent == POSInv.name)
		.select(
			POSItem.item_code,
			Sum(POSItem.stock_qty).as_("total_qty"),
		)
		.where(POSInv.docstatus == 1)
		.where((POSInv.consolidated_invoice == "") | (POSInv.consolidated_invoice.isnull()))
		.where(POSItem.warehouse.isin(warehouses))
		.groupby(POSItem.item_code)
	)

	if item_codes:
		query = query.where(POSItem.item_code.isin(item_codes))

	rows = query.run(as_dict=True)
	return {r.item_code: flt(r.total_qty) for r in rows}


def get_pending_pos_batch_qty_map(
	warehouses: list[str],
	batch_nos: list[str] | None = None,
) -> dict[tuple[str, str], float]:
	"""
	Return qty sold per batch in submitted but unconsolidated POS Invoices.
	"""

	if not warehouses:
		return {}

	POSInv = DocType("POS Invoice")
	POSItem = DocType("POS Invoice Item")

	query = (
		frappe.qb.from_(POSItem)
		.join(POSInv)
		.on(POSItem.parent == POSInv.name)
		.select(
			POSItem.batch_no,
			POSItem.warehouse,
			Sum(POSItem.stock_qty).as_("total_qty"),
		)
		.where(POSInv.docstatus == 1)
		.where((POSInv.consolidated_invoice == "") | (POSInv.consolidated_invoice.isnull()))
		.where(POSItem.warehouse.isin(warehouses))
		.where(POSItem.batch_no.notnull())
		.where(POSItem.batch_no != "")
		.groupby(POSItem.batch_no, POSItem.warehouse)
	)

	if batch_nos:
		query = query.where(POSItem.batch_no.isin(batch_nos))

	rows = query.run(as_dict=True)
	return {(r.batch_no, r.warehouse): flt(r.total_qty) for r in rows}


def get_batch_data(item_code: str, warehouse: str, today: str | None = None):
	"""Fetch available (non-expired) batches for an item in warehouse."""
	today = today or nowdate()
	batches = frappe.db.sql(
		"""
		SELECT
			sle.batch_no,
			SUM(sle.actual_qty) AS batch_qty,
			b.expiry_date,
			b.manufacturing_date
		FROM `tabStock Ledger Entry` sle
		INNER JOIN `tabBatch` b ON b.name = sle.batch_no
		WHERE sle.item_code = %(item_code)s
			AND sle.warehouse = %(warehouse)s
			AND sle.is_cancelled = 0
			AND sle.batch_no IS NOT NULL
		GROUP BY sle.batch_no
		HAVING batch_qty > 0
		ORDER BY b.expiry_date ASC, b.creation ASC
		""",
		{"item_code": item_code, "warehouse": warehouse},
		as_dict=True,
	)

	result = []
	for batch in batches:
		if batch.expiry_date and getdate(batch.expiry_date) < getdate(today):
			continue

		result.append(
			{
				"batch_no": batch.batch_no,
				"batch_qty": flt(batch.batch_qty),
				"expiry_date": batch.expiry_date,
				"manufacturing_date": batch.manufacturing_date,
			}
		)
	return result


def resolve_scale_barcode(barcode: str):
	"""Decode a scale barcode into an item and its weighed quantity."""
	from xpos.x_pos.api.item_processing.barcode import (
		get_scale_barcode_settings,
		parse_scale_barcode_data,
	)

	data = parse_scale_barcode_data(barcode)
	if not data or not data.get("item_code"):
		return None

	settings = get_scale_barcode_settings()
	weight_configured = (
		settings and cint(settings.weight_starting_digit) and cint(settings.weight_total_digits)
	)
	if weight_configured and data.get("qty") is None:
		return None

	decoded = data["item_code"]
	item_code = None
	uom = None

	if frappe.db.exists("Item", decoded):
		item_code = decoded
	else:
		row = frappe.db.get_value(
			"Item Barcode", {"barcode": decoded}, ["parent as item_code", "uom"], as_dict=True
		)
		if row:
			item_code = row.item_code
			uom = row.uom

	if not item_code:
		return None

	item = frappe.get_cached_doc("Item", item_code)
	qty = flt(data.get("qty"))

	return {
		"item_code": item.name,
		"item_name": item.item_name,
		"local_item_name": item.get("local_item_name"),
		"barcode": barcode,
		"uom": uom or item.stock_uom,
		"stock_uom": item.stock_uom,
		"has_batch_no": item.has_batch_no,
		"has_serial_no": item.has_serial_no,
		"is_stock_item": item.is_stock_item,
		"image": item.image,
		"qty": qty,
		"is_scale_barcode": True,
		"scale_price": flt(data["price"]) if data.get("price") is not None else None,
	}
