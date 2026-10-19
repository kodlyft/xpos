import unittest
from unittest.mock import patch

from xpos.x_pos.doctype.pos_closing_shift.closing_processing import reclass

PRECISION = {"LBP": 0, "USD": 2}
MODULE = "xpos.x_pos.doctype.pos_closing_shift.closing_processing.reclass"

rounding_patch = None


def setUpModule():
	"""flt() needs a rounding method; None reproduces an unconfigured site (see test_tender)."""
	global rounding_patch
	rounding_patch = patch("frappe.get_system_settings", return_value=None)
	rounding_patch.start()


def tearDownModule():
	rounding_patch.stop()


class Doc(dict):
	def __getattr__(self, key):
		try:
			return self[key]
		except KeyError as exc:
			raise AttributeError(key) from exc


def sale(payments, legs=(), change_amount=0, docstatus=1, currency="LBP"):
	return Doc(
		docstatus=docstatus,
		currency=currency,
		payments=[Doc(p) for p in payments],
		pos_change_legs=[Doc(leg) for leg in legs],
		change_amount=change_amount,
	)


ACCOUNTS = {"Cash USD": ("Cash - K", "USD Bank - K"), "Cash LBP": ("Cash - K", None)}
CURRENCIES = {"Cash - K": "LBP", "USD Bank - K": "USD", "LBP Bank - K": "LBP"}


@patch(f"{MODULE}.get_currency_precision", side_effect=lambda c: PRECISION.get(c, 2))
class TestBuildReclassRows(unittest.TestCase):
	def test_usd_destination_moves_native_at_frozen_rate(self, _precision):
		nets = {"Cash USD": {"currency": "USD", "native": 270.0, "base": 24300000.0}}
		rows = reclass.build_reclass_rows(nets, ACCOUNTS, "LBP", CURRENCIES, "Main - K")

		self.assertEqual(len(rows), 2)
		bank, cash = rows
		self.assertEqual(bank["account"], "USD Bank - K")
		self.assertEqual(bank["debit_in_account_currency"], 270.0)
		self.assertEqual(bank["exchange_rate"], 90000.0)
		self.assertEqual(cash["account"], "Cash - K")
		self.assertEqual(cash["credit_in_account_currency"], 24300000.0)

	def test_negative_net_reverses_sides(self, _precision):
		nets = {"Cash USD": {"currency": "USD", "native": -10.0, "base": -900000.0}}
		bank, cash = reclass.build_reclass_rows(nets, ACCOUNTS, "LBP", CURRENCIES, None)

		self.assertEqual(bank["credit_in_account_currency"], 10.0)
		self.assertEqual(cash["debit_in_account_currency"], 900000.0)

	def test_company_currency_destination_moves_base(self, _precision):
		accounts = {"Cash USD": ("Cash - K", "LBP Bank - K")}
		nets = {"Cash USD": {"currency": "USD", "native": 270.0, "base": 24300000.0}}
		bank, cash = reclass.build_reclass_rows(nets, accounts, "LBP", CURRENCIES, None)

		self.assertEqual(bank["debit_in_account_currency"], 24300000.0)
		self.assertEqual(bank["exchange_rate"], 1.0)
		self.assertEqual(cash["credit_in_account_currency"], 24300000.0)

	def test_modes_without_destination_or_net_are_skipped(self, _precision):
		nets = {
			"Cash LBP": {"currency": "LBP", "native": 500.0, "base": 500.0},
			"Cash USD": {"currency": "USD", "native": 0.0, "base": 0.0},
		}
		self.assertEqual(reclass.build_reclass_rows(nets, ACCOUNTS, "LBP", CURRENCIES, None), [])

	def test_destination_in_third_currency_is_refused(self, _precision):
		currencies = dict(CURRENCIES, **{"USD Bank - K": "EUR"})
		nets = {"Cash USD": {"currency": "USD", "native": 1.0, "base": 90000.0}}
		with self.assertRaises(Exception):
			reclass.build_reclass_rows(nets, ACCOUNTS, "LBP", currencies, None)


