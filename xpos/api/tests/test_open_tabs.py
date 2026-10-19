# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""Tests for open tabs: recalling a draft raised on another shift, and settling a
past credit sale from the POS."""

import unittest
from unittest.mock import MagicMock, patch

from xpos.api import invoices, payments, utilities

SHIFT_A = "POS-OS-0001"
SHIFT_B = "POS-OS-0002"
PROFILE = "Main"


def raising_throw(*args, **kwargs):
	"""Stand-in for ``frappe.throw`` that behaves like the real one (it raises)."""
	raise Exception(args[0] if args else "thrown")


class TestGetDraftInvoicesScope(unittest.TestCase):
	"""``get_draft_invoices`` widens from one shift to the whole POS Profile."""

	@patch("xpos.api.invoices.get_invoice_type", return_value="Sales Invoice")
	@patch("xpos.api.invoices.can_recall_other_shift_tabs")
	@patch("xpos.api.invoices.frappe")
	def test_default_scope_filters_by_shift(self, mock_frappe, mock_can_recall, _mock_type):
		"""The historical call shape is unchanged and checks no new permission."""
		mock_frappe.get_list.return_value = []

		invoices.get_draft_invoices(SHIFT_A)

		filters = mock_frappe.get_list.call_args.kwargs["filters"]
		self.assertEqual(filters["pos_opening_shift"], SHIFT_A)
		self.assertNotIn("pos_profile", filters)
		mock_can_recall.assert_not_called()

	@patch("xpos.api.invoices.get_invoice_type", return_value="Sales Invoice")
	@patch("xpos.api.invoices.can_recall_other_shift_tabs", return_value=False)
	@patch("xpos.api.invoices.frappe")
	def test_profile_scope_denied_without_gate(self, mock_frappe, _mock_can_recall, _mock_type):
		"""A denied recall must not reach the database at all."""
		mock_frappe.db.get_value.return_value = PROFILE
		mock_frappe.throw.side_effect = raising_throw

		with self.assertRaises(Exception):
			invoices.get_draft_invoices(SHIFT_A, scope="profile")

		mock_frappe.get_list.assert_not_called()

	@patch("xpos.api.invoices.get_invoice_type", return_value="Sales Invoice")
	@patch("xpos.api.invoices.can_recall_other_shift_tabs", return_value=True)
	@patch("xpos.api.invoices.frappe")
	def test_profile_scope_throws_when_shift_has_no_profile(self, mock_frappe, _mock_can_recall, _mock_type):
		mock_frappe.db.get_value.return_value = None
		mock_frappe.throw.side_effect = raising_throw

		with self.assertRaises(Exception):
			invoices.get_draft_invoices(SHIFT_A, scope="profile")

		mock_frappe.get_list.assert_not_called()

	@patch("xpos.api.invoices.get_invoice_type", return_value="Sales Invoice")
	@patch("xpos.api.invoices.can_recall_other_shift_tabs", return_value=True)
	@patch("xpos.api.invoices.frappe")
	def test_profile_scope_filters_by_profile(self, mock_frappe, _mock_can_recall, _mock_type):
		"""The whole point: drop the shift filter, keep the profile one."""
		mock_frappe.db.get_value.return_value = PROFILE
		mock_frappe.db.has_column.return_value = True
		mock_frappe.get_list.return_value = []

		invoices.get_draft_invoices(SHIFT_A, scope="profile")

		kwargs = mock_frappe.get_list.call_args.kwargs
		filters = kwargs["filters"]
		self.assertEqual(filters["pos_profile"], PROFILE)
		self.assertNotIn("pos_opening_shift", filters)
		self.assertEqual(filters["is_return"], 0)
		self.assertEqual(filters["docstatus"], 0)

		# The UI needs these to badge a foreign tab and to hold the concurrency token.
		for field in ("pos_opening_shift", "owner", "modified", "pos_awaiting_settlement"):
			self.assertIn(field, kwargs["fields"])

	@patch("xpos.api.invoices.get_invoice_type", return_value="Sales Invoice")
	@patch("xpos.api.invoices.can_recall_other_shift_tabs", return_value=True)
	@patch("xpos.api.invoices.frappe")
	def test_profile_scope_skips_settlement_column_before_migration(
		self, mock_frappe, _mock_can_recall, _mock_type
	):
		"""A site on new code but old schema must not query a missing column."""
		mock_frappe.db.get_value.return_value = PROFILE
		mock_frappe.db.has_column.return_value = False
		mock_frappe.get_list.return_value = []

		invoices.get_draft_invoices(SHIFT_A, scope="profile")

		self.assertNotIn("pos_awaiting_settlement", mock_frappe.get_list.call_args.kwargs["fields"])


class TestStaleDraftGuard(unittest.TestCase):
	"""Two terminals holding the same tab must not silently overwrite each other."""

	@patch("xpos.api.invoices.frappe")
	def test_no_token_skips_the_check(self, mock_frappe):
		"""Offline replay sends no token, and must keep working."""
		invoices._guard_stale_draft("Sales Invoice", "SI-001", None)

		mock_frappe.db.get_value.assert_not_called()
		mock_frappe.throw.assert_not_called()

	@patch("xpos.api.invoices.frappe")
	def test_matching_token_passes(self, mock_frappe):
		mock_frappe.db.get_value.return_value = "2026-08-10 21:00:00"

		invoices._guard_stale_draft("Sales Invoice", "SI-001", "2026-08-10 21:00:00")

		mock_frappe.throw.assert_not_called()

	@patch("xpos.api.invoices.frappe")
	def test_stale_token_throws(self, mock_frappe):
		mock_frappe.db.get_value.return_value = "2026-08-10 21:05:00"
		mock_frappe.throw.side_effect = raising_throw

		with self.assertRaises(Exception):
			invoices._guard_stale_draft("Sales Invoice", "SI-001", "2026-08-10 21:00:00")

	@patch("xpos.api.invoices.frappe")
	def test_missing_row_does_not_throw(self, mock_frappe):
		"""A draft that vanished is someone else's error to report, not this guard's."""
		mock_frappe.db.get_value.return_value = None

		invoices._guard_stale_draft("Sales Invoice", "SI-001", "2026-08-10 21:00:00")

		mock_frappe.throw.assert_not_called()


class TestSaveDraftInvoiceConcurrency(unittest.TestCase):
	"""``save_draft_invoice`` guards the update and re-homes the tab to the saver."""

	def setUp(self):
		# Profile access is covered by test_profile_settings; here it resolves through the mocked frappe.
		patcher = patch(
			"xpos.api.invoices.resolve_pos_profile",
			side_effect=lambda name: invoices.frappe.get_cached_doc("POS Profile", name),
		)
		patcher.start()
		self.addCleanup(patcher.stop)

	def _pos_profile(self):
		pos = MagicMock()
		pos.name = PROFILE
		pos.company = "Test Co"
		pos.warehouse = "Stores - TC"
		pos.currency = "USD"
		pos.allow_change_posting_date = 0
		pos.taxes_and_charges = None
		pos.get.return_value = 0
		return pos

	def _payload(self, **overrides):
		payload = {
			"pos_profile": PROFILE,
			"customer": "CUST-001",
			"items": [{"item_code": "ITEM-A", "qty": 1, "rate": 100}],
			"name": "SI-001",
			"pos_opening_shift": SHIFT_B,
		}
		payload.update(overrides)
		return payload

	@patch("xpos.api.invoices._ensure_pos_invoice_payment_row")
	@patch("xpos.api.invoices._apply_invoice_delivery_charge_fields")
	@patch("xpos.api.invoices.get_invoice_type", return_value="Sales Invoice")
	@patch("xpos.api.invoices.frappe")
	def test_stale_token_blocks_the_save(self, mock_frappe, _mock_type, _mock_charges, _mock_row):
		mock_frappe.get_cached_doc.return_value = self._pos_profile()
		mock_frappe.db.exists.return_value = True
		mock_frappe.db.get_value.return_value = "2026-08-10 21:05:00"
		mock_frappe.throw.side_effect = raising_throw

		draft = MagicMock()
		draft.docstatus = 0
		mock_frappe.get_doc.return_value = draft

		with self.assertRaises(Exception):
			invoices.save_draft_invoice(self._payload(modified="2026-08-10 21:00:00"))

		draft.save.assert_not_called()

	@patch("xpos.api.invoices.now_datetime")
	@patch("xpos.api.invoices.nowdate", return_value="2026-08-10")
	@patch("xpos.api.invoices._ensure_pos_invoice_payment_row")
	@patch("xpos.api.invoices._apply_invoice_delivery_charge_fields")
	@patch("xpos.api.invoices._get_item_rate_precision", return_value=2)
	@patch("xpos.api.invoices.get_invoice_type", return_value="Sales Invoice")
	@patch("xpos.api.invoices.frappe")
	def test_matching_token_saves_and_rehomes_the_tab(
		self, mock_frappe, _mock_type, _mock_precision, _mock_charges, _mock_row, _mock_nowdate, _mock_now
	):
		"""A recalled tab moves to the recalling cashier's shift, so their closing
		shift reconciles. This is load-bearing for the whole feature."""
		mock_frappe.get_cached_doc.return_value = self._pos_profile()
		mock_frappe.db.exists.return_value = True
		mock_frappe.db.get_value.return_value = "2026-08-10 21:00:00"

		draft = MagicMock()
		draft.docstatus = 0
		draft.name = "SI-001"
		mock_frappe.get_doc.return_value = draft

		invoices.save_draft_invoice(self._payload(modified="2026-08-10 21:00:00"))

		draft.save.assert_called_once()
		self.assertEqual(draft.pos_opening_shift, SHIFT_B)

	@patch("xpos.api.invoices.now_datetime")
	@patch("xpos.api.invoices.nowdate", return_value="2026-08-10")
	@patch("xpos.api.invoices._ensure_pos_invoice_payment_row")
	@patch("xpos.api.invoices._apply_invoice_delivery_charge_fields")
	@patch("xpos.api.invoices._get_item_rate_precision", return_value=2)
	@patch("xpos.api.invoices.get_invoice_type", return_value="Sales Invoice")
	@patch("xpos.api.invoices.frappe")
	def test_no_token_still_saves(
		self, mock_frappe, _mock_type, _mock_precision, _mock_charges, _mock_row, _mock_nowdate, _mock_now
	):
		mock_frappe.get_cached_doc.return_value = self._pos_profile()
		mock_frappe.db.exists.return_value = True

		draft = MagicMock()
		draft.docstatus = 0
		draft.name = "SI-001"
		mock_frappe.get_doc.return_value = draft

		invoices.save_draft_invoice(self._payload())

		draft.save.assert_called_once()


class TestDeleteDraftInvoiceGuard(unittest.TestCase):
	"""A colleague's live tab must not be one stray click from deletion."""

	def _draft(self, shift):
		draft = MagicMock()
		draft.docstatus = 0
		draft.get.side_effect = lambda key: {
			"pos_opening_shift": shift,
			"pos_profile": PROFILE,
		}.get(key)
		return draft

	@patch("xpos.api.invoices._detect_invoice_doctype", return_value="Sales Invoice")
	@patch("xpos.api.invoices.can_recall_other_shift_tabs", return_value=False)
	@patch("xpos.api.invoices.frappe")
	def test_foreign_tab_denied_without_permission(self, mock_frappe, _mock_can_recall, _mock_detect):
		draft = self._draft(SHIFT_A)
		mock_frappe.get_doc.return_value = draft
		mock_frappe.throw.side_effect = raising_throw

		with self.assertRaises(Exception):
			invoices.delete_draft_invoice("SI-001", pos_opening_shift=SHIFT_B)

		draft.delete.assert_not_called()

	@patch("xpos.api.invoices._detect_invoice_doctype", return_value="Sales Invoice")
	@patch("xpos.api.invoices.can_recall_other_shift_tabs", return_value=True)
	@patch("xpos.api.invoices.frappe")
	def test_foreign_tab_allowed_with_permission(self, mock_frappe, _mock_can_recall, _mock_detect):
		draft = self._draft(SHIFT_A)
		mock_frappe.get_doc.return_value = draft

		invoices.delete_draft_invoice("SI-001", pos_opening_shift=SHIFT_B)

		draft.delete.assert_called_once()

	@patch("xpos.api.invoices._detect_invoice_doctype", return_value="Sales Invoice")
	@patch("xpos.api.invoices.can_recall_other_shift_tabs", return_value=False)
	@patch("xpos.api.invoices.frappe")
	def test_own_tab_needs_no_permission(self, mock_frappe, _mock_can_recall, _mock_detect):
		draft = self._draft(SHIFT_B)
		mock_frappe.get_doc.return_value = draft

		invoices.delete_draft_invoice("SI-001", pos_opening_shift=SHIFT_B)

		draft.delete.assert_called_once()


