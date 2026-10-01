# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

import json
from collections import defaultdict

import frappe
from frappe import _
from frappe.utils import cint, flt, now_datetime, nowdate

from xpos.api.exchange import change_leg_table_exists, payment_tender_fields_exist
from xpos.api.utilities import can_close_shift, get_invoice_type, is_pos_cashier
from xpos.utils import row_value

CLOSING_INVOICE_FIELDS = [
	"name",
	"posting_date",
	"currency",
	"grand_total",
	"net_total",
	"total_taxes_and_charges",
	"change_amount",
	"customer",
	"is_return",
]

SUMMARY_INVOICE_FIELDS = [
	"name",
	"currency",
	"grand_total",
	"net_total",
	"paid_amount",
	"change_amount",
	"is_return",
	"customer",
	"customer_name",
]


def resolve_cash_mode_of_payment(pos_profile: str | None) -> str:
	"""The mode of payment whose drawer change is physically handed back out of."""
	if pos_profile:
		return frappe.db.get_value("POS Profile", pos_profile, "cash_mode_of_payment") or "Cash"
	return "Cash"


def resolve_legacy_change(payments: list, change: float, invoice_currency: str, cash_mode: str) -> tuple:
	"""Work out where a leg-less invoice's change came from, as ``(mode, currency, amount)``."""
	rows = [row for row in payments if row_value(row, "mode_of_payment")]
	row = next(
		(candidate for candidate in rows if row_value(candidate, "mode_of_payment") == cash_mode),
		rows[0] if len(rows) == 1 else None,
	)
	if row is None:
		return cash_mode, invoice_currency, change

	mode = row_value(row, "mode_of_payment")
	currency = row_value(row, "pos_tender_currency")
	native = flt(row_value(row, "pos_tender_amount", 0))
	base = flt(row_value(row, "amount", 0))
	if currency and currency != invoice_currency and native and base:
		return mode, currency, change * native / base

	return mode, invoice_currency, change


def get_shift_payment_totals(
	doctype: str, invoices: list, cash_mode_of_payment: str | None = None
) -> dict[str, dict]:
	"""Return ``{mode_of_payment: {"amount": float, "currency": str}}`` for a shift.

	Amounts are net of change given and denominated in each mode's own tender currency, so a USD
	mode reports dollars and an LBP mode reports pounds. That is what the drawer physically holds
	and what the cashier counts; one blended company-currency figure cannot be counted.

	Fetches every invoice's payment and change rows in one query each rather than one query per
	invoice, so the cost is flat in the number of invoices in the shift.
	"""
	names = [row_value(invoice, "name") for invoice in invoices]
	names = [name for name in names if name]
	if not names:
		return {}

	payment_fields = ["parent", "mode_of_payment", "amount"]
	if payment_tender_fields_exist():
		payment_fields += ["pos_tender_currency", "pos_tender_amount"]

	payments_by_invoice = defaultdict(list)
	for row in frappe.get_all(
		"Sales Invoice Payment",
		filters={"parent": ["in", names], "parenttype": doctype},
		fields=payment_fields,
	):
		payments_by_invoice[row_value(row, "parent")].append(row)

	change_legs_by_invoice = defaultdict(list)
	if change_leg_table_exists():
		for row in frappe.get_all(
			"POS Change Leg",
			filters={"parent": ["in", names], "parenttype": doctype, "parentfield": "pos_change_legs"},
			fields=["parent", "mode_of_payment", "currency", "amount"],
		):
			change_legs_by_invoice[row_value(row, "parent")].append(row)

	totals: dict[str, dict] = {}

	def collect(mode, currency, amount):
		if not mode:
			return
		entry = totals.setdefault(mode, {"amount": 0.0, "currency": currency or ""})
		if currency and not entry["currency"]:
			entry["currency"] = currency
		entry["amount"] += flt(amount)

	for invoice in invoices:
		name = row_value(invoice, "name")
		invoice_currency = row_value(invoice, "currency") or ""
		payments = payments_by_invoice.get(name, [])

		for payment in payments:
			tender_currency = row_value(payment, "pos_tender_currency")
			if tender_currency:
				collect(
					row_value(payment, "mode_of_payment"),
					tender_currency,
					row_value(payment, "pos_tender_amount", 0),
				)
			else:
				collect(
					row_value(payment, "mode_of_payment"),
					invoice_currency,
					row_value(payment, "amount", 0),
				)

		# Change is handed back out of the drawer, so it never counts as collected.
		legs = change_legs_by_invoice.get(name, [])
		if legs:
			for leg in legs:
				collect(
					row_value(leg, "mode_of_payment"),
					row_value(leg, "currency") or invoice_currency,
					-flt(row_value(leg, "amount", 0)),
				)
			continue

		change = flt(row_value(invoice, "change_amount", 0))
		if change > 0:
			mode, currency, amount = resolve_legacy_change(
				payments, change, invoice_currency, cash_mode_of_payment or "Cash"
			)
			collect(mode, currency, -amount)

	return totals


