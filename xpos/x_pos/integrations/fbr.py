import json
import re
from dataclasses import dataclass
from typing import Any

import frappe
import requests
import urllib3
from frappe import _
from frappe.utils import cint, cstr, flt, now_datetime

FBR_SANDBOX_URL = "https://esp.fbr.gov.pk:8244/FBR/v1/api/Live/PostData"
FBR_PRODUCTION_URL = "https://gw.fbr.gov.pk/imsp/v1/api/Live/PostData"
DEFAULT_LOCAL_SERVICE_URL = "http://localhost:8524"
LOCAL_SERVICE_PATH = "/api/IMSFiscal/GetInvoiceNumberByModel"
FBR_REQUEST_TIMEOUT = (5, 25)
FBR_SUCCESS_CODES = {"100", 100}
PERCENTAGE_CHARGE_TYPES = {"On Net Total", "On Previous Row Amount", "On Previous Row Total"}
_CONTROL_CHAR_PATTERN = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")
_NTN_PATTERN = re.compile(r"^\d{7}-?\d$")
_CNIC_PATTERN = re.compile(r"^\d{5}-?\d{7}-?\d$")


class FBRIntegrationError(frappe.ValidationError):
	"""Raised when FBR fiscalization cannot be completed."""


class FBRConnectionError(FBRIntegrationError):
	"""Raised specifically when the FBR cloud API is unreachable (internet down).

	Distinct from a business rejection so callers can fall back to the local
	fiscalization service instead of failing the sale. ``sent`` is True when the
	request may have reached FBR (e.g. a read timeout): the outcome is then unknown.
	"""

	sent = False


class FBRUncertainError(FBRIntegrationError):
	"""FBR may have recorded the invoice but did not answer; it must not be fiscalized again blindly."""


@dataclass(frozen=True)
class FBRSettings:
	enabled: bool
	environment: str
	pos_id: str
	bearer_token: str
	api_url: str
	skip_ssl_verification: bool
	local_service_url: str


@dataclass(frozen=True)
class FiscalizationOutcome:
	"""Result of attempting to obtain an FBR fiscal invoice number.

	status:
	  - "disabled"       - FBR is off, not a POS invoice, or already fiscalized.
	  - "cloud"          - number obtained from the FBR cloud API.
	  - "local_required" - cloud is unreachable; the client should call the local
	                       fiscalization service with ``payload`` and finalize.
	  - "uncertain"      - the request may have reached FBR but no answer came back,
	                       or the invoice is already marked so. Nothing is retried.
	"""

	status: str
	fbr_invoice_number: str | None = None
	payload: dict[str, Any] | None = None
	local_service_url: str | None = None
	posted_on: Any = None


