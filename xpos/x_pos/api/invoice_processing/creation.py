import json

import frappe
from erpnext.accounts.doctype.sales_invoice.sales_invoice import get_bank_cash_account
from frappe import _
from frappe.utils import (
	cint,
	flt,
	getdate,
	money_in_words,
)
from frappe.utils.background_jobs import enqueue

from xpos.api.invoices import get_pos_invoice
from xpos.api.profiles import resolve_pos_profile
from xpos.api.utilities import get_invoice_type
from xpos.x_pos.api.invoice_processing.stock import (
	_apply_item_name_overrides,
	_auto_set_return_batches,
	_collect_stock_errors,
	_deduplicate_free_items,
	_merge_duplicate_taxes,
	_should_block,
	_strip_client_freebies_from_payload,
	validate_stock_on_invoice,
)
from xpos.x_pos.api.invoice_processing.utils import (
	_build_invoice_remarks,
	_get_return_validity_settings,
	_resolve_effective_price_list,
	_set_return_valid_upto,
	_validate_return_window,
	get_latest_rate,
)
from xpos.x_pos.api.payments import redeeming_customer_credit
from xpos.x_pos.api.utilities import ensure_child_doctype, set_batch_nos_for_bundles

_coupon_row_fields = ("coupon", "coupon_code", "type", "pos_offer", "applied", "customer")
_offer_row_fields = ("offer_name", "offer", "apply_on", "offer_applied", "coupon_based")


def _set_child_table_from_detail(
	doc,
	child_field: str,
	detail_rows: list[dict],
	allowed_keys: tuple[str, ...],
) -> None:
	"""Replace a child table on *doc* with rows built from *detail_rows*.

	Safely ignores unknown keys so the frontend dict doesn't need to match
	exactly.
	"""
	if not detail_rows:
		return

	if not hasattr(doc, child_field):
		return

	doc.set(child_field, [])
	for row_data in detail_rows:
		if not isinstance(row_data, dict):
			continue
		cleaned = {k: row_data[k] for k in allowed_keys if k in row_data}
		if cleaned:
			doc.append(child_field, cleaned)


def _resolve_write_off_limit(pos_profile_doc: dict) -> float | None:
	if not pos_profile_doc:
		return None

	candidate_fields = (
		"write_off_limit",
		"max_write_off_amount",
		"max_write_off_amount",
		"write_off_amount",
		"write_off_limit",
	)

	for fieldname in candidate_fields:
		raw_value = pos_profile_doc.get(fieldname)
		if raw_value in (None, ""):
			continue
		limit = flt(raw_value)
		if limit > 0:
			return limit

	return None


def _apply_write_off_settings(invoice_doc: dict, data: dict):
	enable_write_off = cint(data.get("is_write_off_change"))

	if invoice_doc.is_return or not enable_write_off:
		invoice_doc.write_off_amount = 0
		invoice_doc.base_write_off_amount = 0
		return

	requested_write_off = flt(data.get("write_off_amount") or invoice_doc.get("write_off_amount"))
	if requested_write_off <= 0:
		invoice_doc.write_off_amount = 0
		invoice_doc.base_write_off_amount = 0
		return

	invoice_total = abs(flt(invoice_doc.rounded_total or invoice_doc.grand_total))
	effective_write_off = min(requested_write_off, invoice_total)

	profile_doc = None
	if invoice_doc.pos_profile and frappe.db.exists("POS Profile", invoice_doc.pos_profile):
		profile_doc = frappe.get_cached_doc("POS Profile", invoice_doc.pos_profile)

	write_off_limit = _resolve_write_off_limit(profile_doc)
	if write_off_limit is not None:
		effective_write_off = min(effective_write_off, write_off_limit)

	allow_partial_payment = cint(profile_doc.get("allow_partial_payment")) if profile_doc else 0
	is_credit_sale = cint(data.get("is_credit_sale"))

	settled_by_payments = 0
	for payment in invoice_doc.get("payments") or []:
		settled_by_payments += max(flt(payment.get("amount")), 0)

	settled_by_loyalty = max(flt(invoice_doc.get("loyalty_amount")), 0)
	settled_by_customer_credit = max(flt(data.get("redeemed_customer_credit")), 0)
	remaining_after_write_off = invoice_total - (
		settled_by_payments + settled_by_loyalty + settled_by_customer_credit + effective_write_off
	)

	if (
		write_off_limit is not None
		and requested_write_off > write_off_limit
		and remaining_after_write_off > 0.001
		and not allow_partial_payment
		and not is_credit_sale
	):
		frappe.throw(
			_(
				"Write off amount exceeds the allowed limit ({0}). Please add payment for the remaining amount."
			).format(write_off_limit)
		)

	precision_write_off = invoice_doc.precision("write_off_amount") or 2
	precision_base_write_off = invoice_doc.precision("base_write_off_amount") or 2
	conversion_rate = flt(invoice_doc.get("conversion_rate") or 1)

	invoice_doc.write_off_amount = flt(effective_write_off, precision_write_off)
	invoice_doc.base_write_off_amount = flt(effective_write_off * conversion_rate, precision_base_write_off)