def get_shift_expected_amounts(opening, doctype: str, invoices: list) -> dict[str, dict]:
	"""Return the expected closing amount per mode of payment, computed server-side.

	Expected = opening float + payments collected - cash taken out of the drawer by submitted
	POS Cash Movements, each in that mode's own tender currency. The opening float is already
	recorded per mode, so once "Cash USD" is its own mode every figure here is natively
	per-currency. This must never be taken from the client: it is the figure the counted cash is
	reconciled against.
	"""
	expected: dict[str, dict] = {}

	def collect(mode, currency, amount):
		if not mode:
			return
		entry = expected.setdefault(mode, {"amount": 0.0, "currency": currency or ""})
		if currency and not entry["currency"]:
			entry["currency"] = currency
		entry["amount"] += flt(amount)

	for detail in opening.balance_details:
		collect(detail.mode_of_payment, row_value(detail, "currency"), flt(detail.amount))

	cash_mode = resolve_cash_mode_of_payment(opening.pos_profile)

	for mode, row in get_shift_payment_totals(doctype, invoices, cash_mode).items():
		collect(mode, row.get("currency"), row.get("amount"))

	movement_total = sum(
		flt(row_value(row, "amount", 0))
		for row in frappe.get_all(
			"POS Cash Movement",
			filters={"pos_opening_shift": opening.name, "docstatus": 1},
			fields=["amount"],
		)
	)
	if movement_total:
		collect(cash_mode, None, -movement_total)

	return expected


def _get_open_shift_rows(user: str):
	return frappe.db.get_all(
		"POS Opening Shift",
		filters={
			"user": user,
			"docstatus": 1,
			"status": "Open",
		},
		or_filters=[
			{"pos_closing_shift": ["is", "not set"]},
			{"pos_closing_shift": ""},
		],
		fields=["name", "pos_profile", "company"],
		order_by="period_start_date desc",
		limit=1,
	)


@frappe.whitelist()
def get_opening_data():
	"""Get data needed for the shift opening dialog.

	Returns POS profiles, companies, and payment methods for the current user.
	"""
	data = {}

	pos_profiles = frappe.db.sql(
		"""
		SELECT DISTINCT p.name, p.company, p.currency, p.warehouse
		FROM `tabPOS Profile` p
		INNER JOIN `tabPOS Profile User` u ON u.parent = p.name
		WHERE p.disabled = 0 AND u.user = %(user)s
		ORDER BY p.name
		""",
		{"user": frappe.session.user},
		as_dict=True,
	)

	data["pos_profiles"] = pos_profiles

	companies = []
	seen = set()
	for profile in pos_profiles:
		company = row_value(profile, "company")
		if company and company not in seen:
			companies.append({"name": company})
			seen.add(company)
	data["companies"] = companies

	profile_names = [row_value(p, "name") for p in pos_profiles if row_value(p, "name")]
	if profile_names:
		payment_methods = frappe.get_list(
			"POS Payment Method",
			filters={"parent": ["in", profile_names]},
			fields=["parent", "mode_of_payment", "default"],
			limit_page_length=0,
			order_by="parent",
			ignore_permissions=True,
		)
		data["payment_methods"] = payment_methods
	else:
		data["payment_methods"] = []

	return data