def prepare_fiscalization(doc: Any) -> FiscalizationOutcome:
	"""Attempt cloud fiscalization; report whether a local fallback is needed.

	Does not mutate the document. Every request is recorded in the fiscal ledger first, so
	a number FBR issued survives a rollback: a later attempt for the same sale id reuses it
	without calling FBR. A request that may have reached FBR is never sent again until an
	FBR check records that it is not there. When the FBR cloud API is unreachable, returns
	a ``local_required`` outcome with the payload for the local service.
	"""
	from xpos.x_pos.integrations import fiscal_ledger

	if not cint(_get_doc_value(doc, "is_pos", 0)):
		return FiscalizationOutcome("disabled")

	pos_profile = cstr(_get_doc_value(doc, "pos_profile", "")).strip()
	if not pos_profile:
		return FiscalizationOutcome("disabled")

	if cstr(_get_doc_value(doc, "fbr_invoice_number", "")).strip():
		return FiscalizationOutcome("disabled")

	settings = _get_fbr_settings(pos_profile)
	if not settings.enabled:
		return FiscalizationOutcome("disabled")

	payload = _build_payload(doc, settings)
	known = fiscal_ledger.begin_cloud_attempt(
		doc,
		settings.pos_id,
		payload["USIN"],
		payload,
		held_uncertain=_get_doc_value(doc, "xpos_fiscal_state", "") == "Uncertain",
	)
	if known.kind == "recorded":
		return recorded_outcome(known, payload)
	if known.kind == "pending":
		return FiscalizationOutcome("uncertain", payload=payload)

	try:
		response_data = _post_invoice(doc, payload, settings)
	except FBRConnectionError as exc:
		fiscal_ledger.finish_attempt(known.attempt, "Uncertain" if exc.sent else "Not Sent", response=exc)
		if exc.sent:
			return FiscalizationOutcome("uncertain", payload=payload)
		return FiscalizationOutcome(
			"local_required", payload=payload, local_service_url=settings.local_service_url
		)
	except FBRIntegrationError as exc:
		fiscal_ledger.finish_attempt(known.attempt, "Rejected", response=exc)
		raise
	except Exception as exc:
		fiscal_ledger.finish_attempt(known.attempt, "Uncertain", response=exc)
		raise

	invoice_number = cstr(_extract_value(response_data, "FBRInvoiceNumber", "InvoiceNumber") or "").strip()
	response_code = cstr(_extract_value(response_data, "Code", default="")).strip()
	response_message = cstr(
		_extract_value(response_data, "Response", "Message", "message", default="")
	).strip()

	if response_code and response_code not in {str(code) for code in FBR_SUCCESS_CODES}:
		fiscal_ledger.finish_attempt(known.attempt, "Rejected", response=json.dumps(response_data))
		raise FBRIntegrationError(response_message or _("FBR did not return a fiscal invoice number."))
	if not invoice_number:
		# FBR answered without saying whether it recorded the sale.
		fiscal_ledger.finish_attempt(known.attempt, "Uncertain", response=json.dumps(response_data))
		return FiscalizationOutcome("uncertain", payload=payload)

	posted_on = now_datetime()
	fiscal_ledger.finish_attempt(
		known.attempt, "Accepted", invoice_number, posted_on, json.dumps(response_data)
	)
	return FiscalizationOutcome("cloud", fbr_invoice_number=invoice_number, posted_on=posted_on)


def recorded_outcome(known: Any, payload: dict[str, Any]) -> FiscalizationOutcome:
	"""Reuse the number FBR already issued for this sale id, if the sale still matches it."""
	from xpos.x_pos.integrations import fiscal_ledger

	if known.content_hash and known.content_hash != fiscal_ledger.content_hash(payload):
		raise FBRIntegrationError(
			_(
				"FBR already holds sale {0} as invoice {1}, with different lines, amounts or payment "
				"mode. Ring it up exactly as it was first sent, or ask a supervisor to review attempt {2}."
			).format(payload.get("USIN"), known.number, known.attempt)
		)
	return FiscalizationOutcome("cloud", fbr_invoice_number=known.number, posted_on=known.posted_on)


def ledger_outcome(doc: Any) -> FiscalizationOutcome | None:
	"""What the fiscal ledger already knows for this draft, without sending anything.

	``cloud`` when FBR holds a number for it, ``uncertain`` when it may, else ``None``.
	"""
	from xpos.x_pos.integrations import fiscal_ledger

	pos_profile = cstr(_get_doc_value(doc, "pos_profile", "")).strip()
	if not cint(_get_doc_value(doc, "is_pos", 0)) or not pos_profile:
		return None
	settings = _get_fbr_settings(pos_profile)
	if not settings.enabled:
		return None
	payload = _build_payload(doc, settings)
	known = fiscal_ledger.lookup(settings.pos_id, payload["USIN"])
	if known.kind == "recorded":
		return recorded_outcome(known, payload)
	if known.kind == "pending":
		return FiscalizationOutcome("uncertain", payload=payload)
	return None


def record_local_result(doc: Any, invoice_number: str | None) -> None:
	"""Keep what the local FBR service answered (``None``: no answer) in the fiscal ledger."""
	from xpos.x_pos.integrations import fiscal_ledger

	settings = _get_fbr_settings(cstr(_get_doc_value(doc, "pos_profile", "")).strip())
	if not settings.enabled:
		return
	payload = _build_payload(doc, settings)
	fiscal_ledger.record_local(doc, settings.pos_id, payload["USIN"], payload, invoice_number)


def fbr_pos_id(pos_profile: str) -> str:
	"""The profile's FBR POS ID; FBR must be enabled on it."""
	settings = _get_fbr_settings(pos_profile)
	if not settings.enabled:
		frappe.throw(_("FBR integration is not enabled on POS Profile {0}.").format(pos_profile))
	return settings.pos_id


