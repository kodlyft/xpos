# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt


import hashlib
import json

import frappe
from frappe import _
from frappe.permissions import has_user_permission
from frappe.utils import cint, cstr, flt, getdate, nowdate

from xpos.api.auth import is_superuser, user_has_pos_permission
from xpos.api.items import get_warehouse_list
from xpos.api.profiles import ensure_profile_allows, resolve_pos_profile
from xpos.utils import read_latest_on_lock

LIST_LIMIT = 30


def receiving_profile(pos_profile: str | None, right: str | None = None):
	profile = resolve_pos_profile(pos_profile)
	ensure_profile_allows(profile, "allow_purchase_receipt", _("Stock receiving"))
	if right and not user_has_pos_permission(right, pos_profile=profile.name):
		frappe.throw(
			_("You are not permitted to do this on POS Profile {0}.").format(profile.name),
			frappe.PermissionError,
		)
	return profile


def can_see_rates(profile) -> bool:
	return user_has_pos_permission("receive_stock_rates", pos_profile=profile.name)


def allowed_warehouses(profile) -> list[str]:
	names = set(get_warehouse_list(profile.warehouse)) | {profile.warehouse}
	allowed = frappe.get_all(
		"Warehouse",
		filters={"name": ["in", list(names)], "company": profile.company, "disabled": 0, "is_group": 0},
		pluck="name",
		order_by="name",
	)
	return [w for w in allowed if has_user_permission(frappe.get_cached_doc("Warehouse", w))]


@frappe.whitelist()
def get_receiving_setup(pos_profile: str | None = None) -> dict:
	profile = receiving_profile(pos_profile)
	warehouses = allowed_warehouses(profile)
	return {
		"pos_profile": profile.name,
		"company": profile.company,
		"warehouse": profile.warehouse if profile.warehouse in warehouses else (warehouses or [None])[0],
		"can_draft": user_has_pos_permission("receive_stock_draft", pos_profile=profile.name),
		"can_submit": user_has_pos_permission("receive_stock_submit", pos_profile=profile.name),
		"can_see_rates": can_see_rates(profile),
	}


@frappe.whitelist()
def lookup_item(pos_profile: str, code: str) -> str | None:
	receiving_profile(pos_profile)
	code = cstr(code).strip()
	if not code:
		return None
	if frappe.db.exists("Item", code):
		return code
	return frappe.db.get_value("Item Barcode", {"barcode": code}, "parent")


def item_flags(item_code: str) -> frappe._dict:
	return frappe.get_cached_value(
		"Item",
		item_code,
		["has_batch_no", "has_serial_no", "variant_of"],
		as_dict=True,
	)


def row_destination(se, row) -> str | None:
	if se.xpos_receiving_warehouse:
		return se.xpos_receiving_warehouse
	if row.material_request_item:
		return frappe.db.get_value("Material Request Item", row.material_request_item, "warehouse")
	return None


def transfer_visible(profile, se, allowed: set[str]) -> bool:
	if se.company != profile.company:
		return False
	return any(row_destination(se, r) in allowed for r in se.items)


def open_transfer_rows(se, allowed: set[str], rates: bool = True) -> list[dict]:
	rows = []
	for r in se.items:
		destination = row_destination(se, r)
		if destination not in allowed:
			continue
		cf = flt(r.conversion_factor) or 1
		pending = flt(r.qty) - flt(r.transferred_qty) / cf
		if flt(pending, r.precision("qty")) <= 0:
			continue
		flags = item_flags(r.item_code)
		row = {
			"ste_detail": r.name,
			"item_code": r.item_code,
			"item_name": r.item_name,
			"uom": r.uom,
			"stock_uom": r.stock_uom,
			"conversion_factor": cf,
			"sent_qty": flt(r.qty),
			"received_qty": flt(r.qty) - pending,
			"pending_qty": pending,
			"s_warehouse": r.s_warehouse,
			"transit_warehouse": r.t_warehouse,
			"destination": destination,
			"has_batch_no": cint(flags.has_batch_no),
			"has_serial_no": cint(flags.has_serial_no),
			"variant_of": flags.variant_of,
		}
		if rates:
			row["basic_rate"] = flt(r.basic_rate)
		rows.append(row)
	return rows


