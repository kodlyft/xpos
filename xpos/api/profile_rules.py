# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""Server-side rules behind POS Profile settings.

The SPA previews these rules, but a submitted cart is always re-checked here
against the server-loaded profile: see docs/features/pos-profile-settings-status.md.
"""

import frappe
from frappe import _
from frappe.utils import cint, flt, getdate, nowdate
from frappe.utils.nestedset import get_ancestors_of

from xpos.api.profiles import resolve_pos_profile


def profile_flag(pos, fieldname: str) -> bool:
	return bool(cint(pos.get(fieldname)))


def customer_price_list(customer: str | None) -> str | None:
	"""The Customer's own selling price list, else the nearest Customer Group one."""
	if not customer:
		return None
	row = frappe.db.get_value("Customer", customer, ["default_price_list", "customer_group"], as_dict=True)
	if not row:
		return None
	if row.default_price_list:
		return row.default_price_list
	if not row.customer_group:
		return None
	for group in [row.customer_group, *get_ancestors_of("Customer Group", row.customer_group)]:
		price_list = frappe.db.get_value("Customer Group", group, "default_price_list")
		if price_list:
			return price_list
	return None


def price_list_usable(price_list: str, currency: str | None) -> bool:
	row = frappe.db.get_value("Price List", price_list, ["enabled", "selling", "currency"], as_dict=True)
	if not row or not row.enabled or not row.selling:
		return False
	return not currency or row.currency == currency


def resolve_selling_price_list(pos, customer: str | None) -> str | None:
	"""Price list for normal sale lines: customer → customer group → profile.

	A customer list is only used when the profile forces it and the list is an
	enabled selling list in the same currency as the profile's own list, so the
	existing currency conversion still applies.
	"""
	base = pos.get("selling_price_list")
	if not profile_flag(pos, "force_price_from_customer_price_list"):
		return base
	candidate = customer_price_list(customer)
	if not candidate or candidate == base:
		return base
	base_currency = frappe.db.get_value("Price List", base, "currency") if base else None
	return candidate if price_list_usable(candidate, base_currency) else base


def get_line_rate(
	price_list: str | None,
	item_code: str,
	uom: str | None = None,
	customer: str | None = None,
	qty: float = 1,
	posting_date: str | None = None,
	batch_no: str | None = None,
) -> float | None:
	"""Item Price for one line, honouring UOM, validity dates and customer-specific prices.

	Returns None when the price list has no usable price for the item.
	"""
	if not price_list or not item_code:
		return None
	from erpnext.stock.get_item_details import get_conversion_factor, get_price_list_rate_for

	stock_uom = frappe.get_cached_value("Item", item_code, "stock_uom")
	uom = uom or stock_uom
	conversion_factor = 1
	if uom != stock_uom:
		conversion_factor = flt(get_conversion_factor(item_code, uom).get("conversion_factor")) or 1
	rate = get_price_list_rate_for(
		frappe._dict(
			price_list=price_list,
			customer=customer,
			uom=uom,
			stock_uom=stock_uom,
			conversion_factor=conversion_factor,
			qty=abs(flt(qty)) or 1,
			transaction_date=posting_date or nowdate(),
			batch_no=batch_no,
		),
		item_code,
	)
	return None if rate is None else flt(rate)


@frappe.whitelist()
def get_customer_line_prices(
	pos_profile: str,
	customer: str | None = None,
	lines: str | list | None = None,
	posting_date: str | None = None,
):
	"""Prices from the effective price list for the given cart lines.

	``lines`` is ``[{row_id, item_code, uom, qty, batch_no}]``. A ``None`` price
	means the list has no price for that line ("price unavailable").
	"""
	pos = resolve_pos_profile(pos_profile)
	lines = frappe.parse_json(lines) if isinstance(lines, str) else (lines or [])
	price_list = resolve_selling_price_list(pos, customer)
	prices = {}
	for line in lines:
		prices[line.get("row_id")] = get_line_rate(
			price_list,
			line.get("item_code"),
			line.get("uom"),
			customer,
			line.get("qty") or 1,
			posting_date,
			line.get("batch_no"),
		)
	return {"price_list": price_list, "prices": prices}


def parse_rule_names(value) -> list[str]:
	"""ERPNext stores ``pricing_rules`` as a JSON list string; the SPA may send a plain name."""
	if not value:
		return []
	if isinstance(value, str) and value.strip().startswith("["):
		value = frappe.parse_json(value)
	if isinstance(value, str):
		value = value.split(",")
	return [str(v).strip() for v in value if str(v).strip()]


