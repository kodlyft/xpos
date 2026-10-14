# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""Gift card endpoints for the POS. Card codes never leave the server except once, to the
cashier who sold the card."""

import frappe
from frappe import _
from frappe.rate_limiter import rate_limit
from frappe.utils import cint, flt, getdate

from xpos.x_pos.gift_cards import (
	add_transaction,
	card_rejection,
	claim_issued_codes,
	find_card_by_code,
	get_company_setting,
	issue_auth_token,
	lock_card,
	mask_code,
	require_gift_card_access,
)

MAX_FAILED_LOOKUPS = 10
LOCKOUT_SECONDS = 10 * 60


def failed_lookup_key(user: str) -> str:
	return f"xpos_gc_failed:{user}"


@frappe.whitelist(methods=["POST"])
@rate_limit(limit=30, seconds=60)
def check_gift_card(code: str, pos_profile: str) -> dict:
	"""Balance of a gift card, plus a short-lived token that lets this cashier tender it."""
	require_gift_card_access("redeem_gift_card", pos_profile)
	user = frappe.session.user
	key = failed_lookup_key(user)
	failures = cint(frappe.cache.get_value(key))
	if failures >= MAX_FAILED_LOOKUPS:
		frappe.throw(
			_("Too many unknown gift cards. Try again in a few minutes."), frappe.RateLimitExceededError
		)

	profile = frappe.get_cached_doc("POS Profile", pos_profile)
	currency = frappe.get_cached_value("Company", profile.company, "default_currency")
	card = find_card_by_code(code)
	rejection = card_rejection(card, profile.company, currency, getdate())
	if rejection:
		if not card:
			frappe.cache.set_value(key, failures + 1, expires_in_sec=LOCKOUT_SECONDS)
		frappe.throw(rejection)

	return {
		"gift_card": card.name,
		"masked_code": mask_code(card.code_last4),
		"balance": flt(card.balance),
		"currency": card.currency,
		"valid_upto": card.valid_upto,
		"mode_of_payment": get_company_setting(profile.company).mode_of_payment,
		"auth": issue_auth_token(card.name, user, pos_profile),
	}


@frappe.whitelist(methods=["POST"])
def claim_issued_gift_cards(invoice: str, doctype: str = "Sales Invoice") -> list:
	"""Codes of the cards sold on ``invoice``, for the cashier who sold them, once."""
	if doctype not in ("Sales Invoice", "POS Invoice"):
		frappe.throw(_("Invalid invoice type."))
	return claim_issued_codes(doctype, invoice)


@frappe.whitelist(methods=["POST"])
def adjust_gift_card(gift_card: str, journal_entry: str, remarks: str = "") -> dict:
	"""Move a card's balance by the amount a submitted Journal Entry moved its liability.

	The Journal Entry is the accounting record; this only keeps the card ledger in step,
	so the liability report still reconciles to the GL.
	"""
	frappe.only_for(["Accounts Manager", "System Manager"])
	card = lock_card(gift_card)
	setting = get_company_setting(card.company)
	je = frappe.db.get_value(
		"Journal Entry", journal_entry, ["docstatus", "company", "posting_date"], as_dict=True
	)
	if not setting or not je or je.docstatus != 1 or je.company != card.company:
		frappe.throw(_("Choose a submitted Journal Entry of {0}.").format(card.company))
	if card.status == "Voided":
		frappe.throw(_("A voided gift card cannot be adjusted."))
	rows = frappe.get_all(
		"Journal Entry Account",
		filters={"parent": journal_entry, "account": setting.liability_account},
		fields=["credit", "debit"],
	)
	amount = sum(flt(r.credit) - flt(r.debit) for r in rows)
	if not amount:
		frappe.throw(_("{0} does not post to {1}.").format(journal_entry, setting.liability_account))

	je_doc = frappe._dict(doctype="Journal Entry", name=journal_entry, posting_date=je.posting_date)
	txn = add_transaction(
		card,
		"Adjustment",
		amount,
		je_doc,
		None,
		f"adjust:Journal Entry:{journal_entry}",
		remarks=remarks or _("Adjusted by {0}").format(journal_entry),
	)
	return {"transaction": txn.name, "balance": card.balance}
