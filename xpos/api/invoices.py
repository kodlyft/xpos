# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

import hashlib
import json
import re
from collections import defaultdict
from contextlib import suppress

import frappe
from frappe import _, cstr
from frappe.permissions import has_user_permission
from frappe.utils import add_days, cint, flt, getdate, now_datetime, nowdate
from frappe.utils.background_jobs import enqueue

from xpos.api.customer_credit import allocate_customer_credit, credit_total, lock_credit_sources
from xpos.api.exchange import get_currency_precision
from xpos.api.profile_rules import (
	check_zero_payable,
	get_line_rate,
	price_unavailable,
	repricing_changes,
	resolve_selling_price_list,
	validate_sale_discounts,
	verified_offer_free_line,
	verified_pricing_rule_free_line,
)
from xpos.api.profiles import resolve_pos_profile, user_may_use_profile
from xpos.api.tender import build_change_legs, build_tender_legs, invoice_currency_of
from xpos.api.utilities import can_recall_other_shift_tabs, get_invoice_type, is_pos_cashier
from xpos.utils import read_latest_on_lock
from xpos.x_pos.doctype.pos_coupon.pos_coupon import validate_invoice_coupons
from xpos.x_pos.gift_cards import (
	claim_issued_codes,
	get_company_setting,
	payment_summary,
	refunds_available,
	require_gift_card_access,
)


def enforce_stock_availability(invoice_doc):
	"""
	Block the sale when it would take stock below zero.
	"""

	from xpos.x_pos.api.invoice_processing.stock import validate_stock_on_invoice
	from xpos.x_pos.api.item_processing.stock import lock_bins_for_update

	if invoice_doc.get("is_return"):
		return

	lock_bins_for_update(
		[
			{"item_code": row.item_code, "warehouse": row.warehouse}
			for row in (invoice_doc.get("items") or []) + (invoice_doc.get("packed_items") or [])
		]
	)
	validate_stock_on_invoice(invoice_doc)


def _get_item_rate_precision():
	"""Return item rate precision from System Settings float_precision, default 3."""
	p = cint(frappe.db.get_default("float_precision"))
	return p if p >= 0 else 3


def _resolve_invoice_posting_date(pos, requested_posting_date=None, current_posting_date=None):
	"""Respect the POS Profile posting-date setting while validating client input."""
	if not cint(pos.get("allow_change_posting_date")):
		return nowdate()

	candidate = requested_posting_date or current_posting_date
	if not candidate:
		return nowdate()

	try:
		return str(getdate(candidate))
	except ValueError:
		frappe.throw(_("Posting Date must be a valid date"))


def _detect_invoice_doctype(invoice_name: str):
	"""Detect whether an invoice name belongs to Sales Invoice or POS Invoice."""
	if frappe.db.exists("Sales Invoice", invoice_name):
		return "Sales Invoice"
	if frappe.db.exists("POS Invoice", invoice_name):
		return "POS Invoice"
	frappe.throw(_("Invoice {0} not found").format(invoice_name))


INVOICE_DOCTYPES = ("Sales Invoice", "POS Invoice")


def ensure_invoice_doctype(doctype: str) -> None:
	if doctype not in INVOICE_DOCTYPES:
		frappe.throw(_("{0} is not an invoice type.").format(doctype), frappe.PermissionError)


def get_pos_invoice(doctype: str, name: str, ptype: str = "read"):
	"""Load an invoice Frappe grants `ptype` on, or one of the caller's own POS Profile and company that their User Permissions allow."""
	ensure_invoice_doctype(doctype)
	denied = _("You are not permitted to access invoice {0}.").format(name)
	scope = frappe.db.get_value(doctype, name, ["pos_profile", "company"], as_dict=True)
	if not scope:
		frappe.throw(denied, frappe.PermissionError)
	doc = frappe.get_doc(doctype, name)
	if doc.has_permission(ptype):
		return doc
	profile = scope.pos_profile
	if (
		profile
		and user_may_use_profile(profile)
		and frappe.db.get_value("POS Profile", profile, "company") == scope.company
		and has_user_permission(doc)
	):
		return doc
	frappe.throw(denied, frappe.PermissionError)


def _mark_xpos_delivery_charges_managed(invoice_doc):
	"""Keep delivery-charge selection under xpos API control for this request."""
	if getattr(invoice_doc, "flags", None) is None:
		invoice_doc.flags = frappe._dict()
	invoice_doc.flags.xpos_skip_auto_delivery_charges = True


def _apply_invoice_delivery_charge_fields(invoice_doc, data: dict):
	"""Apply the delivery-charge selection supplied by the xpos client."""
	_mark_xpos_delivery_charges_managed(invoice_doc)
	selected_charge = data.get("pos_delivery_charges") or None
	invoice_doc.pos_delivery_charges = selected_charge
	invoice_doc.pos_delivery_charges_rate = (
		flt(data.get("pos_delivery_charges_rate", 0)) if selected_charge else 0
	)


def _apply_invoice_loyalty_fields(invoice_doc, data: dict):
	"""Apply loyalty redemption fields without trusting the client amount."""
	redeem_points = cint(data.get("loyalty_points", 0))
	redeem_loyalty = cint(data.get("redeem_loyalty_points", 0)) and redeem_points > 0
	invoice_doc.redeem_loyalty_points = 1 if redeem_loyalty else 0
	invoice_doc.loyalty_points = redeem_points if redeem_loyalty else 0
	invoice_doc.loyalty_amount = 0


def resolve_update_stock(pos, return_against: str | None = None) -> int:
	if return_against:
		doctype = "Sales Invoice" if frappe.db.exists("Sales Invoice", return_against) else "POS Invoice"
		return cint(frappe.db.get_value(doctype, return_against, "update_stock"))
	return cint(pos.get("update_stock", 1))


def apply_invoice_delivery_dates(invoice_doc, data: dict, items: list):
	dates = []
	for row, item_data in zip(invoice_doc.items, items):
		row.delivery_date = item_data.get("delivery_date") or None
		if row.delivery_date:
			dates.append(getdate(row.delivery_date))
	invoice_doc.pos_delivery_date = data.get("pos_delivery_date") or (min(dates) if dates else None)


def resolve_return_sales_person(return_against: str | None) -> str | None:
	"""Sales person credited on the invoice being returned, if any."""
	if not return_against:
		return None

	doctype = _detect_invoice_doctype(return_against)
	return frappe.db.get_value(
		"Sales Team",
		{"parent": return_against, "parenttype": doctype},
		"sales_person",
		order_by="idx asc",
	)


def apply_sales_person(doc, sales_person: str | None, pos_profile: str | None = None):
	"""Attribute the whole document to a single sales person."""
	if not doc.meta.get_field("sales_team"):
		return

	doc.set("sales_team", [])
	if not sales_person:
		return

	if pos_profile:
		from xpos.api.customers import get_allowed_sales_persons

		if sales_person not in get_allowed_sales_persons(pos_profile):
			frappe.throw(
				_("Sales Person {0} is not allowed on POS Profile {1}.").format(sales_person, pos_profile)
			)

	if not frappe.db.get_value("Sales Person", sales_person, "enabled"):
		frappe.throw(_("Sales Person {0} is disabled.").format(sales_person))

	doc.append("sales_team", {"sales_person": sales_person, "allocated_percentage": 100})


def _prepare_invoice_totals_for_loyalty_validation(invoice_doc):
	"""Pre-calculate invoice totals before ERPNext validates loyalty redemption."""
	from xpos.x_pos.api.invoice import apply_tax_inclusive, calc_delivery_charges

	calc_delivery_charges(invoice_doc)
	apply_tax_inclusive(invoice_doc)
	invoice_doc.calculate_taxes_and_totals()


def _resolve_loyalty_paid_amount(invoice_doc) -> float:
	"""Let ERPNext derive the redeemable loyalty amount from the selected points."""
	if not (getattr(invoice_doc, "redeem_loyalty_points", 0) and getattr(invoice_doc, "loyalty_points", 0)):
		invoice_doc.loyalty_amount = 0
		return 0

	from erpnext.accounts.doctype.loyalty_program.loyalty_program import (
		validate_loyalty_points,
	)

	invoice_doc.loyalty_amount = 0
	validate_loyalty_points(invoice_doc, cint(invoice_doc.loyalty_points))
	return round(flt(invoice_doc.loyalty_amount or 0), 2)


def _coerce_amount(value) -> float:
	"""Coerce invoice amounts without depending on request-local Frappe state."""
	try:
		return round(float(value or 0), 2)
	except (TypeError, ValueError):
		return 0.0


def _get_unpaid_balance(invoice_doc) -> float:
	"""Return the unpaid balance remaining on an invoice after applied settlements."""
	outstanding_amount = _coerce_amount(getattr(invoice_doc, "outstanding_amount", 0))
	if outstanding_amount > 0:
		return outstanding_amount

	grand_total = abs(
		_coerce_amount(getattr(invoice_doc, "rounded_total", 0) or getattr(invoice_doc, "grand_total", 0))
	)
	settled_amount = abs(_coerce_amount(getattr(invoice_doc, "paid_amount", 0))) + abs(
		_coerce_amount(getattr(invoice_doc, "write_off_amount", 0))
	)
	return max(0.0, round(grand_total - settled_amount, 2))


def _guard_stale_draft(doctype: str, invoice_name: str, client_modified) -> None:
	"""Reject a write that was built on a stale copy of a shared open tab.

	Once a tab can be recalled from another shift, two terminals can hold the same
	draft at once and the second save would silently wipe the first one's lines.
	The client echoes back the ``modified`` timestamp it loaded; if the row has
	moved on since, the write is refused so the cashier can reload and retry.

	No token means no check, which keeps offline replay and every pre-existing
	caller working exactly as before.
	"""
	if not client_modified:
		return

	current_modified = frappe.db.get_value(doctype, invoice_name, "modified")
	if current_modified and str(current_modified) != str(client_modified):
		frappe.throw(
			_("This tab was changed on another terminal. Reload it and try again."),
			frappe.TimestampMismatchError,
		)


def _validate_unpaid_balance_permissions(
	invoice_doc, pos_profile_doc, data: dict, customer_credit: float = 0
):
	"""Enforce POS Profile permissions before submitting an invoice with a balance due.

	``customer_credit`` is existing customer credit allocated right after submit,
	so it settles that much of the balance.
	"""
	if cint(getattr(invoice_doc, "is_return", 0)):
		return

	outstanding_amount = _get_unpaid_balance(invoice_doc)
	if customer_credit - outstanding_amount > 0.009:
		frappe.throw(
			_("Customer credit of {0} is more than the {1} still due.").format(
				customer_credit, outstanding_amount
			)
		)
	outstanding_amount -= customer_credit
	if outstanding_amount <= 0.009:
		return

	allow_credit_sale = cint(pos_profile_doc.get("allow_credit_sale"))
	allow_partial_payment = cint(pos_profile_doc.get("allow_partial_payment"))
	requested_credit_sale = cint(data.get("is_credit_sale"))
	settled_amount = (
		abs(_coerce_amount(getattr(invoice_doc, "paid_amount", 0)))
		+ abs(_coerce_amount(getattr(invoice_doc, "write_off_amount", 0)))
		+ customer_credit
	)

	if requested_credit_sale or settled_amount <= 0.009:
		if not allow_credit_sale:
			frappe.throw(_("Credit sale is not allowed for POS Profile {0}.").format(pos_profile_doc.name))
		return

	if not (allow_partial_payment or allow_credit_sale):
		frappe.throw(_("Partial payment is not allowed for POS Profile {0}.").format(pos_profile_doc.name))