def verified_pricing_rule_free_line(pos, line: dict) -> bool:
	"""A free line is genuine only if a live Product pricing rule gives this item."""
	for rule_name in parse_rule_names(line.get("pricing_rules")):
		rule = frappe.db.get_value(
			"Pricing Rule",
			rule_name,
			["disable", "selling", "price_or_product_discount", "company", "same_item", "free_item"],
			as_dict=True,
		)
		if not rule or rule.disable or not rule.selling or rule.price_or_product_discount != "Product":
			continue
		if rule.company and rule.company != pos.company:
			continue
		if rule.same_item or rule.free_item == line.get("item_code"):
			return True
	return False


def offer_matches_item(offer, item: dict) -> bool:
	item_code = item.get("item_code")
	if offer.apply_on == "Item Code":
		return bool(offer.item) and offer.item == item_code
	if offer.apply_on == "Item Group":
		return bool(offer.item_group) and offer.item_group == frappe.get_cached_value(
			"Item", item_code, "item_group"
		)
	if offer.apply_on == "Brand":
		return bool(offer.brand) and offer.brand == frappe.get_cached_value("Item", item_code, "brand")
	return False


def live_offer(pos, offer_name: str | None, coupon_offers: set, posting_date):
	"""The POS Offer if it is enabled, in scope for this profile and date, and coupon-unlocked when needed."""
	if not offer_name or not frappe.db.exists("POS Offer", offer_name):
		return None
	offer = frappe.get_cached_doc("POS Offer", offer_name)
	if offer.disabled:
		return None
	if offer.company and offer.company != pos.company:
		return None
	if offer.pos_profile and offer.pos_profile != pos.name:
		return None
	date = getdate(posting_date or nowdate())
	if (offer.valid_from and getdate(offer.valid_from) > date) or (
		offer.valid_upto and getdate(offer.valid_upto) < date
	):
		return None
	if cint(offer.coupon_based) and offer.name not in coupon_offers:
		return None
	return offer


def offer_matching_lines(offer, paid_lines: list[dict]) -> list[dict]:
	"""Paid lines the offer applies to, empty when its qty/amount conditions are not met."""
	if offer.apply_on == "Transaction":
		matching = paid_lines
	else:
		matching = [i for i in paid_lines if offer_matches_item(offer, i)]
	if not matching:
		return []
	matched_qty = sum(abs(flt(i.get("qty"))) for i in matching)
	matched_amt = sum(abs(flt(i.get("qty"))) * flt(i.get("rate")) for i in matching)
	if (flt(offer.min_qty) and matched_qty < flt(offer.min_qty)) or (
		flt(offer.max_qty) and matched_qty > flt(offer.max_qty)
	):
		return []
	if (flt(offer.min_amt) and matched_amt < flt(offer.min_amt)) or (
		flt(offer.max_amt) and matched_amt > flt(offer.max_amt)
	):
		return []
	return matching


def verified_offer_free_line(
	pos, line: dict, paid_lines: list[dict], coupon_offers: set, posting_date
) -> bool:
	"""Re-derive a POS Offer free line on the server; the client's ``is_offer`` flag alone proves nothing."""
	offer = live_offer(pos, line.get("offers"), coupon_offers, posting_date)
	if not offer or offer.offer != "Give Product" or flt(offer.given_qty) <= 0:
		return False
	matching = offer_matching_lines(offer, paid_lines)
	if not matching:
		return False

	item_code = line.get("item_code")
	max_qty = flt(offer.given_qty)
	if cint(offer.replace_item) or cint(offer.replace_cheapest_item):
		if item_code not in {i.get("item_code") for i in matching}:
			return False
		if cint(offer.replace_item):
			max_qty = flt(offer.given_qty) * len(matching)
	elif offer.apply_type == "Item Code":
		if offer.apply_item_code != item_code:
			return False
	elif offer.apply_type == "Item Group":
		if offer.apply_item_group != frappe.get_cached_value("Item", item_code, "item_group"):
			return False
	else:
		return False
	return abs(flt(line.get("qty"))) <= max_qty


def check_zero_price_line(pos, item_code: str, net_rate: float, verified_free: bool) -> None:
	"""Reject an unauthorised zero-price sale line (100% discounts count as zero-price)."""
	if net_rate > 0 or verified_free:
		return
	if not profile_flag(pos, "allow_zero_rated_items"):
		frappe.throw(
			_("Item {0} has a zero price. Zero-price sale lines are not allowed on POS Profile {1}.").format(
				item_code, pos.name
			),
			title=_("Zero price not allowed"),
		)


