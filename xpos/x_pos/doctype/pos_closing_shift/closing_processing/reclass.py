import frappe
from frappe import _
from frappe.utils import cint, flt

from xpos.api.exchange import get_currency_precision
from xpos.x_pos.api.cash_movement.posting import cancel_journal_entry

PER_PAYMENT = "Per Payment"


def shift_invoices(closing_doc, company_currency):
	"""Yield the shift's submitted invoices that are in the company currency."""
	for row in closing_doc.get("pos_transactions") or []:
		invoice = row.get("sales_invoice") or row.get("pos_invoice")
		doctype = "Sales Invoice" if row.get("sales_invoice") else "POS Invoice"
		if not invoice or not frappe.db.exists(doctype, invoice):
			continue

		invoice_doc = frappe.get_doc(doctype, invoice)
		# Invoice-level multi-currency is a different feature; its base figures are not ours to move.
		if (
			invoice_doc.docstatus == 1
			and (invoice_doc.get("currency") or company_currency) == company_currency
		):
			yield invoice_doc


def shift_mode_nets(closing_doc, company_currency):
	"""Return ``{mode: {"currency", "native", "base"}}``: what each mode took over the shift, less change."""
	cash_mode = frappe.db.get_value("POS Profile", closing_doc.pos_profile, "cash_mode_of_payment") or "Cash"
	nets = {}

	def add(mode, currency, native, base):
		entry = nets.setdefault(mode, {"currency": currency, "native": 0.0, "base": 0.0})
		entry["native"] += flt(native)
		entry["base"] += flt(base)

	for invoice_doc in shift_invoices(closing_doc, company_currency):
		currency = company_currency
		for payment in invoice_doc.get("payments") or []:
			tender_currency = payment.get("pos_tender_currency")
			add(
				payment.mode_of_payment,
				tender_currency or currency,
				payment.get("pos_tender_amount") if tender_currency else payment.amount,
				payment.amount,
			)

		legs = invoice_doc.get("pos_change_legs") or []
		for leg in legs:
			add(leg.mode_of_payment, leg.currency or currency, -flt(leg.amount), -flt(leg.base_amount))
		if not legs and flt(invoice_doc.get("change_amount")):
			add(cash_mode, currency, -flt(invoice_doc.change_amount), -flt(invoice_doc.change_amount))

	return nets


def build_reclass_rows(nets, accounts, company_currency, account_currency, cost_center):
	"""Return Journal Entry account rows moving each mode's net from its default to its destination account.

	`accounts` maps mode -> (default_account, destination_account); `account_currency` maps account -> currency.
	"""
	base_precision = get_currency_precision(company_currency)
	rows = []

	for mode, net in sorted(nets.items()):
		source, destination = accounts.get(mode) or (None, None)
		if not destination:
			continue
		if not source:
			frappe.throw(
				_("Mode of Payment {0} has a Destination Account but no Default Account.").format(mode)
			)
		if source == destination:
			continue

		destination_currency = account_currency.get(destination) or company_currency
		if destination_currency == company_currency:
			native = flt(net["base"], base_precision)
			rate = 1.0
		elif destination_currency == net["currency"]:
			native = flt(net["native"], get_currency_precision(destination_currency))
			rate = flt(abs(net["base"] / net["native"]), 9) if native else 0
		else:
			frappe.throw(
				_(
					"Mode of Payment {0} takes {1}, but its Destination Account {2} is in {3}. "
					"Use an account in {1} or in {4}."
				).format(mode, net["currency"], destination, destination_currency, company_currency)
			)

		if not native:
			continue

		# The JE recomputes base as native * rate, so credit exactly that to keep both sides equal.
		base = flt(abs(native) * rate, base_precision)
		destination_side, source_side = (
			("debit_in_account_currency", "credit_in_account_currency")
			if native > 0
			else ("credit_in_account_currency", "debit_in_account_currency")
		)
		remark = _("{0}: {1} {2}").format(mode, abs(native), destination_currency)
		rows.append(
			{
				"account": destination,
				"account_currency": destination_currency,
				"exchange_rate": rate,
				destination_side: abs(native),
				"cost_center": cost_center,
				"user_remark": remark,
			}
		)
		rows.append(
			{
				"account": source,
				"account_currency": company_currency,
				"exchange_rate": 1,
				source_side: base,
				"cost_center": cost_center,
				"user_remark": remark,
			}
		)

	return rows


def destination_accounts(company):
	"""Return ``{mode: row}`` for the company's Mode of Payment Account rows that have a destination."""
	if not frappe.db.has_column("Mode of Payment Account", "pos_destination_account"):
		return {}
	rows = frappe.get_all(
		"Mode of Payment Account",
		filters={
			"company": company,
			"parenttype": "Mode of Payment",
			"pos_destination_account": ["is", "set"],
		},
		fields=[
			"parent",
			"default_account",
			"pos_destination_account",
			"pos_destination_posting",
			"pos_reference_required",
		],
	)
	return {row.parent: row for row in rows}


