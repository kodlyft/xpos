# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""The sale quote behind XPOS Mobile.

Nothing here prices anything on its own. Every number comes from the engines the till and
``create_invoice`` already use: ``get_line_rate`` (price list, customer prices, UOM, quantity tiers),
ERPNext's Pricing Rule engine through ``pricing_rules``, the profile's discount rules in
``profile_rules`` and ERPNext's own tax, rounding and loyalty maths on an unsaved invoice.

A quote never writes. When something cannot be represented faithfully it is reported in
``unsupported`` (the app then refuses to charge) and a refused override or coupon is reported in
``refusals`` with the reason, rather than quietly charging a different amount.
"""

import hashlib
import json

import frappe
from frappe import _
from frappe.utils import cint, flt, nowdate

from xpos.api.auth import user_has_pos_permission
from xpos.api.customers import require_customer_access
from xpos.api.pricing_rules import (
	apply_item_rules,
	apply_transaction_rules,
	pricing_rules_ignored,
	serialise_free_lines,
)
from xpos.api.profile_rules import (
	check_zero_payable,
	customer_discount_rate,
	get_line_rate,
	live_offer,
	manual_discount_cap,
	offer_discounts,
	offer_matching_lines,
	resolve_selling_price_list,
	validate_sale_discounts,
)
from xpos.api.profiles import resolve_pos_profile
from xpos.api.taxes import get_item_tax_template
from xpos.api.utilities import get_invoice_type
from xpos.x_pos.api.invoice import apply_tax_inclusive

MAX_QUOTE_LINES = 200
SUPPORTED_OFFERS = ("Item Price", "Grand Total")


def parse_list(value) -> list:
	value = frappe.parse_json(value) if isinstance(value, str) else value
	return value or []


def context_hash(pos_name: str, customer: str, price_list: str, request: dict) -> str:
	"""Identifies the exact inputs of a quote, so the app can tell a quote is stale before charging."""
	body = json.dumps([pos_name, customer, price_list, request], sort_keys=True, default=str)
	return hashlib.sha256(body.encode()).hexdigest()[:16]


class Quote:
	def __init__(self, pos, customer: str, lines: list, coupons: list, loyalty_points: int, extra_pct: float):
		self.pos = pos
		self.customer = customer
		self.lines = lines
		self.coupon_codes = coupons
		self.loyalty_points = cint(loyalty_points)
		self.extra_pct = flt(extra_pct)
		self.refusals: list[dict] = []
		self.unsupported: list[dict] = []
		self.notices: list[dict] = []
		self.results: list[dict] = []
		self.rows: dict = {}
		self.coupons_detail: list[dict] = []
		self.offers_detail: list[dict] = []

	def refuse(self, reason, row_id=None):
		self.refusals.append({"row_id": row_id, "reason": str(reason)})

	def block(self, reason, row_id=None):
		self.unsupported.append({"row_id": row_id, "reason": str(reason)})

	def run(self) -> dict:
		pos = self.pos
		self.currency = pos.get("currency") or frappe.get_cached_value(
			"Company", pos.company, "default_currency"
		)
		self.price_list = resolve_selling_price_list(pos, self.customer)
		self.doc = frappe.new_doc(get_invoice_type())
		self.doc.update(
			{
				"is_pos": 1,
				"customer": self.customer,
				"company": pos.company,
				"pos_profile": pos.name,
				"currency": self.currency,
				"selling_price_list": self.price_list,
				"price_list_currency": self.currency,
				"posting_date": nowdate(),
				"set_warehouse": pos.warehouse,
			}
		)
		self.can_change_price = user_has_pos_permission("allow_change_price", pos_profile=pos.name)
		self.add_lines()
		priced = [r for r in self.results if not r.get("price_unavailable")]
		if len(priced) != len(self.results) or self.unsupported:
			return self.answer(priced=False)
		self.add_taxes()
		self.apply_pricing_rules()
		self.apply_manual_discounts()
		self.apply_invoice_discount()
		return self.answer(priced=True)

	def add_lines(self):
		pos, doc = self.pos, self.doc
		for index, line in enumerate(self.lines):
			item_code = line.get("item_code")
			row_id = line.get("row_id", index)
			if not item_code or not frappe.db.exists("Item", item_code):
				frappe.throw(_("Item {0} not found").format(item_code))
			qty = flt(line.get("qty"), 3)
			item = frappe.get_cached_doc("Item", item_code)
			uom = line.get("uom") or item.stock_uom
			result = {"row_id": row_id, "item_code": item_code, "uom": uom, "qty": qty}
			self.results.append(result)
			if (
				cint(item.has_serial_no)
				or cint(item.has_batch_no)
				or line.get("serial_no")
				or line.get("batch_no")
			):
				self.block(
					_("{0}: serial and batch items are not supported on mobile yet.").format(item_code),
					row_id,
				)
				continue
			factor = 1.0
			if uom != item.stock_uom:
				factor = next((flt(u.conversion_factor) for u in item.uoms if u.uom == uom), 0)
				if not factor:
					self.block(
						_("{0}: no conversion from {1} to {2}.").format(item_code, uom, item.stock_uom),
						row_id,
					)
					continue

			listed = get_line_rate(self.price_list, item_code, uom, self.customer, qty, doc.posting_date)
			override = line.get("rate_override")
			if override not in (None, ""):
				if not self.can_change_price:
					self.refuse(
						_("You are not permitted to change the price of {0}.").format(item_code), row_id
					)
				else:
					listed = flt(override)
					result["rate_overridden"] = 1
			if listed is None:
				result.update({"rate": None, "price_unavailable": 1})
				continue

			tax = get_item_tax_template(item_code, pos.company)
			row = doc.append(
				"items",
				{
					"item_code": item_code,
					"item_name": item.item_name,
					"item_group": item.item_group,
					"brand": item.brand,
					"qty": qty,
					"uom": uom,
					"stock_uom": item.stock_uom,
					"conversion_factor": factor,
					"stock_qty": qty * factor,
					"rate": listed,
					"price_list_rate": listed,
					"warehouse": pos.warehouse,
					"item_tax_template": tax.get("item_tax_template"),
					"item_tax_rate": frappe.as_json(tax.get("item_tax_map") or {}),
				},
			)
			self.rows[row_id] = row
			result.update({"price_list_rate": listed, "item_tax_template": tax.get("item_tax_template")})

	def add_taxes(self):
		pos, doc = self.pos, self.doc
		if not pos.taxes_and_charges:
			return
		doc.taxes_and_charges = pos.taxes_and_charges
		for tax in frappe.get_cached_doc("Sales Taxes and Charges Template", pos.taxes_and_charges).taxes:
			doc.append(
				"taxes",
				{
					"charge_type": tax.charge_type,
					"account_head": tax.account_head,
					"description": tax.description,
					"rate": tax.rate,
					"cost_center": tax.cost_center,
					"included_in_print_rate": tax.included_in_print_rate,
				},
			)
		apply_tax_inclusive(doc)

	def apply_pricing_rules(self):
		"""ERPNext's Pricing Rules (quantity tiers, promotions, free items) over the priced rows."""
		doc = self.doc
		self.rule_pct = 0.0
		self.rule_amount = 0.0
		self.free_lines = []
		if pricing_rules_ignored(self.pos.name) or not doc.items:
			doc.calculate_taxes_and_totals()
			return
		apply_item_rules(doc)
		for result in self.results:
			row = self.rows.get(result["row_id"])
			if row and result.get("rate_overridden"):
				# a price the cashier set is not repriced by rules
				row.rate = row.price_list_rate = result["price_list_rate"]
				row.discount_percentage = row.discount_amount = 0
				row.pricing_rules = ""
		try:
			rules = apply_transaction_rules(doc)
		except Exception:
			frappe.log_error(
				title="XPOS mobile: transaction pricing rules failed", message=frappe.get_traceback()
			)
			self.block(_("A pricing rule on this sale could not be evaluated."))
			rules = {}
		self.rule_pct = flt(rules.get("additional_discount_percentage"))
		self.rule_amount = flt(rules.get("discount_amount"))
		doc.additional_discount_percentage = 0
		doc.discount_amount = 0
		self.free_lines = serialise_free_lines(doc)
		doc.calculate_taxes_and_totals()
		for result in self.results:
			row = self.rows.get(result["row_id"])
			if row:
				result["pricing_rules"] = row.get("pricing_rules") or None

	def apply_manual_discounts(self):
		"""A cashier's own line discount, held to the same permission and cap ``create_invoice`` enforces."""
		pos = self.pos
		cap = manual_discount_cap(pos)
		for line, result in zip(self.lines, self.results, strict=False):
			pct = flt(line.get("discount_percentage"))
			row = self.rows.get(result["row_id"])
			if not pct or not row:
				continue
			if not user_has_pos_permission("show_edit_discount_field", pos_profile=pos.name):
				self.refuse(
					_("You are not permitted to discount item {0}.").format(row.item_code), result["row_id"]
				)
			elif pct > cap:
				self.refuse(
					_("Item {0}: Discount {1}% exceeds maximum allowed {2}%").format(
						row.item_code, flt(pct, 2), flt(cap, 2)
					),
					result["row_id"],
				)
			elif row.get("pricing_rules"):
				self.refuse(
					_("Item {0} already has a promotion; a manual discount cannot be added to it.").format(
						row.item_code
					),
					result["row_id"],
				)
			else:
				row.discount_percentage = pct
				row.rate = flt(flt(row.price_list_rate) * (1 - pct / 100), 6)
				result["manual_discount_pct"] = pct
		self.doc.calculate_taxes_and_totals()

	def coupon_offers(self) -> set:
		"""Validate entered coupons with the same rules submission uses; the offers they unlock."""
		from xpos.x_pos.doctype.pos_coupon.pos_coupon import check_coupon_code

		unlocked = set()
		for code in dict.fromkeys(c.strip() for c in self.coupon_codes if c and c.strip()):
			check = check_coupon_code(code, self.customer, self.pos.company)
			coupon = check.get("coupon")
			if not coupon:
				self.refuse(check.get("msg") or _("Coupon {0} cannot be used.").format(code))
				continue
			offer = frappe.get_cached_doc("POS Offer", coupon.pos_offer)
			if offer.offer not in SUPPORTED_OFFERS:
				self.block(
					_("Coupon {0} gives a {1} offer, which is not supported on mobile yet.").format(
						code, offer.offer
					)
				)
				continue
			unlocked.add(coupon.pos_offer)
			self.coupons_detail.append(
				{
					"coupon": coupon.name,
					"coupon_code": coupon.coupon_code,
					"type": coupon.coupon_type,
					"pos_offer": coupon.pos_offer,
					"applied": 1,
					"customer": self.customer,
				}
			)
		return unlocked

	def auto_offers(self, paid_lines, coupon_offers) -> list[str]:
		"""Auto-applied POS Offers that match this cart. Only the kinds mobile can price are applied."""
		from xpos.api.offers import get_offers

		names = []
		for offer in get_offers(self.pos.name):
			if not flt(offer.get("auto")) or cint(offer.get("coupon_based")):
				continue
			live = live_offer(self.pos, offer.get("name"), coupon_offers, self.doc.posting_date)
			if not live or not offer_matching_lines(live, paid_lines):
				continue
			if live.offer in SUPPORTED_OFFERS:
				names.append(live.name)
			else:
				self.notices.append(
					{
						"reason": _("Offer {0} ({1}) is not applied by the mobile app.").format(
							live.name, live.offer
						)
					}
				)
		return names

	def apply_invoice_discount(self):
		"""One invoice-level discount: promotions never stack, a cashier's extra discount sits on top."""
		pos, doc = self.pos, self.doc
		base = flt(doc.grand_total)
		paid_lines = [
			{"item_code": r.item_code, "qty": r.qty, "rate": flt(r.rate)}
			for r in doc.items
			if not cint(r.get("is_free_item"))
		]
		coupon_offers = self.coupon_offers()
		offer_names = [*coupon_offers, *self.auto_offers(paid_lines, coupon_offers)]
		for name in offer_names:
			offer = frappe.get_cached_doc("POS Offer", name)
			self.offers_detail.append(
				{
					"offer_name": name,
					"offer": offer.offer,
					"apply_on": offer.apply_on,
					"offer_applied": 1,
					"coupon_based": cint(offer.coupon_based),
					"coupon": next(
						(c["coupon"] for c in self.coupons_detail if c["pos_offer"] == name), None
					),
				}
			)
		item_offer, offer_pct = offer_discounts(pos, offer_names, paid_lines, coupon_offers, doc.posting_date)
		remaining = max(base - item_offer, 0)
		rule_amount = max(remaining * self.rule_pct / 100, self.rule_amount)
		promo = item_offer + max(
			remaining * offer_pct / 100,
			remaining * customer_discount_rate(pos, self.customer) / 100,
			rule_amount,
		)
		manual = 0.0
		if self.extra_pct:
			if not user_has_pos_permission("apply_additional_discount", pos_profile=pos.name):
				self.refuse(_("You are not permitted to give an additional discount."))
			elif self.extra_pct > manual_discount_cap(pos):
				self.refuse(
					_("Additional discount of {0}% exceeds maximum allowed {1}%").format(
						flt(self.extra_pct, 2), flt(manual_discount_cap(pos), 2)
					)
				)
			else:
				manual = max(base - promo, 0) * self.extra_pct / 100
		self.discount_amount = flt(promo + manual, doc.precision("discount_amount"))
		doc.apply_discount_on = "Grand Total"
		doc.discount_amount = self.discount_amount
		doc.calculate_taxes_and_totals()

		self.loyalty_amount = 0.0
		if self.loyalty_points:
			self.apply_loyalty()

		sale_rows = [r for r in doc.items if not cint(r.get("is_free_item"))]
		for row in sale_rows:
			if not row.get("name"):
				row.name = f"quote-{row.idx}"
		try:
			validate_sale_discounts(pos, doc, sale_rows, offer_names, paid_lines, coupon_offers)
			check_zero_payable(pos, doc, sale_rows)
		except (frappe.ValidationError, frappe.PermissionError) as exc:
			self.refuse(exc)
			frappe.clear_messages()

	def apply_loyalty(self):
		from xpos.api.invoices import (
			prepare_invoice_totals_for_loyalty_validation,
			resolve_loyalty_paid_amount,
		)

		doc = self.doc
		doc.redeem_loyalty_points = 1
		doc.loyalty_points = self.loyalty_points
		try:
			prepare_invoice_totals_for_loyalty_validation(doc)
			self.loyalty_amount = resolve_loyalty_paid_amount(doc)
		except (frappe.ValidationError, frappe.PermissionError) as exc:
			self.refuse(exc)
			frappe.clear_messages()
			doc.redeem_loyalty_points = 0
			doc.loyalty_points = 0
			self.loyalty_amount = 0.0
		doc.calculate_taxes_and_totals()

	def answer(self, priced: bool) -> dict:
		doc = self.doc
		request = {
			"lines": [
				{k: ln.get(k) for k in ("item_code", "qty", "uom", "rate_override", "discount_percentage")}
				for ln in self.lines
			],
			"coupons": sorted(self.coupon_codes),
			"loyalty_points": self.loyalty_points,
			"extra_pct": self.extra_pct,
		}
		out = {
			"quote_id": context_hash(self.pos.name, self.customer, self.price_list, request),
			"customer": self.customer,
			"price_list": self.price_list,
			"currency": self.currency,
			"lines": self.results,
			"unsupported": self.unsupported,
			"refusals": self.refusals,
			"notices": self.notices,
		}
		unpriced = [r["item_code"] for r in self.results if r.get("price_unavailable")]
		if unpriced:
			out["price_unavailable"] = unpriced
		if not priced or self.refusals:
			return out
		rounded = cint(not cint(doc.get("disable_rounded_total"))) and flt(doc.get("rounded_total"))
		total = rounded or flt(doc.grand_total)
		profile_cap = flt(self.pos.get("max_discount_percentage_allowed"))
		for result in self.results:
			row = self.rows[result["row_id"]]
			manual = result.get("manual_discount_pct")
			plr = flt(row.price_list_rate)
			pct = manual or flt(row.discount_percentage)
			amount = 0.0 if manual else flt(row.discount_amount)
			result.update(
				{
					"price_list_rate": plr,
					"rate": flt(row.rate),
					"amount": flt(row.amount),
					"send_rate": plr,
					"send_discount_percentage": pct,
					"send_discount_amount": amount,
					"discount_pct": round((1 - flt(row.rate) / plr) * 100, 4) if plr else 0,
				}
			)
			if profile_cap > 0 and pct > profile_cap:
				self.refuse(
					_("Item {0}: Discount {1}% exceeds maximum allowed {2}%").format(
						row.item_code, flt(pct, 2), flt(profile_cap, 2)
					),
					result["row_id"],
				)
		if self.refusals:
			return out
		out.update(
			{
				"net_total": flt(doc.net_total),
				"total_taxes_and_charges": flt(doc.total_taxes_and_charges),
				"grand_total": flt(doc.grand_total),
				"discount_amount": flt(self.discount_amount),
				"loyalty_amount": flt(self.loyalty_amount),
				"payable": flt(total - self.loyalty_amount, doc.precision("grand_total")),
				"free_lines": self.free_lines,
				"coupons_detail": self.coupons_detail,
				"offers_detail": self.offers_detail,
			}
		)
		return out