def manual_discount_cap(pos, user: str | None = None) -> float:
	"""Largest manual discount (%) ``user`` may give through ``pos``.

	The profile's Max Discount and the user's own Discount Limit both cap it.
	A Discount Limit of 0 is the field default ("not set"), so it does not cap.
	"""
	user = user or frappe.session.user
	limit = frappe.db.get_value(
		"POS Profile User", {"parent": pos.name, "parenttype": "POS Profile", "user": user}, "discount_limit"
	)
	caps = [c for c in (flt(pos.get("max_discount_percentage_allowed")), flt(limit)) if c > 0]
	return min(caps) if caps else 100.0


def rule_line_discount_pct(pos, row) -> float:
	"""Discount (%) of ``price_list_rate`` that a live Price pricing rule on this row gives."""
	plr = flt(row.get("price_list_rate"))
	best = 0.0
	for rule_name in parse_rule_names(row.get("pricing_rules")):
		rule = frappe.db.get_value(
			"Pricing Rule",
			rule_name,
			[
				"disable",
				"selling",
				"price_or_product_discount",
				"company",
				"rate_or_discount",
				"discount_percentage",
				"discount_amount",
				"rate",
			],
			as_dict=True,
		)
		if not rule or rule.disable or not rule.selling or rule.price_or_product_discount != "Price":
			continue
		if rule.company and rule.company != pos.company:
			continue
		if rule.rate_or_discount == "Discount Percentage":
			pct = flt(rule.discount_percentage)
		elif plr and rule.rate_or_discount == "Discount Amount":
			pct = flt(rule.discount_amount) / plr * 100
		elif plr and rule.rate_or_discount == "Rate":
			pct = (plr - flt(rule.rate)) / plr * 100
		else:
			pct = 0
		best = max(best, pct)
	return min(max(best, 0.0), 100.0)


def offer_discounts(pos, offer_names, paid_lines: list[dict], coupon_offers: set, posting_date):
	"""Server-derived POS Offer discounts: (item-level amount, grand-total %).

	Mirrors the till's offer engine (Item Price and Grand Total offers) but only
	for offers that are live for this profile, date and coupon.
	"""
	item_amount, total_pct = 0.0, 0.0
	for name in dict.fromkeys(n for n in offer_names if n):
		offer = live_offer(pos, name, coupon_offers, posting_date)
		if not offer:
			continue
		matching = offer_matching_lines(offer, paid_lines)
		if not matching:
			continue
		if offer.offer == "Grand Total":
			total_pct += flt(offer.discount_percentage)
		elif offer.offer == "Item Price" and offer.apply_on != "Transaction":
			for line in matching:
				qty, rate = abs(flt(line.get("qty"))), flt(line.get("rate"))
				if offer.discount_type == "Rate":
					item_amount += max(0.0, qty * rate - qty * flt(offer.rate))
				elif offer.discount_type == "Discount Percentage":
					item_amount += qty * rate * flt(offer.discount_percentage) / 100
				elif offer.discount_type == "Discount Amount":
					item_amount += flt(offer.discount_amount) * qty
	return item_amount, min(total_pct, 100.0)


def transaction_rule_discount(doc, base: float) -> float:
	"""Invoice discount ERPNext's own transaction-level pricing rules applied in validate."""
	best = 0.0
	for row in doc.get("pricing_rules") or []:
		if not row.pricing_rule or row.item_code or row.child_docname:
			continue
		rule = frappe.db.get_value(
			"Pricing Rule",
			row.pricing_rule,
			["disable", "discount_percentage", "discount_amount"],
			as_dict=True,
		)
		if rule and not rule.disable:
			best = max(best, base * flt(rule.discount_percentage) / 100, flt(rule.discount_amount))
	return best


