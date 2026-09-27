# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

import json

import frappe
from frappe.query_builder import DocType
from frappe.query_builder.functions import Sum
from frappe.utils import cint, flt, getdate, nowdate

from xpos.api.utilities import SAFE_FIELDNAME, get_invoice_type, get_item_search_settings


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


def build_item_search_or_filters(term: str, config: dict) -> list[list]:
	"""or_filters for frappe.get_list, over the configured Item columns."""
	pattern = f"%{term}%"
	return [[fieldname, "like", pattern] for fieldname in config["fields"]]


def build_item_search_sql(config: dict) -> str:
	"""OR fragment for the raw-SQL count query, over the configured Item columns."""
	clauses = [
		f"COALESCE(i.`{fieldname}`, '') LIKE %(search)s"
		for fieldname in config["fields"]
		if SAFE_FIELDNAME.match(fieldname)
	]
	return " OR ".join(clauses)


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
	pos = frappe.get_cached_doc("POS Profile", pos_profile)
	warehouse = pos.warehouse

	filters = {"disabled": 0, "is_sales_item": 1}

	if not (include_templates or pos.get("show_template_items")):
		filters["has_variants"] = 0
	elif pos.get("hide_variants_items"):
		filters["variant_of"] = ["in", ["", None]]

	if item_group and item_group != "All Item Groups":
		lft, rgt = frappe.db.get_value("Item Group", item_group, ["lft", "rgt"])
		groups = frappe.get_all("Item Group", filters={"lft": [">=", lft], "rgt": ["<=", rgt]}, pluck="name")
		filters["item_group"] = ["in", groups]
	elif pos.item_groups:
		allowed_names = [ig.item_group for ig in pos.item_groups]
		all_groups: set[str] = set()
		for group_name in allowed_names:
			lft_rgt = frappe.db.get_value("Item Group", group_name, ["lft", "rgt"])
			if lft_rgt:
				lft, rgt = lft_rgt
				descendants = frappe.get_all(
					"Item Group", filters={"lft": [">=", lft], "rgt": ["<=", rgt]}, pluck="name"
				)
				all_groups.update(descendants)
		if all_groups:
			filters["item_group"] = ["in", list(all_groups)]

	config = get_item_search_settings()
	or_filters = []
	if search_term:
		term = search_term.strip()
		resolved_item_code = resolve_scanned_item_code(term, config)
		if resolved_item_code:
			filters["item_code"] = resolved_item_code
		else:
			or_filters = build_item_search_or_filters(term, config)

	hide_unavailable = pos.get("hide_unavailable_items") and warehouse
	use_pos_deduction = bool(get_invoice_type() == "POS Invoice")

	if hide_unavailable:
		wh_list = [warehouse]
		if frappe.db.get_value("Warehouse", warehouse, "is_group"):
			wh_list = frappe.db.get_descendants("Warehouse", warehouse) or []

		in_stock_items = frappe.get_all(
			"Bin",
			filters={"warehouse": ["in", wh_list], "actual_qty": [">", 0]},
			pluck="item_code",
		)

		if use_pos_deduction and in_stock_items:
			pending_map = _get_pending_pos_qty_map(wh_list, item_codes=in_stock_items)
			if pending_map:
				from frappe.query_builder import DocType as DT
				from frappe.query_builder.functions import Sum as SumFn

				BinDT = DT("Bin")
				bin_rows = (
					frappe.qb.from_(BinDT)
					.select(BinDT.item_code, SumFn(BinDT.actual_qty).as_("actual_qty"))
					.where(BinDT.item_code.isin(in_stock_items))
					.where(BinDT.warehouse.isin(wh_list))
					.groupby(BinDT.item_code)
					.run(as_dict=True)
				)
				bin_map = {r.item_code: flt(r.actual_qty) for r in bin_rows}
				in_stock_items = [
					ic for ic in in_stock_items if (bin_map.get(ic, 0) - pending_map.get(ic, 0)) > 0
				]

		non_stock_items = frappe.get_all(
			"Item",
			filters={"is_stock_item": 0, "disabled": 0, "is_sales_item": 1},
			pluck="name",
		)
		available_items = list(set(in_stock_items + non_stock_items))
		if not available_items:
			return []
		filters["name"] = ["in", available_items]

	effective_page_length = cint(page_length)
	search_limit = cint(config["item_search_limit"])
	if search_term and search_limit > 0:
		effective_page_length = (
			min(effective_page_length, search_limit) if effective_page_length > 0 else search_limit
		)

	product_order = pos.get("xpos_product_order") or "Alphabetical"
	metric = {
		"Most Recent Purchase": "last_purchase",
		"Most Revenue": "revenue",
		"Most Transactions": "transactions",
	}.get(product_order)
	# Rank eligible names first; fetch price/stock/details only for the requested page.
	page_codes = None
	if metric:
		eligible = frappe.get_list(
			"Item",
			filters=filters,
			or_filters=or_filters,
			fields=["name"],
			order_by="item_name asc, name asc",
			limit_page_length=0,
		)
		ranking = get_item_sales_ranking(pos.company, metric)
		eligible.sort(key=lambda row: ranking.get(row.name, len(ranking)))
		page_codes = [
			row.name
			for row in eligible[
				cint(start) : cint(start) + effective_page_length if effective_page_length else None
			]
		]
		if not page_codes:
			return []
		filters["name"] = ["in", page_codes]

	items = frappe.get_list(
		"Item",
		filters=filters,
		or_filters=or_filters,
		fields=[
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
			"brand",
			"max_discount",
		],
		order_by={"Item Code": "name asc", "Recently Updated": "modified desc, name asc"}.get(
			pos.get("xpos_product_order"), "item_name asc, name asc"
		),
		limit_start=0 if page_codes is not None else cint(start),
		limit_page_length=effective_page_length,
	)

	if page_codes is not None:
		positions = {code: index for index, code in enumerate(page_codes)}
		items.sort(key=lambda item: positions[item.item_code])

	price_list = pos.selling_price_list or frappe.db.get_single_value(
		"Selling Settings", "selling_price_list"
	)

	for item in items:
		item.rate = (
			frappe.db.get_value(
				"Item Price",
				{"item_code": item.item_code, "price_list": price_list, "selling": 1},
				"price_list_rate",
			)
			or 0
		)

		item.actual_qty = (
			get_stock_qty(item.item_code, warehouse, pos_profile=pos_profile) if warehouse else 0
		)

	if include_uoms and items:
		item_codes = [item.item_code for item in items]
		uom_rows = frappe.get_all(
			"UOM Conversion Detail",
			filters={"parent": ["in", item_codes]},
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
	"""Get total count of items matching the filters."""
	pos = frappe.get_cached_doc("POS Profile", pos_profile)

	conditions = "i.disabled = 0 AND i.is_sales_item = 1 AND i.has_variants = 0"
	values = {}
	bin_join = ""

	if pos.get("hide_unavailable_items") and pos.warehouse:
		bin_join = "LEFT JOIN `tabBin` bin ON bin.item_code = i.name AND bin.warehouse = %(warehouse)s"
		conditions += " AND (i.is_stock_item = 0 OR bin.actual_qty > 0)"
		values["warehouse"] = pos.warehouse

	if item_group and item_group != "All Item Groups":
		ig = frappe.db.get_value("Item Group", item_group, ["lft", "rgt"], as_dict=True)
		if ig:
			conditions += " AND i.item_group IN (SELECT name FROM `tabItem Group` WHERE lft >= %(lft)s AND rgt <= %(rgt)s)"
			values["lft"] = ig.lft
			values["rgt"] = ig.rgt
	elif pos.item_groups:
		# POS Profile restricts to specific item groups — apply as baseline filter
		allowed_names = [ig.item_group for ig in pos.item_groups]
		all_groups: set[str] = set()
		for group_name in allowed_names:
			lft_rgt = frappe.db.get_value("Item Group", group_name, ["lft", "rgt"])
			if lft_rgt:
				lft, rgt = lft_rgt
				descendants = frappe.get_all(
					"Item Group", filters={"lft": [">=", lft], "rgt": ["<=", rgt]}, pluck="name"
				)
				all_groups.update(descendants)
		if all_groups:
			placeholders = ", ".join([f"%(ig_{i})s" for i in range(len(all_groups))])
			for i, g in enumerate(all_groups):
				values[f"ig_{i}"] = g
			conditions += f" AND i.item_group IN ({placeholders})"

	if search_term:
		config = get_item_search_settings()
		fragment = build_item_search_sql(config)
		if fragment:
			conditions += f" AND ({fragment})"
			values["search"] = f"%{search_term.strip()}%"

	sql = "SELECT COUNT(DISTINCT i.name) FROM `tabItem` i " + bin_join + " WHERE " + conditions
	count = frappe.db.sql(sql, values)
	return count[0][0] if count else 0


@frappe.whitelist()
def get_item_groups(pos_profile: str | None = None):
	"""Get item groups, filtered to POS Profile item_groups when configured."""
	if pos_profile:
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
			all_leaf_names: set[str] = set()
			for group_name in allowed_names:
				lft_rgt = frappe.db.get_value("Item Group", group_name, ["lft", "rgt"])
				if lft_rgt:
					lft, rgt = lft_rgt
					descendants = frappe.get_all(
						"Item Group",
						filters={"lft": [">=", lft], "rgt": ["<=", rgt], "is_group": 0},
						pluck="name",
					)
					all_leaf_names.update(descendants)
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

	def _get_item_rate(item_code):
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
		{"barcode": barcode},
		["parent as item_code", "barcode", "uom"],
		as_dict=True,
	)

	if barcode_data:
		item = frappe.get_cached_doc("Item", barcode_data.item_code)
		return {
			"item_code": item.name,
			"item_name": item.item_name,
			"local_item_name": item.get("local_item_name"),
			"barcode": barcode_data.barcode,
			"uom": barcode_data.uom or item.stock_uom,
			"stock_uom": item.stock_uom,
			"rate": _get_item_rate(item.name),
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
			"rate": _get_item_rate(item.name),
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
				"rate": _get_item_rate(item.name),
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
		rate = _get_item_rate(result["item_code"])
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
		for b in _get_batch_data(item_code, warehouse, today):
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
			"brand",
			"max_discount",
		],
		order_by="item_name asc",
	)

	if not variants:
		return {"variants": [], "attributes_meta": {}}

	for v in variants:
		rate = frappe.db.get_value(
			"Item Price",
			{"item_code": v["item_code"], "price_list": price_list, "selling": 1},
			"price_list_rate",
		)
		v["rate"] = flt(rate)
		v["actual_qty"] = (
			get_stock_qty(v["item_code"], warehouse, pos_profile=pos_profile) if warehouse else 0
		)

	from collections import defaultdict

	variant_codes = [v["item_code"] for v in variants]
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

	use_pos_deduction = bool(pos_profile and get_invoice_type() == "POS Invoice")
	pending_map: dict[str, float] = {}
	if use_pos_deduction and warehouse:
		wh_list = [warehouse]
		if frappe.db.get_value("Warehouse", warehouse, "is_group"):
			wh_list = frappe.db.get_descendants("Warehouse", warehouse) or []
		all_item_codes = []
		for d in items:
			if isinstance(d, str):
				all_item_codes.append(d)
			elif d.get("item_code"):
				all_item_codes.append(d.get("item_code"))
		pending_map = _get_pending_pos_qty_map(wh_list, item_codes=all_item_codes)

	results = []
	for d in items:
		if isinstance(d, str):
			item_code = d
			item_warehouse = warehouse
			batch_no = ""
		else:
			item_code = d.get("item_code")
			item_warehouse = d.get("warehouse") or warehouse
			batch_no = d.get("batch_no", "")

		if not item_code or not item_warehouse:
			continue

		if batch_no:
			from erpnext.stock.doctype.batch.batch import get_batch_qty

			qty = flt(get_batch_qty(batch_no, item_warehouse))
			if use_pos_deduction:
				qty -= get_pending_batch_qty(item_warehouse, pos_profile).get(batch_no, 0.0)
		else:
			qty = flt(get_stock_qty(item_code, item_warehouse))
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