@frappe.whitelist(methods=["POST"])
def quote_sale(
	pos_profile: str,
	items: str | list,
	customer: str | None = None,
	coupons: str | list | None = None,
	loyalty_points: int = 0,
	additional_discount_percentage: float = 0,
) -> dict:
	"""What ERPNext would charge for this sale, for this customer: prices, promotions, discounts, taxes, total.

	Computed in memory on an unsaved document, so nothing is written, no stock is touched and no fiscal
	service is called. ``create_invoice`` stays authoritative: it re-prices on save and refuses a sale
	whose rates moved. ``unsupported`` lists what mobile cannot price faithfully (the app must not
	charge); ``refusals`` lists overrides, coupons or loyalty the server turned down, with the reason.
	"""
	if frappe.session.user == "Guest":
		frappe.throw(_("Login required"), frappe.PermissionError)
	pos = resolve_pos_profile(pos_profile)
	lines = parse_list(items)
	if not isinstance(lines, list) or not lines or len(lines) > MAX_QUOTE_LINES:
		frappe.throw(_("A quote needs between 1 and {0} lines.").format(MAX_QUOTE_LINES))

	customer = customer or pos.get("customer")
	if not customer:
		frappe.throw(_("Customer is required"))
	require_customer_access(customer, "read", pos.name)
	return Quote(
		pos, customer, lines, parse_list(coupons), loyalty_points, additional_discount_percentage
	).run()
