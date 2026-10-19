# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""What FBR may hold for each sale id (USIN), kept outside the sale's transaction.

A sale is fiscalized before it is submitted, and a failed submit or credit allocation
rolls the whole request back. The FBR answer must survive that, or a retry would send
the sale again. Every request is therefore written to ``XPOS Fiscal Attempt`` on a
separate database connection that commits on its own: before it is sent (status
*Sent*), and again when the answer is known. Nothing else of the sale is committed.

Only this module writes the table, always on its own connection, so the sale's
transaction never holds a lock the ledger connection waits for.

FBR is not assumed to deduplicate by USIN. A request that may have reached FBR is
never sent again until someone with *Resolve FBR Check* records what FBR's records show.
"""

import hashlib
import json
from contextlib import contextmanager
from dataclasses import dataclass

import frappe
from frappe import _
from frappe.database import get_db
from frappe.utils import cstr, get_datetime, now_datetime, time_diff_in_seconds

TABLE = "`tabXPOS Fiscal Attempt`"
DOCTYPE = "XPOS Fiscal Attempt"
# FBR's timeout is (5, 25) s: a Sent row younger than this may still get its answer.
IN_FLIGHT_SECONDS = 120


@dataclass(frozen=True)
class Known:
	"""What the ledger says about a sale id.

	kind: ``none`` (never sent), ``recorded`` (FBR holds ``number``), ``pending`` (FBR may
	hold it), ``not_recorded`` (a check found it absent), ``failed`` (rejected or never sent).
	"""

	kind: str
	number: str | None = None
	posted_on: object = None
	content_hash: str | None = None
	attempt: str | None = None


def content_hash(payload: dict) -> str:
	"""What was fiscalized, without the moment it was sent."""
	content = {k: v for k, v in payload.items() if k not in ("DateTime", "InvoiceNumber")}
	return hashlib.sha256(json.dumps(content, sort_keys=True, default=str).encode()).hexdigest()


@contextmanager
def ledger_db():
	"""A connection of its own: what it commits survives the caller's rollback."""
	conf = frappe.conf
	db = get_db(
		socket=conf.db_socket,
		host=conf.db_host,
		port=conf.db_port,
		user=conf.db_user or conf.db_name,
		password=conf.db_password,
		cur_db_name=conf.db_name,
	)
	try:
		yield db
		db.sql("commit")
	except Exception:
		if db._conn:
			db.sql("rollback")
		raise
	finally:
		db.close()


def latest(db, pos_id: str, usin: str, lock: bool = False):
	rows = db.sql(
		f"""SELECT * FROM {TABLE} WHERE fbr_pos_id = %s AND usin = %s
		ORDER BY attempt_no DESC LIMIT 1 {"FOR UPDATE" if lock else ""}""",
		(pos_id, usin),
		as_dict=True,
	)
	return rows[0] if rows else None


def known_from(row) -> Known:
	if not row:
		return Known("none")
	if row.status == "Accepted" or row.resolution == "Recorded":
		return Known("recorded", row.fbr_invoice_number, row.posted_on, row.content_hash, row.name)
	if row.resolution == "Not Recorded":
		return Known("not_recorded", attempt=row.name)
	if row.status in ("Sent", "Uncertain"):
		return Known("pending", attempt=row.name)
	return Known("failed", attempt=row.name)


def lookup(pos_id: str, usin: str) -> Known:
	with ledger_db() as db:
		return known_from(latest(db, pos_id, usin))


def insert(db, previous, values: dict) -> str:
	now = now_datetime()
	row = {
		"name": frappe.generate_hash(length=12),
		"creation": now,
		"modified": now,
		"owner": frappe.session.user,
		"modified_by": frappe.session.user,
		"attempt_no": (previous.attempt_no if previous else 0) + 1,
		**values,
	}
	columns = ", ".join(f"`{k}`" for k in row)
	db.sql(
		f"INSERT INTO {TABLE} ({columns}) VALUES ({', '.join(['%s'] * len(row))})",
		tuple(row.values()),
	)
	return row["name"]


def sale_values(doc, pos_id: str, usin: str, payload: dict | None, channel: str, status: str) -> dict:
	return {
		"usin": usin,
		"fbr_pos_id": pos_id,
		"channel": channel,
		"status": status,
		"pos_profile": doc.get("pos_profile"),
		"company": doc.get("company"),
		"invoice_doctype": doc.doctype,
		"invoice": doc.name,
		"content_hash": content_hash(payload) if payload else None,
		"payload": json.dumps(payload, default=str, indent=1) if payload else None,
	}


