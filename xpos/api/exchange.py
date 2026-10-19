# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""
Tender currency and exchange rate resolution for mixed-currency cash payments.
"""

import frappe
from frappe import _
from frappe.utils import cint, flt, getdate, nowdate

from xpos.x_pos.api.invoice_processing.utils import get_latest_rate

DEFAULT_CURRENCY_PRECISION = 2


def get_currency_precision(currency: str) -> int:
	"""Return the number of decimals `currency` is quoted in, e.g. 0 for PKR, 2 for USD."""
	if not currency:
		return DEFAULT_CURRENCY_PRECISION

	number_format = frappe.db.get_value("Currency", currency, "number_format")
	if not number_format:
		return DEFAULT_CURRENCY_PRECISION

	from frappe.utils.number_format import NumberFormat

	try:
		return NumberFormat.from_string(number_format).precision
	except KeyError:
		return DEFAULT_CURRENCY_PRECISION


def get_currency_meta(currency: str) -> dict:
	"""Return the display metadata the POS needs to render amounts in `currency`."""
	row = (
		frappe.db.get_value(
			"Currency",
			currency,
			["name", "symbol", "number_format", "smallest_currency_fraction_value", "symbol_on_right"],
			as_dict=True,
		)
		or frappe._dict()
	)
	return {
		"currency": currency,
		"symbol": row.get("symbol") or currency,
		"precision": get_currency_precision(currency),
		"smallest_fraction": flt(row.get("smallest_currency_fraction_value")),
		"symbol_on_right": cint(row.get("symbol_on_right")),
	}


def resolve_tender_rate(
	currency: str,
	company_currency: str,
	posting_date: str | None = None,
	cache: dict | None = None,
) -> tuple[float, str]:
	"""Return ``(rate, rate_date)`` converting one unit of `currency` into `company_currency`."""
	posting_date = posting_date or nowdate()

	if not currency or currency == company_currency:
		return 1.0, str(getdate(posting_date))

	key = (currency, company_currency, str(posting_date))
	if cache is not None and key in cache:
		return cache[key]

	rows = frappe.get_all(
		"Currency Exchange",
		filters={
			"from_currency": currency,
			"to_currency": company_currency,
			"date": ["<=", posting_date],
			"for_selling": 1,
		},
		fields=["exchange_rate", "date"],
		order_by="date desc, creation desc",
		limit=1,
	)

	if rows:
		result = (flt(rows[0].exchange_rate), str(getdate(rows[0].date)))
	else:
		rate, rate_date = get_latest_rate(currency, company_currency)

		if rate:
			frappe.log_error(
				f"No Currency Exchange record for {currency} to {company_currency} dated on or "
				f"before {posting_date} with For Selling set. Fell back to {rate} "
				f"dated {rate_date}, which may not reflect the posting date.",
				"XPOS Tender Rate Fallback",
			)

		result = (flt(rate), str(getdate(rate_date)) if rate_date else str(getdate(posting_date)))

	if cache is not None:
		cache[key] = result

	return result


def tender_currency_field_exists() -> bool:
	"""Whether the tender currency custom field has been migrated onto Mode of Payment yet."""
	return bool(frappe.db.has_column("Mode of Payment", "pos_tender_currency"))


def payment_tender_fields_exist() -> bool:
	"""Whether the tender columns have been migrated onto Sales Invoice Payment yet."""
	return bool(frappe.db.has_column("Sales Invoice Payment", "pos_tender_currency"))


def change_leg_table_exists() -> bool:
	"""Whether the POS Change Leg child table has been created yet."""
	return bool(frappe.db.table_exists("POS Change Leg"))


def get_mode_tender_currencies(modes: list[str]) -> dict[str, dict]:
	"""Return ``{mode_of_payment: {"currency": str | None, "type": str}}`` in one query."""
	if not modes:
		return {}

	fields = ["name", "type"]
	if tender_currency_field_exists():
		fields.append("pos_tender_currency")

	rows = frappe.get_all(
		"Mode of Payment",
		filters={"name": ["in", list(set(modes))]},
		fields=fields,
	)
	return {
		row.name: {"currency": row.get("pos_tender_currency") or None, "type": row.type or ""} for row in rows
	}


def resolve_mode_tender_currency(mode_of_payment: str) -> str | None:
	"""Return the tender currency tagged on `mode_of_payment`, or None when untagged."""
	if not mode_of_payment or not tender_currency_field_exists():
		return None
	return frappe.db.get_value("Mode of Payment", mode_of_payment, "pos_tender_currency") or None


def build_tender_rate_payload(pos_profile_doc, posting_date: str | None = None) -> list[dict]:
	"""Return one row per payment mode on the profile, with its currency and today's rate."""
	from xpos.x_pos.doctype.pos_closing_shift.closing_processing.reclass import (
		per_payment_modes,
		reference_required_modes,
	)

	posting_date = posting_date or nowdate()
	company_currency = frappe.get_cached_value("Company", pos_profile_doc.company, "default_currency")

	modes = [row.mode_of_payment for row in pos_profile_doc.get("payments") or [] if row.mode_of_payment]
	tender_map = get_mode_tender_currencies(modes)

	rate_cache: dict = {}
	meta_cache: dict = {}
	takes_reference = per_payment_modes(pos_profile_doc.company)
	needs_reference = reference_required_modes(pos_profile_doc.company)
	payload = []

	for mode in modes:
		details = tender_map.get(mode) or {}
		currency = details.get("currency") or company_currency
		rate, rate_date = resolve_tender_rate(currency, company_currency, posting_date, rate_cache)

		if currency not in meta_cache:
			meta_cache[currency] = get_currency_meta(currency)

		payload.append(
			{
				"mode_of_payment": mode,
				"type": details.get("type") or "",
				"is_foreign_tender": currency != company_currency,
				"takes_reference": mode in takes_reference,
				"requires_reference": mode in needs_reference,
				"exchange_rate": rate,
				"rate_date": rate_date,
				**meta_cache[currency],
			}
		)

	return payload


@frappe.whitelist()
def get_tender_rates(pos_profile: str) -> dict:
	"""Return the tender currency and current rate for every payment mode on `pos_profile`."""
	if not pos_profile:
		frappe.throw(_("POS Profile is required"))

	profile = frappe.get_cached_doc("POS Profile", pos_profile)
	company_currency = frappe.get_cached_value("Company", profile.company, "default_currency")

	return {
		"company_currency": company_currency,
		"company_currency_meta": get_currency_meta(company_currency),
		"posting_date": nowdate(),
		"modes": build_tender_rate_payload(profile),
	}