def load_transfer(profile, name: str):
	se = frappe.get_doc("Stock Entry", name)
	if se.outgoing_stock_entry:
		frappe.throw(_("Stock Entry {0} is itself a receipt.").format(name))
	if se.docstatus != 1 or se.purpose != "Material Transfer" or not se.add_to_transit:
		frappe.throw(_("Stock Entry {0} is not an in-transit transfer.").format(name))
	if not transfer_visible(profile, se, set(allowed_warehouses(profile))):
		frappe.throw(
			_("Stock Entry {0} is not available to POS Profile {1}.").format(name, profile.name),
			frappe.PermissionError,
		)
	return se


@frappe.whitelist()
def list_incoming_transfers(pos_profile: str | None = None, txt: str | None = None) -> list[dict]:
	profile = receiving_profile(pos_profile)
	allowed = set(allowed_warehouses(profile))
	filters = {
		"docstatus": 1,
		"purpose": "Material Transfer",
		"add_to_transit": 1,
		"company": profile.company,
		"per_transferred": ["<", 100],
	}
	if txt:
		filters["name"] = ["like", f"%{txt}%"]
	out = []
	names = frappe.get_all(
		"Stock Entry",
		filters=filters,
		pluck="name",
		order_by="posting_date desc, name desc",
		limit_page_length=LIST_LIMIT * 3,
	)
	for name in names:
		se = frappe.get_doc("Stock Entry", name)
		if se.outgoing_stock_entry or not transfer_visible(profile, se, allowed):
			continue
		rows = open_transfer_rows(se, allowed, False)
		if not rows:
			continue
		out.append(
			{
				"name": se.name,
				"posting_date": cstr(se.posting_date),
				"from_warehouse": se.from_warehouse or rows[0]["s_warehouse"],
				"destination": rows[0]["destination"],
				"per_transferred": flt(se.per_transferred),
				"open_rows": len(rows),
				"pending_qty": sum(r["pending_qty"] for r in rows),
			}
		)
		if len(out) >= LIST_LIMIT:
			break
	return out


@frappe.whitelist()
def get_incoming_transfer(pos_profile: str, stock_entry: str) -> dict:
	profile = receiving_profile(pos_profile)
	se = load_transfer(profile, stock_entry)
	rows = open_transfer_rows(se, set(allowed_warehouses(profile)), can_see_rates(profile))
	if not rows:
		frappe.throw(_("Stock Entry {0} has already been fully received.").format(stock_entry))
	return {
		"name": se.name,
		"posting_date": cstr(se.posting_date),
		"from_warehouse": se.from_warehouse or rows[0]["s_warehouse"],
		"destination": rows[0]["destination"],
		"per_transferred": flt(se.per_transferred),
		"remarks": se.remarks or "",
		"items": rows,
	}


@frappe.whitelist()
def list_receipt_drafts(pos_profile: str | None = None) -> list[dict]:
	profile = receiving_profile(pos_profile)
	return frappe.get_all(
		"Stock Entry",
		filters={
			"docstatus": 0,
			"owner": frappe.session.user,
			"company": profile.company,
			"xpos_request_id": ["is", "set"],
			"outgoing_stock_entry": ["is", "set"],
		},
		fields=["name", "outgoing_stock_entry", "posting_date", "modified"],
		order_by="modified desc",
		limit_page_length=LIST_LIMIT,
	)


def fingerprint(data: dict) -> str:
	keys = ("stock_entry", "posting_date", "remarks")
	rows = [{k: row.get(k) for k in ("ste_detail", "qty", "return_qty")} for row in data.get("items") or []]
	payload = {k: data.get(k) for k in keys} | {"items": rows}
	return hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()


