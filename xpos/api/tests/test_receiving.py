# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt


from unittest.mock import patch

import frappe
from erpnext.stock.doctype.batch.batch import get_batch_qty
from erpnext.stock.doctype.item.test_item import make_item
from erpnext.stock.doctype.stock_entry.stock_entry_utils import make_stock_entry
from erpnext.stock.utils import get_stock_balance
from erpnext.tests.utils import ERPNextTestSuite
from frappe.utils import add_days, nowdate

from xpos.api import receiving
from xpos.api.tests.test_profile_settings_hardening import (
	COMPANY,
	ensure,
	ensure_pos_role,
	ensure_user,
	make_profile,
	setup_fixtures,
)

WH = "_Test Warehouse - _TC"
WH2 = "_Test Warehouse 1 - _TC"
OTHER_WH = "_Test Warehouse 2 - _TC"
TRANSIT = "_Test Receiving Transit - _TC"
PROFILE = "_Test Receiving Profile"
FULL, DRAFT_ONLY, NO_RIGHTS = "rc-full@example.com", "rc-draft@example.com", "rc-none@example.com"
FULL_ROLE, DRAFT_ROLE, NO_ROLE = "_Test RC Full", "_Test RC Draft", "_Test RC None"
PLAIN, BOXED, BATCHED, SERIAL = "_Test RC Plain", "_Test RC Boxed", "_Test RC Batched", "_Test RC Serial"


def rid() -> str:
	return "rcv_" + frappe.generate_hash(length=32)


def as_user(user):
	frappe.set_user(user)


class ReceivingCase(ERPNextTestSuite):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		setup_fixtures()
		for wh in (WH2, OTHER_WH):
			ensure("Warehouse", wh, {"warehouse_name": wh.split(" - ")[0], "company": COMPANY})
		ensure(
			"Warehouse",
			TRANSIT,
			{"warehouse_name": "_Test Receiving Transit", "company": COMPANY, "warehouse_type": "Transit"},
		)
		for user in (FULL, DRAFT_ONLY, NO_RIGHTS):
			ensure_user(user, ["Accounts User", "Stock User"])
		ensure_pos_role(FULL_ROLE, ["receive_stock_draft", "receive_stock_submit", "receive_stock_rates"])
		ensure_pos_role(DRAFT_ROLE, ["receive_stock_draft"])
		ensure_pos_role(NO_ROLE, [])
		make_profile(
			PROFILE,
			warehouse=WH,
			users=((FULL, FULL_ROLE, 0), (DRAFT_ONLY, DRAFT_ROLE, 0), (NO_RIGHTS, NO_ROLE, 0)),
			allow_purchase_receipt=1,
		)
		cls.items()

	@classmethod
	def items(cls):
		make_item(PLAIN, {"is_stock_item": 1, "stock_uom": "Nos"})
		boxed = make_item(BOXED, {"is_stock_item": 1, "stock_uom": "Nos"})
		if not [u for u in boxed.uoms if u.uom == "Box"]:
			boxed.append("uoms", {"uom": "Box", "conversion_factor": 10})
			boxed.save()
		make_item(BATCHED, {"is_stock_item": 1, "stock_uom": "Nos", "has_batch_no": 1, "create_new_batch": 0})
		make_item(SERIAL, {"is_stock_item": 1, "stock_uom": "Nos", "has_serial_no": 1})

	def setUp(self):
		frappe.set_user("Administrator")
		frappe.db.set_single_value("Stock Settings", "use_serial_batch_fields", 1)

	def tearDown(self):
		frappe.set_user("Administrator")

	def stock(self, item, wh=WH):
		return get_stock_balance(item, wh)

	def transit(self, rows, destination=WH):
		se = frappe.get_doc(
			{
				"doctype": "Stock Entry",
				"purpose": "Material Transfer",
				"stock_entry_type": "Material Transfer",
				"company": COMPANY,
				"add_to_transit": 1,
				"from_warehouse": WH2,
				"to_warehouse": TRANSIT,
				"xpos_receiving_warehouse": destination,
				"items": [{"s_warehouse": WH2, "t_warehouse": TRANSIT, **row} for row in rows],
			}
		)
		se.insert()
		se.submit()
		return se

	def send(self, qty=10, item=PLAIN, destination=WH, **row):
		make_stock_entry(item_code=item, qty=qty, to_warehouse=WH2, company=COMPANY, rate=20)
		return self.transit([{"item_code": item, "qty": qty, "basic_rate": 20, **row}], destination)

	def data(self, se, qty, **extra):
		return {
			"stock_entry": se.name,
			"items": [{"ste_detail": se.items[0].name, "qty": qty}],
			**extra,
		}

	def save(self, data, action="draft", request_id=None, user=FULL):
		as_user(user)
		return receiving.save_receipt(PROFILE, data, request_id or rid(), action)