def validate_sale_discounts(pos, doc, sale_rows, offer_names, paid_lines, coupon_offers) -> None:
	"""Check every discount on a validated sale against what the cashier may give.

	Promotions are worked out here: customer discount, live POS Offers and
	pricing rules ERPNext applied. Whatever exceeds them is a manual discount and
	needs the matching POS permission and must stay within the manual cap. Client
	labels such as ``discount_source`` are never trusted.
	"""
	from xpos.api.auth import user_has_pos_permission

	cap = manual_discount_cap(pos)
	tolerance = 0.005

	line_manual = {}
	for row in sale_rows:
		plr = flt(row.price_list_rate)
		if plr <= 0:
			continue
		effective = (1 - flt(row.rate) / plr) * 100
		manual = effective - rule_line_discount_pct(pos, row)
		if manual <= tolerance:
			continue
		if not user_has_pos_permission("show_edit_discount_field", pos_profile=pos.name):
			frappe.throw(
				_("Row {0}: you are not permitted to discount item {1}.").format(row.idx, row.item_code),
				frappe.PermissionError,
			)
		if manual - cap > tolerance:
			frappe.throw(
				_("Item {0}: Discount {1}% exceeds maximum allowed {2}%").format(
					row.item_code, flt(manual, 2), flt(cap, 2)
				),
				title=_("Discount not allowed"),
			)
		line_manual[row.name or row.idx] = manual

	discount = flt(doc.discount_amount)
	invoice_manual_pct = 0.0
	if discount > tolerance:
		base = (
			flt(doc.grand_total) + discount
			if (doc.apply_discount_on or "Grand Total") == "Grand Total"
			else flt(doc.total)
		)
		item_offer, total_pct = offer_discounts(pos, offer_names, paid_lines, coupon_offers, doc.posting_date)
		remaining = max(base - item_offer, 0)
		# One invoice-level promotion applies; they never stack with each other.
		invoice_promo = max(
			remaining * total_pct / 100,
			remaining * customer_discount_rate(pos, doc.customer) / 100,
			transaction_rule_discount(doc, remaining),
		)
		promotional = item_offer + invoice_promo
		excess = discount - promotional
		if excess > max(tolerance, base * 0.00005):
			if not user_has_pos_permission("apply_additional_discount", pos_profile=pos.name):
				frappe.throw(
					_("You are not permitted to give an additional discount of {0}.").format(flt(excess, 2)),
					frappe.PermissionError,
				)
			left = base - promotional
			invoice_manual_pct = excess / left * 100 if left > 0 else 100.0
			if invoice_manual_pct - cap > tolerance:
				frappe.throw(
					_("Additional discount of {0}% exceeds maximum allowed {1}%").format(
						flt(invoice_manual_pct, 2), flt(cap, 2)
					),
					title=_("Discount not allowed"),
				)

	if invoice_manual_pct and line_manual:
		# A manual invoice discount on top of a manual line discount is one discount to the customer.
		worst = max(line_manual.values())
		combined = 100 - (100 - worst) * (100 - invoice_manual_pct) / 100
		if combined - cap > tolerance:
			frappe.throw(
				_(
					"Line and invoice discounts together give {0}%, more than the maximum allowed {1}%."
				).format(flt(combined, 2), flt(cap, 2)),
				title=_("Discount not allowed"),
			)


def check_zero_payable(pos, doc, sale_rows) -> None:
	"""No sale line may end up free after all discounts unless the profile allows zero-price sales.

	Uses ERPNext's ``net_amount``, which already carries the invoice discount, so
	a 100% or fixed invoice discount cannot make an unauthorised free sale.
	Server-verified free promotion lines are not in ``sale_rows``.
	"""
	if profile_flag(pos, "allow_zero_rated_items") or not sale_rows:
		return
	for row in sale_rows:
		if flt(row.net_amount) <= 0:
			frappe.throw(
				_(
					"Item {0} would be sold for nothing. Zero-price sale lines are not allowed on POS Profile {1}."
				).format(row.item_code, pos.name),
				title=_("Zero price not allowed"),
			)
	if flt(doc.grand_total) <= 0:
		frappe.throw(
			_("This sale totals zero. Zero-price sales are not allowed on POS Profile {0}.").format(pos.name),
			title=_("Zero price not allowed"),
		)


def quoted_line_rate(line: dict) -> float:
	"""The net rate the till showed for a line: its rate less its own discount."""
	rate = flt(line.get("rate"))
	if flt(line.get("discount_percentage")):
		return rate * (1 - flt(line.get("discount_percentage")) / 100)
	return rate - flt(line.get("discount_amount"))


