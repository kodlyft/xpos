# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""Pricing Rule evaluation for the XPOS cart.

The cart needs to show Pricing Rule discounts *before* the invoice is saved, and
it needs to show exactly what the server will compute on save. Rather than
reimplementing ERPNext's engine, ``reconcile_line_prices`` builds the same
in-memory Sales Invoice the save path builds and drives ERPNext's own
``get_pricing_rule_for_item`` / ``apply_pricing_rule_on_items`` over it.

``get_active_pricing_rules`` returns a flattened snapshot of the active rules so
the browser can keep applying them while the network is down. Tree fields
(item group, customer group, territory) are expanded to their descendant sets
server-side so the offline engine only needs flat membership tests.
"""

from __future__ import annotations

from typing import Any

import frappe
from frappe import _
from frappe.utils import cint, flt, getdate, nowdate

APPLY_ON_CHILD_TABLES: tuple[tuple[str, str, str], ...] = (
	("Item Code", "Pricing Rule Item Code", "item_code"),
	("Item Group", "Pricing Rule Item Group", "item_group"),
	("Brand", "Pricing Rule Brand", "brand"),
)


def parse_json_arg(value, default):
	if value is None or value == "":
		return default
	if isinstance(value, str):
		return frappe.parse_json(value)
	return value


def coerce_date(value) -> str:
	if not value:
		return nowdate()
	try:
		return str(getdate(value))
	except Exception:
		return nowdate()


def empty_result() -> dict[str, Any]:
	return {"updates": [], "free_lines": [], "invoice_updates": {}}


def pricing_rules_ignored(pos_profile: str | None) -> bool:
	"""Mirror ``Sales Invoice.set_pos_fields``, which copies this flag onto the invoice."""

	if not pos_profile:
		return False
	return bool(cint(frappe.get_cached_value("POS Profile", pos_profile, "ignore_pricing_rule")))


def enrich_lines(lines: list[dict]) -> None:
	"""Fill in item_group / brand / stock_uom the frontend may not have sent."""

	missing = [
		line.get("item_code")
		for line in lines
		if line.get("item_code") and not (line.get("item_group") and line.get("brand"))
	]
	if not missing:
		return

	rows = frappe.get_all(
		"Item",
		filters={"name": ("in", list(set(missing)))},
		fields=["name", "item_name", "item_group", "brand", "stock_uom"],
	)
	details = {row.name: row for row in rows}

	for line in lines:
		row = details.get(line.get("item_code"))
		if not row:
			continue
		line.setdefault("item_name", row.item_name)
		line.setdefault("stock_uom", row.stock_uom)
		if not line.get("item_group"):
			line["item_group"] = row.item_group
		if not line.get("brand"):
			line["brand"] = row.brand


def build_invoice_context(ctx: frappe._dict, lines: list[dict]):
	"""Build the unsaved Sales Invoice that ERPNext's pricing engine reads from.

	This is a real Document (not a plain dict) so the engine's document-aware
	paths - mixed conditions, ``apply_rule_on_other``, recursive free items -
	see the same shape they see during ``validate``.
	"""

	customer_group, territory = None, None
	if ctx.get("customer"):
		customer_group, territory = frappe.get_cached_value(
			"Customer", ctx.customer, ["customer_group", "territory"]
		) or (None, None)

	doc = frappe.get_doc(
		{
			"doctype": "Sales Invoice",
			"company": ctx.get("company"),
			"customer": ctx.get("customer"),
			"customer_group": ctx.get("customer_group") or customer_group,
			"territory": ctx.get("territory") or territory,
			"currency": ctx.get("currency"),
			"conversion_rate": flt(ctx.get("conversion_rate") or 1),
			"selling_price_list": ctx.get("price_list"),
			"price_list_currency": ctx.get("currency"),
			"plc_conversion_rate": flt(ctx.get("conversion_rate") or 1),
			"posting_date": coerce_date(ctx.get("posting_date")),
			"coupon_code": ctx.get("coupon_code"),
			"is_pos": 1,
			"pos_profile": ctx.get("pos_profile"),
			"ignore_pricing_rule": 0,
			"items": [],
		}
	)

	total = total_qty = 0.0
	for line in lines:
		qty = abs(flt(line.get("qty") or 0))
		conversion_factor = flt(line.get("conversion_factor") or 1) or 1
		price_list_rate = flt(line.get("price_list_rate") or line.get("rate") or 0)
		rate = flt(line.get("rate") or price_list_rate)

		row = doc.append(
			"items",
			{
				"item_code": line.get("item_code"),
				"item_name": line.get("item_name"),
				"item_group": line.get("item_group"),
				"brand": line.get("brand"),
				"qty": qty,
				"uom": line.get("uom") or line.get("stock_uom"),
				"stock_uom": line.get("stock_uom") or line.get("uom"),
				"conversion_factor": conversion_factor,
				"stock_qty": qty * conversion_factor,
				"price_list_rate": price_list_rate,
				"rate": rate,
				"warehouse": line.get("warehouse"),
				"pricing_rules": line.get("pricing_rules"),
				"is_free_item": 0,
			},
		)
		row.amount = flt(row.rate) * flt(row.qty)
		row.net_amount = row.amount
		total += row.amount
		total_qty += row.qty

	doc.total = total
	doc.net_total = total
	doc.total_qty = total_qty

	return doc


def apply_item_rules(doc) -> dict[str, Any]:
	"""Run ERPNext's per-item pricing engine over the cart rows.

	Deliberately reuses ``apply_pricing_rule_on_items`` /
	``set_pricing_rule_details`` (the controller methods the save path calls)
	instead of reimplementing rate maths, so a cart preview and a saved invoice
	cannot drift apart.
	"""

	from erpnext.accounts.doctype.pricing_rule.pricing_rule import (
		get_pricing_rule_for_item,
		set_transaction_type,
	)

	doc.pricing_rules = []
	parent_dict = {fieldname: doc.get(fieldname) for fieldname in doc.meta.get_valid_columns()}

	priced_rows = list(doc.items)

	for row in priced_rows:
		args = frappe._dict(parent_dict.copy())
		args.update(row.as_dict())
		args.update(
			{
				"doctype": doc.doctype,
				"name": doc.name,
				"child_doctype": row.doctype,
				"child_docname": row.name,
				"transaction_date": doc.posting_date,
				"price_list": doc.get("selling_price_list"),
				"ignore_pricing_rule": 0,
			}
		)
		set_transaction_type(args)

		details = get_pricing_rule_for_item(args, doc=doc) or frappe._dict()

		if details.get("pricing_rules"):
			doc.apply_pricing_rule_on_items(row, details)
			doc.set_pricing_rule_details(row, details)
			if not row.get("pricing_rules"):
				# Product rules take a branch of apply_pricing_rule_on_items that
				# never stamps the trigger row; set_missing_item_details does it
				# via its generic field copy, so do the same here.
				row.pricing_rules = details.get("pricing_rules")
		elif details.get("pricing_rule_removed"):
			# A rule that used to apply no longer matches - reset what it set.
			for fieldname in (
				"rate",
				"discount_percentage",
				"discount_amount",
				"margin_type",
				"margin_rate_or_amount",
			):
				if details.get(fieldname) is not None:
					row.set(fieldname, details.get(fieldname))
			row.pricing_rules = ""

		row.amount = flt(row.rate) * flt(row.qty)
		row.net_amount = row.amount

	doc.total = sum(flt(row.amount) for row in doc.items)
	doc.net_total = doc.total
	doc.total_qty = sum(flt(row.qty) for row in doc.items)

	recalculate_totals(doc)

	return {"priced_rows": priced_rows}


def recalculate_totals(doc) -> None:
	"""Round rates the way the save path does.

	``apply_pricing_rule_on_items`` leaves unrounded rates (e.g. 3.8880000000004);
	``calculate_taxes_and_totals`` is what turns them into the 3.89 the invoice
	stores. Running it here keeps the cart total penny-identical to the invoice.
	"""

	try:
		doc.calculate_taxes_and_totals()
	except Exception:
		# Totals are a presentation concern - never lose the computed discounts
		# over a document shape this routine dislikes.
		frappe.log_error(
			title="XPOS: pricing preview totals failed",
			message=frappe.get_traceback(with_context=True),
		)
		for row in doc.items:
			doc.round_floats_in(row, ["rate", "price_list_rate", "discount_amount", "discount_percentage"])


def apply_transaction_rules(doc) -> dict[str, Any]:
	"""Apply ``apply_on = 'Transaction'`` rules using ERPNext's own routine.

	``apply_pricing_rule_on_transaction`` is what ``AccountsController.validate``
	calls, so invoice-level discounts and transaction free items land exactly as
	they will on save. Because the preview doc starts with no discount, whatever
	is on the doc afterwards is authoritative - including "no discount", which is
	how the cart knows to clear a rule discount that no longer applies.
	"""

	from erpnext.accounts.doctype.pricing_rule.utils import apply_pricing_rule_on_transaction

	apply_pricing_rule_on_transaction(doc)

	discount_percentage = flt(doc.get("additional_discount_percentage"))
	discount_amount = flt(doc.get("discount_amount"))

	# A percentage rule also leaves a derived discount_amount on the doc. The
	# cart's discount is percentage-XOR-amount, so report only the driver.
	if discount_percentage:
		discount_amount = 0.0

	return {
		"additional_discount_percentage": discount_percentage,
		"discount_amount": discount_amount,
		"apply_discount_on": doc.get("apply_discount_on") or "Grand Total",
		"from_pricing_rule": bool(discount_percentage or discount_amount),
	}


def serialise_updates(priced_rows, lines: list[dict]) -> list[dict]:
	from erpnext.accounts.doctype.pricing_rule.utils import get_applied_pricing_rules

	updates = []
	for row, line in zip(priced_rows, lines, strict=False):
		updates.append(
			{
				"row_id": line.get("row_id") or line.get("name") or row.item_code,
				"item_code": row.item_code,
				"price_list_rate": flt(row.price_list_rate),
				"rate": flt(row.rate),
				"discount_percentage": flt(row.discount_percentage),
				"discount_amount": flt(row.discount_amount),
				"margin_type": row.get("margin_type") or None,
				"margin_rate_or_amount": flt(row.get("margin_rate_or_amount")),
				"pricing_rules": get_applied_pricing_rules(row.get("pricing_rules")) or [],
			}
		)
	return updates


def serialise_free_lines(doc) -> list[dict]:
	free_lines = []
	for row in doc.items:
		if not cint(row.get("is_free_item")):
			continue
		free_lines.append(
			{
				"item_code": row.item_code,
				"item_name": row.item_name,
				"qty": flt(row.qty),
				"uom": row.uom,
				"stock_uom": row.get("stock_uom"),
				"conversion_factor": flt(row.get("conversion_factor") or 1),
				"rate": flt(row.rate),
				"price_list_rate": flt(row.price_list_rate),
				"pricing_rules": row.get("pricing_rules"),
				"is_free_item": 1,
			}
		)
	return free_lines


@frappe.whitelist()
def reconcile_line_prices(cart_payload: dict | str | None = None):
	"""Return the Pricing Rule outcome for a cart, without saving anything.

	``cart_payload`` is ``{"context": {...}, "lines": [{...}]}``. Each line
	carries a ``row_id`` (the cart's client-side row id) which is echoed back so
	the frontend can apply results to the right row even when the same item
	appears more than once.
	"""

	cart = parse_json_arg(cart_payload, None)
	if not cart:
		return empty_result()

	ctx = frappe._dict(cart.get("context") or {})
	lines = cart.get("lines") or []

	if not lines:
		return empty_result()
	if not ctx.get("company"):
		frappe.throw(_("Company is required"))
	if pricing_rules_ignored(ctx.get("pos_profile")):
		return empty_result()

	enrich_lines(lines)

	doc = build_invoice_context(ctx, lines)
	priced_rows = apply_item_rules(doc)["priced_rows"]

	try:
		invoice_updates = apply_transaction_rules(doc)
	except Exception:
		# Transaction-level rules are additive: a bad rule config here must not
		# cost the cashier the line-level prices we already computed.
		frappe.log_error(
			title="XPOS: transaction pricing rules failed",
			message=frappe.get_traceback(with_context=True),
		)
		invoice_updates = {}

	return {
		"updates": serialise_updates(priced_rows, lines),
		"free_lines": serialise_free_lines(doc),
		"invoice_updates": invoice_updates,
	}


# ---------------------------------------------------------------------------
# get_active_pricing_rules (offline snapshot)


class TreeExpander:
	"""Expand a tree node to its descendants, memoised for one request.

	ERPNext matches a rule when the rule's group is an *ancestor* of the
	transaction's group (see ``utils._get_tree_conditions``), so expanding the
	rule side to descendants makes the offline test a flat membership check.
	"""

	def __init__(self) -> None:
		self._cache: dict[tuple[str, str], list[str]] = {}

	def __call__(self, doctype: str, name: str | None) -> list[str]:
		if not name:
			return []
		key = (doctype, name)
		if key in self._cache:
			return self._cache[key]

		bounds = frappe.db.get_value(doctype, name, ["lft", "rgt"])
		if not bounds:
			self._cache[key] = [name]
			return self._cache[key]

		lft, rgt = bounds
		names = frappe.get_all(doctype, filters={"lft": (">=", lft), "rgt": ("<=", rgt)}, pluck="name") or [
			name
		]
		self._cache[key] = names
		return names


def get_rule_targets(rule_names: list[str], expand: TreeExpander) -> dict[str, dict[str, Any]]:
	"""Fetch and expand the item code / item group / brand child rows per rule."""

	targets: dict[str, dict[str, Any]] = {
		name: {"item_codes": [], "item_groups": [], "brands": [], "has_target_uom": False}
		for name in rule_names
	}
	if not rule_names:
		return targets

	for apply_on, child_doctype, fieldname in APPLY_ON_CHILD_TABLES:
		child_meta = frappe.get_meta(child_doctype)
		fields = ["parent", fieldname]
		if child_meta.has_field("uom"):
			fields.append("uom")

		rows = frappe.get_all(child_doctype, filters={"parent": ("in", rule_names)}, fields=fields)
		for row in rows:
			value = row.get(fieldname)
			if not value:
				continue
			if row.get("uom"):
				# Per-target UOM restrictions need conversion factors the local
				# engine does not carry - fall back to the server for these.
				targets[row.parent]["has_target_uom"] = True
			if apply_on == "Item Code":
				targets[row.parent]["item_codes"].append(value)
			elif apply_on == "Brand":
				targets[row.parent]["brands"].append(value)
			else:
				targets[row.parent]["item_groups"].extend(expand("Item Group", value))

	for bucket in targets.values():
		bucket["item_groups"] = sorted(set(bucket["item_groups"]))

	return targets


def is_offline_supported(rule: frappe._dict, has_target_uom: bool) -> int:
	"""Rules the browser engine cannot evaluate faithfully are skipped offline.

	Mixed conditions, cross-item rules, per-target UOMs and server-side condition
	scripts all need context or evaluation the local engine does not have.
	Marking them rather than approximating keeps offline prices honest.
	"""

	if cint(rule.get("mixed_conditions")):
		return 0
	if rule.get("apply_rule_on_other"):
		return 0
	if (rule.get("condition") or "").strip():
		return 0
	if cint(rule.get("is_cumulative")):
		# Cumulative rules aggregate over historical transactions.
		return 0
	if has_target_uom:
		return 0
	return 1


@frappe.whitelist()
def get_active_pricing_rules(params: dict | str | None = None, **kwargs):
	"""Return a flattened snapshot of active selling Pricing Rules.

	Consumed by the frontend to price carts locally while offline, so every
	tree field is pre-expanded and every field the local engine needs is
	included verbatim.
	"""

	ctx = frappe._dict(parse_json_arg(params, None) or kwargs or {})

	company = ctx.get("company")
	if not company:
		return []

	if pricing_rules_ignored(ctx.get("pos_profile")):
		return []

	date = coerce_date(ctx.get("date"))

	meta = frappe.get_meta("Pricing Rule")
	fields = [
		"name",
		"title",
		"apply_on",
		"price_or_product_discount",
		"rate_or_discount",
		"apply_discount_on",
		"priority",
		"apply_multiple_pricing_rules",
		"apply_discount_on_rate",
		"is_cumulative",
		"coupon_code_based",
		"mixed_conditions",
		"apply_rule_on_other",
		"condition",
		"company",
		"currency",
		"for_price_list",
		"warehouse",
		"applicable_for",
		"customer",
		"customer_group",
		"territory",
		"min_qty",
		"max_qty",
		"min_amt",
		"max_amt",
		"valid_from",
		"valid_upto",
		"rate",
		"discount_percentage",
		"discount_amount",
		"margin_type",
		"margin_rate_or_amount",
		"same_item",
		"free_item",
		"free_qty",
		"free_item_uom",
		"free_item_rate",
		"is_recursive",
		"recurse_for",
		"apply_recursion_over",
		"round_free_qty",
	]
	fields = [fieldname for fieldname in fields if fieldname == "name" or meta.has_field(fieldname)]

	filters: list[Any] = [
		["selling", "=", 1],
		["disable", "=", 0],
		["company", "in", [company, ""]],
	]

	rules = frappe.get_all("Pricing Rule", filters=filters, fields=fields, order_by="priority desc, name asc")

	# `valid_from` / `valid_upto` are optional open-ended bounds, which is
	# awkward to express as a filter list - narrow them in Python instead.
	rules = [
		rule
		for rule in rules
		if (not rule.get("valid_from") or str(rule["valid_from"]) <= date)
		and (not rule.get("valid_upto") or str(rule["valid_upto"]) >= date)
	]

	if not rules:
		return []

	expand = TreeExpander()
	targets = get_rule_targets([rule["name"] for rule in rules], expand)

	free_item_codes = {rule.get("free_item") for rule in rules if rule.get("free_item")}
	free_item_details = {}
	if free_item_codes:
		free_item_details = {
			row.name: row
			for row in frappe.get_all(
				"Item",
				filters={"name": ("in", list(free_item_codes))},
				fields=["name", "item_name", "stock_uom"],
			)
		}

	snapshot = []
	for rule in rules:
		free_item = free_item_details.get(rule.get("free_item"))
		payload = dict(rule)
		payload.update(
			{
				"valid_from": str(rule["valid_from"]) if rule.get("valid_from") else None,
				"valid_upto": str(rule["valid_upto"]) if rule.get("valid_upto") else None,
				"customer_groups": expand("Customer Group", rule.get("customer_group")),
				"territories": expand("Territory", rule.get("territory")),
				"warehouses": expand("Warehouse", rule.get("warehouse")),
				"item_codes": targets[rule["name"]]["item_codes"],
				"item_groups": targets[rule["name"]]["item_groups"],
				"brands": targets[rule["name"]]["brands"],
				"free_item_name": free_item.item_name if free_item else None,
				"free_item_stock_uom": free_item.stock_uom if free_item else None,
				"offline_supported": is_offline_supported(
					frappe._dict(rule), targets[rule["name"]]["has_target_uom"]
				),
			}
		)
		snapshot.append(payload)

	return snapshot
