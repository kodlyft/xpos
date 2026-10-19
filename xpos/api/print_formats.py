# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.utils import cint
from frappe.utils.nestedset import get_ancestors_of

REPRINT_DOCTYPES = ("Sales Invoice", "POS Invoice")
FALLBACK_PRINT_FORMAT = "XPOS Thermal Receipt"


def usable_print_format(name: str | None) -> bool:
	"""An enabled Print Format for an invoice doctype."""
	if not name:
		return False
	row = frappe.db.get_value("Print Format", name, ["disabled", "doc_type"], as_dict=True)
	return bool(row) and not row.disabled and row.doc_type in REPRINT_DOCTYPES


def resolve_print_format(pos_profile: str | None, customer: str | None = None) -> str:
	"""Receipt format for a sale (``print_format_rules``).

	The first rule row (in table order) whose customer group is the customer's
	group or one of its parents wins; then the profile's Default Print Format;
	then the XPOS thermal receipt. Disabled, missing or non-invoice formats are
	skipped. Rules are plain group matches - no expressions are evaluated.
	"""
	candidates = []
	profile = frappe.get_cached_doc("POS Profile", pos_profile) if pos_profile else None
	if profile:
		group = frappe.db.get_value("Customer", customer, "customer_group") if customer else None
		if group:
			groups = {group, *get_ancestors_of("Customer Group", group)}
			rules = sorted(profile.get("print_format_rules") or [], key=lambda row: row.idx)
			candidates += [row.print_format for row in rules if row.customer_group in groups]
		candidates.append(profile.get("default_print_format"))
	return next((name for name in candidates if usable_print_format(name)), FALLBACK_PRINT_FORMAT)


@frappe.whitelist()
def get_invoice_print_format(doctype: str, name: str) -> dict:
	"""The print format a posted invoice prints (and reprints) with."""
	if doctype not in REPRINT_DOCTYPES:
		frappe.throw(_("Unsupported doctype for printing: {0}").format(doctype))
	frappe.has_permission(doctype, "read", doc=name, throw=True)
	pos_profile, customer = frappe.db.get_value(doctype, name, ["pos_profile", "customer"])
	return {"print_format": resolve_print_format(pos_profile, customer)}


def validate_print_format_rules(doc, method=None) -> None:
	"""POS Profile validate hook: every rule must point at a usable invoice print format."""
	for row in doc.get("print_format_rules") or []:
		if not usable_print_format(row.print_format):
			frappe.throw(
				_("Row {0}: Print Format {1} is disabled, missing or not for Sales/POS Invoice.").format(
					row.idx, row.print_format
				)
			)


@frappe.whitelist()
def get_print_formats(doctype: str = "Sales Invoice"):
	"""Returns available print format names for a doctype."""
	print_formats = frappe.get_all(
		"Print Format",
		filters={"doc_type": doctype, "disabled": 0},
		fields=["name"],
	)
	return [p.name for p in print_formats]


def can_reprint(user: str | None = None, pos_profile: str | None = None) -> bool:
	"""Whether ``user`` may reprint a posted POS invoice (the ``allow_reprint_invoice`` right).

	The right is the user's POS Role on the invoice's own profile.
	"""
	from xpos.api.auth import user_has_pos_permission

	return user_has_pos_permission("allow_reprint_invoice", user, pos_profile)


def invoice_has_permission(doc, ptype: str, user: str) -> bool:
	"""``has_permission`` hook restricting reprinting of POS invoices."""
	if ptype != "print":
		return True
	if not getattr(doc, "is_pos", 0):
		return True
	if cint(getattr(doc, "print_count", 0)) < 1:
		return True
	return can_reprint(user, getattr(doc, "pos_profile", None))


def enforce_reprint_right(doc, method=None, *args, **kwargs) -> None:
	"""``before_print``: a reprint of a POS receipt needs the reprint right.

	Frappe's print view only needs *read*, so the ``has_permission`` hook alone
	does not stop a cashier reprinting from ``/printview``. The rule applies to the
	users of the invoice's own till profile; back-office Desk users keep printing.
	"""
	if not cint(doc.get("is_pos")) or cint(doc.get("print_count")) < 1 or not doc.get("pos_profile"):
		return
	user = frappe.session.user
	on_till = frappe.db.exists(
		"POS Profile User", {"parent": doc.pos_profile, "parenttype": "POS Profile", "user": user}
	)
	if on_till and not can_reprint(user, doc.pos_profile):
		frappe.throw(_("You are not permitted to reprint this receipt."), frappe.PermissionError)


@frappe.whitelist()
def get_receipt_context(pos_profile: str, print_format: str | None = None) -> dict:
	"""Resolve everything the desktop app needs to render a receipt offline."""
	profile = frappe.get_cached_doc("POS Profile", pos_profile)
	company = frappe.get_cached_doc("Company", profile.company)

	address = ""
	if company.get("company_address"):
		addr = frappe.get_cached_doc("Address", company.company_address)
		address = ", ".join(
			p
			for p in [
				addr.address_line1,
				addr.address_line2,
				addr.city,
				addr.state,
				addr.pincode,
			]
			if p
		)

	# Offline receipts use the fixed XPOS layout and only this format's CSS; customer-group
	# rules need the server print view, so they apply online only.
	fmt = print_format if usable_print_format(print_format) else resolve_print_format(pos_profile)
	css = frappe.db.get_value("Print Format", fmt, "css") or ""

	return {
		"company_name": company.company_name or company.name,
		"company_phone": company.get("phone_no") or "",
		"company_email": company.get("email") or "",
		"company_website": company.get("website") or "",
		"company_address": address,
		"company_tax_id": company.get("tax_id") or "",
		"company_logo": company.get("company_logo") or "",
		"receipt_header": company.get("receipt_header") or "",
		"receipt_footer": company.get("receipt_footer") or "",
		"currency": company.get("default_currency") or "",
		"print_discount_amount": cint(profile.get("print_discount_amount")),
		"print_format": fmt,
		"css": css,
	}


@frappe.whitelist()
def mark_invoice_printed(doctype: str, name: str) -> dict:
	"""Record that a POS receipt has printed, so later prints count as reprints."""
	if doctype not in REPRINT_DOCTYPES:
		frappe.throw(_("Unsupported doctype for print tracking: {0}").format(doctype))
	frappe.has_permission(doctype, "read", doc=name, throw=True)
	current = cint(frappe.db.get_value(doctype, name, "print_count"))
	frappe.db.set_value(doctype, name, "print_count", current + 1, update_modified=False)
	return {"name": name, "print_count": current + 1}