def get_item_sales_ranking(company: str, metric: str) -> dict[str, int]:
	"""Lifetime company sales; returns net revenue, and consolidated tickets count once."""
	if metric not in {"last_purchase", "revenue", "transactions"}:
		frappe.throw("Invalid product ranking")
	rows = frappe.db.sql(
		f"""
		SELECT item_code, MAX(CASE WHEN is_return = 0 THEN posted END) AS last_purchase,
		SUM(base_net_amount) AS revenue,
		COUNT(DISTINCT CASE WHEN is_return = 0 THEN ticket END) AS transactions
		FROM (
		 SELECT i.item_code, TIMESTAMP(s.posting_date,s.posting_time) AS posted,
		 s.is_return, i.base_net_amount, CONCAT('SI:',s.name) AS ticket
		 FROM `tabSales Invoice Item` i JOIN `tabSales Invoice` s ON i.parent = s.name
		 WHERE s.docstatus = 1 AND s.company = %(company)s AND IFNULL(s.is_consolidated,0) = 0
		 UNION ALL
		 SELECT i.item_code, TIMESTAMP(s.posting_date,s.posting_time), s.is_return,
		 i.base_net_amount, CONCAT('POS:',s.name)
		 FROM `tabPOS Invoice Item` i JOIN `tabPOS Invoice` s ON i.parent = s.name
		 WHERE s.docstatus = 1 AND s.company = %(company)s
		) sales GROUP BY item_code ORDER BY {metric} DESC, item_code ASC
	""",
		{"company": company},
		as_dict=True,
	)
	return {row.item_code: index for index, row in enumerate(rows)}