def per_payment_modes(company):
	"""Modes whose payments each post their own Journal Entry, so the till offers a reference box."""
	return {
		mode
		for mode, row in destination_accounts(company).items()
		if row.pos_destination_posting == PER_PAYMENT
	}


def reference_required_modes(company):
	"""Per Payment modes whose bank shows the customer's reference, so a sale must carry one."""
	return {
		mode
		for mode, row in destination_accounts(company).items()
		if row.pos_destination_posting == PER_PAYMENT and cint(row.pos_reference_required)
	}


def validate_mode_of_payment(doc, method=None):
	"""Per Payment moves each payment gross, so it cannot work for a mode that hands back change."""
	if doc.type != "Cash":
		return
	for row in doc.get("accounts") or []:
		if row.get("pos_destination_account") and row.get("pos_destination_posting") == PER_PAYMENT:
			frappe.throw(
				_(
					"Row {0}: Per Payment posting is for non-cash modes. {1} is a Cash mode; use Per Shift."
				).format(row.idx, doc.name)
			)


def payment_net(payment, company_currency):
	tender_currency = payment.get("pos_tender_currency")
	return {
		"currency": tender_currency or company_currency,
		"native": flt(payment.get("pos_tender_amount")) if tender_currency else flt(payment.amount),
		"base": flt(payment.amount),
	}


def post_journal_entry(closing_doc, rows, company_currency, posting_date, remark, reference=None):
	je = frappe.new_doc("Journal Entry")
	je.voucher_type = "Journal Entry"
	je.company = closing_doc.company
	je.posting_date = posting_date
	je.multi_currency = int(any(row["account_currency"] != company_currency for row in rows))
	je.user_remark = remark
	je.pos_closing_shift = closing_doc.name
	if reference:
		# Bank Reconciliation ranks and auto-matches a Journal Entry on cheque_no.
		je.cheque_no = reference
		je.cheque_date = posting_date
	for row in rows:
		je.append("accounts", row)

	je.flags.ignore_permissions = True
	frappe.flags.ignore_account_permission = True
	je.insert()
	je.submit()
	return je.name


def create_reclass_journal_entry(closing_doc):
	"""Move the shift's takings to destination accounts: one entry for Per Shift modes, one per payment
	for Per Payment modes. Runs once per shift."""
	company = closing_doc.company
	rows_by_mode = destination_accounts(company)
	if not rows_by_mode or frappe.db.exists(
		"Journal Entry", {"pos_closing_shift": closing_doc.name, "docstatus": 1}
	):
		return []

	for mode, row in rows_by_mode.items():
		if frappe.get_cached_value("Account", row.pos_destination_account, "company") != company:
			frappe.throw(
				_("Destination Account {0} on Mode of Payment {1} does not belong to {2}.").format(
					row.pos_destination_account, mode, company
				)
			)

	accounts = {
		mode: (row.default_account, row.pos_destination_account) for mode, row in rows_by_mode.items()
	}
	per_payment = {mode for mode, row in rows_by_mode.items() if row.pos_destination_posting == PER_PAYMENT}
	per_shift = {mode: pair for mode, pair in accounts.items() if mode not in per_payment}

	company_currency = frappe.get_cached_value("Company", company, "default_currency")
	account_currency = {
		account: frappe.get_cached_value("Account", account, "account_currency")
		for pair in accounts.values()
		for account in pair
		if account
	}
	cost_center = frappe.db.get_value("POS Profile", closing_doc.pos_profile, "cost_center") or (
		frappe.get_cached_value("Company", company, "cost_center")
	)

	posted = []
	rows = build_reclass_rows(
		shift_mode_nets(closing_doc, company_currency),
		per_shift,
		company_currency,
		account_currency,
		cost_center,
	)
	if rows:
		remark = _("POS Closing Shift {0}: move takings to destination accounts").format(closing_doc.name)
		posted.append(
			post_journal_entry(closing_doc, rows, company_currency, closing_doc.posting_date, remark)
		)

	if per_payment:
		for invoice_doc in shift_invoices(closing_doc, company_currency):
			for payment in invoice_doc.get("payments") or []:
				if payment.mode_of_payment not in per_payment:
					continue
				rows = build_reclass_rows(
					{payment.mode_of_payment: payment_net(payment, company_currency)},
					accounts,
					company_currency,
					account_currency,
					cost_center,
				)
				if not rows:
					continue
				reference = payment.get("reference_no") or invoice_doc.name
				remark = _("{0} {1}, reference {2} (POS Closing Shift {3})").format(
					payment.mode_of_payment, invoice_doc.name, reference, closing_doc.name
				)
				posted.append(
					post_journal_entry(
						closing_doc, rows, company_currency, invoice_doc.posting_date, remark, reference
					)
				)

	return posted


def cancel_reclass_journal_entry(closing_doc):
	for name in frappe.get_all(
		"Journal Entry", filters={"pos_closing_shift": closing_doc.name, "docstatus": 1}, pluck="name"
	):
		cancel_journal_entry(name)