def _safe_date_string(value: str) -> str | None:
	if value in (None, ""):
		return None

	if isinstance(value, str):
		normalized = value.strip()
		if not normalized:
			return None
		if normalized.lower() in {"invalid date", "nan", "none", "null", "undefined"}:
			return None
		value = normalized

	try:
		return str(getdate(value))
	except Exception:
		return None


def _sanitize_delivery_dates(payload: dict):
	if not isinstance(payload, dict):
		return

	if "pos_delivery_date" in payload:
		payload["pos_delivery_date"] = _safe_date_string(payload.get("pos_delivery_date"))

	items = payload.get("items")
	if not isinstance(items, list):
		return

	for item in items:
		if isinstance(item, dict) and "delivery_date" in item:
			item["delivery_date"] = _safe_date_string(item.get("delivery_date"))


@frappe.whitelist()
def update_invoice(data: str) -> dict:
	currency_cache = {}
	data = json.loads(data)
	_sanitize_delivery_dates(data)
	_strip_client_freebies_from_payload(data)

	# Extract coupon/offer detail rows before doc creation – the frontend
	# sends ``coupons`` and ``offers`` as JSON-encoded name lists (strings)
	# which Frappe cannot process as child-table data.  The actual row data
	# arrives in ``coupons_detail`` / ``offers_detail`` instead.
	coupons_detail = data.pop("coupons_detail", None) or []
	data.pop("coupons", None)
	offers_detail = data.pop("offers_detail", None) or []
	data.pop("offers", None)

	pos_profile = data.get("pos_profile")
	doctype = get_invoice_type()

	data["doctype"] = doctype

	return_validity_enabled, default_validity_days = _get_return_validity_settings(pos_profile)

	if data.get("name"):
		invoice_doc = get_pos_invoice(doctype, data.get("name"), "write")
		invoice_doc.update(data)
	else:
		resolve_pos_profile(pos_profile)
		invoice_doc = frappe.get_doc(data)

	# Populate coupons child table from frontend detail rows
	_set_child_table_from_detail(invoice_doc, "coupons", coupons_detail, _coupon_row_fields)
	_set_child_table_from_detail(invoice_doc, "offers", offers_detail, _offer_row_fields)

	if (data.get("is_return") or invoice_doc.is_return) and invoice_doc.get("return_against"):
		from xpos.x_pos.api.invoice_processing.returns import validate_return_items

		validation = validate_return_items(
			invoice_doc.return_against,
			[d.as_dict() for d in invoice_doc.items],
			doctype=invoice_doc.doctype,
		)
		if not validation.get("valid"):
			frappe.throw(validation.get("message"))

	_validate_return_window(invoice_doc, doctype, return_validity_enabled)

	customer_name = invoice_doc.get("customer")
	if customer_name and not frappe.db.exists("Customer", customer_name):
		try:
			cust = frappe.get_doc(
				{
					"doctype": "Customer",
					"customer_name": customer_name,
					"customer_group": "All Customer Groups",
					"territory": "All Territories",
					"customer_type": "Individual",
				}
			)
			cust.flags.ignore_permissions = True
			cust.insert()
			invoice_doc.customer = cust.name
			invoice_doc.customer_name = cust.customer_name
		except Exception as e:
			frappe.log_error(f"Failed to create customer {customer_name}: {e}")

	effective_price_list = _resolve_effective_price_list(
		invoice_doc.get("customer"),
		invoice_doc.get("pos_profile") or pos_profile,
		invoice_doc.get("selling_price_list") or data.get("selling_price_list"),
	)
	if effective_price_list:
		invoice_doc.selling_price_list = effective_price_list

	selected_currency = data.get("currency")
	price_list_currency = data.get("price_list_currency")
	if not price_list_currency and invoice_doc.get("selling_price_list"):
		price_list_currency = frappe.db.get_value("Price List", invoice_doc.selling_price_list, "currency")

	overrides = {d.idx: {"item_name": d.item_name} for d in invoice_doc.items}
	locked_items = {}
	if invoice_doc.is_return:
		for d in invoice_doc.items:
			if d.get("locked_price"):
				locked_items[d.idx] = {
					"rate": d.rate,
					"price_list_rate": d.price_list_rate,
					"discount_percentage": d.discount_percentage,
					"discount_amount": d.discount_amount,
					"is_free_item": d.get("is_free_item"),
				}

	invoice_doc.ignore_pricing_rule = 1
	invoice_doc.flags.ignore_pricing_rule = True

	_deduplicate_free_items(invoice_doc)

	invoice_doc.set_missing_values()
	if effective_price_list:
		invoice_doc.selling_price_list = effective_price_list

	_set_return_valid_upto(invoice_doc, return_validity_enabled, default_validity_days)

	_apply_item_name_overrides(invoice_doc, overrides)

	_merge_duplicate_taxes(invoice_doc)

	if locked_items:
		for item in invoice_doc.items:
			locked = locked_items.get(item.idx)
			if locked:
				item.update(locked)
		invoice_doc.calculate_taxes_and_totals()

	company_currency = (
		frappe.get_cached_value("Company", invoice_doc.company, "default_currency") or invoice_doc.currency
	)

	if selected_currency:
		invoice_doc.currency = selected_currency
	price_list_currency = price_list_currency or company_currency

	conversion_rate = 1
	exchange_rate_date = invoice_doc.posting_date
	if invoice_doc.currency != company_currency:
		conversion_rate, exchange_rate_date = get_latest_rate(
			invoice_doc.currency,
			company_currency,
			cache=currency_cache,
		)
		if not conversion_rate or flt(conversion_rate) <= 0:
			frappe.throw(
				_(
					"Unable to find exchange rate for {0} to {1}. Please create a Currency Exchange record manually"
				).format(invoice_doc.currency, company_currency)
			)

		plc_conversion_rate = 1
		if price_list_currency != invoice_doc.currency:
			plc_conversion_rate, _ignored = get_latest_rate(
				price_list_currency,
				invoice_doc.currency,
				cache=currency_cache,
			)
			if not plc_conversion_rate or flt(plc_conversion_rate) <= 0:
				frappe.throw(
					_(
						"Unable to find exchange rate for {0} to {1}. Please create a Currency Exchange record manually"
					).format(price_list_currency, invoice_doc.currency)
				)

		invoice_doc.conversion_rate = conversion_rate
		invoice_doc.plc_conversion_rate = plc_conversion_rate
		invoice_doc.price_list_currency = price_list_currency

		for item in invoice_doc.items:
			if item.price_list_rate:
				item.base_price_list_rate = flt(
					item.price_list_rate * (conversion_rate / plc_conversion_rate),
					item.precision("base_price_list_rate"),
				)
			if item.rate:
				item.base_rate = flt(item.rate * conversion_rate, item.precision("base_rate"))
			if item.amount:
				item.base_amount = flt(item.amount * conversion_rate, item.precision("base_amount"))

		for payment in invoice_doc.payments:
			payment.base_amount = flt(payment.amount * conversion_rate, payment.precision("base_amount"))

		invoice_doc.base_total = flt(invoice_doc.total * conversion_rate, invoice_doc.precision("base_total"))
		invoice_doc.base_net_total = flt(
			invoice_doc.net_total * conversion_rate,
			invoice_doc.precision("base_net_total"),
		)
		invoice_doc.base_grand_total = flt(
			invoice_doc.grand_total * conversion_rate,
			invoice_doc.precision("base_grand_total"),
		)
		invoice_doc.base_rounded_total = flt(
			invoice_doc.rounded_total * conversion_rate,
			invoice_doc.precision("base_rounded_total"),
		)
		invoice_doc.base_in_words = money_in_words(invoice_doc.base_rounded_total, company_currency)

		data["conversion_rate"] = conversion_rate
		data["plc_conversion_rate"] = plc_conversion_rate
		data["exchange_rate_date"] = exchange_rate_date

	inclusive = frappe.get_cached_value("POS Profile", invoice_doc.pos_profile, "tax_inclusive")
	if invoice_doc.get("taxes"):
		for tax in invoice_doc.taxes:
			if tax.charge_type == "Actual":
				tax.included_in_print_rate = 0
			else:
				tax.included_in_print_rate = 1 if inclusive else 0

	if invoice_doc.is_return:
		for payment in invoice_doc.payments:
			payment.amount = -abs(payment.amount)
			payment.base_amount = -abs(payment.base_amount)

		invoice_doc.paid_amount = flt(sum(p.amount for p in invoice_doc.payments))
		invoice_doc.base_paid_amount = flt(sum(p.base_amount for p in invoice_doc.payments))

	invoice_doc.flags.ignore_permissions = True
	frappe.flags.ignore_account_permission = True
	invoice_doc.docstatus = 0
	invoice_doc.save()

	response = invoice_doc.as_dict()
	response["conversion_rate"] = invoice_doc.conversion_rate
	response["plc_conversion_rate"] = invoice_doc.plc_conversion_rate
	response["exchange_rate_date"] = exchange_rate_date
	return response