class TestShiftModeNets(unittest.TestCase):
	@patch(f"{MODULE}.frappe")
	def test_nets_subtract_change_legs_and_include_returns(self, mock_frappe):
		invoices = {
			"SI-1": sale(
				[
					{
						"mode_of_payment": "Cash USD",
						"amount": 9000000,
						"pos_tender_currency": "USD",
						"pos_tender_amount": 100,
					}
				],
				legs=[
					{
						"mode_of_payment": "Cash LBP",
						"currency": "LBP",
						"amount": 407700,
						"base_amount": 407700,
					},
					{"mode_of_payment": "Cash USD", "currency": "USD", "amount": 30, "base_amount": 2700000},
				],
				change_amount=3107700,
			),
			"SI-2": sale(
				[
					{
						"mode_of_payment": "Cash USD",
						"amount": -900000,
						"pos_tender_currency": "USD",
						"pos_tender_amount": -10,
					}
				]
			),
			"SI-3": sale([{"mode_of_payment": "Cash USD", "amount": 1}], docstatus=2),
		}
		mock_frappe.db.get_value.return_value = "Cash LBP"
		mock_frappe.db.exists.return_value = True
		mock_frappe.get_doc.side_effect = lambda doctype, name: invoices[name]

		closing = Doc(
			pos_profile="Main",
			pos_transactions=[Doc(sales_invoice=name) for name in invoices],
		)
		nets = reclass.shift_mode_nets(closing, "LBP")

		self.assertEqual(nets["Cash USD"]["currency"], "USD")
		self.assertEqual(nets["Cash USD"]["native"], 60.0)
		self.assertEqual(nets["Cash USD"]["base"], 5400000.0)
		self.assertEqual(nets["Cash LBP"]["native"], -407700.0)

	@patch(f"{MODULE}.frappe")
	def test_unlegged_change_comes_from_cash_mode(self, mock_frappe):
		invoices = {"SI-1": sale([{"mode_of_payment": "Cash LBP", "amount": 1000}], change_amount=200)}
		mock_frappe.db.get_value.return_value = "Cash LBP"
		mock_frappe.db.exists.return_value = True
		mock_frappe.get_doc.side_effect = lambda doctype, name: invoices[name]

		closing = Doc(pos_profile="Main", pos_transactions=[Doc(sales_invoice="SI-1")])
		self.assertEqual(reclass.shift_mode_nets(closing, "LBP")["Cash LBP"]["base"], 800.0)


def account_row(default, destination, posting="Per Shift"):
	return Doc(default_account=default, pos_destination_account=destination, pos_destination_posting=posting)


def cached_value(doctype, name, field):
	return {
		("Account", "company"): "Kajo",
		("Account", "account_currency"): CURRENCIES.get(name, "LBP"),
		("Company", "default_currency"): "LBP",
		("Company", "cost_center"): "Main - K",
	}[(doctype, field)]


