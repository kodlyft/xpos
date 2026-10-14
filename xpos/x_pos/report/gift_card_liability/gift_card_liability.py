# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""What the store owes on gift cards, card by card, reconciled to the liability account."""

import frappe
from frappe import _
from frappe.query_builder.functions import Coalesce, Sum
from frappe.utils import flt, getdate

from xpos.x_pos.gift_cards import get_company_setting, mask_code

MOVEMENTS = ("Issue", "Redeem", "Refund", "Void", "Adjustment")


def execute(filters=None):
	filters = frappe._dict(filters or {})
	if not filters.company:
		frappe.throw(_("Company is required"))
	filters.to_date = getdate(filters.to_date)
	filters.from_date = getdate(filters.from_date) if filters.from_date else None
	currency = frappe.get_cached_value("Company", filters.company, "default_currency")

	data = get_rows(filters, currency)
	return get_columns(), data, None, None, get_summary(filters, data, currency)


def get_columns():
	money = {"fieldtype": "Currency", "options": "currency", "width": 120}
	return [
		{
			"fieldname": "gift_card",
			"label": _("Gift Card"),
			"fieldtype": "Link",
			"options": "Gift Card",
			"width": 110,
		},
		{"fieldname": "code", "label": _("Code"), "fieldtype": "Data", "width": 110},
		{"fieldname": "status", "label": _("Status"), "fieldtype": "Data", "width": 90},
		{"fieldname": "opening", "label": _("Opening"), **money},
		*({"fieldname": m.lower(), "label": _(m), **money} for m in MOVEMENTS),
		{"fieldname": "outstanding", "label": _("Outstanding"), **money},
		{
			"fieldname": "currency",
			"label": _("Currency"),
			"fieldtype": "Link",
			"options": "Currency",
			"hidden": 1,
		},
	]


def get_rows(filters, currency):
	txn = frappe.qb.DocType("Gift Card Transaction")
	query = (
		frappe.qb.from_(txn)
		.select(txn.gift_card, txn.transaction_type, txn.posting_date, txn.amount)
		.where((txn.company == filters.company) & (txn.posting_date <= filters.to_date))
	)
	if filters.gift_card:
		query = query.where(txn.gift_card == filters.gift_card)

	cards = {}
	for row in query.run(as_dict=True):
		card = cards.setdefault(row.gift_card, {m.lower(): 0.0 for m in ("opening", *MOVEMENTS)})
		if filters.from_date and getdate(row.posting_date) < filters.from_date:
			card["opening"] += flt(row.amount)
		else:
			card[row.transaction_type.lower()] += flt(row.amount)

	details = (
		{
			d.name: d
			for d in frappe.get_all(
				"Gift Card",
				filters={"name": ("in", list(cards))},
				fields=["name", "code_last4", "status", "balance"],
			)
		}
		if cards
		else {}
	)

	data = []
	for name in sorted(cards):
		card = cards[name]
		outstanding = sum(card.values())
		data.append(
			{
				"gift_card": name,
				"code": mask_code(details[name].code_last4),
				"status": details[name].status,
				**card,
				"outstanding": outstanding,
				"currency": currency,
			}
		)
	return data


def get_summary(filters, data, currency):
	ledger = sum(flt(row["outstanding"]) for row in data)
	setting = get_company_setting(filters.company)
	gl_balance = 0.0
	if setting and not filters.gift_card:
		gle = frappe.qb.DocType("GL Entry")
		gl_balance = flt(
			frappe.qb.from_(gle)
			.select(Coalesce(Sum(gle.credit - gle.debit), 0))
			.where(
				(gle.company == filters.company)
				& (gle.account == setting.liability_account)
				& (gle.is_cancelled == 0)
				& (gle.posting_date <= filters.to_date)
			)
			.run()[0][0]
		)

	# POS Invoices reach the GL only when the shift is consolidated
	txn = frappe.qb.DocType("Gift Card Transaction")
	pos = frappe.qb.DocType("POS Invoice")
	pending = flt(
		frappe.qb.from_(txn)
		.join(pos)
		.on(pos.name == txn.voucher_no)
		.select(Coalesce(Sum(txn.amount), 0))
		.where(
			(txn.voucher_type == "POS Invoice")
			& (txn.company == filters.company)
			& (txn.posting_date <= filters.to_date)
			& (Coalesce(pos.consolidated_invoice, "") == "")
		)
		.run()[0][0]
	)

	mismatched = frappe.db.sql(
		"""select count(*) from `tabGift Card` card
		where card.company=%s and abs(card.balance - (
			select coalesce(sum(t.amount), 0) from `tabGift Card Transaction` t where t.gift_card = card.name
		)) > 0.0001""",
		filters.company,
	)[0][0]

	difference = flt(ledger - pending - gl_balance, 6)
	money = {"datatype": "Currency", "currency": currency}
	summary = [
		{"label": _("Ledger outstanding"), "value": ledger, **money},
		{"label": _("Pending shift consolidation"), "value": pending, **money},
		{"label": _("GL balance"), "value": gl_balance, **money},
		{
			"label": _("Difference"),
			"value": difference,
			"indicator": "Green" if not difference else "Red",
			**money,
		},
		{
			"label": _("Cards out of step with their ledger"),
			"value": mismatched,
			"datatype": "Int",
			"indicator": "Green" if not mismatched else "Red",
		},
	]
	if filters.gift_card:
		# a single card cannot be matched against the whole account
		summary = summary[:1]
	return summary