def _get_default_pos_payment_mode(pos_profile_doc) -> str:
	"""Return the default mode of payment configured on the POS Profile."""
	payments = getattr(pos_profile_doc, "payments", None) or []
	if payments:
		mode_of_payment = getattr(payments[0], "mode_of_payment", None)
		if mode_of_payment:
			return mode_of_payment
	return "Cash"


def _ensure_pos_invoice_payment_row(invoice_doc, pos_profile_doc, require_payment_row: bool):
	"""Seed a zero-amount payment row so ERPNext accepts POS sale submissions."""
	if not require_payment_row:
		return

	existing_payments = None
	if hasattr(invoice_doc, "get"):
		existing_payments = invoice_doc.get("payments")

	if existing_payments is None:
		existing_payments = getattr(invoice_doc, "payments", None)

	if existing_payments:
		return

	invoice_doc.append(
		"payments",
		{
			"mode_of_payment": _get_default_pos_payment_mode(pos_profile_doc),
			"amount": 0,
		},
	)


REPRICE_SAVEPOINT = "xpos_reprice"


def request_fingerprint(data: dict, pos_profile: str | None, company: str | None) -> str:
	"""What makes two submissions with the same ``local_id`` the same sale.

	Payments are left out on purpose: re-tendering after a lost response is the same sale.
	"""
	lines = [
		[
			cstr(i.get("item_code")),
			flt(i.get("qty")),
			cstr(i.get("uom")),
			flt(i.get("rate")),
			flt(i.get("discount_percentage")),
			flt(i.get("discount_amount")),
			cstr(i.get("batch_no")),
			cstr(i.get("serial_no")),
			cstr(i.get("warehouse")),
			cstr(i.get("item_tax_template")),
			cint(i.get("is_free_item")),
			cint(i.get("is_offer")),
			cstr(i.get("offers")),
			cstr(i.get("gift_card")),
		]
		for i in data.get("items") or []
	]
	payload = {
		"user": cstr(frappe.session.user),
		"customer": cstr(data.get("customer")),
		"pos_profile": cstr(pos_profile),
		"company": cstr(company),
		"is_return": cint(data.get("is_return")),
		"return_against": cstr(data.get("return_against")),
		"lines": lines,
		"posting_date": cstr(data.get("posting_date")),
		"currency": cstr(data.get("currency")),
		"conversion_rate": flt(data.get("conversion_rate")),
		"selling_price_list": cstr(data.get("selling_price_list")),
		"additional_discount_percentage": flt(data.get("additional_discount_percentage")),
		"discount_amount": flt(data.get("discount_amount")),
		"apply_discount_on": cstr(data.get("apply_discount_on")),
		"write_off_amount": flt(data.get("write_off_amount")),
		"delivery_charges": [
			cstr(data.get("pos_delivery_charges")),
			flt(data.get("pos_delivery_charges_rate")),
		],
		"loyalty": [cint(data.get("redeem_loyalty_points")), flt(data.get("loyalty_points"))],
		"coupons": sorted(
			cstr(c.get("coupon_code") or c.get("pos_offer")) for c in data.get("coupons_detail") or []
		),
		"offers": sorted(cstr(o.get("offer_name")) for o in data.get("offers_detail") or []),
		"customer_credit": sorted(
			[cstr(c.get("source_type")), cstr(c.get("source_name")), flt(c.get("amount"))]
			for c in data.get("customer_credit") or []
		),
	}
	return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()


def find_invoice_by_local_id(
	local_id: str | None, warehouse: str | None = None, fingerprint: str | None = None
) -> tuple[str, str] | None:
	"""Return (doctype, name) of an invoice already created for this client local_id.

	The desktop/offline client assigns every cart a stable ``local_id`` and may
	re-push it after a dropped response. Looking it up here makes invoice creation
	idempotent so a retry returns the original invoice instead of creating a second
	real Sales Invoice (double stock depletion + double revenue).

	A ``local_id`` reused for a different sale (customer, company, user, lines or
	credit) is refused rather than answered with someone else's invoice. Browser
	ids (``inv_`` + 128 random bits) are global; desktop ids are per warehouse.
	"""
	if not local_id:
		return None
	for dt in ("Sales Invoice", "POS Invoice"):
		filters = {"xpos_local_id": local_id, "docstatus": ("in", (0, 1))}
		if not cstr(local_id).startswith("inv_"):
			filters["set_warehouse"] = warehouse
		row = frappe.db.get_value(
			dt,
			filters,
			["name", "owner", "set_warehouse", "xpos_request_hash"],
			as_dict=True,
			order_by="creation asc",
		)
		if not row:
			continue
		# Only the user who created the sale gets it back; older invoices carry no fingerprint.
		if row.owner != frappe.session.user:
			frappe.throw(
				_("Sale id {0} was already used for a different sale. Start a new sale.").format(local_id),
				title=_("Duplicate sale id"),
			)
		if fingerprint and (
			row.set_warehouse != warehouse or (row.xpos_request_hash and row.xpos_request_hash != fingerprint)
		):
			frappe.throw(
				_("Sale id {0} was already used for a different sale ({1}). Start a new sale.").format(
					local_id, row.name
				),
				title=_("Duplicate sale id"),
			)
		return dt, row.name
	return None