def local_fiscalization_outcome(doc: Any) -> FiscalizationOutcome:
	"""The local-service handshake for a draft already waiting for it; FBR's cloud is not called again."""
	settings = _get_fbr_settings(cstr(_get_doc_value(doc, "pos_profile", "")).strip())
	return FiscalizationOutcome(
		"local_required", payload=_build_payload(doc, settings), local_service_url=settings.local_service_url
	)


def apply_fiscal_number(doc: Any, invoice_number: str, posted_on: Any = None) -> None:
	"""Write a fiscal invoice number (from cloud or local service) onto the document."""
	_set_field_if_available(doc, "fbr_invoice_number", cstr(invoice_number).strip())
	_set_field_if_available(doc, "fbr_posted_on", posted_on or now_datetime())


def fiscalize_invoice(doc: Any) -> None:
	"""Fiscalize a POS invoice at submit time (cloud channel).

	Used by the ``before_submit`` hook. The interactive POS flow pre-fiscalizes in
	``create_invoice`` (which can fall back to the local service), setting the number
	first - so this becomes a no-op there. For any other submit path (e.g. background
	submit) it fiscalizes against the FBR cloud and hard-fails if unreachable, since
	no client is present to drive the local fallback.
	"""
	outcome = prepare_fiscalization(doc)
	if outcome.status == "cloud":
		apply_fiscal_number(doc, outcome.fbr_invoice_number, outcome.posted_on)
	elif outcome.status == "uncertain":
		raise FBRUncertainError(
			_(
				"FBR may have received invoice {0} without answering. Check the FBR records "
				"before fiscalizing it again."
			).format(_get_doc_value(doc, "name", ""))
		)
	elif outcome.status == "local_required":
		raise FBRConnectionError(
			_(
				"FBR cloud API is unreachable and the local fiscalization service can only be "
				"reached from the POS terminal. Complete this sale from the POS screen."
			)
		)


def _get_fbr_settings(pos_profile: str) -> FBRSettings:
	profile_doc = frappe.get_doc("POS Profile", pos_profile)
	enabled = cint(getattr(profile_doc, "enable_fbr_integration", 0))
	if not enabled:
		return FBRSettings(
			enabled=False,
			environment="Sandbox",
			pos_id="",
			bearer_token="",
			api_url=FBR_SANDBOX_URL,
			skip_ssl_verification=False,
			local_service_url=DEFAULT_LOCAL_SERVICE_URL,
		)

	environment = cstr(getattr(profile_doc, "fbr_environment", "Sandbox") or "Sandbox").strip()
	pos_id = cstr(getattr(profile_doc, "fbr_pos_id", "") or "").strip()
	bearer_token = cstr(profile_doc.get_password("fbr_bearer_token") or "").strip()
	api_url = cstr(getattr(profile_doc, "fbr_api_url", "") or "").strip() or _default_api_url(environment)
	skip_ssl_verification = cint(getattr(profile_doc, "fbr_skip_ssl_verification", 0)) == 1
	local_service_url = (
		cstr(getattr(profile_doc, "fbr_local_service_url", "") or "").strip().rstrip("/")
		or DEFAULT_LOCAL_SERVICE_URL
	)

	missing = []
	if not pos_id:
		missing.append(_("FBR POS ID"))
	if not bearer_token:
		missing.append(_("FBR Bearer Token"))

	if missing:
		raise FBRIntegrationError(
			_("FBR integration is enabled on POS Profile {0}, but these fields are missing: {1}").format(
				pos_profile, ", ".join(missing)
			)
		)

	return FBRSettings(
		enabled=True,
		environment=environment,
		pos_id=pos_id,
		bearer_token=bearer_token,
		api_url=api_url,
		skip_ssl_verification=skip_ssl_verification,
		local_service_url=local_service_url,
	)


def _default_api_url(environment: str) -> str:
	return FBR_PRODUCTION_URL if cstr(environment).strip().lower() == "production" else FBR_SANDBOX_URL