def find_by_request(request_id: str) -> frappe._dict | None:
	return frappe.db.get_value(
		"Stock Entry",
		{"xpos_request_id": request_id, "docstatus": ["in", (0, 1)]},
		["name", "owner", "docstatus", "xpos_request_hash", "company"],
		as_dict=True,
	)


def lock_rows(names: list[str]) -> None:
	read_latest_on_lock()
	for name in sorted(set(names)):
		frappe.db.sql("select name from `tabStock Entry` where name = %s for update", name)


def result_for(name: str, created: bool) -> dict:
	docstatus = frappe.db.get_value("Stock Entry", name, "docstatus")
	return {
		"name": name,
		"doctype": "Stock Entry",
		"docstatus": docstatus,
		"stock_posted": docstatus == 1,
		"created": created,
	}


def split_serials(raw) -> list[str]:
	return [s.strip() for s in cstr(raw).replace(",", "\n").splitlines() if s.strip()]


def bundle_entries(bundle: str | None, batch_no: str | None, serial_no: str | None, qty: float) -> list[dict]:
	if bundle:
		return [
			{"batch_no": e.batch_no, "serial_no": e.serial_no, "qty": abs(flt(e.qty))}
			for e in frappe.get_all(
				"Serial and Batch Entry",
				filters={"parent": bundle},
				fields=["batch_no", "serial_no", "qty"],
				order_by="idx",
			)
		]
	serials = split_serials(serial_no)
	if serials:
		return [{"batch_no": batch_no, "serial_no": s, "qty": 1} for s in serials]
	return [{"batch_no": batch_no, "serial_no": None, "qty": abs(flt(qty))}] if batch_no else []


def untransferred_tracking(src) -> list[dict]:
	sent = bundle_entries(src.serial_and_batch_bundle, src.batch_no, src.serial_no, src.transfer_qty)
	taken = frappe.get_all(
		"Stock Entry Detail",
		filters={"ste_detail": src.name, "docstatus": 1},
		fields=["serial_and_batch_bundle", "batch_no", "serial_no", "transfer_qty"],
	)
	used_serials, used_batches = set(), {}
	for row in taken:
		for e in bundle_entries(row.serial_and_batch_bundle, row.batch_no, row.serial_no, row.transfer_qty):
			if e["serial_no"]:
				used_serials.add(e["serial_no"])
			else:
				used_batches[e["batch_no"]] = used_batches.get(e["batch_no"], 0) + e["qty"]
	left = []
	for e in sent:
		if e["serial_no"]:
			if e["serial_no"] not in used_serials:
				left.append(e)
		else:
			remaining = e["qty"] - used_batches.get(e["batch_no"], 0)
			used_batches[e["batch_no"]] = max(used_batches.get(e["batch_no"], 0) - e["qty"], 0)
			if remaining > 0:
				left.append({**e, "qty": remaining})
	return left


def tracked_rows(src, qty: float, base: dict) -> list[dict]:
	cf = flt(src.conversion_factor) or 1
	left = untransferred_tracking(src)
	if not left:
		return [{**base, "qty": qty}]
	need = qty * cf
	by_batch: dict = {}
	for e in left:
		if need <= 0:
			break
		got = by_batch.setdefault(e["batch_no"], {"qty": 0, "serials": []})
		if e["serial_no"]:
			got["qty"] += 1
			got["serials"].append(e["serial_no"])
			need -= 1
		else:
			take = min(need, e["qty"])
			got["qty"] += take
			need -= take
	rows = []
	for batch_no, got in by_batch.items():
		row = {**base, "qty": got["qty"] / cf, "use_serial_batch_fields": 1}
		if batch_no:
			row["batch_no"] = batch_no
		if got["serials"]:
			row["serial_no"] = "\n".join(got["serials"])
		rows.append(row)
	return rows