@frappe.whitelist()
def open_shift(pos_profile: str, company: str, balance_details: str | list[dict] | None = None):
	"""Create and submit a POS Opening Shift."""

	balance_details = json.loads(balance_details) if isinstance(balance_details, str) else balance_details

	new_shift = frappe.get_doc(
		{
			"doctype": "POS Opening Shift",
			"period_start_date": now_datetime(),
			"posting_date": nowdate(),
			"user": frappe.session.user,
			"pos_profile": pos_profile,
			"company": company,
			"docstatus": 1,
		}
	)

	if balance_details:
		new_shift.set("balance_details", balance_details)

	new_shift.insert(ignore_permissions=True)

	data = {
		"pos_opening_shift": new_shift.as_dict(),
	}
	_enrich_shift_data(data, pos_profile)

	return data


@frappe.whitelist()
def check_open_shift(user: str | None = None):
	"""Check if the current user has an open POS shift."""

	user = user or frappe.session.user

	open_shifts = _get_open_shift_rows(user)

	if not open_shifts:
		return None

	shift = open_shifts[0]
	shift_name = row_value(shift, "name")
	pos_profile = row_value(shift, "pos_profile")
	data = {
		"pos_opening_shift": frappe.get_doc("POS Opening Shift", shift_name).as_dict(),
	}
	_enrich_shift_data(data, pos_profile)

	return data


@frappe.whitelist()
def close_shift(opening_shift: str, closing_details: str | list[dict] | None):
	"""Create a POS Closing Shift and close the opening shift.

	- Aggregates invoices by POS opening shift reference
	- Tax summary per shift
	- Payment reconciliation with expected vs actual amounts
	"""
	if not can_close_shift():
		frappe.throw(_("Only a Supervisor can close a shift."), frappe.PermissionError)

	closing_details = json.loads(closing_details) if isinstance(closing_details, str) else closing_details

	opening = frappe.get_doc("POS Opening Shift", opening_shift)
	doctype = get_invoice_type()

	filters = {
		"pos_opening_shift": opening.name,
		"docstatus": 1,
		"is_pos": 1,
	}
	if doctype == "POS Invoice":
		filters["consolidated_invoice"] = ["in", ["", None]]

	invoices = frappe.get_all(doctype, filters=filters, fields=CLOSING_INVOICE_FIELDS)

	if not invoices:
		fallback_filters = {
			"pos_profile": opening.pos_profile,
			"posting_date": [">=", opening.posting_date],
			"docstatus": 1,
			"is_pos": 1,
			"owner": opening.user,
			"pos_closing_entry": ["is", "not set"],
		}
		if doctype == "POS Invoice":
			fallback_filters["consolidated_invoice"] = ["in", ["", None]]

		invoices = frappe.get_all(doctype, filters=fallback_filters, fields=CLOSING_INVOICE_FIELDS)

	grand_total = sum(flt(row_value(inv, "grand_total", 0)) for inv in invoices)
	net_total = sum(flt(row_value(inv, "net_total", 0)) for inv in invoices)
	total_qty = len(invoices)

	returns_count = sum(1 for inv in invoices if inv.get("is_return"))

	closing_shift = frappe.get_doc(
		{
			"doctype": "POS Closing Shift",
			"period_start_date": opening.period_start_date,
			"period_end_date": now_datetime(),
			"posting_date": nowdate(),
			"posting_time": now_datetime().strftime("%H:%M:%S"),
			"pos_profile": opening.pos_profile,
			"user": frappe.session.user,
			"company": opening.company,
			"pos_opening_shift": opening.name,
			"grand_total": grand_total,
			"net_total": net_total,
			"total_quantity": total_qty,
		}
	)

	if closing_details:
		expected_amounts = get_shift_expected_amounts(opening, doctype, invoices)
		opening_amounts = {detail.mode_of_payment: flt(detail.amount) for detail in opening.balance_details}

		for detail in closing_details:
			mode_of_payment = detail.get("mode_of_payment")
			closing_amount = flt(detail.get("closing_amount", 0))
			server_row = expected_amounts.get(mode_of_payment) or {}
			expected_amount = flt(server_row.get("amount", 0))

			closing_shift.append(
				"payment_reconciliation",
				{
					"mode_of_payment": mode_of_payment,
					"currency": server_row.get("currency") or None,
					"opening_amount": flt(opening_amounts.get(mode_of_payment, 0)),
					"expected_amount": expected_amount,
					"closing_amount": closing_amount,
					"difference": closing_amount - expected_amount,
				},
			)

	tax_summary = _get_shift_tax_summary(invoices, doctype)
	for tax in tax_summary:
		try:
			closing_shift.append(
				"taxes",
				{
					"account_head": tax.get("account_head"),
					"rate": flt(tax.get("rate")),
					"amount": flt(tax.get("amount")),
				},
			)
		except Exception:
			pass

	invoice_link_field = "pos_invoice" if doctype == "POS Invoice" else "sales_invoice"
	for inv in invoices:
		row = {
			invoice_link_field: row_value(inv, "name"),
			"posting_date": row_value(inv, "posting_date"),
			"customer": row_value(inv, "customer"),
			"grand_total": row_value(inv, "grand_total", 0),
		}
		closing_shift.append("pos_transactions", row)

	closing_shift.insert(ignore_permissions=True)
	closing_shift.submit()

	return {
		"name": closing_shift.name,
		"pos_closing_shift": closing_shift.name,
		"grand_total": grand_total,
		"net_total": net_total,
		"total_invoices": total_qty,
		"returns_count": returns_count,
	}


