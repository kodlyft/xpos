# Copyright (c) 2026, Kodlyft and contributors
# For license information, please see license.txt

import json

import frappe
from erpnext.accounts.party import get_party_account
from frappe import _
from frappe.utils import cint, flt, getdate, nowdate

from .utils import get, get_active_pos_profile, get_default_warehouse


def _resolve_pos_profile(pos_profile: str | dict | None) -> dict:
	if isinstance(pos_profile, dict):
		return pos_profile

	if isinstance(pos_profile, str):
		raw_value = pos_profile.strip()
		if raw_value:
			try:
				decoded = json.loads(raw_value)
			except Exception:
				decoded = raw_value

			if isinstance(decoded, dict):
				return decoded
			if isinstance(decoded, str) and decoded:
				return frappe.get_doc("POS Profile", decoded).as_dict()

	profile = get_active_pos_profile()
	if not profile:
		frappe.throw(_("POS Profile is required to create purchase documents."))
	return profile


def _ensure_allowed(profile: dict, flag: str, label: str):
	if not cint(profile.get(flag)):
		frappe.throw(_("{0} is disabled for this POS Profile.").format(label))


def _resolve_supplier(supplier_value: str | dict | None) -> str | None:
	if isinstance(supplier_value, dict):
		supplier_value = (
			supplier_value.get("name")
			or supplier_value.get("supplier_name")
			or supplier_value.get("supplier")
		)

	supplier = str(supplier_value or "").strip()
	if not supplier:
		return None

	if frappe.db.exists("Supplier", supplier):
		return supplier

	supplier_by_label = frappe.db.get_value("Supplier", {"supplier_name": supplier}, "name")
	if supplier_by_label:
		return supplier_by_label

	ci_match = frappe.db.sql(
		"""
        select name
        from `tabSupplier`
        where lower(name) = lower(%(supplier)s)
           or lower(supplier_name) = lower(%(supplier)s)
        limit 1
        """,
		{"supplier": supplier},
	)
	if ci_match and ci_match[0]:
		return ci_match[0][0]

	return None


def _upsert_item_price(
	item_code: str,
	price_list: str,
	rate: float,
	uom: str | None = None,
	buying: bool = False,
	selling: bool = False,
) -> str | None:
	if not price_list or rate is None:
		return None

	rate = flt(rate)
	filters = {"item_code": item_code, "price_list": price_list}
	if uom:
		filters["uom"] = uom

	existing = frappe.db.get_value("Item Price", filters, "name")
	if existing:
		doc = frappe.get_doc("Item Price", existing)
		doc.price_list_rate = rate
		doc.flags.ignore_permissions = True
		doc.save()
		return doc.name

	doc = frappe.get_doc(
		{
			"doctype": "Item Price",
			"price_list": price_list,
			"item_code": item_code,
			"price_list_rate": rate,
			"buying": 1 if buying else 0,
			"selling": 1 if selling else 0,
			"uom": uom,
		}
	)
	doc.flags.ignore_permissions = True
	doc.insert()
	return doc.name


def _build_items_map(items: list[dict]) -> dict[str, list[dict]]:
	items_by_code = {}
	for row in items or []:
		item_code = row.get("item_code")
		if not item_code:
			continue
		items_by_code.setdefault(item_code, []).append(row)
	return items_by_code


def _resolve_input_row(items_by_code: dict[str, list[dict]], item_code: str) -> dict:
	rows = items_by_code.get(item_code)
	if not rows:
		return {}
	return rows.pop(0)


def _build_purchase_taxes(profile: dict, items: list[dict]) -> list[dict]:
	"""Build Actual taxes_and_charges rows from POS Profile purchase_taxes and per-item tax percentages.

	Each item in *items* must have ``qty``, ``rate``, and optionally ``taxes``
	(a dict mapping tax_type -> percentage, e.g. ``{"Sales Tax": 17}``).

	Returns a list of dicts ready to be appended to a document's ``taxes`` child table:
	``[{charge_type, account_head, description, tax_amount}]``
	"""
	purchase_taxes_config = profile.get("purchase_taxes") or []
	if not purchase_taxes_config:
		return []

	tax_account_map: dict[str, str] = {}
	for row in purchase_taxes_config:
		tax_type = row.get("tax_type")
		account = row.get("erp_tax_account")
		if tax_type and account and tax_type not in tax_account_map:
			tax_account_map[tax_type] = account

	if not tax_account_map:
		return []

	tax_totals: dict[str, float] = {t: 0.0 for t in tax_account_map}

	for item in items or []:
		qty = flt(item.get("qty") or 0)
		rate = flt(item.get("rate") or 0)
		if qty <= 0 or rate <= 0:
			continue
		net = qty * rate
		item_taxes = item.get("taxes") or {}
		for tax_type in tax_account_map:
			percent = flt(item_taxes.get(tax_type) or 0)
			if percent:
				tax_totals[tax_type] += net * percent / 100

	rows = []
	for tax_type, account_head in tax_account_map.items():
		amount = tax_totals[tax_type]
		if amount:
			rows.append(
				{
					"charge_type": "Actual",
					"account_head": account_head,
					"description": tax_type,
					"tax_amount": flt(amount, 2),
				}
			)
	return rows


def _create_purchase_receipt(
	po_doc: dict, payload: dict, default_warehouse: str | None, transaction_date: str
) -> str:
	receipt_date = payload.get("receipt_date") or payload.get("posting_date") or transaction_date
	receipt = frappe.get_doc(
		{
			"doctype": "Purchase Receipt",
			"supplier": po_doc.supplier,
			"company": po_doc.company,
			"posting_date": receipt_date,
			"currency": po_doc.currency,
		}
	)
	if default_warehouse:
		receipt.set_warehouse = default_warehouse

	items_by_code = _build_items_map(payload.get("items"))

	for po_item in po_doc.items:
		payload_row = _resolve_input_row(items_by_code, po_item.item_code)
		if (
			payload.get("receive")
			and not payload_row.get("received_qty")
			and not payload_row.get("receive_qty")
		):
			payload_row["receive_qty"] = po_item.qty
			payload_row["received_qty"] = po_item.qty
		received_qty = flt(
			payload_row.get("received_qty")
			or payload_row.get("receive_qty")
			or payload_row.get("qty")
			or po_item.qty
		)
		if received_qty <= 0:
			continue

		receipt.append(
			"items",
			{
				"item_code": po_item.item_code,
				"item_name": po_item.item_name,
				"qty": received_qty,
				"uom": po_item.uom,
				"stock_uom": po_item.stock_uom,
				"conversion_factor": po_item.conversion_factor or 1,
				"rate": po_item.rate,
				"warehouse": po_item.warehouse or default_warehouse,
				"purchase_order": po_doc.name,
				"purchase_order_item": po_item.name,
				"schedule_date": po_item.schedule_date,
			},
		)

	if not receipt.items:
		frappe.throw(_("No items to receive. Please enter received quantities."))

	receipt.flags.ignore_permissions = True
	frappe.flags.ignore_account_permission = True
	receipt.insert()
	receipt.submit()
	return receipt.name


@frappe.whitelist()
def create_supplier(data: str | dict) -> dict:
	payload = json.loads(data) if isinstance(data, str) else data
	profile = _resolve_pos_profile(payload.get("pos_profile"))
	_ensure_allowed(profile, "allow_create_purchase_suppliers", _("Create suppliers"))

	supplier_name = payload.get("supplier_name") or payload.get("supplier")
	if not supplier_name:
		frappe.throw(_("Supplier name is required."))

	existing = frappe.db.get_value("Supplier", {"supplier_name": supplier_name}, "name")
	if existing:
		return frappe.get_doc("Supplier", existing).as_dict()

	supplier_group = payload.get("supplier_group") or frappe.db.get_value(
		"Supplier Group", {"is_group": 0}, "name"
	)
	supplier_group = supplier_group or "All Supplier Groups"

	supplier = frappe.get_doc(
		{
			"doctype": "Supplier",
			"supplier_name": supplier_name,
			"supplier_group": supplier_group,
			"supplier_type": payload.get("supplier_type") or "Company",
			"tax_id": payload.get("tax_id"),
			"mobile_no": payload.get("mobile_no"),
			"email_id": payload.get("email_id"),
		}
	)
	supplier.flags.ignore_permissions = True
	supplier.insert()
	return supplier.as_dict()


@frappe.whitelist()
def search_suppliers(search_text: str | None = None, limit: int = 20) -> list[dict]:
	filters = {"disabled": 0}
	or_filters = None
	if search_text:
		like_value = f"%{search_text}%"
		or_filters = {
			"name": ["like", like_value],
			"supplier_name": ["like", like_value],
		}

	suppliers = frappe.get_all(
		"Supplier",
		filters=filters,
		or_filters=or_filters,
		fields=[
			"name",
			"supplier_name",
			"supplier_group",
			"supplier_type",
			"default_currency",
		],
		order_by="supplier_name asc",
		limit_page_length=limit,
	)
	return suppliers