@frappe.whitelist()
def create_invoice(data: str | dict, local_id: str | None = None):
	"""Create a POS Sales Invoice from cart data.

	Args:
	    data: JSON string (or dict) containing the cart payload.
	    local_id: Stable client-side id used to deduplicate sync retries so the
	        same cart is never committed twice (exactly-once invoice creation).
	"""
	data = json.loads(data) if isinstance(data, str) else data

	local_id = local_id or data.get("local_id")

	warehouse = data.get("warehouse")
	if not warehouse and data.get("pos_profile"):
		warehouse = frappe.get_cached_doc("POS Profile", data["pos_profile"]).warehouse
	fingerprint = request_fingerprint(
		data,
		data.get("pos_profile"),
		frappe.get_cached_value("POS Profile", data["pos_profile"], "company")
		if data.get("pos_profile") and frappe.db.exists("POS Profile", data["pos_profile"])
		else None,
	)
	existing = find_invoice_by_local_id(local_id, warehouse, fingerprint)
	if existing:
		return existing_sale_response(*existing)

	pos_profile = data.get("pos_profile")
	customer = data.get("customer")
	items = data.get("items", [])
	payments = data.get("payments", [])
	pos_opening_shift = data.get("pos_opening_shift")
	is_return = data.get("is_return", 0)
	return_against = data.get("return_against")
	additional_discount_percentage = flt(data.get("additional_discount_percentage", 0))
	discount_amount = flt(data.get("discount_amount", 0))
	submit_in_background = cint(data.get("submit_in_background", 0))

	if not pos_profile:
		frappe.throw(_("POS Profile is required"))
	if not customer:
		frappe.throw(_("Customer is required"))
	if not items:
		frappe.throw(_("At least one item is required"))

	pos = resolve_pos_profile(pos_profile)

	doctype = get_invoice_type()

	debit_to = None
	if hasattr(pos, "debit_to") and pos.get("debit_to"):
		debit_to = pos.debit_to
	if not debit_to:
		debit_to = frappe.db.get_value("Company", pos.company, "default_receivable_account")

	customer_credit = []
	if data.get("customer_credit"):
		if is_return:
			frappe.throw(_("Customer credit cannot be used on a return."))
		# Locked until this request commits; re-read so a stale till cannot double-spend.
		customer_credit = lock_credit_sources(pos, customer, debit_to, data["customer_credit"])
		submit_in_background = 0

	invoice_name = data.get("name")
	is_existing_draft = False

	if invoice_name and frappe.db.exists(doctype, invoice_name):
		invoice_doc = frappe.get_doc(doctype, invoice_name)
		if invoice_doc.docstatus != 0:
			frappe.throw(_("Only draft invoices can be updated and submitted"))

		_guard_stale_draft(doctype, invoice_name, data.get("modified"))

		if invoice_doc.get("pos_awaiting_settlement") and not is_pos_cashier(
			frappe.session.user, pos_profile
		):
			frappe.throw(_("Only a cashier can settle this invoice."), frappe.PermissionError)

		is_existing_draft = True
		invoice_doc.set("items", [])
		invoice_doc.set("payments", [])
		invoice_doc.set("taxes", [])
		if hasattr(invoice_doc, "coupons"):
			invoice_doc.set("coupons", [])
		if hasattr(invoice_doc, "offers"):
			invoice_doc.set("offers", [])
	else:
		invoice_doc = frappe.new_doc(doctype)

	invoice_doc.is_pos = 1
	if local_id:
		invoice_doc.xpos_local_id = local_id
		invoice_doc.xpos_request_hash = fingerprint
	invoice_doc.pos_profile = pos_profile
	invoice_doc.customer = customer
	invoice_doc.company = pos.company
	invoice_doc.debit_to = debit_to
	if pos.allow_change_posting_date:
		invoice_doc.set_posting_time = 1
		invoice_doc.posting_date = _resolve_invoice_posting_date(
			pos,
			data.get("posting_date"),
			getattr(invoice_doc, "posting_date", None) if is_existing_draft else None,
		)
		invoice_doc.posting_time = now_datetime().strftime("%H:%M:%S")
	else:
		invoice_doc.set_posting_time = 0
		invoice_doc.posting_date = nowdate()
		invoice_doc.posting_time = now_datetime().strftime("%H:%M:%S")

	invoice_doc.set_warehouse = pos.warehouse
	invoice_doc.update_stock = resolve_update_stock(pos, return_against if is_return else None)
	invoice_doc.currency = (
		data.get("currency")
		or pos.currency
		or frappe.db.get_value("Company", pos.company, "default_currency")
	)
	if customer_credit and invoice_doc.currency != frappe.get_cached_value(
		"Company", pos.company, "default_currency"
	):
		frappe.throw(_("Customer credit can only be spent on sales in the company currency."))
	if is_return:
		invoice_doc.selling_price_list = data.get("selling_price_list") or pos.get("selling_price_list")
	else:
		invoice_doc.selling_price_list = resolve_selling_price_list(pos, customer)

	if data.get("conversion_rate"):
		invoice_doc.conversion_rate = flt(data["conversion_rate"])
	if data.get("price_list_currency"):
		invoice_doc.price_list_currency = data["price_list_currency"]
	if data.get("plc_conversion_rate"):
		invoice_doc.plc_conversion_rate = flt(data["plc_conversion_rate"])

	invoice_doc.is_return = 1 if is_return else 0
	if is_return:
		invoice_doc.is_return = 1
		if return_against:
			invoice_doc.return_against = return_against
			items = _validate_return_invoice(return_against, customer, items)
		else:
			frappe.throw(_("Return Against invoice is required for returns"))
	else:
		invoice_doc.return_against = None

	if additional_discount_percentage:
		invoice_doc.additional_discount_percentage = additional_discount_percentage
		invoice_doc.apply_discount_on = data.get("apply_discount_on") or "Grand Total"
	elif discount_amount:
		invoice_doc.discount_amount = discount_amount
		invoice_doc.apply_discount_on = data.get("apply_discount_on") or "Grand Total"

	invoice_doc.pos_notes = data.get("pos_notes", "")

	sales_person = data.get("sales_person") or None
	if sales_person:
		apply_sales_person(invoice_doc, sales_person, pos_profile)
	else:
		apply_sales_person(invoice_doc, resolve_return_sales_person(invoice_doc.return_against))

	_apply_invoice_loyalty_fields(invoice_doc, data)

	if data.get("write_off_amount"):
		invoice_doc.write_off_amount = flt(data["write_off_amount"])
		invoice_doc.write_off_account = data.get("write_off_account") or pos.get("write_off_account")
		invoice_doc.write_off_cost_center = data.get("write_off_cost_center") or pos.get(
			"write_off_cost_center"
		)

	rate_precision = _get_item_rate_precision()

	gift_setting = get_company_setting(pos.company)
	gift_issue_lines = [
		i
		for i in items
		if cint(i.get("gift_card_issue")) or (gift_setting and i.get("item_code") == gift_setting.issue_item)
	]
	if gift_issue_lines:
		gift_setting = require_gift_card_access("sell_gift_card", pos_profile)
	if gift_setting and any(p.get("mode_of_payment") == gift_setting.mode_of_payment for p in payments):
		require_gift_card_access("redeem_gift_card", pos_profile)

	from xpos.api.auth import user_has_pos_permission

	allow_rate_change = user_has_pos_permission("allow_change_price", pos_profile=pos.name)
	coupon_offers = {c.get("pos_offer") for c in data.get("coupons_detail") or [] if c.get("pos_offer")}
	paid_lines = [
		i
		for i in items
		if not cint(i.get("is_free_item")) and not cint(i.get("is_offer")) and i not in gift_issue_lines
	]

	# (row, line as the till sent it, index): compared with ERPNext's result before anything is submitted.
	quoted = []
	sale_rows = []
	for index, item_data in enumerate(items):
		if item_data in gift_issue_lines:
			item_data["item_code"] = gift_setting.issue_item
			item_data["is_free_item"] = 0
		sent_line = dict(item_data)
		item_rate = flt(item_data.get("rate", 0), rate_precision)
		item_qty = flt(item_data.get("qty", 1), 3)
		is_free_item = cint(item_data.get("is_free_item")) and verified_pricing_rule_free_line(pos, item_data)
		verified_free = bool(is_free_item) or bool(
			not is_return
			and cint(item_data.get("is_offer"))
			and verified_offer_free_line(pos, item_data, paid_lines, coupon_offers, invoice_doc.posting_date)
		)
		is_sale_line = not is_return and not verified_free and item_data not in gift_issue_lines

		if is_sale_line and not allow_rate_change:
			listed_rate = get_line_rate(
				invoice_doc.selling_price_list,
				item_data.get("item_code"),
				item_data.get("uom") or item_data.get("stock_uom"),
				customer,
				item_qty,
				invoice_doc.posting_date,
				item_data.get("batch_no"),
			)
			if listed_rate is not None:
				item_rate = flt(listed_rate, rate_precision)
			elif item_rate:
				# Without price-change rights a cashier cannot invent a price the list does not have.
				price_unavailable(item_data.get("item_code"), invoice_doc.selling_price_list)
			# Offers are re-derived from the rates actually charged.
			item_data["rate"] = item_rate

		item = invoice_doc.append("items", {})
		item.item_code = item_data.get("item_code")
		item.item_name = item_data.get("item_name")
		item.local_item_name = frappe.db.get_value(
			"Item", item_data.get("item_code"), "local_item_name"
		) or item_data.get("item_name")
		item.qty = item_qty
		item.uom = item_data.get("uom") or item_data.get("stock_uom")
		item.warehouse = item_data.get("warehouse") or pos.warehouse

		if is_return:
			item.warehouse = item_data.get("warehouse") or item_data.get("source_warehouse") or item.warehouse
			for fieldname in (
				"sales_invoice_item",
				"pos_invoice_item",
				"sales_order",
				"delivery_note",
				"so_detail",
				"dn_detail",
				"expense_account",
				"pos_invoice",
			):
				if item_data.get(fieldname) is not None:
					setattr(item, fieldname, item_data.get(fieldname))

		disc_pct = flt(item_data.get("discount_percentage", 0), 2)
		disc_amt = flt(item_data.get("discount_amount", 0), 2)

		max_discount = flt(pos.get("max_discount_percentage_allowed", 0))
		if max_discount > 0 and disc_pct > max_discount and not verified_free:
			frappe.throw(
				_("Item {0}: Discount {1}% exceeds maximum allowed {2}%").format(
					item_data.get("item_code"), disc_pct, max_discount
				)
			)

		if is_free_item:
			item.is_free_item = 1
			if item_data.get("pricing_rules"):
				item.pricing_rules = item_data["pricing_rules"]

		item.price_list_rate = item_rate
		if disc_pct:
			item.discount_percentage = disc_pct
			item.rate = flt(item_rate * (1.0 - disc_pct / 100.0), rate_precision)
		elif disc_amt:
			item.discount_amount = disc_amt
			item.rate = flt(item_rate - disc_amt, rate_precision)
		else:
			item.rate = item_rate
		if not is_return and item_data not in gift_issue_lines:
			quoted.append((item, sent_line, index))
		if is_sale_line:
			sale_rows.append(item)
		if item_data.get("serial_no"):
			item.serial_no = item_data.get("serial_no")
		if item_data.get("batch_no"):
			item.batch_no = item_data.get("batch_no")
		if item_data.get("item_tax_template"):
			item.item_tax_template = item_data.get("item_tax_template")
		if item_data in gift_issue_lines:
			item.income_account = gift_setting.liability_account
			if is_return:
				item.xpos_gift_card = item_data.get("gift_card")

		if item_data.get("additional_notes"):
			item.additional_notes = item_data["additional_notes"]

	apply_invoice_delivery_dates(invoice_doc, data, items)

	existing_account_heads = set()
	# a gift card is money, not a supply: tax is charged when it is spent
	if pos.taxes_and_charges and not gift_issue_lines:
		invoice_doc.taxes_and_charges = pos.taxes_and_charges
		tax_template = frappe.get_doc("Sales Taxes and Charges Template", pos.taxes_and_charges)
		for tax in tax_template.taxes:
			invoice_doc.append(
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
			existing_account_heads.add(tax.account_head)

	from xpos.x_pos.api.utilities import add_taxes_from_tax_template

	for item_row in invoice_doc.items:
		if getattr(item_row, "item_tax_template", None):
			add_taxes_from_tax_template(
				{"item_tax_template": item_row.item_tax_template},
				invoice_doc,
			)

	_apply_invoice_delivery_charge_fields(invoice_doc, data)

	loyalty_paid = 0
	if invoice_doc.redeem_loyalty_points and invoice_doc.loyalty_points:
		_prepare_invoice_totals_for_loyalty_validation(invoice_doc)
		loyalty_paid = _resolve_loyalty_paid_amount(invoice_doc)

	rate_cache: dict = {}
	tender_rows, total_payment = build_tender_legs(payments, invoice_doc, rate_cache)
	for row in tender_rows:
		invoice_doc.append("payments", row)

	_ensure_pos_invoice_payment_row(invoice_doc, pos, bool(invoice_doc.is_pos and not invoice_doc.is_return))

	if loyalty_paid and hasattr(invoice_doc, "set_paid_amount"):
		_original_set_paid_amount = invoice_doc.set_paid_amount

		def _set_paid_amount_with_loyalty():
			_original_set_paid_amount()
			invoice_doc.paid_amount = flt(invoice_doc.paid_amount + loyalty_paid, 2)
			invoice_doc.base_paid_amount = flt(
				invoice_doc.base_paid_amount + (loyalty_paid * flt(invoice_doc.conversion_rate or 1)),
				2,
			)

		invoice_doc.set_paid_amount = _set_paid_amount_with_loyalty

	if is_return and doctype == "POS Invoice":
		invoice_doc.validate_change_amount = lambda: None
	else:
		paid_precision = get_currency_precision(invoice_currency_of(invoice_doc))
		invoice_doc.paid_amount = flt(total_payment + loyalty_paid, paid_precision)
		invoice_doc.base_paid_amount = flt(
			invoice_doc.paid_amount * flt(invoice_doc.conversion_rate or 1), paid_precision
		)

	change_legs, change_total = build_change_legs(data.get("pos_change_legs") or [], invoice_doc, rate_cache)
	if change_legs:
		invoice_doc.set("pos_change_legs", [])
		for leg in change_legs:
			invoice_doc.append("pos_change_legs", leg)

	change_amount = change_total if change_legs else flt(data.get("change_amount", 0))
	if change_amount > 0:
		invoice_doc.change_amount = change_amount
		if not change_legs and not is_return and doctype == "POS Invoice":
			cap_change_at_overpayment(invoice_doc)

	if pos_opening_shift:
		invoice_doc.pos_opening_shift = pos_opening_shift

	pos_coupons_data = data.get("coupons_detail") or []
	for coupon_row in pos_coupons_data:
		with suppress(AttributeError):
			invoice_doc.append(
				"coupons",
				{
					"coupon": coupon_row.get("coupon"),
					"coupon_code": coupon_row.get("coupon_code"),
					"type": coupon_row.get("type"),
					"pos_offer": coupon_row.get("pos_offer"),
					"applied": cint(coupon_row.get("applied", 1)),
					"customer": coupon_row.get("customer") or customer,
				},
			)

	pos_offers_data = data.get("offers_detail") or []
	for offer_row in pos_offers_data:
		with suppress(AttributeError):
			invoice_doc.append(
				"offers",
				{
					"offer_name": offer_row.get("offer_name"),
					"offer": offer_row.get("offer"),
					"apply_on": offer_row.get("apply_on"),
					"offer_applied": cint(offer_row.get("offer_applied", 1)),
					"coupon_based": cint(offer_row.get("coupon_based", 0)),
					"coupon": offer_row.get("coupon"),
				},
			)

	if cint(pos.get("enable_return_validity")) and not is_return:
		return_days = cint(pos.get("return_validity_days"))
		if return_days > 0:
			invoice_doc.return_valid_upto = add_days(nowdate(), return_days)

	frappe.db.savepoint(REPRICE_SAVEPOINT)
	try:
		if is_existing_draft:
			invoice_doc.save(ignore_permissions=True)
		else:
			invoice_doc.insert(ignore_permissions=True)
	except (frappe.exceptions.UniqueValidationError, frappe.QueryDeadlockError):
		# Concurrent attempts may contend on the naming series before reaching the unique ID.
		frappe.db.rollback()
		existing = find_invoice_by_local_id(local_id, warehouse, fingerprint)
		if existing:
			return existing_sale_response(*existing)
		raise

	if not is_return:
		# ERPNext has now priced the sale. If that differs from what the cashier took payment
		# for, undo everything (draft, locks, gift card rows) and hand the new prices back.
		changes = repricing_changes(invoice_doc, quoted, data)
		if changes:
			frappe.db.rollback(save_point=REPRICE_SAVEPOINT)
			return changes
		validate_sale_discounts(
			pos,
			invoice_doc,
			sale_rows,
			[i.get("offers") for i in items] + [o.get("offer_name") for o in data.get("offers_detail") or []],
			paid_lines,
			coupon_offers,
		)
		check_zero_payable(pos, invoice_doc, sale_rows)

	enforce_stock_availability(invoice_doc)
	validate_invoice_coupons(invoice_doc)

	_validate_unpaid_balance_permissions(invoice_doc, pos, data, credit_total(customer_credit))

	from xpos.x_pos.integrations import fbr

	client_fbr_number = cstr(data.get("fbr_invoice_number") or "").strip()
	if client_fbr_number:
		fbr.record_local_result(invoice_doc, client_fbr_number)
		fbr.apply_fiscal_number(invoice_doc, client_fbr_number)
		invoice_doc.save(ignore_permissions=True)
	else:
		outcome = fbr.prepare_fiscalization(invoice_doc)
		if outcome.status == "local_required" and customer_credit:
			# Nothing reached FBR, and finalizing does not allocate credit.
			frappe.throw(_("Customer credit cannot be combined with local FBR fiscalization."))
		if outcome.status == "uncertain" and customer_credit:
			# Not held as a draft: finalizing does not allocate credit. The fiscal ledger keeps the
			# attempt, so the same sale id is never sent again until an FBR check is recorded.
			frappe.db.rollback(save_point=REPRICE_SAVEPOINT)
			return fiscal_uncertain_sale(outcome.payload["USIN"], pos_profile, invoice_doc)
		if outcome.status in ("local_required", "uncertain"):
			# Keep the draft and its sale id: a retry resumes it instead of fiscalizing again.
			invoice_doc.xpos_fiscal_state = (
				"Awaiting Local" if outcome.status == "local_required" else "Uncertain"
			)
			invoice_doc.save(ignore_permissions=True)
			return fiscal_pending_response(invoice_doc, outcome)
		if outcome.status == "cloud":
			fbr.apply_fiscal_number(invoice_doc, outcome.fbr_invoice_number, outcome.posted_on)
			invoice_doc.save(ignore_permissions=True)

	if submit_in_background:
		enqueue(
			_submit_invoice_job,
			queue="short",
			timeout=300,
			invoice_name=invoice_doc.name,
			doctype=doctype,
		)
		return {
			"name": invoice_doc.name,
			"status": "Queued",
			"grand_total": invoice_doc.grand_total,
			"customer": invoice_doc.customer,
			"customer_name": invoice_doc.customer_name,
		}

	invoice_doc.submit()
	allocate_customer_credit(invoice_doc, customer_credit)
	if customer_credit:
		invoice_doc.reload()

	return _build_invoice_response(invoice_doc)


def cap_change_at_overpayment(invoice_doc):
	"""The client's change can be off by rounding: never record more than paid minus the total."""
	validate_change_amount = invoice_doc.validate_change_amount

	def capped():
		total = flt(invoice_doc.rounded_total) or flt(invoice_doc.grand_total)
		overpaid = flt(invoice_doc.paid_amount) - total + flt(invoice_doc.write_off_amount)
		invoice_doc.change_amount = flt(
			max(0, min(flt(invoice_doc.change_amount), overpaid)), invoice_doc.precision("change_amount")
		)
		validate_change_amount()

	invoice_doc.validate_change_amount = capped


def existing_sale_response(doctype: str, name: str) -> dict:
	"""Answer a retry of a sale that already exists, without creating or fiscalizing it again."""
	doc = frappe.get_doc(doctype, name)
	if doc.docstatus == 1:
		return {**_build_invoice_response(doc), "duplicate": True}
	if doc.get("fbr_invoice_number"):
		# Fiscalized, but the submit failed earlier: finish it without asking FBR again.
		return {**submit_fiscalized_draft(doc), "duplicate": True}
	if doc.get("xpos_fiscal_state"):
		return {**resume_fiscal_draft(doc), "duplicate": True}
	from xpos.x_pos.integrations import fbr

	# Queued for background submission; it may have been fiscalized before its submit failed.
	known = fbr.ledger_outcome(doc)
	if known and known.status == "cloud":
		fbr.apply_fiscal_number(doc, known.fbr_invoice_number, known.posted_on)
		return {**submit_fiscalized_draft(doc), "duplicate": True}
	if known:
		doc.db_set("xpos_fiscal_state", "Uncertain")
		return {**fiscal_pending_response(doc, known), "duplicate": True}
	return {"name": doc.name, "status": "Queued", "duplicate": True, "grand_total": doc.grand_total}


def resume_fiscal_draft(doc) -> dict:
	"""Continue a draft held for FBR, from what the fiscal ledger knows.

	A number FBR issued is reused. A draft waiting for the local service is handed back to it,
	never sent to the cloud again. An uncertain draft stays held until an FBR check is
	recorded; only "not recorded" lets it be sent once more.
	"""
	from xpos.x_pos.integrations import fbr

	if doc.xpos_fiscal_state == "Awaiting Local":
		outcome = fbr.ledger_outcome(doc) or fbr.local_fiscalization_outcome(doc)
	else:
		outcome = fbr.prepare_fiscalization(doc)
	if outcome.status in ("local_required", "uncertain"):
		state = "Awaiting Local" if outcome.status == "local_required" else "Uncertain"
		if doc.xpos_fiscal_state != state:
			doc.xpos_fiscal_state = state
			doc.save(ignore_permissions=True)
		return fiscal_pending_response(doc, outcome)
	if outcome.status == "cloud":
		fbr.apply_fiscal_number(doc, outcome.fbr_invoice_number, outcome.posted_on)
	return submit_fiscalized_draft(doc)


def fiscal_uncertain_sale(usin: str, pos_profile: str, doc) -> dict:
	"""A customer-credit sale whose FBR outcome is unknown: nothing was saved, the attempt is kept."""
	return {
		"name": None,
		"usin": usin,
		"pos_profile": pos_profile,
		"status": "fbr_uncertain",
		"grand_total": doc.grand_total,
		"customer": doc.customer,
		"message": _(
			"FBR may have recorded sale {0} without answering. Nothing was saved and no credit was "
			"used. After the FBR check is recorded, send the same sale again."
		).format(usin),
	}


def fiscal_pending_response(doc, outcome) -> dict:
	"""A saved draft that still needs its FBR number: from the local service, or after a check."""
	response = {
		"name": doc.name,
		"doctype": doc.doctype,
		"grand_total": doc.grand_total,
		"customer": doc.customer,
		"customer_name": doc.customer_name,
	}
	if outcome.status == "uncertain":
		return {
			**response,
			"status": "fbr_uncertain",
			"usin": doc.get("xpos_local_id") or doc.name,
			"pos_profile": doc.get("pos_profile"),
			"message": _(
				"FBR may have recorded invoice {0} without answering. Check FBR's records and record "
				"what they show before it can be finished."
			).format(doc.name),
		}
	return {
		**response,
		"status": "fbr_local_required",
		"fbr_payload": outcome.payload,
		"fbr_local_service_url": outcome.local_service_url,
	}


def fiscal_draft(name: str, doctype: str | None, action: str):
	doctype = doctype or get_invoice_type()
	doc = frappe.get_doc(doctype, name)
	# The user who rang the sale up may finish it, as may the profile's cashiers.
	if (
		doc.get("pos_profile")
		and doc.owner != frappe.session.user
		and not is_pos_cashier(frappe.session.user, doc.pos_profile)
	):
		frappe.throw(_("Only a cashier can {0} this invoice.").format(action), frappe.PermissionError)
	# Serialise with any other request finishing this draft.
	read_latest_on_lock()
	frappe.db.get_value(doctype, name, "name", for_update=True)
	doc.reload()
	return doc


@frappe.whitelist()
def mark_fiscalization_uncertain(name: str, doctype: str | None = None) -> dict:
	"""The local FBR service was asked for a number but did not answer: hold the draft for a check."""
	from xpos.x_pos.integrations import fbr

	doc = fiscal_draft(name, doctype, _("update"))
	if doc.docstatus == 0 and not doc.get("fbr_invoice_number"):
		fbr.record_local_result(doc, None)
		doc.db_set("xpos_fiscal_state", "Uncertain")
	return {"name": doc.name, "status": "fbr_uncertain" if doc.docstatus == 0 else "Paid"}


@frappe.whitelist()
def retry_fiscalization(name: str, doctype: str | None = None) -> dict:
	"""Finish a draft held for an FBR check, once ``resolve_fiscal_check`` has recorded the outcome."""
	doc = fiscal_draft(name, doctype, _("fiscalize"))
	if doc.docstatus == 1:
		return _build_invoice_response(doc)
	if doc.get("xpos_fiscal_state") != "Uncertain":
		frappe.throw(_("Invoice {0} is not waiting for an FBR check.").format(doc.name))
	return resume_fiscal_draft(doc)


FISCAL_RESOLUTIONS = ("Recorded", "Not Recorded")
FBR_NUMBER_PATTERN = re.compile(r"^[A-Za-z0-9*#/_.:-]{4,100}$")


@frappe.whitelist(methods=["POST"])
def resolve_fiscal_check(
	usin: str, pos_profile: str, resolution: str, evidence: str, fbr_invoice_number: str | None = None
) -> dict:
	"""Record what FBR's records show for a sale whose FBR outcome was unknown.

	XPOS cannot ask FBR whether it holds a sale: the IMS API it uses only posts invoices.
	A person with *Resolve FBR Check* on the sale's profile looks the sale id (USIN) up in
	FBR's records and records the answer with what they saw. *Recorded* reuses that number
	when the sale is sent again; *Not Recorded* lets it be sent to FBR once more. Nothing is
	submitted here: the till sends the same sale again to finish it.
	"""
	from xpos.api.auth import user_has_pos_permission
	from xpos.x_pos.integrations import fbr, fiscal_ledger

	usin, evidence = cstr(usin).strip(), cstr(evidence).strip()
	number = cstr(fbr_invoice_number).strip() or None
	if not usin or not pos_profile or not frappe.db.exists("POS Profile", pos_profile):
		frappe.throw(_("A sale id and its POS Profile are required."))
	if not user_has_pos_permission("resolve_fiscal_check", pos_profile=pos_profile):
		frappe.throw(
			_("You are not permitted to resolve FBR checks on {0}.").format(pos_profile),
			frappe.PermissionError,
		)
	if resolution not in FISCAL_RESOLUTIONS:
		frappe.throw(_("Resolution must be Recorded or Not Recorded."))
	if len(evidence) < 10 or len(evidence) > 1000:
		frappe.throw(
			_("Describe where you checked FBR's records and what you found (10 to 1000 characters).")
		)
	if resolution == "Recorded" and not (number and FBR_NUMBER_PATTERN.match(number)):
		frappe.throw(_("Enter the FBR invoice number exactly as FBR's records show it."))
	if resolution == "Not Recorded":
		number = None

	for doctype in ("Sales Invoice", "POS Invoice"):
		if number and frappe.db.has_column(doctype, "fbr_invoice_number"):
			other = frappe.db.get_value(doctype, {"fbr_invoice_number": number, "docstatus": ("<", 2)})
			if other:
				frappe.throw(
					_("FBR number {0} already belongs to {1}. Check the number in FBR's records.").format(
						number, other
					),
					title=_("FBR number in use"),
				)

	legacy_draft = None
	for doctype in ("Sales Invoice", "POS Invoice"):
		name = frappe.db.get_value(
			doctype,
			{
				"xpos_local_id": usin,
				"pos_profile": pos_profile,
				"docstatus": 0,
				"xpos_fiscal_state": "Uncertain",
			},
		) or frappe.db.get_value(
			doctype,
			{"name": usin, "pos_profile": pos_profile, "docstatus": 0, "xpos_fiscal_state": "Uncertain"},
		)
		if name:
			legacy_draft = frappe.get_doc(doctype, name)
			break
	row = fiscal_ledger.resolve(fbr.fbr_pos_id(pos_profile), usin, resolution, number, evidence, legacy_draft)
	return {
		"usin": usin,
		"resolution": row.resolution,
		"fbr_invoice_number": row.fbr_invoice_number,
		"attempt": row.name,
		"resolved_by": row.resolved_by,
	}


def submit_fiscalized_draft(doc) -> dict:
	"""Submit a draft that carries its FBR number. The number is already kept in the fiscal ledger."""
	doc.xpos_fiscal_state = ""
	doc.save(ignore_permissions=True)
	enforce_stock_availability(doc)
	doc.submit()
	return _build_invoice_response(doc)


def _submit_invoice_job(invoice_name: str, doctype: str = "Sales Invoice"):
	"""Background job to submit an invoice."""
	user = frappe.session.user
	try:
		doc = frappe.get_doc(doctype, invoice_name)
		enforce_stock_availability(doc)
		doc.submit()
		frappe.db.commit()
	except Exception as e:
		frappe.db.rollback()
		from xpos.x_pos.integrations.fbr import FBRUncertainError

		if isinstance(e, FBRUncertainError):
			frappe.db.set_value(doctype, invoice_name, "xpos_fiscal_state", "Uncertain")
			frappe.db.commit()
		frappe.log_error(f"Failed to submit {doctype} {invoice_name}: {e}", "X POS Invoice Submission")
		frappe.publish_realtime(
			"pos_invoice_submit_error",
			{"invoice": invoice_name, "error": str(e)},
			user=user,
		)


@frappe.whitelist()
def finalize_fiscal_invoice(name: str, fbr_invoice_number: str, doctype: str | None = None):
	"""Stamp a locally-obtained FBR number on a pending draft and submit it.

	Completes the offline-fiscalization handshake started by ``create_invoice`` when
	it returned ``fbr_local_required``: the client fetched the number from the local
	fiscalization service and passes it here to finalize the sale.
	"""
	from xpos.x_pos.integrations import fbr

	doctype = doctype or get_invoice_type()
	fbr_invoice_number = cstr(fbr_invoice_number or "").strip()
	if not fbr_invoice_number:
		frappe.throw(_("FBR invoice number is required to finalize this invoice."))

	invoice_doc = fiscal_draft(name, doctype, _("finalize"))
	if invoice_doc.docstatus != 0:
		return _build_invoice_response(invoice_doc)
	if invoice_doc.get("xpos_fiscal_state") == "Uncertain":
		# Only a recorded FBR check may supply the number of a sale FBR may already hold.
		known = fbr.ledger_outcome(invoice_doc)
		if not (known and known.status == "cloud" and known.fbr_invoice_number == fbr_invoice_number):
			frappe.throw(
				_("FBR may already hold invoice {0}. Record the FBR check first.").format(invoice_doc.name),
				title=_("FBR check required"),
			)

	# Kept outside this transaction, so a failed submit never asks the local service again.
	fbr.record_local_result(invoice_doc, fbr_invoice_number)
	fbr.apply_fiscal_number(invoice_doc, fbr_invoice_number)
	return submit_fiscalized_draft(invoice_doc)


@frappe.whitelist()
def discard_draft_invoice(name: str, doctype: str | None = None) -> dict:
	"""Delete a draft invoice left pending when fiscalization could not complete.

	Used when both the FBR cloud and the local service are unreachable, so the sale
	could not be finalized and the draft should not linger.
	"""
	doctype = doctype or get_invoice_type()
	ensure_invoice_doctype(doctype)
	if not frappe.db.exists(doctype, name):
		return {"deleted": False}

	invoice_doc = get_pos_invoice(doctype, name, "delete")
	if invoice_doc.docstatus != 0:
		frappe.throw(_("Only a draft invoice can be discarded."))
	if invoice_doc.get("xpos_fiscal_state") == "Uncertain":
		frappe.throw(_("FBR may have recorded invoice {0}. Resolve the FBR check first.").format(name))
	if invoice_doc.get("pos_profile") and not is_pos_cashier(frappe.session.user, invoice_doc.pos_profile):
		frappe.throw(_("Only a cashier can discard this invoice."), frappe.PermissionError)

	frappe.delete_doc(doctype, name, ignore_permissions=True, force=True)
	return {"deleted": True}


@frappe.whitelist()
def save_draft_invoice(data: str | dict):
	"""Save invoice as draft without submitting.

	If data contains a ``name`` field that matches an existing draft invoice,
	that draft is updated in place rather than creating a new document.
	"""
	data = json.loads(data) if isinstance(data, str) else data

	pos_profile = data.get("pos_profile")
	customer = data.get("customer")
	items = data.get("items", [])
	pos_opening_shift = data.get("pos_opening_shift")
	invoice_name = data.get("name")

	if not pos_profile or not customer or not items:
		frappe.throw(_("POS Profile, Customer, and Items are required"))

	pos = resolve_pos_profile(pos_profile)

	doctype = get_invoice_type()

	debit_to = None
	if hasattr(pos, "debit_to") and pos.get("debit_to"):
		debit_to = pos.debit_to
	if not debit_to:
		debit_to = frappe.db.get_value("Company", pos.company, "default_receivable_account")

	is_update = False
	if invoice_name and frappe.db.exists(doctype, invoice_name):
		invoice_doc = frappe.get_doc(doctype, invoice_name)
		if invoice_doc.docstatus != 0:
			frappe.throw(_("Invoice {0} is not a draft and cannot be updated").format(invoice_name))
		_guard_stale_draft(doctype, invoice_name, data.get("modified"))
		is_update = True
		invoice_doc.set("items", [])
		invoice_doc.set("taxes", [])
	else:
		invoice_doc = frappe.new_doc(doctype)

	invoice_doc.is_pos = 1
	invoice_doc.pos_profile = pos_profile
	invoice_doc.customer = customer
	invoice_doc.company = pos.company
	invoice_doc.debit_to = debit_to
	if pos.allow_change_posting_date:
		invoice_doc.set_posting_time = 1
		invoice_doc.posting_date = _resolve_invoice_posting_date(
			pos,
			data.get("posting_date"),
			getattr(invoice_doc, "posting_date", None) if is_update else None,
		)
		invoice_doc.posting_time = now_datetime().strftime("%H:%M:%S")
	else:
		invoice_doc.set_posting_time = 0
		invoice_doc.posting_date = nowdate()
		invoice_doc.posting_time = now_datetime().strftime("%H:%M:%S")
	invoice_doc.set_warehouse = pos.warehouse
	invoice_doc.update_stock = resolve_update_stock(pos)
	invoice_doc.currency = (
		data.get("currency")
		or pos.currency
		or frappe.db.get_value("Company", pos.company, "default_currency")
	)
	invoice_doc.selling_price_list = resolve_selling_price_list(pos, customer)

	if data.get("additional_discount_percentage"):
		invoice_doc.additional_discount_percentage = flt(data["additional_discount_percentage"])
		invoice_doc.apply_discount_on = data.get("apply_discount_on") or "Grand Total"
	elif data.get("discount_amount"):
		invoice_doc.discount_amount = flt(data["discount_amount"])
		invoice_doc.apply_discount_on = data.get("apply_discount_on") or "Grand Total"

	invoice_doc.pos_notes = data.get("pos_notes") or ""

	apply_sales_person(invoice_doc, data.get("sales_person") or None, pos_profile)

	rate_precision = _get_item_rate_precision()

	for item_data in items:
		item_rate = flt(item_data.get("rate", 0), rate_precision)
		disc_pct = flt(item_data.get("discount_percentage", 0), 2)
		disc_amt = flt(item_data.get("discount_amount", 0), 2)

		item = invoice_doc.append("items", {})
		item.item_code = item_data.get("item_code")
		item.item_name = item_data.get("item_name")
		item.qty = flt(item_data.get("qty", 1))
		item.uom = item_data.get("uom") or item_data.get("stock_uom")
		item.warehouse = item_data.get("warehouse") or pos.warehouse

		if cint(item_data.get("is_free_item")):
			item.is_free_item = 1
			if item_data.get("pricing_rules"):
				item.pricing_rules = item_data["pricing_rules"]

		item.price_list_rate = item_rate
		if disc_pct:
			item.discount_percentage = disc_pct
			item.rate = flt(item_rate * (1.0 - disc_pct / 100.0), rate_precision)
		elif disc_amt:
			item.discount_amount = disc_amt
			item.rate = flt(item_rate - disc_amt, rate_precision)
		else:
			item.rate = item_rate

		if item_data.get("serial_no"):
			item.serial_no = item_data["serial_no"]
		if item_data.get("batch_no"):
			item.batch_no = item_data["batch_no"]

	apply_invoice_delivery_dates(invoice_doc, data, items)

	if pos.taxes_and_charges:
		invoice_doc.taxes_and_charges = pos.taxes_and_charges

	payments = data.get("payments", [])
	if payments:
		invoice_doc.set("payments", [])
		tender_rows, _total = build_tender_legs(payments, invoice_doc)
		for row in tender_rows:
			invoice_doc.append("payments", row)

	_ensure_pos_invoice_payment_row(invoice_doc, pos, doctype == "POS Invoice")

	if pos_opening_shift:
		invoice_doc.pos_opening_shift = pos_opening_shift

	if data.get("pos_awaiting_settlement") and frappe.db.has_column(doctype, "pos_awaiting_settlement"):
		invoice_doc.pos_awaiting_settlement = 1

	_apply_invoice_delivery_charge_fields(invoice_doc, data)

	if is_update:
		invoice_doc.save(ignore_permissions=True)
	else:
		invoice_doc.insert(ignore_permissions=True)

	return {
		"name": invoice_doc.name,
		"grand_total": invoice_doc.grand_total,
		"customer": invoice_doc.customer,
		"customer_name": invoice_doc.customer_name,
	}


@frappe.whitelist()
def get_draft_invoices(pos_opening_shift: str, scope: str = "shift"):
	"""Get draft invoices (open tabs) for the current shift, or for the whole profile."""
	doctype = get_invoice_type()
	filters = {"docstatus": 0, "is_pos": 1}
	fields = [
		"name",
		"customer",
		"customer_name",
		"posting_date",
		"grand_total",
		"total_qty",
		"currency",
		"creation",
		"modified",
	]
	limit = 50

	if scope == "profile":
		pos_profile = frappe.db.get_value("POS Opening Shift", pos_opening_shift, "pos_profile")
		if not pos_profile:
			frappe.throw(_("A POS Profile is required to list open tabs across shifts."))

		if not can_recall_other_shift_tabs(pos_profile):
			frappe.throw(
				_("You are not permitted to recall open tabs from other shifts."),
				frappe.PermissionError,
			)

		filters["pos_profile"] = pos_profile
		filters["is_return"] = 0
		fields += ["pos_opening_shift", "owner", "paid_amount"]
		if frappe.db.has_column(doctype, "pos_awaiting_settlement"):
			fields.append("pos_awaiting_settlement")
		limit = 200
	elif pos_opening_shift:
		filters["pos_opening_shift"] = pos_opening_shift

	invoices = frappe.get_list(
		doctype,
		filters=filters,
		fields=fields,
		limit_page_length=limit,
		order_by="modified desc",
	)

	return invoices


@frappe.whitelist()
def get_unsettled_invoices(pos_profile: str | None = None):
	"""Get draft invoices awaiting cashier settlement for a POS profile.

	These are unsubmitted invoices created by a terminal in cashier-settlement
	mode (``pos_awaiting_settlement = 1``). They are listed on the Cashier screen
	regardless of which terminal, operator or shift created them. Once settled
	(submitted), they drop out of this list via the ``docstatus = 0`` filter.
	"""
	doctype = get_invoice_type()

	if not frappe.db.has_column(doctype, "pos_awaiting_settlement"):
		return []

	if not is_pos_cashier(frappe.session.user, pos_profile):
		frappe.throw(_("You are not permitted to settle invoices."), frappe.PermissionError)

	filters = {"docstatus": 0, "is_pos": 1, "pos_awaiting_settlement": 1}
	if pos_profile:
		filters["pos_profile"] = pos_profile

	return frappe.get_list(
		doctype,
		filters=filters,
		fields=[
			"name",
			"customer",
			"customer_name",
			"posting_date",
			"posting_time",
			"grand_total",
			"total_qty",
			"currency",
			"creation",
			"modified",
		],
		limit_page_length=0,
		order_by="modified desc",
	)


@frappe.whitelist()
def get_past_orders(
	pos_profile: str = "",
	from_date: str = "",
	to_date: str = "",
	search_term: str = "",
	page: int = 0,
	limit: int = 20,
	filters: str | None = None,
	order_by: str = "posting_date desc, posting_time desc",
):
	"""Get past submitted invoices with advanced filtering and pagination.

	Args:
	        pos_profile: POS Profile name
	        from_date: Start date for filter
	        to_date: End date for filter
	        search_term: Search in invoice name, customer name, customer
	        page: Page number (0-indexed)
	        limit: Number of records per page
	        filters: JSON array of filter conditions like Frappe's query builder
	                Format: [["fieldname", "operator", "value"], ...]
	                Operators: =, !=, >, <, >=, <=, like, not like, in, not in, between, is, is not
	        order_by: Order by clause (default: posting_date desc, posting_time desc)

	Returns:
	        dict with 'data' (list of orders) and 'total' (total count)
	"""
	conditions = "si.docstatus = 1 AND si.is_pos = 1"
	values = {"offset": cint(page) * cint(limit), "limit": cint(limit)}

	if pos_profile:
		conditions += " AND si.pos_profile = %(pos_profile)s"
		values["pos_profile"] = pos_profile

	if from_date:
		conditions += " AND si.posting_date >= %(from_date)s"
		values["from_date"] = getdate(from_date)

	if to_date:
		conditions += " AND si.posting_date <= %(to_date)s"
		values["to_date"] = getdate(to_date)

	if search_term:
		search_term = search_term.strip()
		conditions += """ AND (
			si.name LIKE %(search)s
			OR si.customer_name LIKE %(search)s
			OR si.customer LIKE %(search)s
		)"""
		values["search"] = f"%{search_term}%"

	if filters:
		if isinstance(filters, str):
			filters = json.loads(filters)

		valid_fields = {
			"status",
			"customer",
			"customer_name",
			"is_return",
			"return_against",
			"grand_total",
			"net_total",
			"paid_amount",
			"outstanding_amount",
			"posting_date",
			"posting_time",
			"currency",
			"owner",
			"modified_by",
		}

		for idx, f in enumerate(filters):
			if len(f) < 3:
				continue

			fieldname, operator, value = f[0], f[1].lower(), f[2]

			if fieldname not in valid_fields:
				continue

			param_name = f"filter_{idx}"
			operator = operator.strip()

			if operator == "=":
				conditions += f" AND si.{fieldname} = %({param_name})s"
				values[param_name] = value
			elif operator == "!=":
				conditions += f" AND si.{fieldname} != %({param_name})s"
				values[param_name] = value
			elif operator == ">":
				conditions += f" AND si.{fieldname} > %({param_name})s"
				values[param_name] = value
			elif operator == "<":
				conditions += f" AND si.{fieldname} < %({param_name})s"
				values[param_name] = value
			elif operator == ">=":
				conditions += f" AND si.{fieldname} >= %({param_name})s"
				values[param_name] = value
			elif operator == "<=":
				conditions += f" AND si.{fieldname} <= %({param_name})s"
				values[param_name] = value
			elif operator == "like":
				conditions += f" AND si.{fieldname} LIKE %({param_name})s"
				values[param_name] = f"%{value}%"
			elif operator == "not like":
				conditions += f" AND si.{fieldname} NOT LIKE %({param_name})s"
				values[param_name] = f"%{value}%"
			elif operator == "in":
				if isinstance(value, list) and value:
					placeholders = ", ".join([f"%({param_name}_{i})s" for i in range(len(value))])
					conditions += f" AND si.{fieldname} IN ({placeholders})"
					for i, v in enumerate(value):
						values[f"{param_name}_{i}"] = v
			elif operator == "not in":
				if isinstance(value, list) and value:
					placeholders = ", ".join([f"%({param_name}_{i})s" for i in range(len(value))])
					conditions += f" AND si.{fieldname} NOT IN ({placeholders})"
					for i, v in enumerate(value):
						values[f"{param_name}_{i}"] = v
			elif operator == "between":
				if isinstance(value, list) and len(value) == 2:
					conditions += f" AND si.{fieldname} BETWEEN %({param_name}_0)s AND %({param_name}_1)s"
					values[f"{param_name}_0"] = value[0]
					values[f"{param_name}_1"] = value[1]
			elif operator in ("is", "is not"):
				if value is None or str(value).lower() in (
					"null",
					"none",
					"set",
					"not set",
				):
					null_check = (
						"IS NULL"
						if operator == "is" or str(value).lower() in ("null", "none", "not set")
						else "IS NOT NULL"
					)
					if str(value).lower() == "set":
						null_check = "IS NOT NULL"
					elif str(value).lower() == "not set":
						null_check = "IS NULL"
					conditions += f" AND si.{fieldname} {null_check}"

	allowed_order_fields = {
		"posting_date",
		"posting_time",
		"grand_total",
		"name",
		"customer_name",
		"status",
		"modified",
	}
	order_parts = []
	for part in order_by.split(","):
		part = part.strip()
		if not part:
			continue
		tokens = part.split()
		field = tokens[0].lower()
		direction = tokens[1].upper() if len(tokens) > 1 else "DESC"
		if field in allowed_order_fields and direction in ("ASC", "DESC"):
			order_parts.append(f"si.{field} {direction}")

	order_clause = ", ".join(order_parts) if order_parts else "si.posting_date DESC, si.posting_time DESC"

	doctype = get_invoice_type()
	table = f"`tab{doctype}`"

	total = frappe.db.sql(
		f"""SELECT COUNT(*) FROM {table} si WHERE """ + conditions,
		values,
		as_list=True,
	)[0][0]

	orders = frappe.db.sql(
		f"""SELECT
			si.name,
			si.customer,
			si.customer_name,
			si.posting_date,
			si.posting_time,
			si.grand_total,
			si.net_total,
			si.total_taxes_and_charges,
			si.paid_amount,
			si.currency,
			si.status,
			si.is_return,
			si.return_against,
			si.owner,
			si.modified
		FROM {table} si
		WHERE """
		+ conditions
		+ """
		ORDER BY """
		+ order_clause
		+ """
		LIMIT %(offset)s, %(limit)s
		""",
		values,
		as_dict=True,
	)

	return {"data": orders, "total": total}


@frappe.whitelist()
def get_invoices(
	pos_opening_shift: str | None = None,
	is_return: int | None = None,
	limit: int = 50,
	pos_profile: str = "",
):
	"""Return POS invoices filtered by opening shift and optional return flag."""
	doctype = get_invoice_type()
	filters = {"docstatus": 1, "is_pos": 1}
	if pos_opening_shift:
		filters["pos_opening_shift"] = pos_opening_shift
	if is_return is not None:
		filters["is_return"] = cint(is_return)

	return frappe.get_all(
		doctype,
		filters=filters,
		fields=[
			"name",
			"customer",
			"customer_name",
			"posting_date",
			"posting_time",
			"grand_total",
			"net_total",
			"paid_amount",
			"status",
			"is_return",
			"return_against",
		],
		order_by="posting_date desc, posting_time desc, modified desc",
		limit_page_length=cint(limit) if limit else 50,
	)


@frappe.whitelist()
def get_invoice_details(invoice_name: str, doctype: str = ""):
	"""Get full invoice details including items and payments."""
	if not doctype:
		doctype = _detect_invoice_doctype(invoice_name)
	doc = get_pos_invoice(doctype, invoice_name)

	return {
		"name": doc.name,
		"customer": doc.customer,
		"customer_name": doc.customer_name,
		"posting_date": str(doc.posting_date),
		"posting_time": str(doc.posting_time),
		"modified": str(doc.modified),
		"pos_opening_shift": getattr(doc, "pos_opening_shift", None),
		"grand_total": doc.grand_total,
		"net_total": doc.net_total,
		"total_taxes_and_charges": doc.total_taxes_and_charges,
		"paid_amount": doc.paid_amount,
		"change_amount": doc.change_amount,
		"outstanding_amount": getattr(doc, "outstanding_amount", 0),
		"currency": doc.currency,
		"status": doc.status,
		"is_return": doc.is_return,
		"return_against": getattr(doc, "return_against", None),
		"discount_amount": getattr(doc, "discount_amount", 0),
		"additional_discount_percentage": getattr(doc, "additional_discount_percentage", 0),
		"base_discount_amount": getattr(doc, "base_discount_amount", 0),
		"total_qty": getattr(doc, "total_qty", 0),
		"total": getattr(doc, "total", 0),
		"sales_partner": getattr(doc, "sales_partner", None),
		"sales_person": doc.sales_team[0].sales_person if doc.get("sales_team") else None,
		"commission_rate": getattr(doc, "commission_rate", 0),
		"total_commission": getattr(doc, "total_commission", 0),
		"loyalty_program": getattr(doc, "loyalty_program", None),
		"loyalty_points": getattr(doc, "loyalty_points", 0),
		"loyalty_amount": getattr(doc, "loyalty_amount", 0),
		"redeem_loyalty_points": getattr(doc, "redeem_loyalty_points", 0),
		"loyalty_redemption_account": getattr(doc, "loyalty_redemption_account", None),
		"owner": doc.owner,
		"pos_profile": getattr(doc, "pos_profile", None),
		"coupon_code": getattr(doc, "coupon_code", None),
		"remarks": getattr(doc, "remarks", None),
		"pos_delivery_charges": getattr(doc, "pos_delivery_charges", None),
		"pos_delivery_charges_rate": getattr(doc, "pos_delivery_charges_rate", 0),
		"pos_delivery_charges_label": (
			frappe.get_cached_value("Delivery Charges", doc.pos_delivery_charges, "label")
			if getattr(doc, "pos_delivery_charges", None)
			else None
		),
		"items": [
			{
				"item_code": i.item_code,
				"item_name": i.item_name,
				"qty": i.qty,
				"rate": i.rate,
				"price_list_rate": i.price_list_rate,
				"amount": i.amount,
				"uom": i.uom,
				"discount_percentage": i.discount_percentage,
				"discount_amount": i.discount_amount,
				"is_free_item": getattr(i, "is_free_item", 0),
				"pricing_rules": getattr(i, "pricing_rules", None),
				"serial_no": getattr(i, "serial_no", None),
				"batch_no": getattr(i, "batch_no", None),
			}
			for i in doc.items
		],
		"payments": [
			{
				"mode_of_payment": p.mode_of_payment,
				"amount": p.amount,
			}
			for p in doc.payments
		],
		"taxes": [
			{
				"description": t.description,
				"rate": t.rate,
				"tax_amount": t.tax_amount,
			}
			for t in doc.taxes
		],
	}


@frappe.whitelist()
def delete_draft_invoice(name: str, doctype: str = "", pos_opening_shift: str = ""):
	"""Delete a draft invoice."""
	if not doctype:
		doctype = _detect_invoice_doctype(name)
	doc = get_pos_invoice(doctype, name, "delete")
	if doc.docstatus != 0:
		frappe.throw(_("Only draft invoices can be deleted"))

	draft_shift = doc.get("pos_opening_shift")
	is_foreign_tab = bool(draft_shift) and bool(pos_opening_shift) and draft_shift != pos_opening_shift
	if is_foreign_tab and not can_recall_other_shift_tabs(doc.get("pos_profile")):
		frappe.throw(
			_("You are not permitted to delete an open tab from another shift."),
			frappe.PermissionError,
		)

	doc.delete(ignore_permissions=True)
	return {"success": True}


@frappe.whitelist()
def search_invoices_for_return(
	company: str,
	invoice_name: str = "",
	customer_name: str = "",
	customer_id: str = "",
	mobile_no: str = "",
	from_date: str = "",
	to_date: str = "",
	min_amount: float | None = None,
	max_amount: float | None = None,
	page: int = 1,
	pos_profile: str = "",
	doctype: str = "Sales Invoice",
):
	"""Search for invoices that can be returned.

	Supports multi-field customer search, date/amount filtering, and pagination.
	"""
	page = max(cint(page), 1)
	page_length = 50
	start = (page - 1) * page_length

	if doctype not in ("Sales Invoice", "POS Invoice"):
		frappe.throw(_("Invalid doctype for return search"))

	table = f"`tab{doctype}`"

	conditions = [
		f"{table}.company = %(company)s",
		f"{table}.docstatus = 1",
		f"{table}.is_return = 0",
	]
	params: dict = {"company": company}

	if from_date and to_date:
		conditions.append(f"{table}.posting_date BETWEEN %(from_date)s AND %(to_date)s")
		params["from_date"] = from_date
		params["to_date"] = to_date
	elif from_date:
		conditions.append(f"{table}.posting_date >= %(from_date)s")
		params["from_date"] = from_date
	elif to_date:
		conditions.append(f"{table}.posting_date <= %(to_date)s")
		params["to_date"] = to_date

	if min_amount and max_amount:
		conditions.append(f"{table}.grand_total BETWEEN %(min_amount)s AND %(max_amount)s")
		params["min_amount"] = flt(min_amount)
		params["max_amount"] = flt(max_amount)
	elif min_amount:
		conditions.append(f"{table}.grand_total >= %(min_amount)s")
		params["min_amount"] = flt(min_amount)
	elif max_amount:
		conditions.append(f"{table}.grand_total <= %(max_amount)s")
		params["max_amount"] = flt(max_amount)

	or_parts = []
	if invoice_name:
		or_parts.append(f"{table}.name LIKE %(inv_name)s")
		params["inv_name"] = f"%{invoice_name}%"

	if customer_name:
		or_parts.append(f"{table}.customer_name LIKE %(cust_name)s")
		params["cust_name"] = f"%{customer_name}%"

	if customer_id:
		or_parts.append(f"{table}.customer LIKE %(cust_id)s")
		params["cust_id"] = f"%{customer_id}%"

	if mobile_no:
		cust_by_mobile = frappe.db.sql(
			"SELECT name FROM `tabCustomer` WHERE mobile_no LIKE %(mob)s LIMIT 100",
			{"mob": f"%{mobile_no}%"},
			as_dict=True,
		)
		if cust_by_mobile:
			mob_ids = [c.name for c in cust_by_mobile]
			mob_placeholders = ", ".join([f"%(mob_{i})s" for i in range(len(mob_ids))])
			or_parts.append(f"{table}.customer IN ({mob_placeholders})")
			for i, mid in enumerate(mob_ids):
				params[f"mob_{i}"] = mid

	if or_parts:
		conditions.append(f"({' OR '.join(or_parts)})")

	where_clause = " AND ".join(conditions)
	# nosemgrep: frappe-sql-format-injection - table/column from validated doctype allowlist, all values parameterized
	sql = f"""
		SELECT
			{table}.name, {table}.company, {table}.customer, {table}.customer_name,
			{table}.posting_date, {table}.posting_time, {table}.grand_total, {table}.currency,
			{table}.discount_amount, {table}.additional_discount_percentage,
			{table}.is_return
		FROM {table}
		WHERE {where_clause}
		ORDER BY {table}.posting_date DESC, {table}.name DESC
		LIMIT %(limit)s OFFSET %(offset)s
		"""
	invoices = frappe.db.sql(
		sql,
		{**params, "limit": page_length + 1, "offset": start},
		as_dict=True,
	)

	has_more = len(invoices) > page_length
	if has_more:
		invoices = invoices[:page_length]

	if pos_profile:
		pos = frappe.get_cached_doc("POS Profile", pos_profile)
		enforce_return_validity = cint(pos.get("enable_return_validity"))
		if enforce_return_validity:
			for inv in invoices:
				validity_date = inv.get("return_valid_upto")
				inv["return_expired"] = (
					1 if (validity_date and getdate(nowdate()) > getdate(validity_date)) else 0
				)

	total_count = start + len(invoices) + (1 if has_more else 0)

	return {"invoices": invoices, "has_more": has_more, "total_count": total_count}


@frappe.whitelist()
def get_invoice_for_return(invoice_name: str, pos_profile: str = "", doctype: str = "Sales Invoice"):
	"""Fetch a single invoice with remaining returnable item quantities.

	Accounts for past returns to show only what can still be returned.
	"""
	doc = get_pos_invoice(doctype, invoice_name)

	return_invoices = frappe.get_all(
		doctype,
		filters={
			"return_against": invoice_name,
			"docstatus": 1,
			"is_return": 1,
		},
		pluck="name",
	)

	returned_qty_map = {}
	for ret_name in return_invoices:
		ret_doc = frappe.get_doc(doctype, ret_name)
		for item in ret_doc.items:
			key = (item.item_code, getattr(item, "batch_no", None) or "")
			returned_qty_map[key] = returned_qty_map.get(key, 0) + abs(item.qty)

	items = []
	is_fully_returned = True
	for item in doc.items:
		key = (item.item_code, getattr(item, "batch_no", None) or "")
		already_returned = returned_qty_map.get(key, 0)
		remaining_qty = flt(item.qty) - already_returned

		if remaining_qty > 0:
			is_fully_returned = False

		items.append(
			{
				"item_code": item.item_code,
				"item_name": item.item_name,
				"qty": item.qty,
				"rate": item.rate,
				"amount": item.amount,
				"uom": item.uom,
				"serial_no": getattr(item, "serial_no", None),
				"batch_no": getattr(item, "batch_no", None),
				"already_returned_qty": already_returned,
				"remaining_returnable_qty": max(remaining_qty, 0),
				"gift_card": item.get("xpos_gift_card"),
			}
		)

	return_expired = False
	if pos_profile:
		pos = frappe.get_cached_doc("POS Profile", pos_profile)
		if cint(pos.get("enable_return_validity")):
			validity_date = getattr(doc, "return_valid_upto", None)
			if validity_date and getdate(nowdate()) > getdate(validity_date):
				return_expired = True

	return {
		"name": doc.name,
		"customer": doc.customer,
		"customer_name": doc.customer_name,
		"posting_date": str(doc.posting_date),
		"grand_total": doc.grand_total,
		"currency": doc.currency,
		"items": items,
		"is_fully_returned": is_fully_returned,
		"return_expired": return_expired,
		"payments": [
			{"mode_of_payment": p.mode_of_payment, "amount": p.amount, "gift_card": p.get("xpos_gift_card")}
			for p in doc.payments
		],
		"gift_card_refunds": refunds_available(doctype, doc.name),
	}


@frappe.whitelist()
def fetch_exchange_rate(from_currency: str, to_currency: str):
	"""Returns exchange rate between two currencies."""
	from erpnext.setup.utils import get_exchange_rate

	rate = get_exchange_rate(from_currency, to_currency, nowdate())
	return {
		"exchange_rate": flt(rate),
		"date": nowdate(),
	}


@frappe.whitelist()
def get_last_invoice_rates(customer: str, item_codes: str | list, company: str):
	"""Get the most recent invoice rates for items by customer."""
	if isinstance(item_codes, str):
		item_codes = json.loads(item_codes)

	if not item_codes:
		return []

	item_params = {}
	for idx, code in enumerate(item_codes):
		item_params[f"item_{idx}"] = code
	item_placeholders = ", ".join([f"%(item_{i})s" for i in range(len(item_codes))])
	results = frappe.db.sql(  # nosemgrep: frappe-sql-format-injection - item_placeholders is built from %(name)s named params, all values parameterized
		f"""
		SELECT
			sii.item_code,
			sii.rate,
			si.currency,
			sii.uom,
			si.posting_date
		FROM `tabSales Invoice Item` sii
		INNER JOIN `tabSales Invoice` si ON si.name = sii.parent
		WHERE si.customer = %(customer)s
			AND si.company = %(company)s
			AND si.docstatus = 1
			AND si.is_return = 0
			AND sii.item_code IN ({item_placeholders})
		ORDER BY si.posting_date DESC, si.creation DESC
		""",
		{"customer": customer, "company": company, **item_params},
		as_dict=True,
	)

	seen = set()
	latest = []
	for r in results:
		if r.item_code not in seen:
			seen.add(r.item_code)
			latest.append(r)

	return latest


def _build_invoice_response(invoice_doc: dict) -> dict:
	"""Build a standard invoice response dict."""
	issued = invoice_doc.flags.xpos_issued_gift_cards
	if issued is None and invoice_doc.docstatus == 1:
		issued = claim_issued_codes(invoice_doc.doctype, invoice_doc.name)
	return {
		"gift_cards": payment_summary(invoice_doc) if invoice_doc.docstatus == 1 else [],
		"issued_gift_cards": issued or [],
		"name": invoice_doc.name,
		"grand_total": invoice_doc.grand_total,
		"net_total": invoice_doc.net_total,
		"total_taxes_and_charges": invoice_doc.total_taxes_and_charges,
		"paid_amount": invoice_doc.paid_amount,
		"change_amount": invoice_doc.change_amount,
		"outstanding_amount": getattr(invoice_doc, "outstanding_amount", 0),
		"customer": invoice_doc.customer,
		"customer_name": invoice_doc.customer_name,
		"posting_date": str(invoice_doc.posting_date),
		"status": invoice_doc.status if invoice_doc.docstatus == 1 else "Draft",
		"is_return": invoice_doc.is_return,
		"items": [
			{
				"item_code": i.item_code,
				"item_name": i.item_name,
				"qty": i.qty,
				"rate": i.rate,
				"amount": i.amount,
			}
			for i in invoice_doc.items
		],
	}


def _validate_return_invoice(return_against: str, customer: str, items: str | list) -> list:
	"""Validate return invoice data against the original invoice and attach source row references."""
	doctype = "Sales Invoice"
	if not frappe.db.exists(doctype, return_against):
		doctype = "POS Invoice"
		if not frappe.db.exists(doctype, return_against):
			frappe.throw(_("Original invoice {0} not found").format(return_against))

	original = frappe.get_doc(doctype, return_against)

	if original.customer != customer:
		frappe.throw(
			_("Customer mismatch: Return must be for the same customer ({0}) as the original invoice").format(
				original.customer_name or original.customer
			)
		)

	original_items_by_code = defaultdict(list)
	for original_item in original.items:
		original_items_by_code[original_item.item_code].append(original_item)

	link_field = "sales_invoice_item" if doctype == "Sales Invoice" else "pos_invoice_item"
	child_doctype = "Sales Invoice Item" if doctype == "Sales Invoice" else "POS Invoice Item"
	# nosemgrep: frappe-sql-format-injection - doctype/child_doctype/link_field from hardcoded allowlist, values parameterized
	query = f"""
        SELECT {link_field} AS row_name, COALESCE(SUM(ABS(qty)), 0) AS returned_qty
        FROM `tab{child_doctype}`
        WHERE parent IN (
            SELECT name FROM `tab{doctype}` WHERE return_against = %(return_against)s AND docstatus = 1
        )
            AND IFNULL({link_field}, '') != ''
        GROUP BY {link_field}
        """

	returned_rows = frappe.db.sql(
		query,
		{"return_against": return_against},
		as_dict=True,
	)
	returned_qty_by_row = {row.row_name: flt(row.returned_qty) for row in returned_rows if row.row_name}
	allocated_qty_by_row = defaultdict(float)
	prepared_items = []

	for item in items:
		item_code = item.get("item_code")
		return_qty = abs(flt(item.get("qty", 0)))

		if item_code not in original_items_by_code:
			frappe.throw(_("Item {0} was not in the original invoice {1}").format(item_code, return_against))

		remaining_to_allocate = return_qty
		total_original_qty = sum(flt(source_item.qty) for source_item in original_items_by_code[item_code])
		total_returned = sum(
			returned_qty_by_row.get(source_item.name, 0) for source_item in original_items_by_code[item_code]
		)

		for source_item in original_items_by_code[item_code]:
			already_returned = returned_qty_by_row.get(source_item.name, 0)
			already_allocated = allocated_qty_by_row.get(source_item.name, 0)
			remaining_on_row = flt(source_item.qty) - already_returned - already_allocated

			if remaining_on_row <= 0:
				continue

			allocated_qty = min(remaining_to_allocate, remaining_on_row)
			prepared_item = dict(item)
			prepared_item["qty"] = -allocated_qty
			prepared_item[link_field] = source_item.name
			prepared_item["sales_order"] = source_item.get("sales_order")
			prepared_item["delivery_note"] = source_item.get("delivery_note")
			prepared_item["so_detail"] = source_item.get("so_detail")
			prepared_item["dn_detail"] = source_item.get("dn_detail")
			prepared_item["expense_account"] = source_item.get("expense_account")
			prepared_item["source_warehouse"] = source_item.get("warehouse")
			if doctype == "Sales Invoice":
				prepared_item["pos_invoice"] = source_item.get("pos_invoice")
				prepared_item["pos_invoice_item"] = source_item.get("pos_invoice_item")

			prepared_items.append(prepared_item)
			allocated_qty_by_row[source_item.name] += allocated_qty
			remaining_to_allocate -= allocated_qty

			if remaining_to_allocate <= 0:
				break

		remaining_returnable = total_original_qty - total_returned
		if remaining_to_allocate > 0:
			frappe.throw(
				_(
					"Item {0}: Cannot return {1} units. Only {2} units remaining for return "
					"(Original: {3}, Already returned: {4})"
				).format(
					item_code,
					return_qty,
					remaining_returnable,
					total_original_qty,
					total_returned,
				)
			)

	return prepared_items


@frappe.whitelist()
def search_invoices_for_repeat(
	company: str,
	search_term: str = "",
	customer: str = "",
	from_date: str = "",
	to_date: str = "",
	pos_profile: str = "",
	page: int = 1,
	doctype: str = "Sales Invoice",
):
	"""Search submitted invoices to repeat/duplicate.

	Returns a paginated list of submitted invoices matching the filters.
	"""
	page = max(cint(page), 1)
	page_length = 20
	start = (page - 1) * page_length

	filters = {
		"company": company,
		"docstatus": 1,
		"is_return": 0,
	}

	if search_term:
		filters["name"] = ["like", f"%{search_term}%"]
	if customer:
		filters["customer"] = ["like", f"%{customer}%"]
	if from_date and to_date:
		filters["posting_date"] = ["between", [from_date, to_date]]
	elif from_date:
		filters["posting_date"] = [">=", from_date]
	elif to_date:
		filters["posting_date"] = ["<=", to_date]

	invoices = frappe.get_list(
		doctype,
		filters=filters,
		fields=[
			"name",
			"customer",
			"customer_name",
			"posting_date",
			"grand_total",
			"currency",
			"total_qty",
		],
		limit_start=start,
		limit_page_length=page_length + 1,
		order_by="posting_date desc, name desc",
	)

	has_more = len(invoices) > page_length
	if has_more:
		invoices = invoices[:page_length]

	return {"invoices": invoices, "has_more": has_more}


@frappe.whitelist()
def get_invoice_for_repeat(invoice_name: str, pos_profile: str = "", doctype: str = "Sales Invoice"):
	"""Fetch invoice details for repeating/duplicating into a new cart.

	Returns item details with current stock prices so the repeated
	invoice uses up-to-date pricing.
	"""
	ensure_invoice_doctype(doctype)
	if not frappe.db.exists(doctype, invoice_name):
		alt = "POS Invoice" if doctype == "Sales Invoice" else "Sales Invoice"
		if frappe.db.exists(alt, invoice_name):
			doctype = alt
		else:
			frappe.throw(_("Invoice {0} not found").format(invoice_name))

	doc = get_pos_invoice(doctype, invoice_name)

	price_list = None
	if pos_profile:
		price_list = frappe.db.get_value("POS Profile", pos_profile, "selling_price_list")

	items = []
	for item in doc.items:
		if getattr(item, "is_offer", False):
			continue

		item_data = {
			"item_code": item.item_code,
			"item_name": item.item_name,
			"qty": abs(item.qty),
			"rate": item.rate,
			"uom": item.uom,
			"stock_uom": item.stock_uom or item.uom,
			"discount_percentage": flt(item.discount_percentage),
			"discount_amount": flt(item.discount_amount),
			"serial_no": getattr(item, "serial_no", None),
			"batch_no": getattr(item, "batch_no", None),
		}

		if price_list:
			current_rate = frappe.db.get_value(
				"Item Price",
				{"item_code": item.item_code, "price_list": price_list, "selling": 1},
				"price_list_rate",
			)
			if current_rate is not None:
				item_data["rate"] = flt(current_rate)
				item_data["discount_percentage"] = 0
				item_data["discount_amount"] = 0

		items.append(item_data)

	return {
		"name": doc.name,
		"customer": doc.customer,
		"customer_name": doc.customer_name,
		"posting_date": str(doc.posting_date),
		"grand_total": doc.grand_total,
		"currency": doc.currency,
		"items": items,
	}