class TestGetOutstandingInvoices(unittest.TestCase):
	"""The unpaid list is per-customer by default and gated when widened."""

	@patch("xpos.api.payments.can_settle_outstanding", return_value=False)
	@patch("xpos.api.payments.frappe")
	def test_customer_scoped_lookup_needs_no_gate(self, mock_frappe, mock_can_settle):
		"""The existing checkout lookup must keep working for everyone."""
		mock_frappe.get_list.return_value = []

		payments.get_outstanding_invoices(customer="CUST-001", company="Test Co")

		mock_can_settle.assert_not_called()
		filters = mock_frappe.get_list.call_args.kwargs["filters"]
		self.assertEqual(filters["customer"], "CUST-001")

	@patch("xpos.api.payments.can_settle_outstanding", return_value=False)
	@patch("xpos.api.payments.frappe")
	def test_cross_customer_lookup_denied_without_gate(self, mock_frappe, _mock_can_settle):
		mock_frappe.throw.side_effect = raising_throw

		with self.assertRaises(Exception):
			payments.get_outstanding_invoices(pos_profile=PROFILE)

		mock_frappe.get_list.assert_not_called()

	@patch("xpos.api.payments.can_settle_outstanding", return_value=True)
	@patch("xpos.api.payments.frappe")
	def test_cross_customer_lookup_queries_unsettled_sales(self, mock_frappe, _mock_can_settle):
		mock_frappe.get_list.return_value = []

		payments.get_outstanding_invoices(pos_profile=PROFILE)

		filters = mock_frappe.get_list.call_args.kwargs["filters"]
		self.assertEqual(filters["docstatus"], 1)
		self.assertEqual(filters["outstanding_amount"], [">", 0])
		self.assertEqual(filters["is_return"], 0)
		self.assertNotIn("customer", filters)

	@patch("xpos.api.payments.can_settle_outstanding", return_value=True)
	@patch("xpos.api.payments.frappe")
	def test_search_term_spans_name_and_customer(self, mock_frappe, _mock_can_settle):
		mock_frappe.get_list.return_value = []

		payments.get_outstanding_invoices(pos_profile=PROFILE, search_term="ada")

		or_filters = mock_frappe.get_list.call_args.kwargs["or_filters"]
		self.assertEqual(set(or_filters), {"name", "customer", "customer_name"})
		self.assertEqual(or_filters["name"], ["like", "%ada%"])