@frappe.whitelist()
def get_shift_summary(opening_shift: str):
	"""Get summary of the current shift for closing.

	Enhanced version with tax breakdown and return info.
	"""
	opening = frappe.get_doc("POS Opening Shift", opening_shift)
	doctype = get_invoice_type()

	filters = {
		"pos_opening_shift": opening.name,
		"docstatus": 1,
		"is_pos": 1,
	}
	if doctype == "POS Invoice":
		filters["consolidated_invoice"] = ["in", ["", None]]

	invoices = frappe.get_all(doctype, filters=filters, fields=SUMMARY_INVOICE_FIELDS)

	if not invoices:
		fallback_filters = {
			"pos_profile": opening.pos_profile,
			"posting_date": [">=", opening.posting_date],
			"docstatus": 1,
			"is_pos": 1,
			"owner": opening.user,
			"pos_closing_entry": ["is", "not set"],
		}
		if doctype == "POS Invoice":
			fallback_filters["consolidated_invoice"] = ["in", ["", None]]

		invoices = frappe.get_all(doctype, filters=fallback_filters, fields=SUMMARY_INVOICE_FIELDS)

	grand_total = sum(flt(row_value(inv, "grand_total", 0)) for inv in invoices)
	net_total = sum(flt(row_value(inv, "net_total", 0)) for inv in invoices)
	returns_count = sum(1 for inv in invoices if inv.get("is_return"))

	payment_summary = get_shift_payment_totals(
		doctype, invoices, resolve_cash_mode_of_payment(opening.pos_profile)
	)

	opening_balances = {}
	for detail in opening.balance_details:
		mode = detail.mode_of_payment
		opening_balances[mode] = {
			"amount": flt(detail.amount),
			"currency": row_value(detail, "currency") or "",
		}

	tax_summary = _get_shift_tax_summary(invoices, doctype)

	return {
		"total_invoices": len(invoices),
		"grand_total": grand_total,
		"net_total": net_total,
		"returns_count": returns_count,
		"payment_summary": payment_summary,
		"opening_balances": opening_balances,
		"expected_amounts": get_shift_expected_amounts(opening, doctype, invoices),
		"tax_summary": tax_summary,
		"pos_profile": opening.pos_profile,
		"company": opening.company,
		"invoices": [
			{
				"name": row_value(inv, "name"),
				"customer": row_value(inv, "customer"),
				"customer_name": row_value(inv, "customer_name"),
				"grand_total": row_value(inv, "grand_total", 0),
				"is_return": row_value(inv, "is_return", 0),
			}
			for inv in invoices
		],
	}