@frappe.whitelist()
def submit_invoice(invoice: str, data: str | dict, submit_in_background: bool = False) -> dict:
	from xpos.x_pos.api.invoice_processing.payment import _create_change_payment_entries

	if isinstance(data, str):
		data = json.loads(data)
	if isinstance(invoice, str):
		invoice = json.loads(invoice)

	_sanitize_delivery_dates(invoice)
	submit_in_background = cint(submit_in_background)
	_strip_client_freebies_from_payload(invoice)

	# Extract coupon/offer detail rows – same as update_invoice.
	coupons_detail = invoice.pop("coupons_detail", None) or []
	invoice.pop("coupons", None)
	offers_detail = invoice.pop("offers_detail", None) or []
	invoice.pop("offers", None)

	pos_profile = invoice.get("pos_profile")
	doctype = get_invoice_type()
	invoice_name = invoice.get("name")
	if not invoice_name or not frappe.db.exists(doctype, invoice_name):
		# Re-inject detail rows so update_invoice can process them.
		if coupons_detail:
			invoice["coupons_detail"] = coupons_detail
		if offers_detail:
			invoice["offers_detail"] = offers_detail
		created = update_invoice(json.dumps(invoice))
		invoice_name = created.get("name")
		invoice_doc = frappe.get_doc(doctype, invoice_name)
	else:
		if "modified" in invoice:
			del invoice["modified"]
		invoice_doc = get_pos_invoice(doctype, invoice_name, "write")

		if invoice_doc.docstatus == 1:
			return {"name": invoice_doc.name, "status": invoice_doc.docstatus}
		if invoice_doc.docstatus == 2:
			frappe.throw(_("Invoice {0} has been cancelled and cannot be submitted.").format(invoice_name))

		invoice_doc.update(invoice)

		# Populate coupons/offers child tables
		_set_child_table_from_detail(invoice_doc, "coupons", coupons_detail, _coupon_row_fields)
		_set_child_table_from_detail(invoice_doc, "offers", offers_detail, _offer_row_fields)

	_deduplicate_free_items(invoice_doc)

	if invoice_doc.redeem_loyalty_points and not invoice_doc.loyalty_program:
		invoice_doc.loyalty_program = frappe.db.get_value("Customer", invoice_doc.customer, "loyalty_program")

	if invoice_doc.redeem_loyalty_points and invoice_doc.loyalty_program:
		if not invoice_doc.loyalty_redemption_account:
			invoice_doc.loyalty_redemption_account = frappe.db.get_value(
				"Loyalty Program", invoice_doc.loyalty_program, "expense_account"
			)

		if not invoice_doc.loyalty_redemption_cost_center:
			invoice_doc.loyalty_redemption_cost_center = invoice_doc.cost_center or frappe.db.get_value(
				"POS Profile", pos_profile, "cost_center"
			)

	_apply_item_name_overrides(invoice_doc)
	if invoice.get("pos_delivery_date"):
		invoice_doc.update_stock = 0
	mop_cash_list = [
		i.mode_of_payment
		for i in invoice_doc.payments
		if "cash" in i.mode_of_payment.lower() and i.type == "Cash"
	]
	if len(mop_cash_list) > 0:
		cash_account = get_bank_cash_account(mop_cash_list[0], invoice_doc.company)
	else:
		cash_account = {"account": frappe.get_value("Company", invoice_doc.company, "default_cash_account")}

	invoice_doc.remarks = _build_invoice_remarks(invoice_doc)

	total_cash = 0
	if data.get("redeemed_customer_credit"):
		total_cash = invoice_doc.total - float(data.get("redeemed_customer_credit"))

	is_payment_entry = 0
	if data.get("redeemed_customer_credit"):
		for row in data.get("customer_credit_dict"):
			if row["type"] == "Advance" and row["credit_to_redeem"]:
				advance = frappe.db.get_value(
					"Payment Entry",
					row["credit_origin"],
					["name", "remarks", "unallocated_amount"],
					as_dict=True,
				)

				advance_payment = {
					"reference_type": "Payment Entry",
					"reference_name": advance.get("name"),
					"remarks": advance.get("remarks"),
					"advance_amount": advance.get("unallocated_amount"),
					"allocated_amount": row["credit_to_redeem"],
				}

				advance_row = invoice_doc.append("advances", {})
				advance_row.update(advance_payment)
				child_dt = (
					"POS Invoice Advance" if invoice_doc.doctype == "POS Invoice" else "Sales Invoice Advance"
				)
				ensure_child_doctype(invoice_doc, "advances", child_dt)
				invoice_doc.is_pos = 0
				is_payment_entry = 1

	payments = invoice_doc.payments

	_auto_set_return_batches(invoice_doc)

	set_batch_nos_for_bundles(invoice_doc, "warehouse", throw=True)

	validate_stock_on_invoice(invoice_doc)

	_apply_write_off_settings(invoice_doc, data)

	invoice_doc.flags.ignore_permissions = True
	frappe.flags.ignore_account_permission = True
	invoice_doc.printed = 1
	invoice_doc.save()

	if data.get("due_date"):
		frappe.db.set_value(
			invoice_doc.doctype,
			invoice_doc.name,
			"due_date",
			data.get("due_date"),
			update_modified=False,
		)

	allow_background_submit = frappe.get_value(
		"POS Profile",
		invoice_doc.pos_profile,
		"allow_submissions_in_background_job",
	)

	if submit_in_background and allow_background_submit:
		enqueue(
			method=submit_in_background_job,
			queue="default",
			timeout=3000,
			is_async=True,
			kwargs={
				"invoice": invoice_doc.name,
				"doctype": invoice_doc.doctype,
				"data": data,
				"is_payment_entry": is_payment_entry,
				"total_cash": total_cash,
				"cash_account": cash_account,
				"payments": payments,
			},
		)
	else:
		invoice_doc.submit()

		_create_change_payment_entries(invoice_doc, data, pos_profile, cash_account)
		redeeming_customer_credit(invoice_doc, data, is_payment_entry, total_cash, cash_account, payments)

	return {"name": invoice_doc.name, "status": invoice_doc.docstatus}