class TestTransferReceiving(ReceivingCase):
	def test_partial_receipt_moves_stock_out_of_transit_and_keeps_the_reference(self):
		se = self.send(10)
		before = self.stock(PLAIN)
		made = self.save(self.data(se, 6), "submit")
		self.assertEqual(self.stock(PLAIN) - before, 6)
		receipt = frappe.get_doc("Stock Entry", made["name"])
		self.assertEqual(receipt.outgoing_stock_entry, se.name)
		self.assertEqual((receipt.items[0].s_warehouse, receipt.items[0].t_warehouse), (TRANSIT, WH))
		self.assertEqual(receipt.items[0].ste_detail, se.items[0].name)
		as_user(FULL)
		detail = receiving.get_incoming_transfer(PROFILE, se.name)
		self.assertEqual(detail["items"][0]["pending_qty"], 4)
		self.assertEqual(detail["items"][0]["received_qty"], 6)
		self.assertEqual(frappe.db.get_value("Stock Entry", se.name, "per_transferred"), 60)

	def test_several_receipts_finish_the_transfer(self):
		se = self.send(10)
		self.save(self.data(se, 4), "submit")
		self.save(self.data(se, 6), "submit")
		as_user(FULL)
		self.assertNotIn(se.name, [t["name"] for t in receiving.list_incoming_transfers(PROFILE)])

	def test_cannot_receive_more_than_is_in_transit(self):
		se = self.send(5)
		with self.assertRaisesRegex(frappe.ValidationError, "still in transit"):
			self.save(self.data(se, 6))

	def test_negative_and_empty_quantities_are_refused(self):
		se = self.send(5)
		with self.assertRaisesRegex(frappe.ValidationError, "negative"):
			self.save(self.data(se, -1))
		with self.assertRaisesRegex(frappe.ValidationError, "at least one row"):
			self.save(self.data(se, 0))

	def test_completed_transfer_cannot_be_received_again(self):
		se = self.send(5)
		self.save(self.data(se, 5), "submit")
		with self.assertRaises(frappe.ValidationError):
			self.save(self.data(se, 1))

	def test_a_transfer_is_listed_only_at_its_receiving_warehouse(self):
		mine, other = self.send(5), self.send(5, destination=OTHER_WH)
		as_user(FULL)
		listed = receiving.list_incoming_transfers(PROFILE)
		self.assertIn(mine.name, [t["name"] for t in listed])
		self.assertNotIn(other.name, [t["name"] for t in listed])
		self.assertEqual({t["destination"] for t in listed if t["name"] == mine.name}, {WH})
		with self.assertRaises(frappe.PermissionError):
			receiving.get_incoming_transfer(PROFILE, other.name)
		with self.assertRaises(frappe.PermissionError):
			self.save(self.data(other, 1))

	def test_receipt_goes_into_the_receiving_warehouse_of_the_transfer(self):
		se = self.send(5)
		made = self.save(self.data(se, 5), "submit")
		self.assertEqual(frappe.get_doc("Stock Entry", made["name"]).items[0].t_warehouse, WH)

	def test_a_transfer_without_a_destination_is_hidden_from_everyone(self):
		se = self.send(5)
		frappe.db.set_value("Stock Entry", se.name, "xpos_receiving_warehouse", None)
		as_user(FULL)
		self.assertNotIn(se.name, [t["name"] for t in receiving.list_incoming_transfers(PROFILE)])

	def test_a_requested_transfer_is_received_only_where_it_was_asked_for(self):
		request = frappe.get_doc(
			{
				"doctype": "Material Request",
				"material_request_type": "Material Transfer",
				"company": COMPANY,
				"schedule_date": add_days(nowdate(), 3),
				"items": [
					{"item_code": PLAIN, "qty": 5, "warehouse": WH, "schedule_date": add_days(nowdate(), 3)}
				],
			}
		)
		request.insert()
		request.submit()
		make_stock_entry(item_code=PLAIN, qty=5, to_warehouse=WH2, company=COMPANY, rate=20)
		se = self.transit(
			[
				{
					"item_code": PLAIN,
					"qty": 5,
					"basic_rate": 20,
					"material_request": request.name,
					"material_request_item": request.items[0].name,
				}
			]
		)
		frappe.db.set_value("Stock Entry", se.name, "xpos_receiving_warehouse", None)
		as_user(FULL)
		self.assertIn(se.name, [t["name"] for t in receiving.list_incoming_transfers(PROFILE)])
		self.assertEqual(receiving.get_incoming_transfer(PROFILE, se.name)["items"][0]["destination"], WH)

	def test_transfer_of_another_company_is_hidden(self):
		se = self.send(5)
		frappe.db.set_value("Stock Entry", se.name, "company", "_Test Company 1")
		as_user(FULL)
		self.assertNotIn(se.name, [t["name"] for t in receiving.list_incoming_transfers(PROFILE)])
		with self.assertRaises(frappe.PermissionError):
			receiving.get_incoming_transfer(PROFILE, se.name)

	def test_receipts_and_other_entries_are_not_transfers(self):
		se = self.send(5)
		made = self.save(self.data(se, 2), "submit")
		as_user(FULL)
		with self.assertRaisesRegex(frappe.ValidationError, "itself a receipt"):
			receiving.get_incoming_transfer(PROFILE, made["name"])
		plain = make_stock_entry(item_code=PLAIN, qty=1, to_warehouse=WH, company=COMPANY, rate=20)
		with self.assertRaisesRegex(frappe.ValidationError, "not an in-transit"):
			receiving.get_incoming_transfer(PROFILE, plain.name)

	def test_draft_moves_no_stock_and_submit_does(self):
		se = self.send(5)
		before = self.stock(PLAIN)
		draft = self.save(self.data(se, 5))
		self.assertEqual((draft["docstatus"], draft["stock_posted"]), (0, False))
		self.assertEqual(self.stock(PLAIN), before)
		as_user(FULL)
		self.assertIn(draft["name"], [d["name"] for d in receiving.list_receipt_drafts(PROFILE)])
		done = receiving.submit_receipt_draft(PROFILE, draft["name"])
		self.assertTrue(done["stock_posted"])
		self.assertEqual(self.stock(PLAIN) - before, 5)
		self.assertNotIn(draft["name"], [d["name"] for d in receiving.list_receipt_drafts(PROFILE)])

	def test_outstanding_is_rechecked_at_submit(self):
		se = self.send(10)
		draft_a = self.save(self.data(se, 8))
		draft_b = self.save(self.data(se, 8))
		as_user(FULL)
		receiving.submit_receipt_draft(PROFILE, draft_a["name"])
		with self.assertRaises(frappe.ValidationError):
			receiving.submit_receipt_draft(PROFILE, draft_b["name"])

	def test_uom_rows_convert_to_stock(self):
		make_stock_entry(item_code=BOXED, qty=50, to_warehouse=WH2, company=COMPANY, rate=20)
		se = self.transit(
			[{"item_code": BOXED, "qty": 3, "uom": "Box", "conversion_factor": 10, "basic_rate": 200}]
		)
		before = self.stock(BOXED)
		self.save(self.data(se, 2), "submit")
		self.assertEqual(self.stock(BOXED) - before, 20)
		as_user(FULL)
		self.assertEqual(receiving.get_incoming_transfer(PROFILE, se.name)["items"][0]["pending_qty"], 1)

	def test_shortage_return_goes_back_to_the_source(self):
		se = self.send(10)
		src = self.stock(PLAIN, WH2)
		self.save(self.data(se, 7), "submit")
		as_user(FULL)
		request = rid()
		data = {"stock_entry": se.name, "items": [{"ste_detail": se.items[0].name, "return_qty": 3}]}
		first = receiving.return_transfer_shortage(PROFILE, data, request)
		again = receiving.return_transfer_shortage(PROFILE, data, request)
		self.assertEqual(first["name"], again["name"])
		self.assertEqual(self.stock(PLAIN, WH2) - src, 3)
		self.assertEqual(frappe.db.get_value("Stock Entry", se.name, "per_transferred"), 100)

	def test_batch_tracked_partial_receipts_keep_their_batch(self):
		batch = "RC-TB-" + frappe.generate_hash(length=6)
		frappe.get_doc(
			{"doctype": "Batch", "batch_id": batch, "item": BATCHED, "expiry_date": add_days(nowdate(), 60)}
		).insert()
		make_stock_entry(item_code=BATCHED, qty=6, to_warehouse=WH2, company=COMPANY, rate=20, batch_no=batch)
		se = self.transit(
			[
				{
					"item_code": BATCHED,
					"qty": 6,
					"batch_no": batch,
					"use_serial_batch_fields": 1,
				}
			]
		)
		self.save(self.data(se, 2), "submit")
		self.assertEqual(get_batch_qty(batch, WH, BATCHED), 2)
		self.save(self.data(se, 4), "submit")
		self.assertEqual(get_batch_qty(batch, WH, BATCHED), 6)

	def test_serial_tracked_partial_receipts_carry_distinct_serials(self):
		tag = frappe.generate_hash(length=5)
		serials = [f"RC-SN-{tag}-{i}" for i in range(4)]
		for number in serials:
			frappe.get_doc(
				{"doctype": "Serial No", "serial_no": number, "item_code": SERIAL, "company": COMPANY}
			).insert()
		make_stock_entry(
			item_code=SERIAL, qty=4, to_warehouse=WH2, company=COMPANY, rate=20, serial_no=serials
		)
		se = self.transit(
			[
				{
					"item_code": SERIAL,
					"qty": 4,
					"serial_no": "\n".join(serials),
					"use_serial_batch_fields": 1,
				}
			]
		)
		first = self.save(self.data(se, 3), "submit")
		self.save(self.data(se, 1), "submit")
		received = frappe.db.get_all(
			"Serial No", filters={"name": ["in", serials]}, fields=["name", "warehouse"]
		)
		self.assertEqual({r.warehouse for r in received}, {WH})
		self.assertEqual(len(frappe.get_doc("Stock Entry", first["name"]).items[0].serial_no.split("\n")), 3)