@frappe.whitelist()
def create_purchase_item(data: str | dict) -> dict:
	payload = json.loads(data) if isinstance(data, str) else data
	profile = _resolve_pos_profile(payload.get("pos_profile"))
	_ensure_allowed(profile, "allow_create_purchase_items", _("Create items"))

	item_code = payload.get("item_code") or payload.get("item_name")
	item_name = payload.get("item_name") or item_code
	stock_uom = payload.get("stock_uom")

	if not item_code:
		frappe.throw(_("Item code is required."))
	if not stock_uom:
		frappe.throw(_("Stock UOM is required."))

	existing = frappe.db.exists("Item", item_code)
	if existing:
		return frappe.get_doc("Item", item_code).as_dict()

	item_group = payload.get("item_group") or frappe.db.get_value("Item Group", {"is_group": 0}, "name")
	item_group = item_group or "All Item Groups"

	barcode = payload.get("barcode")
	if barcode and frappe.db.exists("Item Barcode", {"barcode": barcode}):
		frappe.throw(_("Barcode {0} already exists.").format(barcode))

	item_doc = frappe.get_doc(
		{
			"doctype": "Item",
			"item_code": item_code,
			"item_name": item_name,
			"item_group": item_group,
			"stock_uom": stock_uom,
			"is_stock_item": 1,
			"disabled": 0,
			"default_warehouse": profile.get("warehouse"),
			"standard_rate": flt(payload.get("buying_price") or 0),
		}
	)

	if barcode:
		item_doc.append("barcodes", {"barcode": barcode})

	item_doc.flags.ignore_permissions = True
	item_doc.flags.ignore_mandatory = True
	item_doc.insert()

	selling_price_list = payload.get("selling_price_list") or profile.get("selling_price_list")
	buying_price_list = payload.get("buying_price_list")

	selling_price = payload.get("selling_price")
	buying_price = payload.get("buying_price")

	_upsert_item_price(
		item_code,
		selling_price_list,
		selling_price,
		uom=stock_uom,
		selling=True,
	)
	_upsert_item_price(
		item_code,
		buying_price_list,
		buying_price,
		uom=stock_uom,
		buying=True,
	)

	if buying_price is not None:
		item_doc.db_set("standard_rate", flt(buying_price), update_modified=False)

	return {
		"item": item_doc.as_dict(),
		"selling_price_list": selling_price_list,
		"buying_price_list": buying_price_list,
	}


def _get_mode_of_payment_account(mode: str, company: str) -> str:
	account = frappe.db.get_value(
		"Mode of Payment Account",
		{"parent": mode, "company": company},
		"default_account",
	)
	if not account:
		frappe.throw(
			_("Please set default account for Mode of Payment {0} in company {1}").format(mode, company)
		)
	return account


def _create_payment_entry(
	reference_doc: dict, payments: list[dict], company: str, transaction_date: str
) -> list[str]:
	if not payments:
		return []

	created_payments = []

	ref_doctype = reference_doc.doctype
	ref_name = reference_doc.name

	outstanding_amount = 0
	if ref_doctype == "Purchase Invoice":
		outstanding_amount = reference_doc.outstanding_amount
	else:
		outstanding_amount = reference_doc.grand_total

	for pay in payments:
		amount = flt(pay.get("amount"))
		mode = pay.get("mode_of_payment")

		if amount <= 0:
			continue

		paid_from_account = _get_mode_of_payment_account(mode, company)

		pe = frappe.new_doc("Payment Entry")
		pe.payment_type = "Pay"
		pe.company = company
		pe.posting_date = transaction_date
		pe.mode_of_payment = mode
		pe.party_type = "Supplier"
		pe.party = reference_doc.supplier

		pe.paid_from = paid_from_account

		pe.paid_to = get_party_account("Supplier", reference_doc.supplier, company)
		if not pe.paid_to:
			frappe.throw(_("Please set Default Payable Account in Company {0}").format(company))

		pe.paid_amount = amount
		pe.received_amount = amount
		allocated_amount = 0
		if outstanding_amount > 0:
			allocated_amount = min(amount, outstanding_amount)
			outstanding_amount -= allocated_amount

		if allocated_amount > 0:
			pe.append(
				"references",
				{
					"reference_doctype": ref_doctype,
					"reference_name": ref_name,
					"allocated_amount": allocated_amount,
				},
			)

		pe.flags.ignore_permissions = True
		pe.insert()
		pe.submit()
		created_payments.append(pe.name)

	return created_payments


@frappe.whitelist()
def create_purchase_order(data: str | dict) -> dict:
	payload = json.loads(data) if isinstance(data, str) else data
	profile = _resolve_pos_profile(payload.get("pos_profile"))
	_ensure_allowed(profile, "allow_purchase_order", _("Purchase orders"))

	receive_now = cint(payload.get("receive"))
	if receive_now:
		_ensure_allowed(profile, "allow_purchase_receipt", _("Receive stock"))

	supplier_input = payload.get("supplier")
	if not supplier_input:
		frappe.throw(_("Supplier is required."))

	supplier = _resolve_supplier(supplier_input)
	if not supplier:
		frappe.throw(_("Supplier {0} was not found.").format(supplier_input))

	company = payload.get("company") or profile.get("company") or frappe.defaults.get_default("company")
	if not company:
		frappe.throw(_("Company is required."))

	warehouse = payload.get("warehouse") or profile.get("warehouse") or get_default_warehouse(company)
	transaction_date = payload.get("transaction_date") or nowdate()
	schedule_date = payload.get("schedule_date") or transaction_date

	items = payload.get("items") or []
	if not items:
		frappe.throw(_("Purchase order requires at least one item."))

	supplier_doc = frappe.get_doc("Supplier", supplier)
	supplier_currency = supplier_doc.default_currency
	if not supplier_currency:
		supplier_currency = frappe.get_value("Company", company, "default_currency")

	buying_price_list = get("buying_price_list", profile) or frappe.db.get_value(
		"Price List", {"buying": 1, "company": company}, "name"
	)
	price_list_currency = frappe.get_value("Price List", buying_price_list, "currency")

	if price_list_currency and price_list_currency != supplier_currency:
		alternative_price_list = frappe.db.get_value(
			"Price List",
			{"currency": supplier_currency, "buying": 1, "enabled": 1},
			"name",
		)
		if alternative_price_list:
			buying_price_list = alternative_price_list

	po_doc = frappe.get_doc(
		{
			"doctype": "Purchase Order",
			"supplier": supplier,
			"company": company,
			"transaction_date": transaction_date,
			"schedule_date": schedule_date,
			"currency": supplier_currency,
			"buying_price_list": buying_price_list,
		}
	)

	for cf in (
		"custom_alias_name",
		"custom_po_category",
		"custom_po_type",
		"custom_po_department",
		"custom_po_remarks",
		"custom_zero_qty",
	):
		val = payload.get(cf)
		if val:
			po_doc.set(cf, val)

	if warehouse:
		po_doc.set_warehouse = warehouse

	item_codes = [row.get("item_code") for row in items if row.get("item_code")]
	if item_codes:
		item_meta = frappe.get_all(
			"Item",
			filters={"name": ["in", item_codes]},
			fields=["name", "item_name", "stock_uom"],
		)
		item_map = {row.name: row for row in item_meta}
	else:
		item_map = {}

	for row in items:
		item_code = row.get("item_code")
		if not item_code:
			continue

		qty = flt(row.get("qty"))
		if qty <= 0:
			continue

		meta = item_map.get(item_code)
		stock_uom = row.get("stock_uom") or (meta.stock_uom if meta else None)
		item_name = row.get("item_name") or (meta.item_name if meta else item_code)
		uom = row.get("uom") or stock_uom
		conversion_factor = flt(row.get("conversion_factor") or 1)
		if not conversion_factor:
			conversion_factor = 1

		po_doc.append(
			"items",
			{
				"item_code": item_code,
				"item_name": item_name,
				"qty": qty,
				"uom": uom,
				"stock_uom": stock_uom,
				"conversion_factor": conversion_factor,
				"rate": flt(row.get("rate")),
				"warehouse": row.get("warehouse") or warehouse,
				"schedule_date": schedule_date,
				"custom_alias": row.get("custom_alias") or item_name,
				"custom_stock_in_hand": flt(row.get("custom_stock_in_hand")),
				"custom_transit_stock": flt(row.get("custom_transit_stock")),
				"custom_required_loose": flt(row.get("custom_required_loose")),
				"custom_required_packs": flt(row.get("custom_required_packs")),
				"custom_generic_item": row.get("custom_generic_item") or "",
				"custom_category": row.get("custom_category") or "",
				"custom_class": row.get("custom_class") or "",
				"custom_item_packing": row.get("custom_item_packing") or "",
				"custom_pack_units": flt(row.get("custom_pack_units")),
			},
		)

	if not po_doc.items:
		frappe.throw(_("Purchase order requires at least one item with quantity."))

	for tax_row in _build_purchase_taxes(profile, items):
		po_doc.append("taxes", tax_row)

	po_doc.flags.ignore_permissions = True
	frappe.flags.ignore_account_permission = True
	po_doc.save()

	try:
		if cint(payload.get("submit", 1)):
			po_doc.submit()

		receipt_name = None
		receipt_doc = None
		if receive_now:
			receipt_name = _create_purchase_receipt(po_doc, payload, warehouse, transaction_date)
			if receipt_name:
				receipt_doc = frappe.get_doc("Purchase Receipt", receipt_name)
		invoice_name = None
		if cint(payload.get("create_invoice", 0)):
			invoice_name = _create_purchase_invoice(
				po_doc,
				payload,
				warehouse,
				transaction_date,
				receipt_doc=receipt_doc,
				profile=profile,
			)

		payments = payload.get("payments")
		if payments:
			ref_doc = frappe.get_doc("Purchase Invoice", invoice_name) if invoice_name else po_doc
			_create_payment_entry(ref_doc, payments, company, transaction_date)

		return {
			"purchase_order": po_doc.name,
			"purchase_receipt": receipt_name,
			"purchase_invoice": invoice_name,
		}
	except Exception as err:
		frappe.log_error(frappe.get_traceback(), _("X POS Purchase Order Flow Failed"))
		frappe.throw(_("Purchase Order {0} processing failed: {1}").format(po_doc.name, str(err)))


