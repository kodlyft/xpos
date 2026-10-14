# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""
Normalise and validate mixed-currency cash tender and change legs.
"""

import frappe
from frappe import _
from frappe.utils import cint, flt

from xpos.api.exchange import (
	get_currency_precision,
	get_mode_tender_currencies,
	resolve_tender_rate,
)
from xpos.x_pos.gift_cards import GiftCardAuthError, gift_card_mode, live_connection_message, read_auth_token


def minor_unit(currency: str) -> float:
	"""Smallest representable amount in `currency`: 1 for LBP, 0.01 for USD."""
	return 10.0 ** -get_currency_precision(currency)


def invoice_currency_of(invoice_doc) -> str:
	"""Return the currency `invoice_doc` is denominated in."""
	currency = invoice_doc.get("currency")
	if currency:
		return currency
	company = invoice_doc.get("company")
	return frappe.get_cached_value("Company", company, "default_currency") if company else ""


def build_tender_legs(payments: list[dict], invoice_doc, rate_cache: dict | None = None) -> tuple:
	"""Turn client payment rows into ``Sales Invoice Payment`` rows."""
	rate_cache = rate_cache if rate_cache is not None else {}

	invoice_currency = invoice_currency_of(invoice_doc)
	invoice_precision = get_currency_precision(invoice_currency)
	tolerance = minor_unit(invoice_currency)
	posting_date = invoice_doc.get("posting_date")

	modes = [payment.get("mode_of_payment") for payment in payments if payment.get("mode_of_payment")]
	tender_map = get_mode_tender_currencies(modes)
	gift_mode = gift_card_mode(invoice_doc.get("company"))

	rows: list[dict] = []
	total = 0.0

	for payment in payments:
		mode = payment.get("mode_of_payment")
		if not mode:
			continue

		details = tender_map.get(mode) or {}
		tender_currency = details.get("currency")
		client_amount = flt(payment.get("amount", 0))

		if gift_mode and mode == gift_mode:
			amount = flt(client_amount, invoice_precision)
			if amount:
				rows.append(gift_card_leg(payment, amount, invoice_doc))
				total += amount
			continue

		claimed = payment.get("pos_tender_currency")
		if claimed and claimed != (tender_currency or invoice_currency):
			frappe.throw(
				_("Mode of Payment {0} is set up for {1}, not {2}. Reload the POS and try again.").format(
					mode, tender_currency or invoice_currency, claimed
				)
			)

		if not tender_currency or tender_currency == invoice_currency:
			amount = flt(client_amount, invoice_precision)
			if amount == 0:
				continue
			rows.append({"mode_of_payment": mode, "amount": amount})
			total += amount
			continue

		native_precision = get_currency_precision(tender_currency)
		native = flt(payment.get("pos_tender_amount", client_amount), native_precision)
		if native == 0:
			continue

		rate, _rate_date = resolve_tender_rate(tender_currency, invoice_currency, posting_date, rate_cache)
		if not rate:
			frappe.throw(
				_(
					"No exchange rate is available for {0} to {1}. Create a Currency Exchange record "
					"for today before accepting {0}."
				).format(tender_currency, invoice_currency)
			)

		sign = -1 if native < 0 else 1
		amount = flt(abs(native) * rate, invoice_precision) * sign

		# The client does its own conversion so the cashier sees a live total. Treat it as a
		# checksum: a mismatch means the till was working from a stale rate.
		if client_amount and abs(amount - client_amount) > tolerance:
			frappe.throw(
				_(
					"{0} {1} converts to {2} {3} at today's rate of {4}, but the till sent {5} {3}. "
					"Reload the POS to pick up the current rate."
				).format(native, tender_currency, amount, invoice_currency, rate, client_amount)
			)

		rows.append(
			{
				"mode_of_payment": mode,
				"amount": amount,
				"pos_tender_currency": tender_currency,
				"pos_tender_amount": native,
				"pos_exchange_rate": rate,
			}
		)
		total += amount

	return rows, flt(total, invoice_precision)


def gift_card_leg(payment: dict, amount: float, invoice_doc) -> dict:
	"""A gift-card payment row. A sale needs the token from a live balance check; a return
	may only send money back to a card that paid the original sale."""
	mode = payment.get("mode_of_payment")
	if invoice_doc.get("is_return"):
		card = payment.get("gift_card")
		used = card and frappe.db.exists(
			"Sales Invoice Payment",
			{"parent": invoice_doc.return_against, "mode_of_payment": mode, "xpos_gift_card": card},
		)
		if not used:
			frappe.throw(_("Choose the gift card that paid {0}.").format(invoice_doc.return_against))
		return {"mode_of_payment": mode, "amount": amount, "xpos_gift_card": card}

	token = payment.get("gift_card_auth")
	auth = read_auth_token(token)
	if not auth:
		frappe.throw(live_connection_message(), GiftCardAuthError)
	return {
		"mode_of_payment": mode,
		"amount": amount,
		"xpos_gift_card": auth["gift_card"],
		"xpos_gift_card_auth": token,
	}


def build_change_legs(change_legs: list[dict], invoice_doc, rate_cache: dict | None = None) -> tuple:
	"""Turn client change rows into ``POS Change Leg`` rows."""
	rate_cache = rate_cache if rate_cache is not None else {}

	invoice_currency = invoice_currency_of(invoice_doc)
	invoice_precision = get_currency_precision(invoice_currency)
	posting_date = invoice_doc.get("posting_date")

	modes = [leg.get("mode_of_payment") for leg in change_legs if leg.get("mode_of_payment")]
	tender_map = get_mode_tender_currencies(modes)

	rows: list[dict] = []
	total_base = 0.0

	for leg in change_legs:
		mode = leg.get("mode_of_payment")
		if not mode:
			frappe.throw(_("Every change row needs a Mode of Payment."))

		details = tender_map.get(mode) or {}
		if (details.get("type") or "") != "Cash":
			frappe.throw(
				_("Change can only be given through a Cash mode of payment. {0} is of type {1}.").format(
					mode, details.get("type") or _("unset")
				)
			)

		currency = details.get("currency") or invoice_currency
		claimed = leg.get("currency")
		if claimed and claimed != currency:
			frappe.throw(
				_("Mode of Payment {0} gives change in {1}, not {2}.").format(mode, currency, claimed)
			)

		native = flt(abs(flt(leg.get("amount", 0))), get_currency_precision(currency))
		if native == 0:
			continue

		rate, _rate_date = resolve_tender_rate(currency, invoice_currency, posting_date, rate_cache)
		if not rate:
			frappe.throw(
				_("No exchange rate is available for {0} to {1}, so change cannot be given in {0}.").format(
					currency, invoice_currency
				)
			)

		base_amount = flt(native * rate, invoice_precision)
		rows.append(
			{
				"mode_of_payment": mode,
				"currency": currency,
				"amount": native,
				"base_amount": base_amount,
				"exchange_rate": rate,
			}
		)
		total_base += base_amount

	return rows, flt(total_base, invoice_precision)


def validate_tender_currency_legs(doc):
	"""Re-check tender and change legs after ERPNext has finished its own totals."""
	if cint(doc.get("is_return")) or cint(doc.get("is_consolidated")):
		return

	change_legs = doc.get("pos_change_legs") or []
	tagged_payments = [row for row in doc.get("payments") or [] if row.get("pos_tender_currency")]

	if not change_legs and not tagged_payments:
		return

	invoice_currency = invoice_currency_of(doc)
	invoice_precision = get_currency_precision(invoice_currency)
	tolerance = minor_unit(invoice_currency)

	for row in tagged_payments:
		expected = flt(abs(flt(row.pos_tender_amount)) * flt(row.pos_exchange_rate), invoice_precision)
		if abs(expected - abs(flt(row.amount))) > tolerance:
			frappe.throw(
				_("Payment row {0}: {1} {2} at {3} is {4} {5}, but the row carries {6} {5}.").format(
					row.idx,
					row.pos_tender_amount,
					row.pos_tender_currency,
					row.pos_exchange_rate,
					expected,
					invoice_currency,
					row.amount,
				)
			)

	validate_change_allocation(doc, change_legs, invoice_currency, invoice_precision, tolerance)
	validate_change_gl_safety(doc)


def validate_change_allocation(doc, change_legs, invoice_currency, invoice_precision, tolerance):
	"""The change legs must account for exactly the change ERPNext computed."""
	change_amount = flt(doc.get("change_amount"))

	if not change_legs:
		return

	allocated = flt(sum(flt(leg.base_amount) for leg in change_legs), invoice_precision)
	if abs(allocated - change_amount) > tolerance:
		frappe.throw(
			_(
				"Change of {0} {1} is due but the change rows account for {2} {1}. The difference is {3} {1}."
			).format(
				change_amount,
				invoice_currency,
				allocated,
				flt(change_amount - allocated, invoice_precision),
			)
		)


def validate_change_gl_safety(doc):
	"""Refuse to post change that ERPNext's skip path would mis-post.

	The patch enables the setting. This catches the case where it gets turned back off.
	"""
	if not flt(doc.get("change_amount")):
		return

	if cint(frappe.db.get_single_value("POS Settings", "post_change_gl_entries")):
		return

	change_account = doc.get("account_for_change_amount")
	matching = [row for row in doc.get("payments") or [] if row.get("account") == change_account]
	if len(matching) == 1:
		return

	frappe.throw(
		_(
			"This invoice gives {0} in change across {1} payment rows matching the change account, "
			"which ERPNext cannot post correctly while "
			"POS Settings > Create Ledger Entries for Change Amount is disabled. Enable that setting."
		).format(doc.get("change_amount"), len(matching))
	)