class TestIdempotency(ReceivingCase):
	def test_a_retried_save_returns_the_first_document(self):
		se = self.send(10)
		request = rid()
		before = self.stock(PLAIN)
		first = self.save(self.data(se, 3), "submit", request)
		again = self.save(self.data(se, 3), "submit", request)
		self.assertEqual(first["name"], again["name"])
		self.assertFalse(again["created"])
		self.assertEqual(self.stock(PLAIN) - before, 3)

	def test_a_retry_submits_a_draft_the_first_attempt_left(self):
		se = self.send(10)
		request = rid()
		before = self.stock(PLAIN)
		draft = self.save(self.data(se, 3), "draft", request)
		again = self.save(self.data(se, 3), "submit", request)
		self.assertEqual(draft["name"], again["name"])
		self.assertEqual(again["docstatus"], 1)
		self.assertEqual(self.stock(PLAIN) - before, 3)

	def test_a_request_id_reused_for_other_content_is_refused(self):
		se = self.send(10)
		request = rid()
		self.save(self.data(se, 3), "draft", request)
		with self.assertRaisesRegex(frappe.ValidationError, "different receipt"):
			self.save(self.data(se, 4), "draft", request)

	def test_status_lookup_reconciles_an_unanswered_save(self):
		se = self.send(10)
		request = rid()
		as_user(FULL)
		self.assertFalse(receiving.get_receipt_status(PROFILE, request)["found"])
		made = self.save(self.data(se, 2), "draft", request)
		status = receiving.get_receipt_status(PROFILE, request)
		self.assertEqual((status["found"], status["name"], status["docstatus"]), (True, made["name"], 0))

	def test_another_user_cannot_claim_a_request_id(self):
		se = self.send(10)
		request = rid()
		self.save(self.data(se, 2), "draft", request)
		with self.assertRaises(frappe.ValidationError):
			self.save(self.data(se, 2), "draft", request, user="Administrator")

	def test_concurrent_twin_insert_falls_back_to_the_first(self):
		se = self.send(10)
		request = rid()
		first = self.save(self.data(se, 2), "draft", request)
		as_user(FULL)
		profile = receiving.receiving_profile(PROFILE, "receive_stock_draft")
		data = self.data(se, 2)
		twin = receiving.build_receipt(profile, data)
		with patch.object(frappe.db, "rollback"):
			self.assertIsNone(receiving.insert_or_reuse(twin, request, receiving.fingerprint(data)))
		self.assertEqual(receiving.find_by_request(request).name, first["name"])


