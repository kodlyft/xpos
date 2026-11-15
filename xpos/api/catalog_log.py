# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""Change log behind the offline catalogue delta feed (see ``catalog_sync``)."""

import frappe
from frappe.utils import add_days, cint, now

DOCTYPE = "XPOS Catalog Change"
RETENTION_DAYS_DEFAULT = 7
PRUNED_KEY = "xpos_catalog_pruned_through"


def retention_days() -> int:
	return max(cint(frappe.conf.get("xpos_catalog_retention_days")) or RETENTION_DAYS_DEFAULT, 1)


def write(kind: str, refs: list[str | None]) -> None:
	if frappe.flags.in_install or frappe.flags.in_migrate or not frappe.db.table_exists(DOCTYPE):
		return
	stamp = now()
	user = frappe.session.user
	for ref in refs:
		frappe.db.sql(
			"""INSERT INTO `tabXPOS Catalog Change` (name, creation, modified, modified_by, owner, docstatus, idx, kind, ref, logged_at)
			VALUES (%(n)s, %(t)s, %(t)s, %(u)s, %(u)s, 0, 0, %(k)s, %(r)s, %(t)s)""",
			{
				"n": frappe.db.get_next_sequence_val(DOCTYPE),
				"t": stamp,
				"u": user,
				"k": kind,
				"r": (ref or "")[:140],
			},
		)


def log_item(doc, method=None) -> None:
	code = doc.name if doc.doctype == "Item" else doc.get("item_code")
	if code:
		write("item", [code])


def log_item_rename(doc, method=None, old=None, new=None, merge=False) -> None:
	write("item", [old, new])


def log_reset(doc, method=None) -> None:
	write("reset", [f"{doc.doctype}:{doc.name}"])


def last_seq() -> int:
	row = frappe.db.sql("SELECT MAX(name) FROM `tabXPOS Catalog Change`")
	newest = cint(row[0][0]) if row and row[0][0] else 0
	return max(newest, pruned_through())


def pruned_through() -> int:
	return cint(frappe.db.get_default(PRUNED_KEY))


def prune_catalog_changes() -> None:
	cutoff = add_days(now(), -retention_days())
	newest = frappe.db.sql("SELECT MAX(name) FROM `tabXPOS Catalog Change` WHERE logged_at < %s", cutoff)
	top = cint(newest[0][0]) if newest and newest[0][0] else 0
	if not top:
		return
	frappe.db.sql("DELETE FROM `tabXPOS Catalog Change` WHERE name <= %s", top)
	frappe.db.set_default(PRUNED_KEY, max(top, pruned_through()))