@patch(f"{MODULE}.get_currency_precision", side_effect=lambda c: PRECISION.get(c, 2))
@patch(f"{MODULE}.post_journal_entry", side_effect=lambda *args, **kwargs: f"JV-{args[4][:12]}")
@patch(f"{MODULE}.frappe")
class TestCreateReclassJournalEntry(unittest.TestCase):
	closing = Doc(name="CLS-1", company="Kajo", pos_profile="Main", posting_date="2026-10-16")

	def setUp(self):
		self.transfers = [
			sale(
				[
					{
						"mode_of_payment": "UNIBANK",
						"amount": 900000,
						"pos_tender_currency": "USD",
						"pos_tender_amount": 10,
						"reference_no": "TRF-1",
					},
					{"mode_of_payment": "Cash LBP", "amount": 5000},
				]
			),
			sale(
				[
					{
						"mode_of_payment": "UNIBANK",
						"amount": 1800000,
						"pos_tender_currency": "USD",
						"pos_tender_amount": 20,
					}
				]
			),
		]
		self.transfers[0].update(name="SI-1", posting_date="2026-10-15")
		self.transfers[1].update(name="SI-2", posting_date="2026-10-16")

	def run_create(self, mock_frappe, rows, nets):
		mock_frappe.db.exists.return_value = False
		mock_frappe.db.get_value.return_value = None
		mock_frappe.get_cached_value.side_effect = cached_value
		with (
			patch(f"{MODULE}.destination_accounts", return_value=rows),
			patch(f"{MODULE}.shift_mode_nets", return_value=nets),
			patch(f"{MODULE}.shift_invoices", return_value=self.transfers),
		):
			return reclass.create_reclass_journal_entry(self.closing)

	def test_per_payment_posts_one_entry_per_transfer_with_its_reference(
		self, mock_frappe, mock_post, _precision
	):
		rows = {
			"UNIBANK": account_row("Cash - K", "USD Bank - K", "Per Payment"),
			"Cash LBP": account_row("Cash - K", None),
		}
		nets = {"UNIBANK": {"currency": "USD", "native": 30.0, "base": 2700000.0}}

		self.run_create(mock_frappe, rows, nets)

		self.assertEqual(mock_post.call_count, 2)
		first, second = (call.args for call in mock_post.call_args_list)
		self.assertEqual(first[3], "2026-10-15")
		self.assertEqual(first[5], "TRF-1")
		self.assertEqual(first[1][0]["debit_in_account_currency"], 10.0)
		self.assertEqual(first[1][1]["credit_in_account_currency"], 900000.0)
		# no transfer number taken (e.g. a refund): fall back to the invoice, so it still has a reference
		self.assertEqual(second[5], "SI-2")
		self.assertEqual(second[3], "2026-10-16")

	def test_per_shift_mode_posts_one_shift_entry(self, mock_frappe, mock_post, _precision):
		rows = {"UNIBANK": account_row("Cash - K", "USD Bank - K")}
		nets = {"UNIBANK": {"currency": "USD", "native": 30.0, "base": 2700000.0}}

		self.run_create(mock_frappe, rows, nets)

		mock_post.assert_called_once()
		args = mock_post.call_args.args
		self.assertEqual(args[3], "2026-10-16")
		self.assertEqual(len(args), 5)  # no reference: one consolidated deposit
		self.assertEqual(args[1][0]["debit_in_account_currency"], 30.0)

	def test_a_shift_that_already_posted_posts_nothing(self, mock_frappe, mock_post, _precision):
		mock_frappe.db.exists.return_value = True
		with patch(f"{MODULE}.destination_accounts", return_value={"UNIBANK": account_row("C", "B")}):
			self.assertEqual(reclass.create_reclass_journal_entry(self.closing), [])
		mock_post.assert_not_called()

	def test_cancel_cancels_every_entry_of_the_shift(self, mock_frappe, mock_post, _precision):
		mock_frappe.get_all.return_value = ["JV-1", "JV-2"]
		with patch(f"{MODULE}.cancel_journal_entry") as mock_cancel:
			reclass.cancel_reclass_journal_entry(self.closing)
		self.assertEqual([call.args[0] for call in mock_cancel.call_args_list], ["JV-1", "JV-2"])


class TestReferenceModes(unittest.TestCase):
	def test_only_per_payment_modes_with_require_reference_insist_on_one(self):
		rows = {
			"UNIBANK HTG": Doc(**account_row("C", "B", "Per Payment"), pos_reference_required=1),
			"SOGEBANK HTG": Doc(**account_row("C", "B", "Per Payment"), pos_reference_required=0),
			"BUH HTG": Doc(**account_row("C", "B"), pos_reference_required=1),
		}
		with patch(f"{MODULE}.destination_accounts", return_value=rows):
			self.assertEqual(reclass.per_payment_modes("Kajo"), {"UNIBANK HTG", "SOGEBANK HTG"})
			self.assertEqual(reclass.reference_required_modes("Kajo"), {"UNIBANK HTG"})


@patch(f"{MODULE}.frappe")
class TestValidateModeOfPayment(unittest.TestCase):
	def test_per_payment_is_refused_on_a_cash_mode(self, mock_frappe):
		mock_frappe.throw.side_effect = Exception("cash")
		doc = Doc(name="Cash HTG", type="Cash", accounts=[Doc(idx=1, **account_row("C", "B", "Per Payment"))])
		with self.assertRaises(Exception):
			reclass.validate_mode_of_payment(doc)

	def test_per_payment_is_fine_on_a_bank_mode(self, mock_frappe):
		doc = Doc(name="UNIBANK", type="Bank", accounts=[Doc(idx=1, **account_row("C", "B", "Per Payment"))])
		reclass.validate_mode_of_payment(doc)
		mock_frappe.throw.assert_not_called()