def _build_payload(doc: Any, settings: FBRSettings) -> dict[str, Any]:
	item_cache: dict[str, dict[str, Any]] = {}
	is_return = cint(_get_doc_value(doc, "is_return", 0)) == 1
	invoice_type = 3 if is_return else 1
	items = []
	total_sale_value = 0.0
	total_tax_charged = 0.0
	total_discount = abs(_company_amount(doc, "discount_amount"))
	total_quantity = 0.0

	for item in _get_doc_value(doc, "items", []) or []:
		qty = abs(flt(_get_doc_value(item, "qty", 0)))
		if qty <= 0:
			continue

		item_code = cstr(_get_doc_value(item, "item_code", "")).strip()
		item_meta = _get_item_metadata(item_code, item_cache)
		pct_code = cstr(item_meta.get("customs_tariff_number") or "").strip()
		if not pct_code:
			raise FBRIntegrationError(
				_("Item {0} is missing Customs Tariff Number, which FBR requires as the PCT Code.").format(
					item_code or _get_doc_value(item, "item_name", _("Unknown Item"))
				)
			)

		line_invoice_type = _resolve_item_invoice_type(is_return, item_meta)
		actual_sale_value = abs(_company_amount(item, "net_amount")) or abs(_company_amount(item, "amount"))
		gross_sale_value = (
			abs(flt(_get_doc_value(item, "price_list_rate", 0) or _get_doc_value(item, "rate", 0))) * qty
		)
		line_discount = max(gross_sale_value - actual_sale_value, 0.0)
		line_tax_charged, line_tax_rate = _resolve_item_tax(item, doc, actual_sale_value)
		line_total = abs(_company_amount(item, "amount")) or (actual_sale_value + line_tax_charged)

		items.append(
			{
				"ItemCode": item_code,
				"ItemName": _sanitize_text(_get_doc_value(item, "item_name", item_code), max_length=150),
				"Quantity": qty,
				"PCTCode": pct_code,
				"TaxRate": line_tax_rate,
				"SaleValue": actual_sale_value,
				"TotalAmount": line_total,
				"TaxCharged": line_tax_charged,
				"Discount": line_discount,
				"FurtherTax": 0.0,
				"InvoiceType": line_invoice_type,
				"RefUSIN": _get_reference_usin(doc) if is_return else None,
			}
		)

		total_sale_value += actual_sale_value
		total_tax_charged += line_tax_charged
		total_discount += line_discount
		total_quantity += qty

	buyer_name = _sanitize_text(_get_doc_value(doc, "customer_name", ""), max_length=150)
	buyer_phone = _sanitize_text(
		_get_doc_value(doc, "contact_mobile", "") or _get_doc_value(doc, "contact_phone", ""),
		max_length=20,
	)
	buyer_ntn, buyer_cnic = _split_tax_identifier(_get_doc_value(doc, "tax_id", ""))

	return {
		"InvoiceNumber": "",
		"POSID": _coerce_pos_id(settings.pos_id),
		"USIN": _sanitize_text(
			_get_doc_value(doc, "xpos_local_id", "") or _get_doc_value(doc, "name", ""),
			max_length=50,
		),
		"DateTime": _build_posting_datetime(doc),
		"BuyerNTN": buyer_ntn,
		"BuyerCNIC": buyer_cnic,
		"BuyerName": buyer_name,
		"BuyerPhoneNumber": buyer_phone,
		"TotalBillAmount": abs(_company_amount(doc, "rounded_total"))
		or abs(_company_amount(doc, "grand_total")),
		"TotalQuantity": total_quantity,
		"TotalSaleValue": total_sale_value,
		"TotalTaxCharged": total_tax_charged,
		"Discount": total_discount,
		"FurtherTax": 0.0,
		"PaymentMode": _resolve_payment_mode(doc),
		"RefUSIN": _get_reference_usin(doc) if is_return else None,
		"InvoiceType": invoice_type,
		"Items": items,
	}


