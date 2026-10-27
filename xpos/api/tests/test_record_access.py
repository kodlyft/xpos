# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""Live checks that POS endpoints only return records the caller may see.

Run on a disposable test site::

    bench --site <site> run-tests --module xpos.api.tests.test_record_access
"""

import frappe
from erpnext.accounts.doctype.sales_invoice.test_sales_invoice import create_sales_invoice
from erpnext.tests.utils import ERPNextTestSuite

from xpos.api import customers as customers_api
from xpos.api import invoices as invoices_api
from xpos.api.tests.test_profile_settings_hardening import ensure, ensure_user, make_profile, setup_fixtures

CASHIER = "ra-cashier@example.com"
OWN_PROFILE = "_Test RA Own Profile"
OTHER_PROFILE = "_Test RA Other Profile"
ALLOWED_GROUP = "_Test RA Allowed Group"
OTHER_GROUP = "_Test RA Other Group"
NESTED_GROUP = "_Test RA Nested Group"
BROAD = "ra-broad@example.com"
OUTSIDER = "ra-outsider@example.com"
NO_ROLES = "ra-noroles@example.com"
EMPTY_PROFILE = "_Test RA Empty Profile"
INSIDE = "_Test RA Inside Customer"
NESTED = "_Test RA Nested Customer"
OTHER_COMPANY = "_Test Company 1"
OUTSIDE = "_Test RA Outside Customer"


def ensure_customer(name, group):
	ensure(
		"Customer",
		name,
		{
			"customer_name": name,
			"customer_group": group,
			"territory": "All Territories",
			"mobile_no": "0300" + str(abs(hash(name)))[:7],
		},
	)


def restrict(user, allow, name):
	perm = frappe.get_doc(
		{"doctype": "User Permission", "user": user, "allow": allow, "for_value": name}
	).insert(ignore_permissions=True)
	frappe.clear_cache(user=user)
	return perm


def post_balance(customer, company, debit):
	"""A submitted receivable GL row, written directly so no accounting validation is needed."""
	frappe.get_doc(
		{
			"doctype": "GL Entry",
			"posting_date": frappe.utils.nowdate(),
			"account": frappe.db.get_value("Company", company, "default_receivable_account"),
			"party_type": "Customer",
			"party": customer,
			"company": company,
			"debit": debit,
			"credit": 0,
			"docstatus": 1,
			"voucher_type": "Journal Entry",
			"voucher_no": "RA-" + company,
		}
	).db_insert()


def draft_on(profile):
	invoice = create_sales_invoice(do_not_save=1)
	invoice.pos_profile = profile
	invoice.insert(ignore_permissions=True)
	return invoice


class RecordAccessTestCase(ERPNextTestSuite):
	def setUp(self):
		frappe.set_user("Administrator")
		setup_fixtures()
		for group in (ALLOWED_GROUP, OTHER_GROUP):
			ensure(
				"Customer Group",
				group,
				{"customer_group_name": group, "parent_customer_group": "All Customer Groups"},
			)
		ensure(
			"Customer Group",
			NESTED_GROUP,
			{"customer_group_name": NESTED_GROUP, "parent_customer_group": ALLOWED_GROUP},
		)
		ensure_customer(INSIDE, ALLOWED_GROUP)
		ensure_customer(NESTED, NESTED_GROUP)
		ensure_customer(OUTSIDE, OTHER_GROUP)
		ensure_user(CASHIER, [])
		ensure_user(BROAD, ["Sales Manager", "Accounts User"])
		ensure_user(OUTSIDER, ["Sales Manager", "Accounts User"])
		ensure_user(NO_ROLES, [])
		make_profile(
			OWN_PROFILE,
			users=[(CASHIER, "Cashier", 0), (BROAD, "Cashier", 0)],
			customer_groups=[{"customer_group": ALLOWED_GROUP}],
		)
		make_profile(OTHER_PROFILE)
		make_profile(EMPTY_PROFILE, users=[(CASHIER, "Cashier", 0)])
		self.own_draft = draft_on(OWN_PROFILE)
		self.other_draft = draft_on(OTHER_PROFILE)
		frappe.set_user(CASHIER)

	def tearDown(self):
		frappe.set_user("Administrator")
		super().tearDown()


class TestCustomerScope(RecordAccessTestCase):
	"""Customer endpoints stop at the POS Profile's customer groups."""

	def test_customer_inside_the_profile_groups_is_readable(self):
		info = customers_api.get_customer_info(INSIDE, pos_profile=OWN_PROFILE)
		self.assertEqual(info["name"], INSIDE)
		self.assertEqual(customers_api.get_customer_addresses(INSIDE, pos_profile=OWN_PROFILE), [])

	def test_customer_outside_the_profile_groups_is_refused(self):
		for read in (
			customers_api.get_customer_info,
			customers_api.get_customer_addresses,
			customers_api.get_customer_loyalty_info,
		):
			with self.subTest(read.__name__), self.assertRaises(frappe.PermissionError):
				read(OUTSIDE, pos_profile=OWN_PROFILE)

	def test_customer_outside_the_profile_groups_cannot_be_changed(self):
		with self.assertRaises(frappe.PermissionError):
			customers_api.update_customer(OUTSIDE, {"mobile_no": "03001112222"}, pos_profile=OWN_PROFILE)
		frappe.set_user("Administrator")
		self.assertNotEqual(frappe.db.get_value("Customer", OUTSIDE, "mobile_no"), "03001112222")

	def test_credit_lookup_is_scoped_too(self):
		frappe.set_user("Administrator")
		frappe.db.set_value("POS Profile", OWN_PROFILE, "use_customer_credit", 1)
		frappe.set_user(CASHIER)
		with self.assertRaises(frappe.PermissionError):
			customers_api.get_customer_credit(OUTSIDE, pos_profile=OWN_PROFILE)

	def test_search_only_lists_customers_in_the_profile_groups(self):
		names = {row.name for row in customers_api.get_customers("_Test RA", pos_profile=OWN_PROFILE)}
		self.assertIn(INSIDE, names)
		self.assertNotIn(OUTSIDE, names)

	def test_search_through_someone_elses_profile_is_refused(self):
		with self.assertRaises(frappe.PermissionError):
			customers_api.get_customers("_Test RA", pos_profile=OTHER_PROFILE)

	def test_broad_customer_permission_does_not_lift_the_group_boundary(self):
		frappe.set_user(BROAD)
		self.assertTrue(frappe.has_permission("Customer", "read", doc=OUTSIDE))
		for read in (customers_api.get_customer_info, customers_api.get_customer_addresses):
			with self.subTest(read.__name__), self.assertRaises(frappe.PermissionError):
				read(OUTSIDE, pos_profile=OWN_PROFILE)
		self.assertEqual(customers_api.get_customer_info(INSIDE, pos_profile=OWN_PROFILE)["name"], INSIDE)

	def test_administrator_is_bound_by_the_profile_groups_too(self):
		frappe.set_user("Administrator")
		with self.assertRaises(frappe.PermissionError):
			customers_api.get_customer_info(OUTSIDE, pos_profile=OWN_PROFILE)

	def test_empty_group_list_is_unrestricted(self):
		self.assertEqual(customers_api.get_customer_info(OUTSIDE, pos_profile=EMPTY_PROFILE)["name"], OUTSIDE)

	def test_child_groups_are_inside_the_parent_group(self):
		self.assertEqual(customers_api.get_customer_info(NESTED, pos_profile=OWN_PROFILE)["name"], NESTED)

	def test_guest_and_non_pos_users_are_refused(self):
		for user in ("Guest", NO_ROLES):
			frappe.set_user(user)
			for read in (customers_api.get_customer_info, customers_api.get_customer_addresses):
				with self.subTest(user=user, read=read.__name__), self.assertRaises(frappe.PermissionError):
					read(INSIDE, pos_profile=OWN_PROFILE)

	def test_forged_profile_is_refused(self):
		with self.assertRaises((frappe.PermissionError, frappe.FrappeTypeError)):
			customers_api.get_customer_info(INSIDE, pos_profile={"customer_groups": []})
		with self.assertRaises(frappe.PermissionError):
			customers_api.get_customer_info(INSIDE, pos_profile=OTHER_PROFILE)

	def test_user_permission_on_customer_still_applies_inside_the_group(self):
		other = "_Test RA Second Inside"
		ensure_customer(other, ALLOWED_GROUP)
		restrict(CASHIER, "Customer", other)
		with self.assertRaises(frappe.PermissionError):
			customers_api.get_customer_info(INSIDE, pos_profile=OWN_PROFILE)
		self.assertEqual(customers_api.get_customer_info(other, pos_profile=OWN_PROFILE)["name"], other)

	def test_balance_covers_the_profile_company_only(self):
		frappe.set_user("Administrator")
		post_balance(INSIDE, "_Test Company", 111)
		post_balance(INSIDE, OTHER_COMPANY, 22222)
		frappe.set_user(CASHIER)
		info = customers_api.get_customer_info(INSIDE, pos_profile=OWN_PROFILE)
		self.assertEqual(info["balance"], 111)
		self.assertNotIn("22222", str(info))

	def test_denied_customer_response_leaks_nothing(self):
		frappe.db.set_value("Customer", OUTSIDE, "tax_id", "TAX-SECRET-77")
		with self.assertRaises(frappe.PermissionError) as raised:
			customers_api.get_customer_info(OUTSIDE, pos_profile=OWN_PROFILE)
		self.assertNotIn("TAX-SECRET-77", str(raised.exception))
		self.assertNotIn("0300", str(raised.exception))

	def test_reading_a_customer_does_not_allow_changing_it(self):
		for change in (
			lambda: customers_api.update_customer(
				INSIDE, {"mobile_no": "03009998888"}, pos_profile=OWN_PROFILE
			),
			lambda: customers_api.unenroll_customer_loyalty(INSIDE, pos_profile=OWN_PROFILE),
		):
			with self.assertRaises(frappe.PermissionError):
				change()
		frappe.set_user("Administrator")
		self.assertNotEqual(frappe.db.get_value("Customer", INSIDE, "mobile_no"), "03009998888")

	def test_a_cached_customer_is_not_served_to_another_user(self):
		customers_api.get_customer_info(INSIDE, pos_profile=OWN_PROFILE)
		frappe.set_user(OUTSIDER)
		with self.assertRaises(frappe.PermissionError):
			customers_api.get_customer_info(INSIDE, pos_profile=OWN_PROFILE)

	def test_addresses_honour_address_user_permissions(self):
		frappe.set_user("Administrator")
		addresses = []
		for title in ("RA Seen", "RA Hidden"):
			addresses.append(
				frappe.get_doc(
					{
						"doctype": "Address",
						"address_title": title,
						"address_line1": title + " Street",
						"city": "Karachi",
						"country": "Pakistan",
						"links": [{"link_doctype": "Customer", "link_name": INSIDE}],
					}
				).insert(ignore_permissions=True)
			)
		restrict(CASHIER, "Address", addresses[0].name)
		frappe.set_user(CASHIER)
		listed = customers_api.get_customer_addresses(INSIDE, pos_profile=OWN_PROFILE)
		self.assertEqual([row["name"] for row in listed], [addresses[0].name])
		info = customers_api.get_customer_info(INSIDE, pos_profile=OWN_PROFILE)
		self.assertNotIn("RA Hidden", str(info))