@frappe.whitelist()
def create_purchase_invoice_direct(data: str | dict) -> dict:
	payload = json.loads(data) if isinstance(data, str) else data
	profile = _resolve_pos_profile(payload.get("pos_profile"))
	_ensure_allowed(profile, "allow_purchase_order", _("Purchase invoices"))

	update_stock = cint(payload.get("receive") or payload.get("update_stock"))
	if update_stock:
		_ensure_allowed(profile, "allow_purchase_receipt", _("Receive stock"))

	supplier = _resolve_supplier(payload.get("supplier"))
	if not supplier:
		frappe.throw(_("Supplier is required."))

	company = payload.get("company") or profile.get("company") or frappe.defaults.get_user_default("Company")
	if not company:
		frappe.throw(_("Company is required."))

	posting_date = payload.get("posting_date") or payload.get("invoice_date") or nowdate()
	warehouse = payload.get("warehouse") or profile.get("warehouse") or get_default_warehouse(company)
	if update_stock and not warehouse:
		frappe.throw(_("Warehouse is required when receiving stock with a Purchase Invoice."))

	items = payload.get("items") or []
	if not items:
		frappe.throw(_("Purchase invoice requires at least one item."))

	item_codes = [row.get("item_code") for row in items if row.get("item_code")]
	item_map = {}
	if item_codes:
		item_meta = frappe.get_all(
			"Item",
			filters={"name": ["in", item_codes]},
			fields=["name", "item_name", "stock_uom"],
		)
		item_map = {row.name: row for row in item_meta}

	update_item_prices(items, profile)
	invoice = frappe.get_doc(
		{
			"doctype": "Purchase Invoice",
			"supplier": supplier,
			"company": company,
			"posting_date": posting_date,
			"bill_no": payload.get("bill_no") or None,
			"remarks": payload.get("remarks") or None,
			"currency": payload.get("currency")
			or frappe.db.get_value("Company", company, "default_currency"),
			"update_stock": update_stock,
		}
	)

	is_paid = cint(payload.get("is_paid"))
	mode_of_payment = payload.get("mode_of_payment")
	if is_paid and mode_of_payment:
		invoice.is_paid = 1
		invoice.mode_of_payment = mode_of_payment
		cash_bank_account = _get_mode_of_payment_account(mode_of_payment, company)
		invoice.cash_bank_account = cash_bank_account

	if warehouse and update_stock:
		invoice.set_warehouse = warehouse

	for row in items:
		item_code = row.get("item_code")
		if not item_code:
			continue

		qty = flt(row.get("qty"))
		if qty <= 0:
			continue

		meta = item_map.get(item_code)
		stock_uom = row.get("stock_uom") or (meta.stock_uom if meta else None)
		item_name = row.get("item_name") or (meta.item_name if meta else item_code)
		uom = row.get("uom") or stock_uom
		conversion_factor = flt(row.get("conversion_factor") or 1)
		if not conversion_factor:
			conversion_factor = 1

		invoice_item = {
			"item_code": item_code,
			"item_name": item_name,
			"qty": qty,
			"uom": uom,
			"stock_uom": stock_uom,
			"conversion_factor": conversion_factor,
			"rate": flt(row.get("rate")),
			"batch_no": row.get("batch_no") or None,
		}

		row_warehouse = row.get("warehouse") or warehouse
		if row_warehouse:
			invoice_item["warehouse"] = row_warehouse

		purchase_order = row.get("purchase_order") or payload.get("purchase_order")
		if purchase_order:
			invoice_item["purchase_order"] = purchase_order

		if row.get("po_detail"):
			invoice_item["po_detail"] = row.get("po_detail")

		if row.get("purchase_receipt"):
			invoice_item["purchase_receipt"] = row.get("purchase_receipt")

		if row.get("pr_detail"):
			invoice_item["pr_detail"] = row.get("pr_detail")

		invoice.append("items", invoice_item)

	if not invoice.items:
		frappe.throw(_("Purchase invoice requires at least one item with quantity."))

	profile_tax_rows = _build_purchase_taxes(profile, items)
	if profile_tax_rows:
		for tax_row in profile_tax_rows:
			invoice.append("taxes", tax_row)
	else:
		taxes_template = payload.get("taxes_and_charges")
		if taxes_template and frappe.db.exists("Purchase Taxes and Charges Template", taxes_template):
			invoice.taxes_and_charges = taxes_template
			template_taxes = frappe.get_all(
				"Purchase Taxes and Charges",
				filters={
					"parent": taxes_template,
					"parenttype": "Purchase Taxes and Charges Template",
				},
				fields=[
					"charge_type",
					"description",
					"rate",
					"account_head",
					"included_in_print_rate",
					"cost_center",
					"tax_amount",
				],
				order_by="idx asc",
			)
			for tax_row in template_taxes:
				invoice.append(
					"taxes",
					{
						"charge_type": tax_row.get("charge_type") or "On Net Total",
						"account_head": tax_row.get("account_head"),
						"description": tax_row.get("description"),
						"rate": flt(tax_row.get("rate")),
						"included_in_print_rate": cint(tax_row.get("included_in_print_rate")),
						"cost_center": tax_row.get("cost_center") or None,
					},
				)

	invoice.flags.ignore_permissions = True
	frappe.flags.ignore_account_permission = True
	invoice.insert()

	if is_paid and mode_of_payment:
		invoice.paid_amount = invoice.grand_total
		invoice.save()

	invoice.submit()

	return {
		"purchase_invoice": invoice.name,
		"grand_total": invoice.grand_total,
		"is_paid": invoice.is_paid,
	}


@frappe.whitelist()
def search_items(search_text: str | None = None, limit: int = 20) -> list[dict]:
	limit = cint(limit) or 20
	search_text = (search_text or "").strip()

	if search_text:
		like_value = f"%{search_text}%"
		items = frappe.db.sql(
			"""
            SELECT DISTINCT i.name, i.item_name, i.stock_uom, i.standard_rate,
                   i.item_group
            FROM `tabItem` i
            LEFT JOIN `tabItem Barcode` ib ON ib.parent = i.name
            WHERE i.disabled = 0
              AND (
                i.name LIKE %(like)s
                OR i.item_name LIKE %(like)s
                OR ib.barcode LIKE %(like)s
              )
            ORDER BY i.item_name ASC
            LIMIT %(limit)s
            """,
			{"like": like_value, "limit": limit},
			as_dict=True,
		)
	else:
		items = frappe.get_all(
			"Item",
			filters={"disabled": 0},
			fields=["name", "item_name", "stock_uom", "standard_rate", "item_group"],
			limit_page_length=limit,
			order_by="item_name asc",
		)

	item_codes = [it.get("name") for it in items if it.get("name")]
	uom_rows = []
	if item_codes:
		uom_rows = frappe.get_all(
			"UOM Conversion Detail",
			filters={"parent": ["in", item_codes]},
			fields=["parent", "uom", "conversion_factor"],
		)
	uom_map = {}
	for row in uom_rows:
		uom_map.setdefault(row.parent, []).append(
			{"uom": row.uom, "conversion_factor": row.conversion_factor}
		)

	barcode_map = {}
	if item_codes:
		barcode_rows = frappe.get_all(
			"Item Barcode",
			filters={"parent": ["in", item_codes]},
			fields=["parent", "barcode"],
		)
		for row in barcode_rows:
			barcode_map.setdefault(row.parent, []).append(row.barcode)

	results = []
	for it in items:
		item_code = it.get("name")
		stock_uom = it.get("stock_uom")
		uoms = uom_map.get(item_code, [])
		if stock_uom and not any(u.get("uom") == stock_uom for u in uoms):
			uoms.append({"uom": stock_uom, "conversion_factor": 1})
		barcodes = barcode_map.get(item_code, [])
		results.append(
			{
				"item_code": item_code,
				"item_name": it.get("item_name"),
				"stock_uom": stock_uom,
				"item_uoms": uoms,
				"standard_rate": it.get("standard_rate"),
				"barcode": barcodes[0] if barcodes else None,
				"barcodes": barcodes,
				"item_group": it.get("item_group"),
			}
		)
	return results