def _post_invoice(doc: Any, payload: dict[str, Any], settings: FBRSettings) -> dict[str, Any]:
	headers = {
		"Authorization": f"Bearer {settings.bearer_token}",
		"Accept": "application/json",
		"Content-Type": "application/json",
	}

	try:
		response = requests.post(
			settings.api_url,
			json=payload,
			headers=headers,
			timeout=FBR_REQUEST_TIMEOUT,
			verify=not settings.skip_ssl_verification,
		)
	except requests.RequestException as exc:
		frappe.log_error(
			f"Invoice: {_get_doc_value(doc, 'name', '')}\nURL: {settings.api_url}\nError: {exc}\nPayload: {json.dumps(payload, default=str)}",
			"X POS FBR Request Error",
		)
		error = FBRConnectionError(_("FBR API call failed: {0}").format(cstr(exc)))
		error.sent = request_may_have_reached_fbr(exc)
		raise error from exc

	response_data = _parse_response(response)
	if response.status_code >= 500:
		# A gateway error can come after FBR recorded the invoice.
		frappe.log_error(
			f"Invoice: {_get_doc_value(doc, 'name', '')}\nStatus: {response.status_code}\nResponse: {response.text}",
			"X POS FBR Response Error",
		)
		error = FBRConnectionError(_("FBR answered HTTP {0}.").format(response.status_code))
		error.sent = True
		raise error
	if response.status_code >= 400:
		message = cstr(
			_extract_value(
				response_data, "Response", "Message", "message", default=response.text or response.reason
			)
		).strip()
		frappe.log_error(
			(
				f"Invoice: {_get_doc_value(doc, 'name', '')}\n"
				f"Status: {response.status_code}\n"
				f"URL: {settings.api_url}\n"
				f"Payload: {json.dumps(payload, default=str)}\n"
				f"Response: {response.text}"
			),
			"X POS FBR Response Error",
		)
		if response.status_code in {401, 403}:
			message = message or _(
				"FBR rejected the request. Check the bearer token and IP whitelist configured on the FBR portal."
			)
		raise FBRIntegrationError(message or _("FBR rejected the invoice request."))

	return response_data


def request_may_have_reached_fbr(exc: requests.RequestException) -> bool:
	"""False only when the connection itself failed, so FBR cannot have seen the invoice."""
	if isinstance(
		exc, requests.ConnectTimeout | requests.exceptions.SSLError | requests.exceptions.InvalidURL
	):
		return False
	if isinstance(exc, requests.ConnectionError):
		reason = getattr(exc.args[0], "reason", None) if exc.args else None
		return not isinstance(reason, urllib3.exceptions.NewConnectionError)
	return not isinstance(exc, requests.exceptions.MissingSchema | requests.exceptions.InvalidSchema)


def _parse_response(response: requests.Response) -> dict[str, Any]:
	try:
		payload = response.json()
		return payload if isinstance(payload, dict) else {"data": payload}
	except ValueError:
		text = cstr(response.text).strip()
		if not text:
			return {}
		try:
			payload = json.loads(text)
			return payload if isinstance(payload, dict) else {"data": payload}
		except ValueError:
			return {"message": text}


def _extract_value(data: dict[str, Any], *keys: str, default: Any = None) -> Any:
	for key in keys:
		if key in data and data[key] not in (None, ""):
			return data[key]
	return default


def _resolve_payment_mode(doc: Any) -> int:
	payments = [
		payment
		for payment in (_get_doc_value(doc, "payments", []) or [])
		if abs(flt(_get_doc_value(payment, "amount", 0))) > 0
	]
	if len(payments) > 1:
		return 5
	if not payments:
		return 1

	payment = payments[0]
	mode_name = cstr(_get_doc_value(payment, "mode_of_payment", "")).strip()
	configured_code = cstr(
		frappe.db.get_value("Mode of Payment", mode_name, "fbr_payment_mode_code") or ""
	).strip()
	if configured_code:
		return cint(configured_code)

	mode_name_lower = mode_name.lower()
	if "cash" in mode_name_lower:
		return 1
	if "card" in mode_name_lower or "visa" in mode_name_lower or "master" in mode_name_lower:
		return 2
	if "gift" in mode_name_lower or "voucher" in mode_name_lower:
		return 3
	if "loyalty" in mode_name_lower:
		return 4
	if "cheque" in mode_name_lower or "check" in mode_name_lower:
		return 6

	raise FBRIntegrationError(
		_(
			"Mode of Payment {0} is not mapped to an FBR Payment Mode Code. Configure the FBR Payment Mode Code field on that Mode of Payment."
		).format(mode_name)
	)


def _get_reference_usin(doc: Any) -> str | None:
	return_against = cstr(_get_doc_value(doc, "return_against", "")).strip()
	if not return_against:
		return None

	for doctype in (_get_doc_value(doc, "doctype", ""), "Sales Invoice", "POS Invoice"):
		if doctype and frappe.db.exists(doctype, return_against):
			return return_against

	return return_against