class TestInvoiceScope(RecordAccessTestCase):
	"""Invoice endpoints load only Sales or POS Invoices of the caller's own till profiles."""

	def test_own_profile_invoice_is_readable(self):
		self.assertEqual(invoices_api.get_invoice_details(self.own_draft.name)["name"], self.own_draft.name)

	def test_other_profile_invoice_is_refused(self):
		name = self.other_draft.name
		for read in (
			lambda: invoices_api.get_invoice_details(name),
			lambda: invoices_api.get_invoice_for_return(name),
			lambda: invoices_api.get_invoice_for_repeat(name),
		):
			with self.assertRaises(frappe.PermissionError):
				read()

	def test_other_profile_draft_cannot_be_deleted(self):
		for delete in (
			lambda: invoices_api.delete_draft_invoice(self.other_draft.name, "Sales Invoice"),
			lambda: invoices_api.discard_draft_invoice(self.other_draft.name, "Sales Invoice"),
		):
			with self.assertRaises(frappe.PermissionError):
				delete()
		self.assertTrue(frappe.db.exists("Sales Invoice", self.other_draft.name))

	def test_non_invoice_doctypes_are_refused(self):
		with self.assertRaises(frappe.PermissionError):
			invoices_api.get_invoice_details(INSIDE, doctype="Customer")
		with self.assertRaises(frappe.PermissionError):
			invoices_api.get_invoice_for_repeat(INSIDE, doctype="Customer")
		with self.assertRaises(frappe.PermissionError):
			invoices_api.discard_draft_invoice(INSIDE, doctype="Customer")
		self.assertTrue(frappe.db.exists("Customer", INSIDE))

	def test_desk_permission_still_reaches_any_invoice(self):
		frappe.set_user("Administrator")
		self.assertEqual(
			invoices_api.get_invoice_details(self.other_draft.name)["name"], self.other_draft.name
		)

	def test_arbitrary_doctypes_are_refused_before_loading(self):
		for doctype in ("Salary Slip", "User"):
			with self.subTest(doctype), self.assertRaises(frappe.PermissionError):
				invoices_api.get_invoice_details("Administrator", doctype=doctype)

	def test_missing_invoice_is_refused_like_a_forbidden_one(self):
		with self.assertRaises(frappe.PermissionError):
			invoices_api.get_invoice_details("ACC-SINV-DOES-NOT-EXIST", doctype="Sales Invoice")

	def test_guest_and_non_pos_users_are_refused(self):
		for user in ("Guest", NO_ROLES):
			frappe.set_user(user)
			with self.subTest(user), self.assertRaises(frappe.PermissionError):
				invoices_api.get_invoice_details(self.own_draft.name)

	def test_invoice_of_another_company_is_refused_on_the_profile_route(self):
		frappe.db.set_value("Sales Invoice", self.own_draft.name, "company", OTHER_COMPANY)
		with self.assertRaises(frappe.PermissionError):
			invoices_api.get_invoice_details(self.own_draft.name)

	def test_company_user_permission_beats_profile_membership(self):
		restrict(CASHIER, "Company", OTHER_COMPANY)
		with self.assertRaises(frappe.PermissionError):
			invoices_api.get_invoice_details(self.own_draft.name)

	def test_customer_user_permission_beats_profile_membership(self):
		restrict(CASHIER, "Customer", INSIDE)
		with self.assertRaises(frappe.PermissionError):
			invoices_api.get_invoice_details(self.own_draft.name)

	def test_denied_invoice_response_leaks_nothing(self):
		customer = frappe.db.get_value("Sales Invoice", self.other_draft.name, "customer")
		with self.assertRaises(frappe.PermissionError) as raised:
			invoices_api.get_invoice_details(self.other_draft.name)
		message = str(raised.exception)
		self.assertNotIn(customer, message)
		self.assertNotIn(str(self.other_draft.grand_total), message)

	def test_generic_permission_reaches_another_profiles_invoice(self):
		frappe.set_user(BROAD)
		self.assertEqual(
			invoices_api.get_invoice_details(self.other_draft.name)["name"], self.other_draft.name
		)

	def test_a_cached_invoice_is_not_served_to_another_user(self):
		invoices_api.get_invoice_details(self.own_draft.name)
		frappe.set_user(OUTSIDER)
		restrict(OUTSIDER, "Company", OTHER_COMPANY)
		with self.assertRaises(frappe.PermissionError):
			invoices_api.get_invoice_details(self.own_draft.name)


