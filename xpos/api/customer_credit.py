# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""Spending a customer's existing credit at the till (``use_customer_credit``).

Credit is money the customer already has with the company: unallocated
receipts (Payment Entry) and return credit notes still owed back. It is not
the same as selling on account (``allow_credit_sale``), and a customer's net
balance is never treated as spendable.

Allocation goes through ERPNext's own reconciliation, as the Payment
Reconciliation tool does: Payment Entries are linked to the new invoice with
``reconcile_against_document`` and credit notes with ``reconcile_dr_cr_note``.
It always needs a connection: sources are locked and re-read at submission.
"""

import frappe
from frappe import _
from frappe.utils import flt

from xpos.api.customers import require_customer_access
from xpos.api.profile_rules import profile_flag
from xpos.api.profiles import ensure_profile_allows, resolve_pos_profile
from xpos.api.utilities import get_invoice_type

PAYMENT_ENTRY = "Payment Entry"
CREDIT_NOTE = "Sales Invoice"


def invoice_receivable_account(pos) -> str | None:
	"""The receivable account XPOS invoices post to (same rule as create_invoice)."""
	return pos.get("debit_to") or frappe.get_cached_value(
		"Company", pos.company, "default_receivable_account"
	)


def credit_account_supported(company: str, account: str | None) -> bool:
	"""Only company-currency receivable accounts: no exchange gain/loss at the till."""
	if not account:
		return False
	return frappe.get_cached_value("Account", account, "account_currency") == frappe.get_cached_value(
		"Company", company, "default_currency"
	)


def list_credit_sources(customer: str, company: str, account: str) -> list[dict]:
	"""Eligible credit, oldest first, scoped to customer, company and receivable account."""
	receipts = frappe.get_all(
		PAYMENT_ENTRY,
		filters={
			"docstatus": 1,
			"payment_type": "Receive",
			"party_type": "Customer",
			"party": customer,
			"company": company,
			"paid_from": account,
			"unallocated_amount": (">", 0),
		},
		fields=["name", "posting_date", "unallocated_amount"],
		order_by="posting_date asc, creation asc",
	)
	credit_notes = frappe.get_all(
		CREDIT_NOTE,
		filters={
			"docstatus": 1,
			"is_return": 1,
			"customer": customer,
			"company": company,
			"debit_to": account,
			"outstanding_amount": ("<", 0),
		},
		fields=["name", "posting_date", "outstanding_amount"],
		order_by="posting_date asc, creation asc",
	)
	rows = [
		{
			"source_type": PAYMENT_ENTRY,
			"source_name": r.name,
			"posting_date": r.posting_date,
			"available": flt(r.unallocated_amount),
		}
		for r in receipts
	]
	rows += [
		{
			"source_type": CREDIT_NOTE,
			"source_name": r.name,
			"posting_date": r.posting_date,
			"available": abs(flt(r.outstanding_amount)),
		}
		for r in credit_notes
	]
	return rows


@frappe.whitelist()
def get_customer_credit(customer: str, pos_profile: str | None = None, company: str | None = None) -> dict:
	"""Spendable credit for ``customer`` through the caller's POS Profile.

	``company`` is accepted for older callers but ignored: the profile decides.
	"""
	pos = resolve_pos_profile(pos_profile)
	empty = {"total_credit": 0, "currency": None, "sources": []}
	if not customer or not profile_flag(pos, "use_customer_credit"):
		return empty
	require_customer_access(customer, pos_profile=pos.name)
	account = invoice_receivable_account(pos)
	if not credit_account_supported(pos.company, account):
		return empty
	sources = list_credit_sources(customer, pos.company, account)
	return {
		"total_credit": flt(sum(r["available"] for r in sources), 2),
		"currency": frappe.get_cached_value("Account", account, "account_currency"),
		"sources": sources,
	}


def lock_credit_sources(pos, customer: str, account: str, requested: list[dict]) -> list[dict]:
	"""Lock each requested source row and check the amount is still available.

	The row locks are held until the request commits, so two tills cannot spend
	the same credit: the second waits, then sees the reduced balance.
	"""
	ensure_profile_allows(pos, "use_customer_credit", _("Customer credit"))

	if not frappe.db.transaction_writes:
		frappe.db.rollback()  # nothing written yet; only ends the read-only snapshot
	frappe.db.get_value("Customer", customer, "name", for_update=True)

	if get_invoice_type() != "Sales Invoice":
		frappe.throw(_("Customer credit can only be used when XPOS creates Sales Invoices."))
	if not credit_account_supported(pos.company, account):
		frappe.throw(_("Customer credit is only supported on receivable accounts in the company currency."))

	merged: dict[tuple[str, str], float] = {}
	for row in requested:
		key = (row.get("source_type"), row.get("source_name"))
		if key[0] not in (PAYMENT_ENTRY, CREDIT_NOTE) or not key[1]:
			frappe.throw(_("Invalid customer credit source."))
		merged[key] = merged.get(key, 0) + flt(row.get("amount"), 2)

	locked = []
	for (source_type, source_name), amount in sorted(merged.items()):
		if amount <= 0:
			frappe.throw(_("Customer credit amounts must be positive."))
		if source_type == PAYMENT_ENTRY:
			row = frappe.db.sql(
				"""SELECT docstatus, payment_type, party_type, party, company, paid_from, unallocated_amount
				FROM `tabPayment Entry` WHERE name = %s FOR UPDATE""",
				source_name,
				as_dict=True,
			)
			row = row[0] if row else None
			valid = bool(
				row
				and row.docstatus == 1
				and row.payment_type == "Receive"
				and row.party_type == "Customer"
				and row.party == customer
				and row.company == pos.company
				and row.paid_from == account
			)
			available = flt(row.unallocated_amount) if valid else 0
		else:
			row = frappe.db.sql(
				"""SELECT docstatus, is_return, customer, company, debit_to, outstanding_amount
				FROM `tabSales Invoice` WHERE name = %s FOR UPDATE""",
				source_name,
				as_dict=True,
			)
			row = row[0] if row else None
			valid = bool(
				row
				and row.docstatus == 1
				and row.is_return
				and row.customer == customer
				and row.company == pos.company
				and row.debit_to == account
				and flt(row.outstanding_amount) < 0
			)
			available = abs(flt(row.outstanding_amount)) if valid else 0
		if not valid:
			frappe.throw(
				_("{0} {1} is not available as credit for this customer.").format(source_type, source_name)
			)
		if amount - available > 0.005:
			frappe.throw(
				_("Only {0} of credit is left on {1} {2}; {3} was requested.").format(
					flt(available, 2), source_type, source_name, flt(amount, 2)
				),
				title=_("Customer credit changed"),
			)
		locked.append(
			{"source_type": source_type, "source_name": source_name, "amount": amount, "available": available}
		)
	return locked


def credit_total(credits: list[dict]) -> float:
	return flt(sum(c["amount"] for c in credits), 2)


def allocate_customer_credit(invoice_doc, credits: list[dict]) -> None:
	"""Allocate locked credit to the submitted invoice through ERPNext reconciliation."""
	if not credits:
		return
	from erpnext.accounts.doctype.payment_reconciliation.payment_reconciliation import reconcile_dr_cr_note
	from erpnext.accounts.utils import reconcile_against_document

	base = {
		"against_voucher_type": invoice_doc.doctype,
		"against_voucher": invoice_doc.name,
		"account": invoice_doc.debit_to,
		"party_type": "Customer",
		"party": invoice_doc.customer,
		"dr_or_cr": "credit_in_account_currency",
		"exchange_rate": 1,
		"difference_amount": 0,
		"cost_center": invoice_doc.get("cost_center"),
		"currency": invoice_doc.party_account_currency or invoice_doc.currency,
	}
	receipts = [
		frappe._dict(
			base,
			voucher_type=PAYMENT_ENTRY,
			voucher_no=c["source_name"],
			voucher_detail_no=None,
			is_advance=0,
			unreconciled_amount=c["available"],
			unadjusted_amount=c["available"],
			allocated_amount=c["amount"],
		)
		for c in credits
		if c["source_type"] == PAYMENT_ENTRY
	]
	notes = [
		frappe._dict(
			base,
			voucher_type=CREDIT_NOTE,
			voucher_no=c["source_name"],
			unadjusted_amount=c["available"],
			allocated_amount=c["amount"],
		)
		for c in credits
		if c["source_type"] == CREDIT_NOTE
	]
	if receipts:
		reconcile_against_document(receipts)
	if notes:
		reconcile_dr_cr_note(notes, invoice_doc.company)


def lock_credit_note_spend(doc, method=None) -> None:
	"""``before_submit`` of Journal Entry and Payment Entry: a credit note cannot be spent twice.

	ERPNext checks a credit note's balance with a plain read, which can predate a till's
	committed allocation (REPEATABLE READ). Locking the note reads its latest balance and
	queues behind any till still spending it.
	"""
	spend: dict[str, float] = {}
	if doc.doctype == "Journal Entry":
		for row in doc.get("accounts") or []:
			if row.reference_type == CREDIT_NOTE and row.party_type == "Customer":
				spend[row.reference_name] = spend.get(row.reference_name, 0) + flt(
					row.debit_in_account_currency
				)
	else:
		for row in doc.get("references") or []:
			if row.reference_doctype == CREDIT_NOTE and doc.party_type == "Customer":
				spend[row.reference_name] = spend.get(row.reference_name, 0) + abs(flt(row.allocated_amount))

	# Only credit notes are locked: ordinary invoices a payment settles keep ERPNext's own locking.
	# ``is_return`` cannot change after submit, so a plain read is enough to pick them out.
	spent = [n for n, amount in spend.items() if n and amount > 0]
	if not spent:
		return
	notes = frappe.get_all(CREDIT_NOTE, filters={"name": ("in", spent), "is_return": 1}, pluck="name")
	for note in sorted(notes):
		row = frappe.db.sql(
			"""SELECT outstanding_amount FROM `tabSales Invoice`
			WHERE name = %s AND docstatus = 1 FOR UPDATE""",
			note,
			as_dict=True,
		)
		if not row:
			continue
		available = max(-flt(row[0].outstanding_amount), 0)
		if spend[note] - available > 0.005:
			frappe.throw(
				_("Credit Note {0} has only {1} left; it was spent elsewhere after you pulled it.").format(
					note, flt(available, 2)
				),
				title=_("Customer credit changed"),
			)