def _resolve_item_invoice_type(is_return: bool, item_meta: dict[str, Any]) -> int:
	if cint(item_meta.get("fbr_third_schedule", 0)):
		return 12 if is_return else 11
	return 3 if is_return else 1


def _get_item_metadata(item_code: str, cache: dict[str, dict[str, Any]]) -> dict[str, Any]:
	if item_code not in cache:
		cache[item_code] = (
			frappe.db.get_value(
				"Item",
				item_code,
				["customs_tariff_number", "fbr_third_schedule"],
				as_dict=True,
			)
			or {}
		)
	return cache[item_code]


def _resolve_item_tax(item: Any, doc: Any, sale_value: float) -> tuple[float, float]:
	amount_value = abs(_company_amount(item, "amount"))
	net_amount_value = abs(_company_amount(item, "net_amount"))
	if amount_value and net_amount_value and abs(amount_value - net_amount_value) > 0.0001:
		tax_charged = abs(amount_value - net_amount_value)
		rate = flt((tax_charged / sale_value) * 100, 3) if sale_value else 0.0
		return tax_charged, rate

	tax_rate = _resolve_item_tax_rate(item, doc)
	tax_charged = flt(sale_value * tax_rate / 100, 2) if sale_value and tax_rate else 0.0
	return tax_charged, tax_rate


def _resolve_item_tax_rate(item: Any, doc: Any) -> float:
	item_tax_rate = _parse_json_mapping(_get_doc_value(item, "item_tax_rate", None))
	if item_tax_rate:
		return flt(sum(flt(value) for value in item_tax_rate.values()), 3)

	total_rate = 0.0
	for tax in _get_doc_value(doc, "taxes", []) or []:
		if cstr(_get_doc_value(tax, "charge_type", "")).strip() in PERCENTAGE_CHARGE_TYPES:
			total_rate += flt(_get_doc_value(tax, "rate", 0))
	return flt(total_rate, 3)


def _parse_json_mapping(value: Any) -> dict[str, Any]:
	if isinstance(value, dict):
		return value
	if not value:
		return {}
	try:
		parsed = json.loads(cstr(value))
		return parsed if isinstance(parsed, dict) else {}
	except ValueError:
		return {}


def _split_tax_identifier(value: Any) -> tuple[str | None, str | None]:
	tax_id = _sanitize_text(value, max_length=20)
	if not tax_id:
		return None, None
	if _NTN_PATTERN.match(tax_id):
		return tax_id, None
	if _CNIC_PATTERN.match(tax_id):
		return None, tax_id
	return tax_id, None


def _coerce_pos_id(value: str) -> int | str:
	return int(value) if value.isdigit() else value


def _build_posting_datetime(doc: Any) -> str:
	posting_date = cstr(_get_doc_value(doc, "posting_date", "")).strip()
	posting_time = cstr(_get_doc_value(doc, "posting_time", "")).strip() or now_datetime().strftime(
		"%H:%M:%S"
	)
	return f"{posting_date} {posting_time}".strip()


def _company_amount(doc: Any, fieldname: str) -> float:
	base_fieldname = f"base_{fieldname}"
	base_value = _get_doc_value(doc, base_fieldname, None)
	if base_value not in (None, ""):
		return flt(base_value)
	return flt(_get_doc_value(doc, fieldname, 0))


def _get_doc_value(doc: Any, fieldname: str, default: Any = None) -> Any:
	if hasattr(doc, "get"):
		try:
			value = doc.get(fieldname)
			if value is not None:
				return value
		except TypeError:
			pass
	return getattr(doc, fieldname, default)


def _set_field_if_available(doc: Any, fieldname: str, value: Any) -> None:
	meta = getattr(doc, "meta", None)
	if meta and hasattr(meta, "get_field") and not meta.get_field(fieldname):
		return
	if hasattr(doc, "set"):
		doc.set(fieldname, value)
	else:
		setattr(doc, fieldname, value)


def _sanitize_text(value: Any, max_length: int | None = None) -> str | None:
	if value in (None, ""):
		return None
	text = _CONTROL_CHAR_PATTERN.sub("", cstr(value).strip())
	if max_length:
		text = text[:max_length]
	return text or None