def get_stock_qty(item_code: str, warehouse: str, pos_profile: str | None = None):
	"""Get actual qty from Bin, supporting warehouse groups."""
	if not warehouse:
		return 0

	warehouses = [warehouse]
	if frappe.db.get_value("Warehouse", warehouse, "is_group"):
		warehouses = frappe.db.get_descendants("Warehouse", warehouse) or []

	from frappe.query_builder import DocType
	from frappe.query_builder.functions import Sum

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
		pending_map = _get_pending_pos_qty_map(warehouses, item_codes=[item_code])
		bin_qty -= pending_map.get(item_code, 0.0)

	return bin_qty


def get_pending_batch_qty(warehouse: str, pos_profile: str | None) -> dict[str, float]:
	"""Return batch_no -> qty already sold on unconsolidated POS Invoices."""

	if not warehouse or not pos_profile or get_invoice_type() != "POS Invoice":
		return {}

	warehouses = [warehouse]
	if frappe.db.get_value("Warehouse", warehouse, "is_group"):
		warehouses = frappe.db.get_descendants("Warehouse", warehouse) or []

	pending: dict[str, float] = {}
	for (batch_no, _wh), qty in get_pending_pos_batch_qty_map(warehouses).items():
		pending[batch_no] = pending.get(batch_no, 0.0) + qty

	return pending


def _get_pending_pos_qty_map(
	warehouses: list[str],
	item_codes: list[str] | None = None,
) -> dict[str, float]:
	"""Return qty sold in submitted but unconsolidated POS Invoices.

	Returns a dict mapping item_code -> total pending qty across the
	given warehouses.  Only submitted (docstatus=1) POS Invoices that
	have not yet been consolidated are considered.
	"""
	from frappe.query_builder import DocType
	from frappe.query_builder.functions import Sum

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


def _get_batch_data(item_code: str, warehouse: str, today: str | None = None):
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