def posting_values(data: dict) -> dict:
	posting_date = cstr(data.get("posting_date")) or nowdate()
	if getdate(posting_date) > getdate(nowdate()):
		frappe.throw(_("The receiving date cannot be in the future."))
	return {"posting_date": posting_date, "set_posting_time": 1 if posting_date != nowdate() else 0}


def receipt_rows(src, out, qty: float, source_warehouse: str, target_warehouse: str) -> list[dict]:
	return tracked_rows(
		src,
		qty,
		{
			"item_code": src.item_code,
			"uom": src.uom,
			"stock_uom": src.stock_uom,
			"conversion_factor": src.conversion_factor or 1,
			"s_warehouse": source_warehouse,
			"t_warehouse": target_warehouse,
			"basic_rate": src.basic_rate,
			"against_stock_entry": out.name,
			"ste_detail": src.name,
			"material_request": src.material_request,
			"material_request_item": src.material_request_item,
		},
	)


def build_receipt(profile, data: dict):
	out = load_transfer(profile, data.get("stock_entry"))
	lock_rows([out.name])
	out.reload()
	open_rows = {r["ste_detail"]: r for r in open_transfer_rows(out, set(allowed_warehouses(profile)), False)}
	by_name = {r.name: r for r in out.items}

	doc = {
		"doctype": "Stock Entry",
		"purpose": "Material Transfer",
		"stock_entry_type": "Material Transfer",
		"outgoing_stock_entry": out.name,
		"company": out.company,
		"add_to_transit": 0,
		"remarks": cstr(data.get("remarks"))
		or _("Received at {0}").format(", ".join(sorted({r["destination"] for r in open_rows.values()}))),
	}
	doc.update(posting_values(data))
	rows = []
	for idx, row in enumerate(data.get("items") or [], 1):
		label = _("Row {0}").format(idx)
		qty = flt(row.get("qty"))
		if qty < 0:
			frappe.throw(_("{0}: quantity cannot be negative.").format(label))
		if qty == 0:
			continue
		src, pending = by_name.get(row.get("ste_detail")), open_rows.get(row.get("ste_detail"))
		if not src or not pending:
			frappe.throw(_("{0}: nothing is left to receive on that row of {1}.").format(label, out.name))
		if qty > pending["pending_qty"] + 0.000001:
			frappe.throw(
				_("{0}: {1} is more than the {2} still in transit for {3}.").format(
					label, qty, pending["pending_qty"], src.item_code
				)
			)
		rows += receipt_rows(src, out, qty, src.t_warehouse, pending["destination"])
	if not rows:
		frappe.throw(_("Enter a quantity for at least one row."))
	doc["items"] = rows
	return frappe.get_doc(doc)


def insert_or_reuse(doc, request_id: str, digest: str):
	doc.xpos_request_id = request_id
	doc.xpos_request_hash = digest
	doc.flags.ignore_permissions = True
	try:
		doc.insert()
	except frappe.UniqueValidationError:
		frappe.db.rollback()
		return None
	return doc


def check_request_id(request_id: str) -> None:
	if not request_id or len(cstr(request_id)) < 16:
		frappe.throw(_("A request id is required."))


def reconcile_existing(profile, existing, digest: str, submit: bool) -> dict:
	if not existing:
		frappe.throw(_("The earlier request could not be found. Try again."))
	if existing.owner != frappe.session.user or existing.company != profile.company:
		frappe.throw(
			_("This request id belongs to another receipt. Start a new receipt."),
			title=_("Duplicate request"),
		)
	if existing.xpos_request_hash and existing.xpos_request_hash != digest:
		frappe.throw(
			_("This request id was already used for a different receipt ({0}).").format(existing.name),
			title=_("Duplicate request"),
		)
	if submit and existing.docstatus == 0:
		doc = frappe.get_doc("Stock Entry", existing.name)
		doc.flags.ignore_permissions = True
		doc.submit()
	return result_for(existing.name, False)