def attach_tender_currencies(data: dict, profile_doc):
	"""Decorate the profile's payment rows with their tender currency, type and current rate."""
	from xpos.api.exchange import build_tender_rate_payload, get_currency_meta

	rows = (data.get("pos_profile") or {}).get("payments") or []
	if not rows:
		return

	company_currency = frappe.get_cached_value("Company", profile_doc.company, "default_currency")
	by_mode = {entry["mode_of_payment"]: entry for entry in build_tender_rate_payload(profile_doc)}

	for row in rows:
		entry = by_mode.get(row.get("mode_of_payment"))
		if not entry:
			continue
		row["pos_tender_currency"] = entry["currency"]
		row["type"] = entry["type"]
		row["is_foreign_tender"] = entry["is_foreign_tender"]
		row["exchange_rate"] = entry["exchange_rate"]
		row["rate_date"] = entry["rate_date"]
		row["precision"] = entry["precision"]
		row["symbol"] = entry["symbol"]

	data["company_currency"] = company_currency
	data["company_currency_meta"] = get_currency_meta(company_currency)


def _enrich_shift_data(data: dict, pos_profile: str):
	"""Add profile, company, settings, and tax template data to shift response."""
	try:
		profile = frappe.get_cached_doc("POS Profile", pos_profile)
	except (AttributeError, Exception):
		frappe.clear_cache(doctype="POS Profile")
		profile = frappe.get_doc("POS Profile", pos_profile)
	data["pos_profile"] = profile.as_dict()
	data["company"] = frappe.get_cached_doc("Company", profile.company).as_dict()
	data["is_cashier"] = is_pos_cashier(frappe.session.user, pos_profile)
	attach_tender_currencies(data, profile)

	allow_negative_stock = cint(frappe.db.get_single_value("Stock Settings", "allow_negative_stock") or 0)
	data["stock_settings"] = {"allow_negative_stock": bool(allow_negative_stock)}

	data["disable_rounded_total"] = cint(
		frappe.db.get_single_value("Global Defaults", "disable_rounded_total") or 0
	)

	if profile.taxes_and_charges:
		try:
			tax_template = frappe.get_cached_doc(
				"Sales Taxes and Charges Template", profile.taxes_and_charges
			)
			data["taxes"] = [
				{
					"description": tax.description
					or (str(tax.account_head).split(" - ")[0] if tax.account_head else "Tax"),
					"charge_type": tax.charge_type,
					"rate": flt(tax.rate),
					"account_head": tax.account_head,
					"included_in_print_rate": cint(tax.included_in_print_rate) or 0,
				}
				for tax in tax_template.taxes
			]
			data["tax_inclusive"] = cint(profile.get("tax_inclusive")) or 0
		except Exception:
			data["taxes"] = []
			data["tax_inclusive"] = 0
	else:
		data["taxes"] = []
		data["tax_inclusive"] = 0

	from xpos.api.auth import user_has_pos_permission

	data["print_settings"] = {
		"print_format": profile.get("print_format") or "POS Invoice",
		"print_format_for_online": profile.get("print_format_for_online"),
		"allow_print_before_pay": 1
		if user_has_pos_permission("print_draft_invoice", pos_profile=pos_profile)
		else 0,
		"auto_print_receipt": cint(profile.get("auto_print_receipt")) or 0,
		"letter_head": profile.get("letter_head") or "",
	}


def _get_shift_tax_summary(invoices: list, doctype: str = "Sales Invoice") -> list:
	"""Aggregate tax info across all shift invoices."""
	if not invoices:
		return []

	inv_names = [row_value(inv, "name") for inv in invoices if row_value(inv, "name")]
	if not inv_names:
		return []

	taxes = frappe.get_all(
		"Sales Taxes and Charges",
		filters={"parent": ["in", inv_names], "parenttype": doctype},
		fields=["account_head", "rate", {"SUM": "tax_amount", "as": "amount"}],
		group_by="account_head, rate",
		order_by="account_head",
	)

	return taxes