@frappe.whitelist()
def search_item_by_barcode(barcode: str, pos_profile: str | None = None) -> dict | None:
	"""Search item specifically by barcode for purchasing."""
	if not barcode:
		return None

	barcode_data = frappe.db.get_value(
		"Item Barcode",
		{"barcode": barcode},
		["parent as item_code", "barcode", "uom"],
		as_dict=True,
	)

	if barcode_data:
		item = frappe.get_cached_doc("Item", barcode_data.item_code)
		return {
			"item_code": item.name,
			"item_name": item.item_name,
			"barcode": barcode_data.barcode,
			"uom": barcode_data.uom or item.stock_uom,
			"stock_uom": item.stock_uom,
			"standard_rate": _get_buying_rate(item.name),
		}

	if frappe.db.exists("Item", barcode):
		item = frappe.get_cached_doc("Item", barcode)
		return {
			"item_code": item.name,
			"item_name": item.item_name,
			"barcode": barcode,
			"uom": item.stock_uom,
			"stock_uom": item.stock_uom,
			"standard_rate": _get_buying_rate(item.name),
		}

	return None


def _create_purchase_invoice(
	po_doc: dict,
	payload: dict,
	default_warehouse: str | None,
	transaction_date: str,
	receipt_doc: dict | None = None,
	profile: dict | None = None,
) -> str:
	invoice_date = payload.get("invoice_date") or payload.get("invoice_posting_date") or transaction_date
	invoice = frappe.get_doc(
		{
			"doctype": "Purchase Invoice",
			"supplier": po_doc.supplier,
			"company": po_doc.company,
			"posting_date": invoice_date,
			"purchase_order": po_doc.name,
			"currency": payload.get("currency") or po_doc.currency,
		}
	)
	if default_warehouse:
		invoice.set_warehouse = default_warehouse

	items_by_code = _build_items_map(payload.get("items"))
	receipt_items = (
		{item.purchase_order_item: item for item in (receipt_doc.items or [])} if receipt_doc else {}
	)
	for po_item in po_doc.items:
		payload_row = _resolve_input_row(items_by_code, po_item.item_code)
		qty = flt(payload_row.get("qty") or po_item.qty)
		if qty <= 0:
			continue
		invoice_item = {
			"item_code": po_item.item_code,
			"item_name": po_item.item_name,
			"qty": qty,
			"uom": po_item.uom,
			"stock_uom": po_item.stock_uom,
			"conversion_factor": po_item.conversion_factor or 1,
			"rate": po_item.rate,
			"warehouse": po_item.warehouse or default_warehouse,
			"purchase_order": po_doc.name,
			"po_detail": po_item.name,
			"schedule_date": po_item.schedule_date,
		}
		receipt_item = receipt_items.get(po_item.name)
		if receipt_item and receipt_doc:
			invoice_item["purchase_receipt"] = receipt_doc.name
			invoice_item["pr_detail"] = receipt_item.name
		invoice.append("items", invoice_item)

	if not invoice.items:
		frappe.throw(_("No items to invoice. Please ensure there are items on the Purchase Order."))

	if profile:
		payload_items_by_code: dict[str, list[dict]] = {}
		for p_item in payload.get("items") or []:
			code = p_item.get("item_code")
			if code:
				payload_items_by_code.setdefault(code, []).append(p_item)

		combined_items = []
		for inv_item in invoice.items:
			p_rows = payload_items_by_code.get(inv_item.item_code) or [{}]
			combined_items.append(
				{
					"qty": inv_item.qty,
					"rate": inv_item.rate,
					"taxes": (p_rows[0].get("taxes") or {}),
				}
			)

		for tax_row in _build_purchase_taxes(profile, combined_items):
			invoice.append("taxes", tax_row)

	invoice.flags.ignore_permissions = True
	frappe.flags.ignore_account_permission = True
	invoice.insert()
	invoice.submit()
	return invoice.name


@frappe.whitelist()
def get_pending_receipts(warehouse: str | None = None, limit: int = 50) -> list[dict]:
	"""Get Purchase Orders that are pending stock receipt."""
	filters = {
		"docstatus": 1,
		"status": ["in", ["To Receive and Bill", "To Receive"]],
		"per_received": ["<", 100],
	}
	if warehouse:
		po_names = frappe.db.sql_list(
			"""
            SELECT DISTINCT parent FROM `tabPurchase Order Item`
            WHERE warehouse = %(warehouse)s AND docstatus = 1
            """,
			{"warehouse": warehouse},
		)
		if po_names:
			filters["name"] = ["in", po_names]
		else:
			return []

	orders = frappe.get_all(
		"Purchase Order",
		filters=filters,
		fields=[
			"name",
			"supplier",
			"supplier_name",
			"company",
			"transaction_date",
			"grand_total",
			"status",
			"per_received",
			"per_billed",
		],
		order_by="transaction_date desc",
		limit_page_length=cint(limit) or 50,
	)

	for order in orders:
		order["items"] = frappe.get_all(
			"Purchase Order Item",
			filters={"parent": order["name"], "docstatus": 1},
			fields=[
				"name as po_detail",
				"item_code",
				"item_name",
				"qty",
				"received_qty",
				"rate",
				"uom",
				"stock_uom",
				"conversion_factor",
				"warehouse",
			],
		)
		for item in order["items"]:
			item["pending_qty"] = flt(item["qty"]) - flt(item["received_qty"])

	return orders


@frappe.whitelist()
def get_purchase_order_detail(purchase_order: str) -> dict:
	"""Get a single Purchase Order with its items for receiving."""

	if not purchase_order or not frappe.db.exists("Purchase Order", purchase_order):
		frappe.throw(_("Purchase Order {0} does not exist.").format(purchase_order))

	po = frappe.get_doc("Purchase Order", purchase_order)
	items = []
	for item in po.items:
		items.append(
			{
				"po_detail": item.name,
				"item_code": item.item_code,
				"item_name": item.item_name,
				"qty": flt(item.qty),
				"received_qty": flt(item.received_qty),
				"pending_qty": flt(item.qty) - flt(item.received_qty),
				"rate": flt(item.rate),
				"uom": item.uom,
				"stock_uom": item.stock_uom,
				"conversion_factor": flt(item.conversion_factor) or 1,
				"warehouse": item.warehouse,
			}
		)

	return {
		"name": po.name,
		"supplier": po.supplier,
		"supplier_name": po.supplier_name,
		"company": po.company,
		"transaction_date": str(po.transaction_date),
		"grand_total": flt(po.grand_total),
		"status": po.status,
		"per_received": flt(po.per_received),
		"per_billed": flt(po.per_billed),
		"items": items,
	}


@frappe.whitelist()
def receive_stock(data: str | dict) -> dict:
	"""
	Create a Purchase Receipt from a Purchase Order.
	Supports partial receipt and rejection.

	data = {
	    "purchase_order": "PO-00001",
	    "warehouse": "Stores - R",
	    "items": [
	        {
	            "po_detail": "row-id",
	            "item_code": "ITEM-001",
	            "accept_qty": 10,
	            "reject_qty": 2,
	            "rejected_warehouse": "Rejected - R"  // optional
	        }
	    ],
	    "remarks": "Some items damaged"
	}
	"""
	payload = json.loads(data) if isinstance(data, str) else data

	po_name = payload.get("purchase_order")
	if not po_name:
		frappe.throw(_("Purchase Order is required."))

	po = frappe.get_doc("Purchase Order", po_name)
	if po.docstatus != 1:
		frappe.throw(_("Purchase Order {0} is not submitted.").format(po_name))

	warehouse = payload.get("warehouse") or get_default_warehouse()
	items_data = payload.get("items", [])
	remarks = payload.get("remarks", "")

	if not items_data:
		frappe.throw(_("No items to receive."))

	receipt = frappe.get_doc(
		{
			"doctype": "Purchase Receipt",
			"supplier": po.supplier,
			"company": po.company,
			"posting_date": nowdate(),
			"purchase_order": po_name,
		}
	)

	if remarks:
		receipt.remarks = remarks

	po_items_map = {item.name: item for item in po.items}

	has_rejections = False
	for row in items_data:
		po_detail = row.get("po_detail")
		po_item = po_items_map.get(po_detail)
		if not po_item:
			continue

		accept_qty = flt(row.get("accept_qty", 0))
		reject_qty = flt(row.get("reject_qty", 0))

		if accept_qty <= 0 and reject_qty <= 0:
			continue

		total_qty = accept_qty + reject_qty
		item_warehouse = row.get("warehouse") or po_item.warehouse or warehouse

		receipt_item = {
			"item_code": po_item.item_code,
			"item_name": po_item.item_name,
			"qty": total_qty,
			"uom": po_item.uom,
			"stock_uom": po_item.stock_uom,
			"conversion_factor": po_item.conversion_factor or 1,
			"rate": po_item.rate,
			"warehouse": item_warehouse,
			"purchase_order": po_name,
			"purchase_order_item": po_detail,
			"schedule_date": (str(po_item.schedule_date) if po_item.schedule_date else nowdate()),
		}

		if reject_qty > 0:
			has_rejections = True
			receipt_item["rejected_qty"] = reject_qty
			receipt_item["qty"] = accept_qty
			rejected_wh = row.get("rejected_warehouse")
			if rejected_wh:
				receipt_item["rejected_warehouse"] = rejected_wh

		receipt.append("items", receipt_item)

	if not receipt.items:
		frappe.throw(_("No valid items to receive."))

	receipt.flags.ignore_permissions = True
	receipt.insert()
	receipt.submit()

	result = {
		"purchase_receipt": receipt.name,
		"purchase_order": po_name,
		"status": "completed",
		"has_rejections": has_rejections,
		"items_received": len(receipt.items),
	}

	return result