class TestLegacyEndpointScope(RecordAccessTestCase):
	"""The legacy `xpos.x_pos.api` endpoints apply the same checks."""

	def test_draft_invoice_doc_refuses_other_profiles_and_doctypes(self):
		from xpos.x_pos.api import invoices as legacy_invoices

		self.assertEqual(legacy_invoices.get_draft_invoice_doc(self.own_draft.name).name, self.own_draft.name)
		with self.assertRaises(frappe.PermissionError):
			legacy_invoices.get_draft_invoice_doc(self.other_draft.name)
		with self.assertRaises(frappe.PermissionError):
			legacy_invoices.get_draft_invoice_doc(CASHIER, doctype="User")

	def test_customer_endpoints_refuse_customers_outside_the_groups(self):
		from xpos.x_pos.api import customers as legacy_customers

		for call in (
			lambda: legacy_customers.get_customer_info(OUTSIDE),
			lambda: legacy_customers.get_customer_balance(OUTSIDE),
			lambda: legacy_customers.get_customer_addresses(OUTSIDE),
			lambda: legacy_customers.set_customer_info(OUTSIDE, "mobile_no", "03001112222"),
		):
			with self.assertRaises(frappe.PermissionError):
				call()
		self.assertEqual(legacy_customers.get_customer_info(INSIDE)["name"], INSIDE)

	def test_legacy_balance_covers_the_profile_company_only(self):
		from xpos.x_pos.api import customers as legacy_customers

		frappe.set_user("Administrator")
		post_balance(INSIDE, "_Test Company", 111)
		post_balance(INSIDE, OTHER_COMPANY, 22222)
		frappe.set_user(CASHIER)
		result = legacy_customers.get_customer_balance(INSIDE)
		self.assertEqual(result["balance"], 111)
		self.assertNotIn("22222", str(result))

	def test_legacy_broad_customer_permission_does_not_lift_the_group_boundary(self):
		from xpos.x_pos.api import customers as legacy_customers

		frappe.set_user(BROAD)
		for call in (
			lambda: legacy_customers.get_customer_info(OUTSIDE),
			lambda: legacy_customers.get_customer_addresses(OUTSIDE),
		):
			with self.assertRaises(frappe.PermissionError):
				call()

	def test_customer_list_uses_the_server_profile_not_the_request(self):
		from xpos.x_pos.api import customers as legacy_customers

		forged = frappe.as_json({"name": OWN_PROFILE, "customer_groups": []})
		names = {row.name for row in legacy_customers.get_customer_names(forged)}
		self.assertIn(INSIDE, names)
		self.assertNotIn(OUTSIDE, names)
		with self.assertRaises(frappe.PermissionError):
			legacy_customers.get_customers_count(frappe.as_json({"name": OTHER_PROFILE}))

	def test_update_invoice_cannot_create_other_doctypes_or_edit_other_profiles(self):
		from xpos.x_pos.api.invoice_processing.creation import update_invoice

		with self.assertRaises(frappe.PermissionError):
			update_invoice(frappe.as_json({"name": self.other_draft.name, "remarks": "changed"}))
		frappe.set_user("Administrator")
		self.assertNotEqual(frappe.db.get_value("Sales Invoice", self.other_draft.name, "remarks"), "changed")
		frappe.set_user(CASHIER)
		with self.assertRaises(frappe.PermissionError):
			update_invoice(
				frappe.as_json(
					{"doctype": "User", "email": "forged@example.com", "pos_profile": OTHER_PROFILE}
				)
			)
		self.assertFalse(frappe.db.exists("User", "forged@example.com"))