def submit_in_background_job(*args, **kwargs):
	from xpos.x_pos.api.invoice_processing.payment import _create_change_payment_entries

	invoice = kwargs.get("invoice")
	try:
		doctype = kwargs.get("doctype") or "Sales Invoice"
		data = kwargs.get("data") or {}
		is_payment_entry = kwargs.get("is_payment_entry")
		total_cash = kwargs.get("total_cash")
		cash_account = kwargs.get("cash_account")
		payments = kwargs.get("payments") or []

		invoice_doc = frappe.get_doc(doctype, invoice)

		if invoice_doc.docstatus == 1:
			return

		invoice_doc.flags.ignore_permissions = True
		frappe.flags.ignore_account_permission = True

		validate_stock_on_invoice(invoice_doc)
		if hasattr(invoice_doc, "validate_credit_limit"):
			invoice_doc.validate_credit_limit()

		invoice_doc.remarks = _build_invoice_remarks(invoice_doc)

		_apply_write_off_settings(invoice_doc, data)

		if invoice_doc.redeem_loyalty_points and not invoice_doc.loyalty_program:
			invoice_doc.loyalty_program = frappe.db.get_value(
				"Customer", invoice_doc.customer, "loyalty_program"
			)

		if invoice_doc.redeem_loyalty_points and invoice_doc.loyalty_program:
			if not invoice_doc.loyalty_redemption_account:
				invoice_doc.loyalty_redemption_account = frappe.db.get_value(
					"Loyalty Program", invoice_doc.loyalty_program, "expense_account"
				)

			if not invoice_doc.loyalty_redemption_cost_center:
				invoice_doc.loyalty_redemption_cost_center = invoice_doc.cost_center

		invoice_doc.save()

		invoice_doc.submit()

		_create_change_payment_entries(invoice_doc, data, invoice_doc.pos_profile, cash_account)
		redeeming_customer_credit(invoice_doc, data, is_payment_entry, total_cash, cash_account, payments)

	except Exception as e:
		frappe.db.rollback()
		error_msg = str(e)
		frappe.log_error(f"POS Background Submission Failed for {invoice}: {error_msg}")
		frappe.publish_realtime(
			"pos_invoice_submit_error",
			{"invoice": invoice, "error": error_msg},
			user=frappe.session.user,
		)


@frappe.whitelist()
def validate_cart_items(items: list, pos_profile: str | None = None):
	"""Validate cart items for available stock.

	Returns a list of item dicts where requested quantity exceeds availability.
	This can be used on the front-end for pre-submission checks.
	"""

	if isinstance(items, str):
		items = json.loads(items)

	if pos_profile and not frappe.db.exists("POS Profile", pos_profile):
		pos_profile = None

	if not _should_block(pos_profile):
		return []

	errors = _collect_stock_errors(items, pos_profile=pos_profile)
	if not errors:
		return []

	return errors