@frappe.whitelist()
def get_stock_and_transit(item_codes: str | list[str], warehouse: str | None = None) -> dict:
	"""
	Get stock in hand and transit stock for given item codes.

	Args:
	    item_codes: list of item codes
	    warehouse: optional warehouse filter

	Returns:
	    dict keyed by item_code with stock_in_hand and transit_stock
	"""
	if isinstance(item_codes, str):
		item_codes = json.loads(item_codes)

	if not item_codes:
		return {}

	result = {}

	bin_filters = {"item_code": ["in", item_codes]}
	if warehouse:
		bin_filters["warehouse"] = warehouse

	bins = frappe.get_all(
		"Bin",
		filters=bin_filters,
		fields=["item_code", "actual_qty", "ordered_qty"],
		group_by="item_code" if not warehouse else None,
	)

	stock_map = {}
	ordered_map = {}
	for b in bins:
		stock_map[b.item_code] = flt(stock_map.get(b.item_code, 0)) + flt(b.actual_qty)
		ordered_map[b.item_code] = flt(ordered_map.get(b.item_code, 0)) + flt(b.ordered_qty)

	transit_data = frappe.db.sql(
		"""
        SELECT poi.item_code,
               SUM(poi.qty - poi.received_qty) as transit_qty
        FROM `tabPurchase Order Item` poi
        INNER JOIN `tabPurchase Order` po ON po.name = poi.parent
        WHERE poi.item_code IN %(item_codes)s
          AND po.docstatus = 1
          AND po.status NOT IN ('Completed', 'Cancelled', 'Closed')
          AND poi.qty > poi.received_qty
        GROUP BY poi.item_code
        """,
		{"item_codes": item_codes},
		as_dict=True,
	)

	transit_map = {}
	for row in transit_data:
		transit_map[row.item_code] = flt(row.transit_qty)

	for code in item_codes:
		result[code] = {
			"stock_in_hand": flt(stock_map.get(code, 0)),
			"transit_stock": flt(transit_map.get(code, 0)),
		}

	return result


@frappe.whitelist()
def get_category_items(
	supplier: str,
	po_category: str,
	warehouse: str | None = None,
	from_date: str | None = None,
	to_date: str | None = None,
) -> list[dict]:
	"""
	Get items based on PO category and supplier.

	Categories:
	- Against Purchase Quotation: Items from supplier's purchase quotations
	- Against Sale Order: Items from pending sales orders
	- Projection Period: Items based on sales projection for a given date range
	- Reorder Level: Items below reorder level

	Args:
	    supplier: Supplier name
	    po_category: PO Category string
	    warehouse: Optional warehouse filter
	    from_date: Start date for projection period
	    to_date: End date for projection period

	Returns:
	    List of items with qty suggestions
	"""
	if not supplier or not po_category:
		frappe.throw(_("Supplier and PO Category are required."))

	items = []

	if po_category == "Projection Period":
		items = _get_items_from_projection(supplier, warehouse, from_date, to_date)

	elif po_category == "Reorder Level":
		items = _get_items_below_reorder(supplier, warehouse)

	if items:
		item_codes = [i.get("item_code") for i in items]
		uom_data = _get_item_uoms(item_codes)
		for item in items:
			item["item_uoms"] = uom_data.get(item.get("item_code"), [])

	return items


def _get_items_from_projection(
	supplier: str,
	warehouse: str | None = None,
	from_date: str | None = None,
	to_date: str | None = None,
) -> list[dict]:
	"""Get items based on sales projection for a date range.

	Looks at Sales Invoice Items in the specified period (defaults to last 30
	days when no dates are given), calculates the average daily sales, then
	suggests a reorder quantity that covers the same period length.
	"""
	supplier_items = _get_supplier_item_codes(supplier)
	if not supplier_items:
		return []

	if from_date and to_date:
		start = getdate(from_date)
		end = getdate(to_date)
	else:
		end = getdate(nowdate())
		start = frappe.utils.add_days(end, -30)

	period_days = max((end - start).days, 1)

	sales_data = frappe.db.sql(
		"""
        SELECT
            sii.item_code,
            sii.item_name,
            sii.stock_uom,
            SUM(sii.qty) as total_qty
        FROM `tabSales Invoice Item` sii
        INNER JOIN `tabSales Invoice` si ON si.name = sii.parent
        WHERE sii.item_code IN %(items)s
          AND si.docstatus = 1
          AND si.posting_date >= %(from_date)s
          AND si.posting_date <= %(to_date)s
        GROUP BY sii.item_code
        """,
		{"items": supplier_items, "from_date": start, "to_date": end},
		as_dict=True,
	)

	if not sales_data:
		return []

	item_codes = [r.item_code for r in sales_data]
	stock_data = get_stock_and_transit(item_codes, warehouse)

	items = []
	for row in sales_data:
		avg_daily = flt(row.total_qty) / period_days
		suggested_qty = max(1, int(avg_daily * period_days))

		stock = stock_data.get(row.item_code, {})
		current_stock = flt(stock.get("stock_in_hand", 0))
		transit_stock = flt(stock.get("transit_stock", 0))
		net_required = max(0, suggested_qty - current_stock - transit_stock)

		item = frappe.get_cached_doc("Item", row.item_code)
		items.append(
			{
				"item_code": row.item_code,
				"item_name": row.item_name,
				"stock_uom": row.stock_uom,
				"standard_rate": _get_buying_rate(row.item_code),
				"qty": max(1, int(net_required)) if net_required > 0 else suggested_qty,
				"item_group": item.item_group,
				"custom_stock_in_hand": current_stock,
				"custom_transit_stock": transit_stock,
			}
		)

	return items


def _get_items_below_reorder(supplier: str, warehouse: str | None = None) -> list[dict]:
	"""Get items below reorder level for this supplier."""
	supplier_items = _get_supplier_item_codes(supplier)
	if not supplier_items:
		return []

	filters = {"parent": ["in", supplier_items], "warehouse_reorder_level": [">", 0]}
	if warehouse:
		filters["warehouse"] = warehouse

	reorder_data = frappe.get_all(
		"Item Reorder",
		filters=filters,
		fields=[
			"parent as item_code",
			"warehouse_reorder_level",
			"warehouse_reorder_qty",
		],
	)

	if not reorder_data:
		return []

	reorder_items = {r.item_code: r for r in reorder_data}
	stock_data = get_stock_and_transit(list(reorder_items.keys()), warehouse)

	items = []
	for item_code, reorder_info in reorder_items.items():
		current_stock = stock_data.get(item_code, {}).get("stock_in_hand", 0)
		transit_stock = stock_data.get(item_code, {}).get("transit_stock", 0)
		available = current_stock + transit_stock

		if available < reorder_info.warehouse_reorder_level:
			item = frappe.get_cached_doc("Item", item_code)
			shortage = reorder_info.warehouse_reorder_level - available
			reorder_qty = max(shortage, reorder_info.warehouse_reorder_qty or shortage)

			items.append(
				{
					"item_code": item_code,
					"item_name": item.item_name,
					"stock_uom": item.stock_uom,
					"standard_rate": _get_buying_rate(item_code),
					"qty": int(reorder_qty),
					"item_group": item.item_group,
					"custom_stock_in_hand": current_stock,
					"custom_transit_stock": transit_stock,
				}
			)

	return items


def _get_supplier_item_codes(supplier: str) -> list[str]:
	"""Get all item codes for a supplier."""
	supplier_items = set()

	supplier_item_rows = frappe.get_all(
		"Item Supplier",
		filters={"supplier": supplier},
		fields=["parent"],
	)
	for row in supplier_item_rows:
		supplier_items.add(row.parent)

	default_supplier_rows = frappe.get_all(
		"Item Default",
		filters={"default_supplier": supplier},
		fields=["parent"],
	)
	for row in default_supplier_rows:
		supplier_items.add(row.parent)

	return list(supplier_items)


def _get_buying_rate(item_code: str, price_list: str | None = None) -> float:
	"""Get buying rate for an item."""
	rate = 0
	if price_list:
		rate = frappe.db.get_value(
			"Item Price",
			{"item_code": item_code, "price_list": price_list, "buying": 1},
			"price_list_rate",
		)
	if not rate:
		rate = frappe.db.get_value("Item", item_code, "standard_rate")
	return flt(rate)


