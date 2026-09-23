# Copyright (c) 2026, Kodlyft and contributors
# For license information, please see license.txt

import json
from collections import defaultdict

import frappe
from frappe import _, cstr
from frappe.utils import cint, flt, getdate, now_datetime, nowdate
from frappe.utils.background_jobs import enqueue

from xpos.api.utilities import get_invoice_type, is_pos_cashier


def enforce_stock_availability(invoice_doc):
	"""
	Block the sale when it would take stock below zero.

	The cart guard in the browser is advisory only - it works off a snapshot
	that goes stale, and offline replay bypasses it entirely - so this is the
	authoritative check.  Bins are locked first so two terminals cannot both
	sell the last unit.
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
	val = frappe.db.get_default("float_precision")
	try:
		p = cint(val)
		return p if p >= 0 else 3
	except Exception:
		return 3


def _resolve_invoice_posting_date(pos, requested_posting_date=None, current_posting_date=None):
	"""Respect the POS Profile posting-date setting while validating client input."""
	if not cint(pos.get("allow_change_posting_date")):
		return nowdate()

	candidate = requested_posting_date or current_posting_date
	if not candidate:
		return nowdate()

	try:
		return str(getdate(candidate))
	except Exception:
		frappe.throw(_("Posting Date must be a valid date"))


def _detect_invoice_doctype(invoice_name: str):
	"""Detect whether an invoice name belongs to Sales Invoice or POS Invoice."""
	if frappe.db.exists("Sales Invoice", invoice_name):
		return "Sales Invoice"
	if frappe.db.exists("POS Invoice", invoice_name):
		return "POS Invoice"
	frappe.throw(_("Invoice {0} not found").format(invoice_name))


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


def _validate_unpaid_balance_permissions(invoice_doc, pos_profile_doc, data: dict):
	"""Enforce POS Profile permissions before submitting an invoice with a balance due."""
	if cint(getattr(invoice_doc, "is_return", 0)):
		return

	outstanding_amount = _get_unpaid_balance(invoice_doc)
	if outstanding_amount <= 0.009:
		return

	allow_credit_sale = cint(pos_profile_doc.get("allow_credit_sale"))
	allow_partial_payment = cint(pos_profile_doc.get("allow_partial_payment"))
	requested_credit_sale = cint(data.get("is_credit_sale"))
	settled_amount = abs(_coerce_amount(getattr(invoice_doc, "paid_amount", 0))) + abs(
		_coerce_amount(getattr(invoice_doc, "write_off_amount", 0))
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
		try:
			existing_payments = invoice_doc.get("payments")
		except Exception:
			existing_payments = None

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


def find_invoice_by_local_id(local_id: str | None, warehouse: str | None = None) -> tuple[str, str] | None:
	"""Return (doctype, name) of an invoice already created for this client local_id.

	The desktop/offline client assigns every cart a stable ``local_id`` and may
	re-push it after a dropped response. Looking it up here makes invoice creation
	idempotent so a retry returns the original invoice instead of creating a second
	real Sales Invoice (double stock depletion + double revenue).
	"""
	if not local_id:
		return None
	for dt in ("Sales Invoice", "POS Invoice"):
		name = frappe.db.get_value(
			dt, {"xpos_local_id": local_id, "set_warehouse": warehouse, "docstatus": 1}, "name"
		)
		if name:
			return dt, name
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
	existing = find_invoice_by_local_id(local_id, warehouse)
	if existing:
		dt, name = existing
		return {**_build_invoice_response(frappe.get_doc(dt, name)), "duplicate": True}

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

	pos = frappe.get_cached_doc("POS Profile", pos_profile)

	doctype = get_invoice_type()

	debit_to = None
	if hasattr(pos, "debit_to") and pos.get("debit_to"):
		debit_to = pos.debit_to
	if not debit_to:
		debit_to = frappe.db.get_value("Company", pos.company, "default_receivable_account")

	invoice_name = data.get("name")
	is_existing_draft = False

	if invoice_name and frappe.db.exists(doctype, invoice_name):
		invoice_doc = frappe.get_doc(doctype, invoice_name)
		if invoice_doc.docstatus != 0:
			frappe.throw(_("Only draft invoices can be updated and submitted"))

		if invoice_doc.get("pos_awaiting_settlement") and not is_pos_cashier(
			frappe.session.user, pos_profile
		):
			frappe.throw(_("Only a cashier can settle this invoice."), frappe.PermissionError)

		is_existing_draft = True
		invoice_doc.set("items", [])
		invoice_doc.set("payments", [])
		invoice_doc.set("taxes", [])
		if hasattr(invoice_doc, "sales_team"):
			invoice_doc.set("sales_team", [])
		if hasattr(invoice_doc, "coupons"):
			invoice_doc.set("coupons", [])
		if hasattr(invoice_doc, "offers"):
			invoice_doc.set("offers", [])
	else:
		invoice_doc = frappe.new_doc(doctype)

	invoice_doc.is_pos = 1
	if local_id:
		invoice_doc.xpos_local_id = local_id
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
	invoice_doc.update_stock = cint(pos.get("update_stock")) or 1
	invoice_doc.currency = (
		data.get("currency")
		or pos.currency
		or frappe.db.get_value("Company", pos.company, "default_currency")
	)
	invoice_doc.selling_price_list = data.get("selling_price_list") or pos.get("selling_price_list")

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
	invoice_doc.pos_delivery_date = data.get("pos_delivery_date", None) or None
	if data.get("sales_person", None):
		invoice_doc.append(
			"sales_team",
			{
				"sales_person": data["sales_person"],
				"allocated_percentage": 100,
			},
		)

	_apply_invoice_loyalty_fields(invoice_doc, data)

	if data.get("write_off_amount"):
		invoice_doc.write_off_amount = flt(data["write_off_amount"])
		invoice_doc.write_off_account = data.get("write_off_account") or pos.get("write_off_account")
		invoice_doc.write_off_cost_center = data.get("write_off_cost_center") or pos.get(
			"write_off_cost_center"
		)

	rate_precision = _get_item_rate_precision()

	from xpos.api.auth import user_has_pos_permission

	allow_rate_change = user_has_pos_permission("allow_change_price", pos_profile=pos.name)

	for item_data in items:
		item_rate = flt(item_data.get("rate", 0), rate_precision)
		item_qty = flt(item_data.get("qty", 1), 3)

		if not allow_rate_change:
			price_list = pos.get("selling_price_list")
			if price_list:
				price_list_rate = frappe.db.get_value(
					"Item Price",
					{
						"item_code": item_data.get("item_code"),
						"price_list": price_list,
						"selling": 1,
						"uom": item_data.get("uom") or item_data.get("stock_uom"),
					},
					"price_list_rate",
				)
				if price_list_rate is not None and flt(price_list_rate, rate_precision) != item_rate:
					item_rate = flt(price_list_rate, rate_precision)

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
					try:
						setattr(item, fieldname, item_data.get(fieldname))
					except Exception:
						pass

		disc_pct = flt(item_data.get("discount_percentage", 0), 2)
		disc_amt = flt(item_data.get("discount_amount", 0), 2)

		max_discount = flt(pos.get("max_discount_percentage_allowed", 0))
		if max_discount > 0 and disc_pct > max_discount:
			frappe.throw(
				_("Item {0}: Discount {1}% exceeds maximum allowed {2}%").format(
					item_data.get("item_code"), disc_pct, max_discount
				)
			)

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
			item.serial_no = item_data.get("serial_no")
		if item_data.get("batch_no"):
			item.batch_no = item_data.get("batch_no")
		if item_data.get("item_tax_template"):
			item.item_tax_template = item_data.get("item_tax_template")

		if item_data.get("additional_notes"):
			try:
				item.additional_notes = item_data["additional_notes"]
			except Exception:
				pass
		if item_data.get("delivery_date"):
			try:
				item.delivery_date = item_data["delivery_date"]
			except Exception:
				pass

	existing_account_heads = set()
	if pos.taxes_and_charges:
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

	total_payment = 0
	for payment in payments:
		pay_amount = flt(payment.get("amount", 0), 2)
		if pay_amount != 0:
			invoice_doc.append(
				"payments",
				{
					"mode_of_payment": payment.get("mode_of_payment"),
					"amount": pay_amount,
					"account": payment.get("account"),
					"type": payment.get("type"),
				},
			)
			total_payment += pay_amount

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
		invoice_doc.paid_amount = flt(total_payment + loyalty_paid, 2)
		invoice_doc.base_paid_amount = flt(invoice_doc.paid_amount * flt(invoice_doc.conversion_rate or 1), 2)

	change_amount = flt(data.get("change_amount", 0))
	if change_amount > 0:
		invoice_doc.change_amount = change_amount

	if pos_opening_shift:
		try:
			invoice_doc.pos_opening_shift = pos_opening_shift
		except Exception:
			pass

	pos_coupons_data = data.get("coupons_detail") or []
	for coupon_row in pos_coupons_data:
		try:
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
		except Exception:
			pass

	pos_offers_data = data.get("offers_detail") or []
	for offer_row in pos_offers_data:
		try:
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
		except Exception:
			pass

	try:
		enforce_return_validity = cint(pos.get("enable_return_validity"))
		if enforce_return_validity and not is_return:
			return_days = cint(pos.get("return_validity_days")) or 0
			if return_days > 0:
				from datetime import timedelta

				invoice_doc.return_valid_upto = getdate(nowdate()) + timedelta(days=return_days)
	except Exception:
		pass

	try:
		if is_existing_draft:
			invoice_doc.save(ignore_permissions=True)
		else:
			invoice_doc.insert(ignore_permissions=True)
	except frappe.exceptions.UniqueValidationError:
		frappe.db.rollback()
		existing = find_invoice_by_local_id(local_id, warehouse)
		if existing:
			dt, name = existing
			return {**_build_invoice_response(frappe.get_doc(dt, name)), "duplicate": True}
		raise

	enforce_stock_availability(invoice_doc)

	_validate_unpaid_balance_permissions(invoice_doc, pos, data)

	from xpos.x_pos.integrations import fbr

	client_fbr_number = cstr(data.get("fbr_invoice_number") or "").strip()
	if client_fbr_number:
		fbr.apply_fiscal_number(invoice_doc, client_fbr_number)
		invoice_doc.save(ignore_permissions=True)
	else:
		outcome = fbr.prepare_fiscalization(invoice_doc)
		if outcome.status == "local_required":
			return {
				"status": "fbr_local_required",
				"name": invoice_doc.name,
				"doctype": doctype,
				"fbr_payload": outcome.payload,
				"fbr_local_service_url": outcome.local_service_url,
				"grand_total": invoice_doc.grand_total,
				"customer": invoice_doc.customer,
				"customer_name": invoice_doc.customer_name,
			}
		if outcome.status == "cloud":
			fbr.apply_fiscal_number(invoice_doc, outcome.fbr_invoice_number, outcome.posted_on)
			invoice_doc.save(ignore_permissions=True)

	if submit_in_background:
		enqueue(
			submit_invoice_job,
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

	return _build_invoice_response(invoice_doc)


def submit_invoice_job(invoice_name: str, doctype: str = "Sales Invoice"):
	"""Background job to submit an invoice."""
	user = frappe.session.user
	try:
		doc = frappe.get_doc(doctype, invoice_name)
		enforce_stock_availability(doc)
		doc.submit()
		frappe.db.commit()
	except Exception as e:
		frappe.db.rollback()
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

	invoice_doc = frappe.get_doc(doctype, name)
	if invoice_doc.docstatus != 0:
		return _build_invoice_response(invoice_doc)

	if invoice_doc.get("pos_profile") and not is_pos_cashier(frappe.session.user, invoice_doc.pos_profile):
		frappe.throw(_("Only a cashier can finalize this invoice."), frappe.PermissionError)

	fbr.apply_fiscal_number(invoice_doc, fbr_invoice_number)
	invoice_doc.save(ignore_permissions=True)
	invoice_doc.submit()
	return _build_invoice_response(invoice_doc)


@frappe.whitelist()
def discard_draft_invoice(name: str, doctype: str | None = None) -> dict:
	"""Delete a draft invoice left pending when fiscalization could not complete.

	Used when both the FBR cloud and the local service are unreachable, so the sale
	could not be finalized and the draft should not linger.
	"""
	doctype = doctype or get_invoice_type()
	if not frappe.db.exists(doctype, name):
		return {"deleted": False}

	invoice_doc = frappe.get_doc(doctype, name)
	if invoice_doc.docstatus != 0:
		frappe.throw(_("Only a draft invoice can be discarded."))
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

	pos = frappe.get_cached_doc("POS Profile", pos_profile)

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
	invoice_doc.update_stock = cint(pos.get("update_stock")) or 1
	invoice_doc.currency = (
		data.get("currency")
		or pos.currency
		or frappe.db.get_value("Company", pos.company, "default_currency")
	)
	invoice_doc.selling_price_list = data.get("selling_price_list") or pos.get("selling_price_list")

	if data.get("additional_discount_percentage"):
		invoice_doc.additional_discount_percentage = flt(data["additional_discount_percentage"])
		invoice_doc.apply_discount_on = data.get("apply_discount_on") or "Grand Total"
	elif data.get("discount_amount"):
		invoice_doc.discount_amount = flt(data["discount_amount"])
		invoice_doc.apply_discount_on = data.get("apply_discount_on") or "Grand Total"

	try:
		invoice_doc.pos_notes = data.get("pos_notes") or ""
	except Exception:
		pass

	for item_data in items:
		item = invoice_doc.append("items", {})
		item.item_code = item_data.get("item_code")
		item.item_name = item_data.get("item_name")
		item.qty = flt(item_data.get("qty", 1))
		item.rate = flt(item_data.get("rate", 0))
		item.uom = item_data.get("uom") or item_data.get("stock_uom")
		item.warehouse = item_data.get("warehouse") or pos.warehouse
		if item_data.get("discount_percentage"):
			item.discount_percentage = flt(item_data["discount_percentage"])
		if item_data.get("discount_amount"):
			item.discount_amount = flt(item_data["discount_amount"])
		if item_data.get("serial_no"):
			item.serial_no = item_data["serial_no"]
		if item_data.get("batch_no"):
			item.batch_no = item_data["batch_no"]

	if pos.taxes_and_charges:
		invoice_doc.taxes_and_charges = pos.taxes_and_charges

	payments = data.get("payments", [])
	if payments:
		invoice_doc.set("payments", [])
		for payment in payments:
			pay_amount = flt(payment.get("amount", 0), 2)
			invoice_doc.append(
				"payments",
				{
					"mode_of_payment": payment.get("mode_of_payment"),
					"amount": pay_amount,
					"account": payment.get("account"),
					"type": payment.get("type"),
				},
			)

	_ensure_pos_invoice_payment_row(invoice_doc, pos, doctype == "POS Invoice")

	if pos_opening_shift:
		try:
			invoice_doc.pos_opening_shift = pos_opening_shift
		except Exception:
			pass

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
def get_draft_invoices(pos_opening_shift: str):
	"""Get draft invoices for the current shift."""
	filters = {"docstatus": 0, "is_pos": 1}

	if pos_opening_shift:
		filters["pos_opening_shift"] = pos_opening_shift

	doctype = get_invoice_type()

	invoices = frappe.get_list(
		doctype,
		filters=filters,
		fields=[
			"name",
			"customer",
			"customer_name",
			"posting_date",
			"grand_total",
			"total_qty",
			"currency",
			"creation",
			"modified",
		],
		limit_page_length=50,
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
	doc = frappe.get_doc(doctype, invoice_name)

	return {
		"name": doc.name,
		"customer": doc.customer,
		"customer_name": doc.customer_name,
		"posting_date": str(doc.posting_date),
		"posting_time": str(doc.posting_time),
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
				"amount": i.amount,
				"uom": i.uom,
				"discount_percentage": i.discount_percentage,
				"discount_amount": i.discount_amount,
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
def delete_draft_invoice(name: str, doctype: str = ""):
	"""Delete a draft invoice."""
	if not doctype:
		doctype = _detect_invoice_doctype(name)
	doc = frappe.get_doc(doctype, name)
	if doc.docstatus != 0:
		frappe.throw(_("Only draft invoices can be deleted"))
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
	# nosemgrep: frappe-sql-format-injection — table/column from validated doctype allowlist, all values parameterized
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
	doc = frappe.get_doc(doctype, invoice_name)

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
		"payments": [{"mode_of_payment": p.mode_of_payment, "amount": p.amount} for p in doc.payments],
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
	results = frappe.db.sql(  # nosemgrep: frappe-sql-format-injection — item_placeholders is built from %(name)s named params, all values parameterized
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
	return {
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
	# nosemgrep: frappe-sql-format-injection — doctype/child_doctype/link_field from hardcoded allowlist, values parameterized
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
	if not frappe.db.exists(doctype, invoice_name):
		alt = "POS Invoice" if doctype == "Sales Invoice" else "Sales Invoice"
		if frappe.db.exists(alt, invoice_name):
			doctype = alt
		else:
			frappe.throw(_("Invoice {0} not found").format(invoice_name))

	doc = frappe.get_doc(doctype, invoice_name)

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