@frappe.whitelist()
def save_receipt(pos_profile: str, data: str | dict, request_id: str, action: str = "draft") -> dict:
	data = json.loads(data) if isinstance(data, str) else dict(data)
	if action not in ("draft", "submit"):
		frappe.throw(_("Unknown action."))
	check_request_id(request_id)
	submit = action == "submit"
	profile = receiving_profile(pos_profile, "receive_stock_submit" if submit else "receive_stock_draft")
	digest = fingerprint(data)

	existing = find_by_request(request_id)
	if existing:
		return reconcile_existing(profile, existing, digest, submit)

	doc = insert_or_reuse(build_receipt(profile, data), request_id, digest)
	if doc is None:
		return reconcile_existing(profile, find_by_request(request_id), digest, submit)
	if submit:
		doc.submit()
	return result_for(doc.name, True)


@frappe.whitelist()
def get_receipt_status(pos_profile: str, request_id: str) -> dict:
	profile = receiving_profile(pos_profile)
	existing = find_by_request(request_id)
	if not existing or existing.owner != frappe.session.user or existing.company != profile.company:
		return {"found": False}
	return {"found": True, **result_for(existing.name, False)}


@frappe.whitelist()
def submit_receipt_draft(pos_profile: str, name: str) -> dict:
	profile = receiving_profile(pos_profile, "receive_stock_submit")
	doc = frappe.get_doc("Stock Entry", name)
	if not doc.xpos_request_id or doc.company != profile.company:
		frappe.throw(_("{0} was not saved from Stock Receiving.").format(name), frappe.PermissionError)
	if doc.owner != frappe.session.user and not is_superuser(frappe.session.user):
		frappe.throw(_("{0} was saved by another user.").format(name), frappe.PermissionError)
	if doc.docstatus == 1:
		return result_for(name, False)
	if doc.docstatus != 0:
		frappe.throw(_("{0} is cancelled.").format(name))
	doc.flags.ignore_permissions = True
	doc.submit()
	return result_for(name, False)


@frappe.whitelist()
def return_transfer_shortage(pos_profile: str, data: str | dict, request_id: str) -> dict:
	data = json.loads(data) if isinstance(data, str) else dict(data)
	profile = receiving_profile(pos_profile, "receive_stock_submit")
	check_request_id(request_id)
	digest = fingerprint(
		{**data, "items": [{**r, "qty": r.get("return_qty")} for r in data.get("items") or []]}
	)
	existing = find_by_request(request_id)
	if existing:
		return reconcile_existing(profile, existing, digest, True)

	out = load_transfer(profile, data.get("stock_entry"))
	lock_rows([out.name])
	out.reload()
	open_rows = {r["ste_detail"]: r for r in open_transfer_rows(out, set(allowed_warehouses(profile)), False)}
	by_name = {r.name: r for r in out.items}
	rows = []
	for idx, row in enumerate(data.get("items") or [], 1):
		qty = flt(row.get("return_qty"))
		if qty <= 0:
			continue
		src, pending = by_name.get(row.get("ste_detail")), open_rows.get(row.get("ste_detail"))
		if not src or not pending or qty > pending["pending_qty"] + 0.000001:
			frappe.throw(_("Row {0}: not that much is left in transit.").format(idx))
		rows += receipt_rows(src, out, qty, src.t_warehouse, src.s_warehouse)
	if not rows:
		frappe.throw(_("Enter a quantity to return."))
	doc = frappe.get_doc(
		{
			"doctype": "Stock Entry",
			"purpose": "Material Transfer",
			"stock_entry_type": "Material Transfer",
			"outgoing_stock_entry": out.name,
			"company": out.company,
			"add_to_transit": 0,
			"posting_date": nowdate(),
			"remarks": cstr(data.get("remarks")) or _("Shortage return from transit to source"),
			"items": rows,
		}
	)
	doc = insert_or_reuse(doc, request_id, digest)
	if doc is None:
		return reconcile_existing(profile, find_by_request(request_id), digest, True)
	doc.submit()
	return result_for(doc.name, True)