def repricing_changes(doc, quoted: list[tuple], data: dict) -> dict | None:
	"""Compare what the cashier accepted with ERPNext's authoritative calculation.

	``quoted`` holds ``(row, line, index)`` per submitted sale line. Returns a
	reprice response when any line rate or the invoice discount moved, else None.
	Comparisons are made at the row's own rate precision, so rounding alone
	never counts as a change.
	"""
	lines = []
	live_rows = {id(r) for r in doc.items}
	for row, line, index in quoted:
		precision = row.precision("rate") if id(row) in live_rows else 2
		before = flt(quoted_line_rate(line), precision)
		after = flt(row.rate, precision) if id(row) in live_rows else None
		if after is None or abs(after - before) > 0.5 / 10**precision:
			lines.append(
				{
					"row_id": line.get("row_id"),
					"index": index,
					"item_code": line.get("item_code"),
					"quoted_rate": before,
					"rate": after,
					"price_list_rate": flt(row.price_list_rate) if after is not None else None,
					"discount_percentage": flt(row.discount_percentage) if after is not None else None,
					"discount_amount": flt(row.discount_amount) if after is not None else None,
				}
			)

	sent_pct = flt(data.get("additional_discount_percentage"))
	sent_amount = flt(data.get("discount_amount"))
	currency_tolerance = 0.5 / 10 ** doc.precision("discount_amount")
	if sent_pct:
		discount_changed = abs(flt(doc.additional_discount_percentage) - sent_pct) > 0.005
	else:
		discount_changed = abs(flt(doc.discount_amount) - sent_amount) > currency_tolerance

	if not lines and not discount_changed:
		return None
	# The till folds POS Offer discounts into the invoice discount, so an invoice discount
	# set by ERPNext (a transaction pricing rule) replaces them; the two cannot be combined.
	offer_names = {i.get("offers") for i in data.get("items") or []} | {
		o.get("offer_name") for o in data.get("offers_detail") or []
	}
	offer_conflict = discount_changed and any(
		frappe.db.get_value("POS Offer", name, "offer") in ("Grand Total", "Item Price")
		for name in offer_names
		if name
	)
	return {
		"status": "reprice_required",
		"price_list": doc.selling_price_list,
		"lines": lines,
		"additional_discount_percentage": flt(doc.additional_discount_percentage),
		"discount_amount": flt(doc.discount_amount),
		"discount_changed": discount_changed,
		"offer_conflict": offer_conflict,
		"grand_total": flt(doc.grand_total),
		"rounded_total": flt(doc.rounded_total),
		"message": _(
			"A pricing rule sets this sale's invoice discount, which cannot be combined with POS Offers. "
			"Remove the offers and take payment again."
		)
		if offer_conflict
		else _("Prices changed since this sale was rung up. Review the new prices and take payment again."),
	}


def price_unavailable(item_code: str, price_list: str | None) -> None:
	frappe.throw(
		_("Price unavailable for item {0} in price list {1}.").format(item_code, price_list or "-"),
		title=_("Price unavailable"),
	)


def validate_delivery_charge(doc) -> None:
	"""``use_delivery_charges`` is the master switch for charging delivery on a POS sale.

	Only a newly set or changed charge is checked, so existing drafts and
	submitted history are left alone. The rate itself is always recomputed from
	the Delivery Charges record by ``calc_delivery_charges``.
	"""
	charge = doc.get("pos_delivery_charges")
	if not charge or not doc.get("pos_profile") or doc.get("is_return") or doc.get("is_consolidated"):
		return
	if not (doc.is_new() or doc.has_value_changed("pos_delivery_charges")):
		return

	pos = frappe.get_cached_doc("POS Profile", doc.pos_profile)
	if not profile_flag(pos, "use_delivery_charges"):
		frappe.throw(
			_("Delivery charges are disabled for POS Profile {0}.").format(pos.name),
			title=_("Delivery charges disabled"),
		)

	from xpos.x_pos.doctype.delivery_charges.delivery_charges import get_applicable_delivery_charges

	eligible = get_applicable_delivery_charges(doc.company, pos.name, delivery_charges=charge)
	if charge not in {c.name for c in eligible}:
		frappe.throw(
			_("Delivery charge {0} is not available for company {1} and POS Profile {2}.").format(
				charge, doc.company, pos.name
			),
			title=_("Delivery charge not allowed"),
		)


def is_blind_closing(pos_profile: str | None, user: str | None = None) -> bool:
	"""Whether ``user`` must count the drawer without seeing what it should hold.

	Applies when the profile hides expected amounts and the user lacks the
	``view_expected_amount`` POS permission; holds before and after closing.
	"""
	from xpos.api.auth import user_has_pos_permission

	if not pos_profile or not cint(
		frappe.get_cached_value("POS Profile", pos_profile, "hide_expected_amount")
	):
		return False
	return not user_has_pos_permission("view_expected_amount", user, pos_profile)


def customer_discount_rate(pos, customer: str | None) -> float:
	"""The customer's Discount (%) as this profile applies it, capped by the profile maximum."""
	if not customer or not profile_flag(pos, "apply_customer_discount"):
		return 0.0
	rate = flt(frappe.db.get_value("Customer", customer, "discount"))
	cap = flt(pos.get("max_discount_percentage_allowed"))
	return min(rate, cap) if cap > 0 else rate