class TestSettleOutstandingInvoice(unittest.TestCase):
	"""Settling a past credit sale, including the closing-shift contract."""

	def _invoice(self, docstatus=1, outstanding=250.0):
		invoice = MagicMock()
		invoice.docstatus = docstatus
		invoice.outstanding_amount = outstanding
		invoice.customer = "CUST-001"
		invoice.company = "Test Co"
		return invoice

	@patch("xpos.api.payments.can_settle_outstanding", return_value=False)
	@patch("xpos.api.payments.frappe")
	def test_denied_without_gate(self, mock_frappe, _mock_can_settle):
		mock_frappe.throw.side_effect = raising_throw

		with self.assertRaises(Exception):
			payments.settle_outstanding_invoice("SI-001", 100, "Cash", SHIFT_A, PROFILE)

		mock_frappe.get_doc.assert_not_called()

	@patch("xpos.api.payments.can_settle_outstanding", return_value=True)
	@patch("xpos.api.payments.frappe")
	def test_requires_an_open_shift(self, mock_frappe, _mock_can_settle):
		"""Without a shift the cash would never reach a closing entry."""
		mock_frappe.throw.side_effect = raising_throw

		with self.assertRaises(Exception):
			payments.settle_outstanding_invoice("SI-001", 100, "Cash", "", PROFILE)

	@patch("xpos.api.payments.can_settle_outstanding", return_value=True)
	@patch("xpos.api.payments.frappe")
	def test_rejects_a_draft_invoice(self, mock_frappe, _mock_can_settle):
		mock_frappe.db.exists.return_value = True
		mock_frappe.get_doc.return_value = self._invoice(docstatus=0)
		mock_frappe.throw.side_effect = raising_throw

		with self.assertRaises(Exception):
			payments.settle_outstanding_invoice("SI-001", 100, "Cash", SHIFT_A, PROFILE)

	@patch("xpos.api.payments.can_settle_outstanding", return_value=True)
	@patch("xpos.api.payments.frappe")
	def test_rejects_a_settled_invoice(self, mock_frappe, _mock_can_settle):
		mock_frappe.db.exists.return_value = True
		mock_frappe.get_doc.return_value = self._invoice(outstanding=0)
		mock_frappe.throw.side_effect = raising_throw

		with self.assertRaises(Exception):
			payments.settle_outstanding_invoice("SI-001", 100, "Cash", SHIFT_A, PROFILE)

	@patch("xpos.api.payments.can_settle_outstanding", return_value=True)
	@patch("xpos.api.payments.frappe")
	def test_rejects_overpayment(self, mock_frappe, _mock_can_settle):
		"""A POS settles a balance; it does not take money on account."""
		mock_frappe.db.exists.return_value = True
		mock_frappe.get_doc.return_value = self._invoice(outstanding=250.0)
		mock_frappe.throw.side_effect = raising_throw

		with self.assertRaises(Exception):
			payments.settle_outstanding_invoice("SI-001", 300, "Cash", SHIFT_A, PROFILE)

	@patch("xpos.api.payments.can_settle_outstanding", return_value=True)
	@patch("xpos.api.payments.frappe")
	def test_rejects_non_positive_amount(self, mock_frappe, _mock_can_settle):
		mock_frappe.db.exists.return_value = True
		mock_frappe.get_doc.return_value = self._invoice()
		mock_frappe.throw.side_effect = raising_throw

		with self.assertRaises(Exception):
			payments.settle_outstanding_invoice("SI-001", 0, "Cash", SHIFT_A, PROFILE)

	@patch("xpos.api.payments.create_payment_entry")
	@patch("xpos.api.payments.can_settle_outstanding", return_value=True)
	@patch("xpos.api.payments.frappe")
	def test_stamps_the_shift_on_the_payment_entry(self, mock_frappe, _mock_can_settle, mock_create_pe):
		"""``reference_no`` is how POS Closing Shift finds the payment - see
		``get_payments_entries``. Without it the drawer reconciles short."""
		mock_frappe.db.exists.return_value = True
		mock_frappe.get_doc.return_value = self._invoice(outstanding=250.0)
		mock_frappe.db.get_value.return_value = 150.0
		mock_create_pe.return_value = {"name": "PE-001", "paid_amount": 100}

		result = payments.settle_outstanding_invoice("SI-001", 100, "Cash", SHIFT_A, PROFILE)

		payload = mock_create_pe.call_args.args[0]
		self.assertEqual(payload["reference_no"], SHIFT_A)
		self.assertEqual(payload["reference_doctype"], "Sales Invoice")
		self.assertEqual(payload["reference_name"], "SI-001")
		self.assertEqual(payload["customer"], "CUST-001")
		self.assertEqual(payload["mode_of_payment"], "Cash")
		self.assertTrue(payload["submit"])

		self.assertEqual(result["payment_entry"], "PE-001")
		self.assertEqual(result["allocated_amount"], 100)
		self.assertEqual(result["outstanding_after"], 150.0)

	@patch("xpos.api.payments.create_payment_entry")
	@patch("xpos.api.payments.can_settle_outstanding", return_value=True)
	@patch("xpos.api.payments.frappe")
	def test_allows_settling_the_exact_outstanding(self, mock_frappe, _mock_can_settle, mock_create_pe):
		"""Paying a tab off in full is the common case and must not trip the cap."""
		mock_frappe.db.exists.return_value = True
		mock_frappe.get_doc.return_value = self._invoice(outstanding=250.0)
		mock_frappe.db.get_value.return_value = 0.0
		mock_create_pe.return_value = {"name": "PE-002"}

		result = payments.settle_outstanding_invoice("SI-001", 250.0, "Cash", SHIFT_A, PROFILE)

		self.assertEqual(result["outstanding_after"], 0.0)


