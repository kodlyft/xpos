import unittest
from unittest.mock import MagicMock, patch

from xpos.x_pos.integrations import fbr, fiscal_ledger


class DummyMeta:
	def get_field(self, fieldname):
		return True


class DummyDoc(dict):
	def __init__(self, **kwargs):
		super().__init__(**kwargs)
		object.__setattr__(self, "meta", DummyMeta())

	def get(self, key, default=None):
		return super().get(key, default)

	def set(self, key, value):
		self[key] = value

	def __getattr__(self, item):
		try:
			return self[item]
		except KeyError as exc:
			raise AttributeError(item) from exc

	def __setattr__(self, key, value):
		if key == "meta":
			object.__setattr__(self, key, value)
		else:
			self[key] = value


def connection_refused():
	"""What requests raises when nothing reached FBR (connection refused)."""
	from urllib3.exceptions import MaxRetryError, NewConnectionError

	return fbr.requests.ConnectionError(MaxRetryError(None, "/", reason=NewConnectionError(None, "refused")))


class TestFBRIntegration(unittest.TestCase):
	def setUp(self):
		self.translation_patcher = patch("xpos.x_pos.integrations.fbr._", lambda message: message)
		self.now_patcher = patch(
			"xpos.x_pos.integrations.fbr.now_datetime",
			return_value="2026-04-06 10:30:00",
		)
		self.translation_patcher.start()
		self.now_patcher.start()
		# The fiscal ledger is a database table; here it is a fake that knows nothing yet.
		self.known = fiscal_ledger.Known("none")
		self.begin = patch.object(fiscal_ledger, "begin_cloud_attempt", side_effect=self.fake_begin).start()
		self.finish = patch.object(fiscal_ledger, "finish_attempt").start()

	def tearDown(self):
		patch.stopall()

	def fake_begin(self, doc, pos_id, usin, payload, held_uncertain):
		if self.known.kind in ("recorded", "pending"):
			return self.known
		if held_uncertain and self.known.kind != "not_recorded":
			return fiscal_ledger.Known("pending")
		return fiscal_ledger.Known("none", attempt="ATTEMPT-1")

	def _make_invoice(self, **overrides):
		item = DummyDoc(
			item_code="ITEM-001",
			item_name="Test Item",
			qty=2,
			price_list_rate=100,
			rate=100,
			base_net_amount=200,
			base_amount=234,
		)
		payment = DummyDoc(mode_of_payment="Cash", amount=234)
		defaults = {
			"doctype": "Sales Invoice",
			"name": "ACC-SINV-2026-0001",
			"is_pos": 1,
			"pos_profile": "POS-TEST",
			"is_return": 0,
			"posting_date": "2026-04-06",
			"posting_time": "10:30:00",
			"customer": "CUST-0001",
			"customer_name": "Walk In Customer",
			"tax_id": "1234567-8",
			"contact_mobile": "03001234567",
			"items": [item],
			"payments": [payment],
			"taxes": [],
			"base_discount_amount": 0,
			"base_rounded_total": 234,
			"base_grand_total": 234,
		}
		defaults.update(overrides)
		return DummyDoc(**defaults)

	def _mock_profile(self, enabled=True):
		profile = MagicMock()
		profile.enable_fbr_integration = 1 if enabled else 0
		profile.fbr_environment = "Sandbox"
		profile.fbr_pos_id = "110014"
		profile.fbr_api_url = ""
		profile.fbr_skip_ssl_verification = 0
		profile.fbr_local_service_url = "http://localhost:8524"
		profile.get_password.return_value = "secret-token"
		return profile

	def _db_get_value_side_effect(self, doctype, name, fieldname=None, *args, **kwargs):
		if doctype == "Item":
			return {"customs_tariff_number": "11001010", "fbr_third_schedule": 0}
		if doctype == "Mode of Payment":
			return ""
		return None

	@patch("xpos.x_pos.integrations.fbr.requests.post")
	@patch("xpos.x_pos.integrations.fbr.frappe")
	def test_fiscalize_invoice_stores_fbr_response(self, mock_frappe, mock_post):
		invoice = self._make_invoice()
		mock_frappe.get_doc.return_value = self._mock_profile(enabled=True)
		mock_frappe.db.get_value.side_effect = self._db_get_value_side_effect

		response = MagicMock()
		response.status_code = 200
		response.json.return_value = {
			"FBRInvoiceNumber": "9329402106181682148",
			"Code": "100",
			"Response": "Invoice received successfully",
		}
		response.text = '{"FBRInvoiceNumber":"9329402106181682148","Code":"100"}'
		mock_post.return_value = response

		fbr.fiscalize_invoice(invoice)

		self.assertEqual(invoice.fbr_invoice_number, "9329402106181682148")
		self.assertTrue(invoice.fbr_posted_on)

		called_payload = mock_post.call_args.kwargs["json"]
		self.assertEqual(called_payload["InvoiceNumber"], "")
		self.assertEqual(called_payload["USIN"], invoice.name)
		self.assertEqual(called_payload["POSID"], 110014)
		self.assertEqual(called_payload["Items"][0]["PCTCode"], "11001010")

	@patch("xpos.x_pos.integrations.fbr.requests.post")
	@patch("xpos.x_pos.integrations.fbr.frappe")
	def test_fiscalize_invoice_skips_when_disabled(self, mock_frappe, mock_post):
		invoice = self._make_invoice()
		mock_frappe.get_doc.return_value = self._mock_profile(enabled=False)

		fbr.fiscalize_invoice(invoice)

		mock_post.assert_not_called()
		self.assertFalse(invoice.get("fbr_invoice_number"))

	@patch("xpos.x_pos.integrations.fbr.requests.post")
	@patch("xpos.x_pos.integrations.fbr.frappe")
	def test_fiscalize_invoice_requires_pct_code(self, mock_frappe, mock_post):
		invoice = self._make_invoice()
		mock_frappe.get_doc.return_value = self._mock_profile(enabled=True)

		def missing_pct_side_effect(doctype, name, fieldname=None, *args, **kwargs):
			if doctype == "Item":
				return {"customs_tariff_number": "", "fbr_third_schedule": 0}
			if doctype == "Mode of Payment":
				return ""
			return None

		mock_frappe.db.get_value.side_effect = missing_pct_side_effect

		with self.assertRaises(fbr.FBRIntegrationError):
			fbr.fiscalize_invoice(invoice)

		mock_post.assert_not_called()

	@patch("xpos.x_pos.integrations.fbr.requests.post")
	@patch("xpos.x_pos.integrations.fbr.frappe")
	def test_prepare_fiscalization_cloud_success(self, mock_frappe, mock_post):
		invoice = self._make_invoice()
		mock_frappe.get_doc.return_value = self._mock_profile(enabled=True)
		mock_frappe.db.get_value.side_effect = self._db_get_value_side_effect

		response = MagicMock()
		response.status_code = 200
		response.json.return_value = {"FBRInvoiceNumber": "9329402106181682148", "Code": "100"}
		response.text = '{"FBRInvoiceNumber":"9329402106181682148","Code":"100"}'
		mock_post.return_value = response

		outcome = fbr.prepare_fiscalization(invoice)

		self.assertEqual(outcome.status, "cloud")
		self.assertEqual(outcome.fbr_invoice_number, "9329402106181682148")
		# prepare_fiscalization must not mutate the document.
		self.assertFalse(invoice.get("fbr_invoice_number"))

	@patch("xpos.x_pos.integrations.fbr.requests.post")
	@patch("xpos.x_pos.integrations.fbr.frappe")
	def test_prepare_fiscalization_local_required_when_offline(self, mock_frappe, mock_post):
		invoice = self._make_invoice()
		mock_frappe.get_doc.return_value = self._mock_profile(enabled=True)
		mock_frappe.db.get_value.side_effect = self._db_get_value_side_effect
		mock_post.side_effect = connection_refused()

		outcome = fbr.prepare_fiscalization(invoice)

		self.assertEqual(outcome.status, "local_required")
		self.assertIsNotNone(outcome.payload)
		self.assertEqual(outcome.payload["POSID"], 110014)
		self.assertEqual(outcome.local_service_url, "http://localhost:8524")
		self.assertFalse(invoice.get("fbr_invoice_number"))

	@patch("xpos.x_pos.integrations.fbr.requests.post")
	@patch("xpos.x_pos.integrations.fbr.frappe")
	def test_fiscalize_invoice_raises_connection_error_when_offline(self, mock_frappe, mock_post):
		invoice = self._make_invoice()
		mock_frappe.get_doc.return_value = self._mock_profile(enabled=True)
		mock_frappe.db.get_value.side_effect = self._db_get_value_side_effect
		mock_post.side_effect = connection_refused()

		# The submit-time hook has no client to drive the local fallback → hard-fail.
		with self.assertRaises(fbr.FBRConnectionError):
			fbr.fiscalize_invoice(invoice)

	@patch("xpos.x_pos.integrations.fbr.requests.post")
	@patch("xpos.x_pos.integrations.fbr.frappe")
	def test_no_answer_after_sending_is_uncertain_not_local(self, mock_frappe, mock_post):
		invoice = self._make_invoice()
		mock_frappe.get_doc.return_value = self._mock_profile(enabled=True)
		mock_frappe.db.get_value.side_effect = self._db_get_value_side_effect
		for error in (
			fbr.requests.ReadTimeout("no answer"),
			fbr.requests.ConnectionError("connection reset"),
			fbr.requests.RequestException("unknown"),
		):
			mock_post.side_effect = error
			self.assertEqual(fbr.prepare_fiscalization(invoice).status, "uncertain")
			with self.assertRaises(fbr.FBRUncertainError):
				fbr.fiscalize_invoice(invoice)
		# Once marked, FBR is not called at all.
		mock_post.reset_mock()
		self.assertEqual(
			fbr.prepare_fiscalization({**invoice, "xpos_fiscal_state": "Uncertain"}).status, "uncertain"
		)
		mock_post.assert_not_called()

	@patch("xpos.x_pos.integrations.fbr.requests.post")
	@patch("xpos.x_pos.integrations.fbr.frappe")
	def test_prepare_fiscalization_uses_local_id_as_usin(self, mock_frappe, mock_post):
		invoice = self._make_invoice(xpos_local_id="inv_local_123")
		mock_frappe.get_doc.return_value = self._mock_profile(enabled=True)
		mock_frappe.db.get_value.side_effect = self._db_get_value_side_effect
		mock_post.side_effect = connection_refused()

		outcome = fbr.prepare_fiscalization(invoice)

		self.assertEqual(outcome.payload["USIN"], "inv_local_123")

	def _setup_enabled(self, mock_frappe):
		mock_frappe.get_doc.return_value = self._mock_profile(enabled=True)
		mock_frappe.db.get_value.side_effect = self._db_get_value_side_effect

	@patch("xpos.x_pos.integrations.fbr.requests.post")
	@patch("xpos.x_pos.integrations.fbr.frappe")
	def test_a_number_fbr_already_issued_is_reused_without_sending(self, mock_frappe, mock_post):
		self._setup_enabled(mock_frappe)
		invoice = self._make_invoice(xpos_local_id="inv_1")
		payload = fbr._build_payload(invoice, fbr._get_fbr_settings("POS-TEST"))
		self.known = fiscal_ledger.Known(
			"recorded", "FBR-OLD-1", "2026-04-06 10:00:00", fiscal_ledger.content_hash(payload), "ATTEMPT-0"
		)
		outcome = fbr.prepare_fiscalization(invoice)
		self.assertEqual((outcome.status, outcome.fbr_invoice_number), ("cloud", "FBR-OLD-1"))
		mock_post.assert_not_called()

		# A different sale under the same id is refused, still without sending.
		with self.assertRaises(fbr.FBRIntegrationError):
			fbr.prepare_fiscalization(self._make_invoice(xpos_local_id="inv_1", base_rounded_total=999))
		mock_post.assert_not_called()

	def test_content_hash_ignores_only_the_time_sent(self):
		payload = {
			"USIN": "inv_1",
			"DateTime": "2026-04-06 10:00:00",
			"TotalBillAmount": 10,
			"PaymentMode": 1,
		}
		same = fiscal_ledger.content_hash({**payload, "DateTime": "2026-04-07 09:00:00"})
		self.assertEqual(fiscal_ledger.content_hash(payload), same)
		self.assertNotEqual(fiscal_ledger.content_hash({**payload, "PaymentMode": 2}), same)

	@patch("xpos.x_pos.integrations.fbr.requests.post")
	@patch("xpos.x_pos.integrations.fbr.frappe")
	def test_gateway_errors_and_answers_without_a_number_are_uncertain(self, mock_frappe, mock_post):
		self._setup_enabled(mock_frappe)
		for status, body in ((502, {}), (504, {"Response": "timeout"}), (200, {}), (200, {"Code": "100"})):
			mock_post.return_value = MagicMock(status_code=status, json=MagicMock(return_value=body), text="")
			self.assertEqual(fbr.prepare_fiscalization(self._make_invoice()).status, "uncertain")
			self.assertEqual(self.finish.call_args.args[:2], ("ATTEMPT-1", "Uncertain"))

	@patch("xpos.x_pos.integrations.fbr.requests.post")
	@patch("xpos.x_pos.integrations.fbr.frappe")
	def test_attempt_outcomes_are_recorded(self, mock_frappe, mock_post):
		self._setup_enabled(mock_frappe)
		mock_post.return_value = MagicMock(
			status_code=200, json=MagicMock(return_value={"Code": "100", "InvoiceNumber": "FBR-1"})
		)
		fbr.prepare_fiscalization(self._make_invoice())
		self.assertEqual(self.finish.call_args.args[:3], ("ATTEMPT-1", "Accepted", "FBR-1"))

		mock_post.return_value = MagicMock(
			status_code=200, json=MagicMock(return_value={"Code": "401", "Response": "bad"})
		)
		with self.assertRaises(fbr.FBRIntegrationError):
			fbr.prepare_fiscalization(self._make_invoice())
		self.assertEqual(self.finish.call_args.args[:2], ("ATTEMPT-1", "Rejected"))

		mock_post.side_effect = connection_refused()
		self.assertEqual(fbr.prepare_fiscalization(self._make_invoice()).status, "local_required")
		self.assertEqual(self.finish.call_args.args[:2], ("ATTEMPT-1", "Not Sent"))


if __name__ == "__main__":
	unittest.main()