def _get_item_uoms(item_codes: list[str]) -> dict[str, list[dict[str, float]]]:
	"""Get UOM conversion details for items."""
	if not item_codes:
		return {}

	uom_rows = frappe.get_all(
		"UOM Conversion Detail",
		filters={"parent": ["in", item_codes]},
		fields=["parent", "uom", "conversion_factor"],
	)

	uom_map = {}
	for row in uom_rows:
		if row.parent not in uom_map:
			uom_map[row.parent] = []
		uom_map[row.parent].append({"uom": row.uom, "conversion_factor": row.conversion_factor})

	for item_code in item_codes:
		if item_code not in uom_map:
			stock_uom = frappe.get_value("Item", item_code, "stock_uom")
			uom_map[item_code] = [{"uom": stock_uom, "conversion_factor": 1}]
		else:
			stock_uom = frappe.get_value("Item", item_code, "stock_uom")
			has_stock_uom = any(u["uom"] == stock_uom for u in uom_map[item_code])
			if not has_stock_uom:
				uom_map[item_code].append({"uom": stock_uom, "conversion_factor": 1})

	return uom_map


@frappe.whitelist()
def save_po_draft(data: str | dict, pos_profile: str) -> dict:
	"""
	Save or update a Purchase Order in Draft state (docstatus=0).

	Accepts the same cart payload as create_purchase_order plus an optional
	``draft_name`` field.  When ``draft_name`` is provided and points to an
	existing docstatus=0 PO, that document is updated in-place; otherwise a
	new Draft PO is inserted.

	Returns:
	    dict: draft_name, supplier, supplier_name, transaction_date,
	          items_count, modified
	"""
	payload = json.loads(data) if isinstance(data, str) else data

	supplier_input = payload.get("supplier")
	if not supplier_input:
		frappe.throw(_("Please select a supplier before saving a draft."))

	supplier = _resolve_supplier(supplier_input)
	if not supplier:
		frappe.throw(_("Supplier '{0}' not found.").format(supplier_input))

	company = payload.get("company") or frappe.defaults.get_default("company")
	if not company:
		frappe.throw(_("Company is required."))

	warehouse = payload.get("warehouse") or get_default_warehouse(company)
	transaction_date = payload.get("transaction_date") or nowdate()
	schedule_date = payload.get("schedule_date") or transaction_date
	draft_name = payload.get("draft_name")

	if draft_name and frappe.db.exists("Purchase Order", draft_name):
		po_doc = frappe.get_doc("Purchase Order", draft_name)
		if po_doc.docstatus != 0:
			frappe.throw(_("Cannot update a submitted Purchase Order as draft."))
		po_doc.supplier = supplier
		po_doc.company = company
		po_doc.transaction_date = transaction_date
		po_doc.schedule_date = schedule_date
		po_doc.items = []
	else:
		supplier_doc = frappe.get_doc("Supplier", supplier)
		supplier_currency = supplier_doc.default_currency or frappe.get_value(
			"Company", company, "default_currency"
		)
		buying_price_list = get("buying_price_list", pos_profile) or frappe.db.get_value(
			"Price List", {"buying": 1, "company": company}, "name"
		)
		po_doc = frappe.get_doc(
			{
				"doctype": "Purchase Order",
				"supplier": supplier,
				"company": company,
				"transaction_date": transaction_date,
				"schedule_date": schedule_date,
				"currency": supplier_currency,
				"buying_price_list": buying_price_list,
			}
		)

	if warehouse:
		po_doc.set_warehouse = warehouse

	for cf in (
		"custom_alias_name",
		"custom_po_category",
		"custom_po_type",
		"custom_po_department",
		"custom_po_remarks",
		"custom_zero_qty",
	):
		val = payload.get(cf)
		if val is not None:
			po_doc.set(cf, val)

	for row in payload.get("items") or []:
		item_code = row.get("item_code")
		if not item_code:
			continue
		qty = flt(row.get("qty", 0))
		if qty <= 0:
			continue
		uom = row.get("uom") or row.get("stock_uom") or "Nos"
		stock_uom = row.get("stock_uom") or uom
		po_doc.append(
			"items",
			{
				"item_code": item_code,
				"item_name": row.get("item_name") or item_code,
				"qty": qty,
				"uom": uom,
				"stock_uom": stock_uom,
				"conversion_factor": flt(row.get("conversion_factor") or 1),
				"rate": flt(row.get("rate") or 0),
				"warehouse": row.get("warehouse") or warehouse,
				"schedule_date": schedule_date,
			},
		)

	po_doc.flags.ignore_permissions = True
	frappe.flags.ignore_account_permission = True

	if draft_name and po_doc.get("name"):
		po_doc.save()
	else:
		po_doc.insert()

	return {
		"draft_name": po_doc.name,
		"supplier": po_doc.supplier,
		"supplier_name": po_doc.supplier_name or po_doc.supplier,
		"transaction_date": str(po_doc.transaction_date),
		"items_count": len(po_doc.items),
		"modified": str(po_doc.modified),
	}


@frappe.whitelist()
def load_po_draft(name: str) -> dict:
	"""
	Load a draft Purchase Order and return its data in the frontend cart format.

	Args:
	    name: Purchase Order docname

	Returns:
	    dict compatible with the purchaseStore draft loader.
	"""
	if not frappe.db.exists("Purchase Order", name):
		frappe.throw(_("Purchase Order '{0}' not found.").format(name))

	po = frappe.get_doc("Purchase Order", name)
	if po.docstatus != 0:
		frappe.throw(_("Purchase Order '{0}' is not a draft.").format(name))

	item_codes = [item.item_code for item in po.items]
	uom_data_map = _get_item_uoms(item_codes) if item_codes else {}

	items = []
	for item in po.items:
		uom_list = uom_data_map.get(item.item_code, [])
		if not any(u["uom"] == item.stock_uom for u in uom_list):
			uom_list.append({"uom": item.stock_uom, "conversion_factor": 1})
		items.append(
			{
				"item_code": item.item_code,
				"item_name": item.item_name,
				"qty": flt(item.qty),
				"rate": flt(item.rate),
				"uom": item.uom,
				"stock_uom": item.stock_uom,
				"conversion_factor": flt(item.conversion_factor) or 1,
				"warehouse": item.warehouse,
				"stock_in_hand": flt(item.get("custom_stock_in_hand")),
				"transit_stock": flt(item.get("custom_transit_stock")),
				"required_packs": flt(item.get("custom_required_packs")),
				"pack_units": flt(item.get("custom_pack_units")),
				"class": item.get("custom_class") or "",
				"item_packing": item.get("custom_item_packing") or "",
				"item_group": item.item_group or "",
				"item_uoms": uom_list,
				"discount_percent": 0,
			}
		)

	return {
		"draft_name": po.name,
		"supplier": po.supplier,
		"supplier_name": po.supplier_name or po.supplier,
		"items": items,
		"po_category": po.get("custom_po_category") or "",
		"po_type": po.get("custom_po_type") or "",
		"po_department": po.get("custom_po_department") or "",
		"po_remarks": po.get("custom_po_remarks") or "",
		"po_zero_qty": po.get("custom_zero_qty") or "No",
		"created_at": str(po.creation),
		"updated_at": str(po.modified),
	}


@frappe.whitelist()
def delete_po_draft(name: str) -> dict:
	"""
	Delete a draft Purchase Order (docstatus=0 only).

	Args:
	    name: Purchase Order docname

	Returns:
	    dict with success status.
	"""
	if not frappe.db.exists("Purchase Order", name):
		return {"success": True}

	po = frappe.get_doc("Purchase Order", name)
	if po.docstatus != 0:
		frappe.throw(_("Cannot delete a submitted Purchase Order."))

	frappe.delete_doc("Purchase Order", name, ignore_permissions=True)
	return {"success": True}


@frappe.whitelist()
def list_po_drafts(limit: int = 20) -> list[dict]:
	"""
	List draft Purchase Orders owned by the current user (docstatus=0).

	Returns:
	    List of dicts: name, supplier, supplier_name, transaction_date,
	                   grand_total, creation, modified, items_count.
	"""
	drafts = frappe.get_all(
		"Purchase Order",
		filters={
			"docstatus": 0,
			"owner": frappe.session.user,
		},
		fields=[
			"name",
			"supplier",
			"supplier_name",
			"transaction_date",
			"grand_total",
			"creation",
			"modified",
		],
		order_by="modified desc",
		limit_page_length=cint(limit) or 20,
	)

	for draft in drafts:
		draft["items_count"] = frappe.db.count("Purchase Order Item", filters={"parent": draft["name"]})

	return drafts