@frappe.whitelist()
def create_opening_shift(data: str | dict, local_id: str | None = None) -> dict:
	"""Create POS Opening Shift from desktop app sync.

	Used by the sync engine to push locally-created shifts to the server.

	Args:
	    data: JSON string containing shift data
	    local_id: Local ID from the desktop app for deduplication

	Returns:
	    dict with 'name' key containing the server docname
	"""
	data = json.loads(data) if isinstance(data, str) else data

	if local_id:
		existing = frappe.db.get_value("POS Opening Shift", {"xpos_local_id": local_id}, "name")
		if existing:
			return {"name": existing, "duplicate": True}

	new_shift = frappe.get_doc(
		{
			"doctype": "POS Opening Shift",
			"period_start_date": data.get("period_start_date") or now_datetime(),
			"posting_date": data.get("posting_date") or nowdate(),
			"user": data.get("user") or frappe.session.user,
			"pos_profile": data.get("pos_profile"),
			"company": data.get("company"),
			"xpos_local_id": local_id,
			"docstatus": 1,  # Submit immediately
		}
	)

	# Add balance details if provided
	balance_details = data.get("balance_details") or []
	for detail in balance_details:
		new_shift.append(
			"balance_details",
			{
				"mode_of_payment": detail.get("mode_of_payment"),
				"amount": flt(detail.get("opening_amount") or detail.get("amount", 0)),
			},
		)

	new_shift.insert(ignore_permissions=True)

	return {"name": new_shift.name}


@frappe.whitelist()
def create_closing_shift(data: str | dict, local_id: str | None = None) -> dict:
	"""Create POS Closing Shift from desktop app sync.

	Used by the sync engine to push locally-created closing shifts to the server.

	Args:
	    data: JSON string containing closing data
	    local_id: Local ID from the desktop app for deduplication

	Returns:
	    dict with 'name' key containing the server docname
	"""
	if not can_close_shift():
		frappe.throw(_("Only a Supervisor can close a shift."), frappe.PermissionError)

	data = json.loads(data) if isinstance(data, str) else data

	if local_id:
		existing = frappe.db.get_value("POS Closing Shift", {"xpos_local_id": local_id}, "name")
		if existing:
			return {"name": existing, "duplicate": True}

	opening_shift = data.get("pos_opening_shift")
	if not opening_shift:
		frappe.throw(_("Opening Shift is required"))

	try:
		opening = frappe.get_doc("POS Opening Shift", opening_shift)
	except frappe.DoesNotExistError:
		frappe.throw(_("POS Opening Shift {0} not found").format(opening_shift))

	closing_shift = frappe.get_doc(
		{
			"doctype": "POS Closing Shift",
			"period_start_date": opening.period_start_date,
			"period_end_date": data.get("period_end_date") or now_datetime(),
			"posting_date": data.get("posting_date") or nowdate(),
			"posting_time": data.get("posting_time") or now_datetime().strftime("%H:%M:%S"),
			"pos_profile": data.get("pos_profile") or opening.pos_profile,
			"user": data.get("user") or frappe.session.user,
			"company": data.get("company") or opening.company,
			"pos_opening_shift": opening.name,
			"grand_total": flt(data.get("grand_total", 0)),
			"net_total": flt(data.get("net_total", 0)),
			"total_quantity": cint(data.get("total_quantity", 0)),
			"xpos_local_id": local_id,
		}
	)

	payment_details = data.get("payment_reconciliation") or data.get("closing_details") or []
	for detail in payment_details:
		closing_shift.append(
			"payment_reconciliation",
			{
				"mode_of_payment": detail.get("mode_of_payment"),
				"opening_amount": flt(detail.get("opening_amount", 0)),
				"expected_amount": flt(detail.get("expected_amount", 0)),
				"closing_amount": flt(detail.get("closing_amount", 0)),
				"difference": flt(detail.get("difference", 0)),
			},
		)

	closing_shift.insert(ignore_permissions=True)
	closing_shift.submit()

	return {"name": closing_shift.name}