class TestAccess(ReceivingCase):
	def test_draft_and_submit_are_separate_rights(self):
		se = self.send(5)
		self.assertEqual(self.save(self.data(se, 1), "draft", user=DRAFT_ONLY)["docstatus"], 0)
		with self.assertRaises(frappe.PermissionError):
			self.save(self.data(se, 1), "submit", user=DRAFT_ONLY)
		with self.assertRaises(frappe.PermissionError):
			self.save(self.data(se, 1), "draft", user=NO_RIGHTS)
		made = self.save(self.data(se, 1))
		as_user(DRAFT_ONLY)
		with self.assertRaises(frappe.PermissionError):
			receiving.submit_receipt_draft(PROFILE, made["name"])

	def test_user_outside_the_profile_is_refused(self):
		se = self.send(5)
		ensure_user("rc-outsider@example.com", ["Accounts User"])
		with self.assertRaises(frappe.PermissionError):
			self.save(self.data(se, 1), user="rc-outsider@example.com")

	def test_warehouse_user_permission_narrows_the_scope(self):
		group = "_Test RC Tree - _TC"
		ensure("Warehouse", group, {"warehouse_name": "_Test RC Tree", "company": COMPANY, "is_group": 1})
		for name in ("A", "B"):
			ensure(
				"Warehouse",
				f"_Test RC {name} - _TC",
				{"warehouse_name": f"_Test RC {name}", "company": COMPANY, "parent_warehouse": group},
			)
		to_a, to_b = (
			self.send(2, destination="_Test RC A - _TC"),
			self.send(2, destination="_Test RC B - _TC"),
		)
		original = frappe.db.get_value("POS Profile", PROFILE, "warehouse")
		frappe.db.set_value("POS Profile", PROFILE, "warehouse", group)
		frappe.clear_cache(doctype="POS Profile")
		frappe.local.xpos_warehouse_lists = {}
		as_user(FULL)
		names = [t["name"] for t in receiving.list_incoming_transfers(PROFILE)]
		self.assertIn(to_a.name, names)
		self.assertIn(to_b.name, names)
		frappe.set_user("Administrator")
		frappe.get_doc(
			{
				"doctype": "User Permission",
				"user": FULL,
				"allow": "Warehouse",
				"for_value": "_Test RC B - _TC",
			}
		).insert(ignore_permissions=True)
		frappe.clear_cache(user=FULL)
		frappe.local.xpos_warehouse_lists = {}
		as_user(FULL)
		names = [t["name"] for t in receiving.list_incoming_transfers(PROFILE)]
		self.assertNotIn(to_a.name, names)
		self.assertIn(to_b.name, names)
		frappe.set_user("Administrator")
		frappe.db.delete("User Permission", {"user": FULL, "allow": "Warehouse"})
		frappe.clear_cache(user=FULL)
		frappe.db.set_value("POS Profile", PROFILE, "warehouse", original)
		frappe.clear_cache(doctype="POS Profile")
		frappe.local.xpos_warehouse_lists = {}

	def test_receiving_switch_off_closes_the_page(self):
		frappe.db.set_value("POS Profile", PROFILE, "allow_purchase_receipt", 0)
		frappe.clear_cache(doctype="POS Profile")
		try:
			as_user(FULL)
			with self.assertRaises(frappe.ValidationError):
				receiving.get_receiving_setup(PROFILE)
		finally:
			frappe.db.set_value("POS Profile", PROFILE, "allow_purchase_receipt", 1)
			frappe.clear_cache(doctype="POS Profile")

	def test_future_receiving_date_is_refused(self):
		se = self.send(5)
		with self.assertRaisesRegex(frappe.ValidationError, "future"):
			self.save(self.data(se, 1, posting_date=add_days(nowdate(), 3)))

	def test_rates_are_sent_only_to_users_who_may_see_them(self):
		se = self.send(5)
		as_user(FULL)
		self.assertIn("basic_rate", receiving.get_incoming_transfer(PROFILE, se.name)["items"][0])
		as_user(DRAFT_ONLY)
		self.assertNotIn("basic_rate", receiving.get_incoming_transfer(PROFILE, se.name)["items"][0])

	def test_barcode_resolves_to_its_item(self):
		item = frappe.get_doc("Item", BOXED)
		if not [b for b in item.barcodes if b.barcode == "RC-BOX-1"]:
			item.append("barcodes", {"barcode": "RC-BOX-1", "uom": "Box"})
			item.save()
		as_user(FULL)
		self.assertEqual(receiving.lookup_item(PROFILE, "RC-BOX-1"), BOXED)
		self.assertEqual(receiving.lookup_item(PROFILE, PLAIN), PLAIN)
		self.assertIsNone(receiving.lookup_item(PROFILE, "no-such-code"))