@frappe.whitelist()
def save_pi_draft(data: str | dict) -> dict:
	"""Save or update a Purchase Invoice draft (docstatus=0).

	Args:
	        data: JSON string or dict with keys:
	                - draft_name (optional): existing draft to update
	                - supplier, company, warehouse, posting_date, bill_no, remarks
	                - items: list of item dicts
	                - additional_discount_percentage, discount_amount, taxes_and_charges

	Returns:
	        dict with draft_name, supplier, items_count, modified
	"""
	payload = json.loads(data) if isinstance(data, str) else data

	supplier = _resolve_supplier(payload.get("supplier"))
	if not supplier:
		frappe.throw(_("Supplier is required to save a draft."))

	company = payload.get("company") or frappe.defaults.get_user_default("Company")
	if not company:
		frappe.throw(_("Company is required."))

	posting_date = payload.get("posting_date") or nowdate()
	warehouse = payload.get("warehouse")
	update_stock = cint(payload.get("receive") or payload.get("update_stock") or 1)

	draft_name = payload.get("draft_name")
	is_update = False

	if draft_name and frappe.db.exists("Purchase Invoice", draft_name):
		pi_doc = frappe.get_doc("Purchase Invoice", draft_name)
		if pi_doc.docstatus != 0:
			frappe.throw(_("Invoice {0} is not a draft.").format(draft_name))
		is_update = True
		pi_doc.set("items", [])
	else:
		pi_doc = frappe.new_doc("Purchase Invoice")

	pi_doc.supplier = supplier
	pi_doc.company = company
	pi_doc.posting_date = posting_date
	pi_doc.bill_no = payload.get("bill_no") or None
	pi_doc.remarks = payload.get("remarks") or None
	pi_doc.update_stock = update_stock
	pi_doc.currency = payload.get("currency") or frappe.db.get_value("Company", company, "default_currency")

	if warehouse and update_stock:
		pi_doc.set_warehouse = warehouse

	if payload.get("additional_discount_percentage"):
		pi_doc.additional_discount_percentage = flt(payload["additional_discount_percentage"])
		pi_doc.apply_discount_on = payload.get("apply_discount_on") or "Grand Total"
	elif payload.get("discount_amount"):
		pi_doc.discount_amount = flt(payload["discount_amount"])
		pi_doc.apply_discount_on = payload.get("apply_discount_on") or "Grand Total"

	items = payload.get("items") or []
	item_codes = [r.get("item_code") for r in items if r.get("item_code")]
	item_map = {}
	if item_codes:
		item_meta = frappe.get_all(
			"Item",
			filters={"name": ["in", item_codes]},
			fields=["name", "item_name", "stock_uom"],
		)
		item_map = {row.name: row for row in item_meta}

	for row in items:
		item_code = row.get("item_code")
		if not item_code:
			continue

		meta = item_map.get(item_code)
		stock_uom = row.get("stock_uom") or (meta.stock_uom if meta else None)
		item_name = row.get("item_name") or (meta.item_name if meta else item_code)
		uom = row.get("uom") or stock_uom
		conversion_factor = flt(row.get("conversion_factor") or 1) or 1

		pi_item = {
			"item_code": item_code,
			"item_name": item_name,
			"qty": flt(row.get("qty") or 0),
			"uom": uom,
			"stock_uom": stock_uom,
			"conversion_factor": conversion_factor,
			"rate": flt(row.get("rate") or 0),
			"batch_no": row.get("batch_no") or None,
		}

		row_warehouse = row.get("warehouse") or warehouse
		if row_warehouse:
			pi_item["warehouse"] = row_warehouse

		purchase_order = row.get("purchase_order") or payload.get("purchase_order")
		if purchase_order:
			pi_item["purchase_order"] = purchase_order
		if row.get("po_detail"):
			pi_item["po_detail"] = row["po_detail"]

		pi_doc.append("items", pi_item)

	if not pi_doc.items:
		frappe.throw(_("At least one item is required."))

	pi_doc.flags.ignore_permissions = True
	if is_update:
		pi_doc.save()
	else:
		pi_doc.insert()

	return {
		"draft_name": pi_doc.name,
		"supplier": pi_doc.supplier,
		"items_count": len(pi_doc.items),
		"modified": str(pi_doc.modified),
	}


@frappe.whitelist()
def load_pi_draft(name: str, pos_profile: str) -> dict:
	"""Load a Purchase Invoice draft (docstatus=0) into the frontend cart format.

	Args:
	        name: Purchase Invoice docname
	        pos_profile: POS profile name
	Returns:
	        dict with draft_name, supplier, posting_date, bill_no, remarks, items, etc.
	"""
	if not frappe.db.exists("Purchase Invoice", name):
		frappe.throw(_("Draft {0} not found.").format(name))

	doc = frappe.get_doc("Purchase Invoice", name)
	if doc.docstatus != 0:
		frappe.throw(_("Invoice {0} is not a draft.").format(name))

	item_codes = [item.item_code for item in doc.items if item.item_code]
	uom_map = {}
	if item_codes:
		uom_rows = frappe.get_all(
			"UOM Conversion Detail",
			filters={"parent": ["in", item_codes]},
			fields=["parent", "uom", "conversion_factor"],
		)
		for row in uom_rows:
			uom_map.setdefault(row.parent, []).append(
				{"uom": row.uom, "conversion_factor": row.conversion_factor}
			)

	selling_price_list = get("selling_price_list", pos_profile) or frappe.db.get_value(
		"Price List", {"selling": 1, "company": doc.company}, "name"
	)

	selling_map = {}
	if selling_price_list and item_codes:
		sp_rows = frappe.get_all(
			"Item Price",
			filters={
				"item_code": ["in", item_codes],
				"price_list": selling_price_list,
				"selling": 1,
			},
			fields=["item_code", "price_list_rate", "uom"],
		)
		for row in sp_rows:
			selling_map[row.item_code] = flt(row.price_list_rate)

	items = []
	for item in doc.items:
		uoms = uom_map.get(item.item_code, [])
		if item.stock_uom and not any(u["uom"] == item.stock_uom for u in uoms):
			uoms.append({"uom": item.stock_uom, "conversion_factor": 1})

		items.append(
			{
				"item_code": item.item_code,
				"item_name": item.item_name,
				"qty": item.qty,
				"rate": item.rate,
				"uom": item.uom,
				"stock_uom": item.stock_uom,
				"conversion_factor": item.conversion_factor or 1,
				"warehouse": item.warehouse,
				"batch_no": item.batch_no,
				"discount_percent": flt(item.discount_percentage),
				"discount_amount": flt(item.discount_amount),
				"item_uoms": uoms,
				"sale_price": selling_map.get(item.item_code, 0),
				"purchase_order": item.purchase_order,
				"po_detail": item.po_detail,
			}
		)

	return {
		"draft_name": doc.name,
		"supplier": doc.supplier,
		"posting_date": str(doc.posting_date),
		"bill_no": doc.bill_no,
		"remarks": doc.remarks,
		"update_stock": doc.update_stock,
		"discount_amount": flt(doc.discount_amount),
		"additional_discount_percentage": flt(doc.additional_discount_percentage),
		"items": items,
	}


@frappe.whitelist()
def delete_pi_draft(name: str) -> dict:
	"""Delete a Purchase Invoice draft (docstatus=0)."""
	if not frappe.db.exists("Purchase Invoice", name):
		return {"success": True}

	doc = frappe.get_doc("Purchase Invoice", name)
	if doc.docstatus != 0:
		frappe.throw(_("Cannot delete submitted invoice {0}.").format(name))

	frappe.delete_doc("Purchase Invoice", name, ignore_permissions=True)
	return {"success": True}


@frappe.whitelist()
def list_pi_drafts(limit: int = 20) -> list[dict]:
	"""List draft Purchase Invoices owned by the current user (docstatus=0).

	Returns:
	        List of dicts: name, supplier, supplier_name, posting_date,
	                       grand_total, creation, modified, items_count.
	"""
	drafts = frappe.get_all(
		"Purchase Invoice",
		filters={
			"docstatus": 0,
			"owner": frappe.session.user,
		},
		fields=[
			"name",
			"supplier",
			"supplier_name",
			"posting_date",
			"grand_total",
			"bill_no",
			"creation",
			"modified",
		],
		order_by="modified desc",
		limit_page_length=cint(limit) or 20,
	)

	for draft in drafts:
		draft["items_count"] = frappe.db.count("Purchase Invoice Item", filters={"parent": draft["name"]})

	return drafts


@frappe.whitelist()
def submit_pi_draft(name: str) -> dict:
	"""Submit a Purchase Invoice draft.

	Args:
	        name: Purchase Invoice docname (docstatus=0)

	Returns:
	        dict with purchase_invoice name
	"""
	if not frappe.db.exists("Purchase Invoice", name):
		frappe.throw(_("Draft {0} not found.").format(name))

	doc = frappe.get_doc("Purchase Invoice", name)
	if doc.docstatus != 0:
		frappe.throw(_("Invoice {0} is not a draft.").format(name))

	doc.flags.ignore_permissions = True
	frappe.flags.ignore_account_permission = True
	doc.submit()

	return {
		"purchase_invoice": doc.name,
		"grand_total": doc.grand_total,
	}