def begin_cloud_attempt(doc, pos_id: str, usin: str, payload: dict, held_uncertain: bool) -> Known:
	"""Claim the right to send this sale to FBR's cloud, or say what is already known.

	Returns ``Known("none", attempt=...)`` when the caller may send now. A draft already
	marked *Uncertain* (``held_uncertain``) is sent only after a check found it absent.
	"""
	try:
		with ledger_db() as db:
			previous = latest(db, pos_id, usin, lock=True)
			known = known_from(previous)
			if known.kind in ("recorded", "pending"):
				return known
			if held_uncertain and known.kind != "not_recorded":
				return Known("pending", attempt=known.attempt)
			name = insert(db, previous, sale_values(doc, pos_id, usin, payload, "Cloud", "Sent"))
			return Known("none", attempt=name)
	except Exception as error:
		if not (isinstance(error, frappe.QueryDeadlockError) or frappe.db.is_unique_key_violation(error)):
			raise
		# Another request is claiming this sale at this moment; its outcome is not known yet.
		frappe.log_error(f"USIN {usin}: {error}", "X POS FBR attempt claimed concurrently")
		return Known("pending")


def finish_attempt(name: str, status: str, number: str | None = None, posted_on=None, response=None):
	with ledger_db() as db:
		db.sql(
			f"""UPDATE {TABLE} SET status = %s, fbr_invoice_number = %s, posted_on = %s,
			response = %s, modified = %s WHERE name = %s AND status = 'Sent'""",
			(status, number, posted_on, cstr(response)[:2000] or None, now_datetime(), name),
		)


def record_local(doc, pos_id: str, usin: str, payload: dict | None, number: str | None) -> Known:
	"""The local FBR service answered with ``number``, or (``None``) did not answer at all."""
	with ledger_db() as db:
		previous = latest(db, pos_id, usin, lock=True)
		known = known_from(previous)
		if known.kind == "recorded":
			if number and number != known.number:
				frappe.throw(
					_("FBR number {0} is already recorded for sale {1}; {2} cannot replace it.").format(
						known.number, usin, number
					)
				)
			return known
		if known.kind == "pending":
			if not number:
				return known
			frappe.throw(
				_("FBR may already hold sale {0}. Record the FBR check before entering a number.").format(
					usin
				)
			)
		values = sale_values(
			doc, pos_id, usin, payload, "Local Service", "Accepted" if number else "Uncertain"
		)
		values.update(fbr_invoice_number=number, posted_on=now_datetime() if number else None)
		name = insert(db, previous, values)
		return known_from(frappe._dict(values, name=name))


def number_in_use(db, number: str, usin: str) -> str | None:
	"""Another sale id FBR already gave this number to, according to the ledger."""
	row = db.sql(
		f"""SELECT usin FROM {TABLE} WHERE fbr_invoice_number = %s AND usin != %s
		AND (status = 'Accepted' OR resolution = 'Recorded') LIMIT 1""",
		(number, usin),
	)
	return row[0][0] if row else None


def resolve(
	pos_id: str, usin: str, resolution: str, number: str | None, evidence: str, legacy_draft=None
) -> dict:
	"""Record what FBR's records show for a sale whose outcome was unknown.

	Serialised by locking the sale's latest attempt; a second resolver waits, then sees the
	first one's answer. Repeating the same answer is accepted; a different one is refused.
	"""
	with ledger_db() as db:
		row = latest(db, pos_id, usin, lock=True)
		if not row and legacy_draft:
			# Held as Uncertain before attempts were recorded.
			insert(db, None, sale_values(legacy_draft, pos_id, usin, None, "Unknown", "Uncertain"))
			row = latest(db, pos_id, usin, lock=True)
		if not row:
			frappe.throw(_("No FBR request for sale {0} is waiting for a check.").format(usin))
		if row.resolution:
			if row.resolution == resolution and cstr(row.fbr_invoice_number) == cstr(number):
				return row
			frappe.throw(
				_("Sale {0} was already resolved as {1} by {2} on {3}.").format(
					usin, _(row.resolution), row.resolved_by, row.resolved_on
				),
				title=_("FBR check already recorded"),
			)
		if row.status not in ("Sent", "Uncertain"):
			frappe.throw(
				_("FBR's answer for sale {0} is already known ({1}); there is nothing to check.").format(
					usin, _(row.status)
				)
			)
		if (
			row.status == "Sent"
			and time_diff_in_seconds(now_datetime(), get_datetime(row.creation)) < IN_FLIGHT_SECONDS
		):
			frappe.throw(
				_(
					"The request for sale {0} may still be waiting for FBR's answer. Try again in two minutes."
				).format(usin)
			)
		if number:
			if other := number_in_use(db, number, usin):
				frappe.throw(
					_("FBR number {0} already belongs to {1}. Check the number in FBR's records.").format(
						number, other
					),
					title=_("FBR number in use"),
				)
		now = now_datetime()
		db.sql(
			f"""UPDATE {TABLE} SET resolution = %s, fbr_invoice_number = %s, posted_on = %s,
			resolved_by = %s, resolved_on = %s, resolution_evidence = %s, modified = %s,
			modified_by = %s WHERE name = %s""",
			(
				resolution,
				number,
				now if number else None,
				frappe.session.user,
				now,
				evidence,
				now,
				frappe.session.user,
				row.name,
			),
		)
		return latest(db, pos_id, usin)