class TestOpenTabGates(unittest.TestCase):
	"""The gates fail closed on a site that has not migrated yet."""

	@patch("xpos.api.utilities.frappe")
	def test_recall_denied_when_column_missing(self, mock_frappe):
		mock_frappe.db.has_column.return_value = False

		self.assertFalse(utilities.can_recall_other_shift_tabs(PROFILE))

	@patch("xpos.api.utilities.frappe")
	def test_recall_denied_without_a_profile(self, mock_frappe):
		self.assertFalse(utilities.can_recall_other_shift_tabs(None))
		mock_frappe.db.has_column.assert_not_called()

	@patch("xpos.api.auth.user_has_pos_permission", return_value=True)
	@patch("xpos.api.utilities.frappe")
	def test_recall_denied_when_profile_flag_off(self, mock_frappe, _mock_permission):
		mock_frappe.db.has_column.return_value = True
		mock_frappe.db.get_value.return_value = 0

		self.assertFalse(utilities.can_recall_other_shift_tabs(PROFILE))

	@patch("xpos.api.auth.user_has_pos_permission", return_value=False)
	@patch("xpos.api.utilities.frappe")
	def test_recall_denied_when_role_permission_off(self, mock_frappe, _mock_permission):
		mock_frappe.db.has_column.return_value = True
		mock_frappe.db.get_value.return_value = 1

		self.assertFalse(utilities.can_recall_other_shift_tabs(PROFILE))

	@patch("xpos.api.auth.user_has_pos_permission", return_value=True)
	@patch("xpos.api.utilities.frappe")
	def test_recall_allowed_when_both_gates_agree(self, mock_frappe, _mock_permission):
		mock_frappe.db.has_column.return_value = True
		mock_frappe.db.get_value.return_value = 1

		self.assertTrue(utilities.can_recall_other_shift_tabs(PROFILE))

	@patch("xpos.api.auth.user_has_pos_permission", return_value=True)
	@patch("xpos.api.utilities.frappe")
	def test_settlement_gate_reads_its_own_flag(self, mock_frappe, _mock_permission):
		mock_frappe.db.has_column.return_value = True
		mock_frappe.db.get_value.return_value = 1

		self.assertTrue(utilities.can_settle_outstanding(PROFILE))
		mock_frappe.db.get_value.assert_called_with("POS Profile", PROFILE, "allow_outstanding_settlement")


if __name__ == "__main__":
	unittest.main()
