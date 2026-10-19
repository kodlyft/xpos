# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""
POS Payments API.

- Phone payment requests
- Customer credit retrieval & redemption
- Outstanding invoice lookup
- Unallocated payment lookup
- Payment entry creation
"""

import json

import frappe
from frappe import _
from frappe.utils import flt, nowdate

from xpos.api.utilities import can_settle_outstanding


@frappe.whitelist()
def get_available_credit(
	customer: str, company: str | None = None, pos_profile: str | None = None
) -> list[dict]:
	"""Spendable credit rows for a customer; same rules as xpos.api.customer_credit."""
	from xpos.api.customer_credit import get_customer_credit

	return get_customer_credit(customer, pos_profile=pos_profile)["sources"]


@frappe.whitelist()
def get_outstanding_invoices(
	customer: str | None = None,
	company: str | None = None,
	currency: str | None = None,
	pos_profile: str | None = None,
	page_start: int = 0,
	page_length: int = 20,
	search_term: str | None = None,
) -> list[dict]:
	"""Fetch submitted invoices that still carry a balance."""
	if not customer and not can_settle_outstanding(pos_profile):
		frappe.throw(
			_("You are not permitted to list unpaid invoices across customers."),
			frappe.PermissionError,
		)

	filters = {
		"docstatus": 1,
		"outstanding_amount": [">", 0],
		"is_return": 0,
	}

	if customer:
		filters["customer"] = customer
	if company:
		filters["company"] = company
	if currency:
		filters["currency"] = currency

	or_filters = None
	if search_term:
		pattern = f"%{search_term.strip()}%"
		or_filters = {
			"name": ["like", pattern],
			"customer": ["like", pattern],
			"customer_name": ["like", pattern],
		}

	invoices = frappe.get_list(
		"Sales Invoice",
		filters=filters,
		or_filters=or_filters,
		fields=[
			"name",
			"customer",
			"customer_name",
			"posting_date",
			"grand_total",
			"paid_amount",
			"outstanding_amount",
			"currency",
			"status",
		],
		limit_start=page_start,
		limit_page_length=page_length,
		order_by="posting_date asc",
	)

	return invoices


@frappe.whitelist()
def get_unallocated_payments(
	customer: str, company: str, currency: str | None = None, mode_of_payment: str | None = None
) -> list[dict]:
	"""Returns unallocated payments, journal entries, and credit notes for a customer."""
	payments = []

	pe_filters = {
		"party_type": "Customer",
		"party": customer,
		"company": company,
		"docstatus": 1,
		"payment_type": "Receive",
		"unallocated_amount": [">", 0],
	}
	if mode_of_payment:
		pe_filters["mode_of_payment"] = mode_of_payment

	pe_list = frappe.get_list(
		"Payment Entry",
		filters=pe_filters,
		fields=[
			"name",
			"posting_date",
			"paid_amount",
			"unallocated_amount",
			"mode_of_payment",
			"paid_to_account_currency as currency",
		],
	)
	for pe in pe_list:
		pe["type"] = "Payment Entry"
		payments.append(pe)

	cn_list = frappe.db.sql(
		"""
		SELECT
			name, posting_date, grand_total,
			ABS(outstanding_amount) AS unallocated_amount,
			currency
		FROM `tabSales Invoice`
		WHERE customer = %(customer)s
			AND company = %(company)s
			AND docstatus = 1
			AND is_return = 1
			AND outstanding_amount < 0
		ORDER BY posting_date ASC
		""",
		{"customer": customer, "company": company},
		as_dict=True,
	)
	for cn in cn_list:
		cn["type"] = "Credit Note"
		payments.append(cn)

	return payments


def create_payment_entry(data: str | dict) -> dict:
	"""Create (and optionally submit) a Payment Entry for a customer."""
	if isinstance(data, str):
		data = json.loads(data)

	customer = data.get("customer")
	company = data.get("company")
	amount = flt(data.get("amount"))
	mode_of_payment = data.get("mode_of_payment")

	if not all([customer, company, amount, mode_of_payment]):
		frappe.throw(_("Customer, Company, Amount, and Mode of Payment are required"))

	from erpnext.accounts.doctype.sales_invoice.sales_invoice import (
		get_bank_cash_account,
	)

	account_details = get_bank_cash_account(mode_of_payment, company)

	pe = frappe.new_doc("Payment Entry")
	pe.payment_type = "Receive"
	pe.party_type = "Customer"
	pe.party = customer
	pe.company = company
	pe.paid_amount = amount
	pe.received_amount = amount
	pe.mode_of_payment = mode_of_payment
	pe.paid_to = account_details.get("account")
	pe.posting_date = nowdate()
	pe.reference_no = data.get("reference_no", "POS Payment")
	pe.reference_date = nowdate()

	if data.get("reference_doctype") and data.get("reference_name"):
		pe.append(
			"references",
			{
				"reference_doctype": data["reference_doctype"],
				"reference_name": data["reference_name"],
				"allocated_amount": amount,
			},
		)

	pe.insert(ignore_permissions=True)

	if data.get("submit"):
		pe.submit()

	return {
		"name": pe.name,
		"paid_amount": pe.paid_amount,
		"status": "Submitted" if pe.docstatus == 1 else "Draft",
	}


@frappe.whitelist()
def settle_outstanding_invoice(
	invoice: str,
	amount: float,
	mode_of_payment: str,
	pos_opening_shift: str,
	pos_profile: str | None = None,
) -> dict:
	"""Collect payment against a past submitted invoice from the POS.

	This is the credit-sale half of open tabs: the sale is already submitted, so it
	is settled with a Payment Entry rather than by loading a cart.
	"""
	if not can_settle_outstanding(pos_profile):
		frappe.throw(
			_("You are not permitted to settle outstanding invoices."),
			frappe.PermissionError,
		)

	if not pos_opening_shift:
		frappe.throw(_("An open shift is required to settle an invoice."))

	if not frappe.db.exists("Sales Invoice", invoice):
		frappe.throw(_("Sales Invoice {0} does not exist").format(invoice))

	invoice_doc = frappe.get_doc("Sales Invoice", invoice)

	if invoice_doc.docstatus != 1:
		frappe.throw(_("Only a submitted invoice can be settled."))

	outstanding_amount = flt(invoice_doc.outstanding_amount)
	if outstanding_amount <= 0:
		frappe.throw(_("Invoice {0} has nothing outstanding.").format(invoice))

	amount = flt(amount)
	if amount <= 0:
		frappe.throw(_("Payment amount must be greater than zero."))

	if amount > outstanding_amount + 0.009:
		frappe.throw(
			_("Payment of {0} exceeds the {1} outstanding on invoice {2}.").format(
				amount, outstanding_amount, invoice
			)
		)

	result = create_payment_entry(
		{
			"customer": invoice_doc.customer,
			"company": invoice_doc.company,
			"amount": amount,
			"mode_of_payment": mode_of_payment,
			"reference_doctype": "Sales Invoice",
			"reference_name": invoice,
			"reference_no": pos_opening_shift,
			"submit": True,
		}
	)

	return {
		"payment_entry": result.get("name"),
		"allocated_amount": amount,
		"outstanding_after": flt(frappe.db.get_value("Sales Invoice", invoice, "outstanding_amount")),
	}


@frappe.whitelist()
def create_payment_request(doc: str | dict) -> dict | None:
	"""Creates a phone payment request."""
	if isinstance(doc, str):
		doc = json.loads(doc)

	for pay in doc.get("payments", []):
		if pay.get("type") == "Phone":
			if flt(pay.get("amount")) <= 0:
				frappe.throw(_("Payment amount cannot be less than or equal to 0"))

			if not doc.get("contact_mobile"):
				frappe.throw(_("Please enter the phone number first"))

			payment_gateway_account = frappe.db.get_value(
				"Payment Gateway Account",
				{"payment_account": pay.get("account")},
				"name",
			)

			existing = frappe.db.exists(
				{
					"doctype": "Payment Request",
					"reference_doctype": "Sales Invoice",
					"reference_name": doc.get("name"),
					"payment_gateway_account": payment_gateway_account,
				}
			)

			if existing:
				pr = frappe.get_doc("Payment Request", existing)
				pr.request_phone_payment()
				return pr.as_dict()

			from erpnext.accounts.doctype.payment_request.payment_request import (
				make_payment_request,
			)

			args = {
				"dt": "Sales Invoice",
				"dn": doc.get("name"),
				"recipient_id": doc.get("contact_mobile"),
				"mode_of_payment": pay.get("mode_of_payment"),
				"payment_gateway_account": payment_gateway_account,
				"payment_request_type": "Inward",
				"party_type": "Customer",
				"party": doc.get("customer"),
				"return_doc": True,
			}

			try:
				pr = make_payment_request(**args)
				pr.submit()
				return pr.as_dict()
			except Exception as e:
				frappe.log_error(f"Payment request creation failed: {e}", "X POS Payment Request")
				frappe.throw(_("Failed to create payment request: {0}").format(str(e)))

	return None