@frappe.whitelist()
def get_purchase_orders_for_invoice(
	supplier: str,
	warehouse: str | None = None,
	pos_profile: str | None = None,
	company: str | None = None,
) -> list[dict]:
	"""Get submitted Purchase Orders with pending billing for a supplier.

	Args:
	        supplier: Supplier name/docname
	        warehouse: Optional warehouse filter
	        pos_profile: Optional POS profile name

	Returns:
	        List of PO dicts with items that can be invoiced.
	"""
	supplier = _resolve_supplier(supplier)
	if not supplier:
		return []

	filters = {
		"docstatus": 1,
		"supplier": supplier,
		"per_billed": ["<", 100],
		"status": ["not in", ["Closed", "Cancelled"]],
	}

	pos = frappe.get_all(
		"Purchase Order",
		filters=filters,
		fields=[
			"name",
			"supplier",
			"supplier_name",
			"transaction_date",
			"grand_total",
			"per_received",
			"per_billed",
			"status",
		],
		order_by="transaction_date desc",
		limit_page_length=50,
	)

	selling_price_list = get("selling_price_list", pos_profile) or frappe.db.get_value(
		"Price List", {"selling": 1, "company": company}, "name"
	)

	for po in pos:
		items = frappe.get_all(
			"Purchase Order Item",
			filters={"parent": po["name"]},
			fields=[
				"name as po_detail",
				"item_code",
				"item_name",
				"qty",
				"received_qty",
				"billed_amt",
				"rate",
				"amount",
				"uom",
				"stock_uom",
				"conversion_factor",
				"warehouse",
			],
		)

		for item in items:
			item["pending_qty"] = flt(item["qty"]) - flt(item.get("received_qty") or 0)
			if selling_price_list:
				sp = frappe.db.get_value(
					"Item Price",
					{
						"item_code": item["item_code"],
						"price_list": selling_price_list,
						"selling": 1,
					},
					"price_list_rate",
				)
				item["sale_price"] = flt(sp)
			else:
				item["sale_price"] = 0

			uoms = frappe.get_all(
				"UOM Conversion Detail",
				filters={"parent": item["item_code"]},
				fields=["uom", "conversion_factor"],
			)
			if item["stock_uom"] and not any(u["uom"] == item["stock_uom"] for u in uoms):
				uoms.append({"uom": item["stock_uom"], "conversion_factor": 1})
			item["item_uoms"] = uoms

		po["items"] = items

	return pos


def update_item_prices(items: list, pos_profile: dict):
	"""Update item prices for items."""
	selling_price_list = None
	buying_price_list = None

	if pos_profile.get("update_selling_price"):
		selling_price_list = pos_profile.get("selling_price_list", pos_profile) or frappe.db.get_value(
			"Price List", {"selling": 1, "company": pos_profile.get("company")}, "name"
		)

	if pos_profile.get("update_buying_price"):
		buying_price_list = pos_profile.get("buying_price_list", pos_profile) or frappe.db.get_value(
			"Price List", {"buying": 1, "company": pos_profile.get("company")}, "name"
		)

	for row in items:
		item_code = row.get("item_code")
		sale_price = flt(row.get("sale_price"))
		rate = flt(row.get("rate"))

		if not item_code or (not sale_price and not rate):
			continue

		if selling_price_list and pos_profile.get("update_selling_price"):
			_upsert_item_price(
				item_code,
				selling_price_list,
				sale_price / flt(row.get("conversion_factor") or 1),
				uom=frappe.db.get_value("Item", item_code, "stock_uom"),
				selling=True,
			)

		if buying_price_list and pos_profile.get("update_buying_price"):
			_upsert_item_price(
				item_code,
				buying_price_list,
				rate / flt(row.get("conversion_factor") or 1),
				uom=frappe.db.get_value("Item", item_code, "stock_uom"),
				buying=True,
			)


@frappe.whitelist()
def update_item_selling_price(
	data: str | dict, pos_profile: str | None = None, company: str | None = None
) -> dict:
	"""Apply purchase-screen sale prices before a Purchase Invoice draft is submitted.

	The draft submit path does not go through ``create_purchase_invoice_direct``,
	so the frontend calls this first; the POS Profile flags still decide what is written.
	"""
	from erpnext.stock.get_item_details import get_conversion_factor

	payload = json.loads(data) if isinstance(data, str) else data
	# Only a profile name is accepted - a client-supplied dict could switch price updates on.
	profile = _resolve_pos_profile(pos_profile if isinstance(pos_profile, str) else None)
	_ensure_allowed(profile, "allow_purchase_order", _("Purchase invoices"))

	items = []
	for row in payload.get("items") or []:
		if not row.get("item_code"):
			continue
		conversion_factor = 1
		if row.get("uom"):
			conversion_factor = (
				flt(get_conversion_factor(row["item_code"], row["uom"]).get("conversion_factor")) or 1
			)
		items.append({**row, "conversion_factor": conversion_factor})

	update_item_prices(items, profile)
	return {"updated_count": len(items)}


@frappe.whitelist()
def get_item_purchase_details(item_code: str, pos_profile: str | None = None) -> dict | None:
	"""Fetch full item details for purchase invoice including prices, UOMs, and tax info.

	Args:
	        item_code: Item code / name
	        pos_profile: Optional POS Profile name (to resolve buying/selling price lists)

	Returns:
	        Dict with item_code, item_name, stock_uom, purchase_uom, buying_rate,
	        selling_rate, conversion_factor, item_uoms, item_tax_template, tax_rate
	"""
	if not item_code or not frappe.db.exists("Item", item_code):
		return None

	item = frappe.get_cached_doc("Item", item_code)

	uoms = []
	for row in item.uoms or []:
		uoms.append({"uom": row.uom, "conversion_factor": flt(row.conversion_factor)})

	if item.stock_uom and not any(u["uom"] == item.stock_uom for u in uoms):
		uoms.append({"uom": item.stock_uom, "conversion_factor": 1})

	purchase_uom = item.purchase_uom or get("purchase_uom", pos_profile) or item.stock_uom
	purchase_cf = 1
	for u in uoms:
		if u["uom"] == purchase_uom:
			purchase_cf = flt(u["conversion_factor"]) or 1
			break

	buying_price_list = get("buying_price_list", pos_profile) or frappe.db.get_value(
		"Price List", {"buying": 1, "company": item.company}, "name"
	)
	buying_rate = 0
	if buying_price_list:
		bp = frappe.db.get_value(
			"Item Price",
			{
				"item_code": item_code,
				"price_list": buying_price_list,
				"buying": 1,
			},
			"price_list_rate",
		)
		if not bp:
			bp = frappe.db.get_value(
				"Item Price",
				{"item_code": item_code, "price_list": buying_price_list, "buying": 1},
				"price_list_rate",
			)
		buying_rate = flt(bp)
	if not buying_rate:
		buying_rate = flt(item.last_purchase_rate) or flt(item.standard_rate) or flt(item.valuation_rate)

	selling_price_list = get("selling_price_list", pos_profile) or frappe.db.get_value(
		"Price List", {"selling": 1, "company": item.company}, "name"
	)

	selling_rate = 0
	if selling_price_list:
		sp = frappe.db.get_value(
			"Item Price",
			{"item_code": item_code, "price_list": selling_price_list, "selling": 1},
			"price_list_rate",
		)
		selling_rate = flt(sp)
	if not selling_rate:
		selling_rate = flt(item.standard_selling_rate)

	barcodes = [b.barcode for b in (item.barcodes or []) if b.barcode]

	return {
		"item_code": item.name,
		"item_name": item.item_name,
		"stock_uom": item.stock_uom,
		"purchase_uom": purchase_uom,
		"purchase_cf": purchase_cf,
		"item_uoms": uoms,
		"buying_rate": buying_rate,
		"selling_rate": selling_rate,
		"item_group": item.item_group,
		"barcode": barcodes[0] if barcodes else None,
		"barcodes": barcodes,
	}


@frappe.whitelist()
def get_purchase_tax_template(template_name: str | None = None, company: str | None = None) -> dict:
	"""Fetch taxes from a Purchase Taxes and Charges Template.

	If template_name is not given, tries to find the default template for the company.

	Args:
	        template_name: Purchase Taxes and Charges Template name
	        company: Company name (used to find default template if template_name not given)

	Returns:
	        Dict with template_name and taxes list
	"""
	if not template_name:
		company = company or frappe.defaults.get_user_default("Company")
		if company:
			template_name = frappe.db.get_value(
				"Purchase Taxes and Charges Template",
				{"company": company, "is_default": 1},
				"name",
			)
		if not template_name:
			template_name = frappe.db.get_value(
				"Purchase Taxes and Charges Template",
				{"is_default": 1},
				"name",
			)

	if not template_name:
		return {"template_name": "", "taxes": []}

	taxes = frappe.get_all(
		"Purchase Taxes and Charges",
		filters={
			"parent": template_name,
			"parenttype": "Purchase Taxes and Charges Template",
		},
		fields=[
			"charge_type",
			"description",
			"rate",
			"account_head",
			"included_in_print_rate",
			"tax_amount",
		],
		order_by="idx asc",
	)

	return {"template_name": template_name, "taxes": taxes}
