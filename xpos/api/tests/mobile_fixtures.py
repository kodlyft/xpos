# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""The shop the XPOS Mobile tests sell in: customers on two price lists, quantity and promotion rules, units of
measure, a gift card setup and users with different rights. ``build_live_site`` makes it permanent for a
connected run of the app against a real server (``mobile/tests/live``)."""

import frappe
from erpnext.accounts.doctype.pos_profile.test_pos_profile import make_pos_profile

from xpos.x_pos.gift_cards import SETTINGS

COMPANY = "_Test Company"
PROFILE = "MP Profile"
STANDARD = "MP Standard"
WHOLESALE = "MP Wholesale"
CASHIER = "mp-cashier@example.com"
MANAGER = "mp-manager@example.com"
RETAIL = "MP Retail Cust"
WHOLE = "MP Wholesale Cust"
WALKIN = "MP Walk-in"
WIDGET = "MP-WIDGET"
GADGET = "MP-GADGET"
CASE = "MP-CASE"
GIFT_ITEM = "MP Gift Card Item"
GIFT_MODE = "MP Gift Card"
LIABILITY = "MP Gift Liability - _TC"


def ensure(doctype, name, values):
	if not frappe.db.exists(doctype, name):
		frappe.get_doc({"doctype": doctype, **values}).insert(ignore_permissions=True)


def ensure_user(email, roles):
	ensure(
		"User",
		email,
		{
			"email": email,
			"first_name": email.split("@")[0],
			"send_welcome_email": 0,
			"roles": [{"role": r} for r in roles],
		},
	)


def price(item, price_list, rate, **extra):
	key = {"item_code": item, "price_list": price_list, "uom": extra.get("uom") or "Nos"}
	if not frappe.db.exists("Item Price", key):
		frappe.get_doc(
			{
				"doctype": "Item Price",
				"item_code": item,
				"price_list": price_list,
				"price_list_rate": rate,
				"currency": "INR",
				**extra,
			}
		).insert(ignore_permissions=True)


def setup_fixtures():
	for group in ("MP Retail", "MP Wholesale"):
		ensure(
			"Customer Group",
			group,
			{"customer_group_name": group, "parent_customer_group": "All Customer Groups"},
		)
	for name in (STANDARD, WHOLESALE):
		ensure("Price List", name, {"price_list_name": name, "currency": "INR", "selling": 1, "enabled": 1})
	for uom in ("Nos", "Box"):
		ensure("UOM", uom, {"uom_name": uom})

	for code in (WIDGET, GADGET, CASE, GIFT_ITEM):
		ensure(
			"Item",
			code,
			{
				"item_code": code,
				"item_name": code,
				"item_group": "All Item Groups",
				"stock_uom": "Nos",
				"is_stock_item": 0,
				"is_sales_item": 1,
			},
		)
	case = frappe.get_doc("Item", CASE)
	if not case.get("uoms") or not any(u.uom == "Box" for u in case.uoms):
		case.append("uoms", {"uom": "Box", "conversion_factor": 12})
	if not case.barcodes:
		case.append("barcodes", {"barcode": "MP-CASE-BOX", "uom": "Box"})
	case.save(ignore_permissions=True)

	price(WIDGET, STANDARD, 100)
	price(WIDGET, WHOLESALE, 80)
	price(GADGET, STANDARD, 200)
	price(GADGET, WHOLESALE, 150)
	price(CASE, STANDARD, 10)
	price(CASE, STANDARD, 115, uom="Box")

	ensure(
		"Pricing Rule",
		"MP Widget 10+",
		{
			"title": "MP Widget 10+",
			"apply_on": "Item Code",
			"items": [{"item_code": WIDGET}],
			"price_or_product_discount": "Price",
			"rate_or_discount": "Rate",
			"rate": 90,
			"min_qty": 10,
			"selling": 1,
			"company": COMPANY,
			"currency": "INR",
			"for_price_list": STANDARD,
		},
	)
	ensure(
		"Pricing Rule",
		"MP Gadget 3+",
		{
			"title": "MP Gadget 3+",
			"apply_on": "Item Code",
			"items": [{"item_code": GADGET}],
			"price_or_product_discount": "Price",
			"rate_or_discount": "Discount Percentage",
			"discount_percentage": 10,
			"min_qty": 3,
			"selling": 1,
			"company": COMPANY,
			"currency": "INR",
		},
	)

	ensure_user(CASHIER, ["Sales User", "Accounts User", "Stock User"])
	ensure_user(MANAGER, ["Sales User", "Sales Manager", "Accounts User", "Accounts Manager", "Stock User"])

	for name, group, extra in (
		(WALKIN, "MP Retail", {}),
		(RETAIL, "MP Retail", {}),
		(WHOLE, "MP Wholesale", {"default_price_list": WHOLESALE, "discount": 5}),
	):
		ensure(
			"Customer",
			name,
			{
				"customer_name": name,
				"customer_group": group,
				"territory": "All Territories",
				"customer_type": "Individual",
				"mobile_no": f"0300{abs(hash(name)) % 10**7:07d}",
				**extra,
			},
		)

	pos = make_pos_profile(name=PROFILE, selling_price_list=STANDARD, do_not_insert=1)
	if not frappe.db.exists("POS Profile", PROFILE):
		pos.customer = WALKIN
		pos.force_price_from_customer_price_list = 1
		pos.apply_customer_discount = 1
		pos.max_discount_percentage_allowed = 10
		pos.allow_return = 1
		pos.append("applicable_for_users", {"user": CASHIER, "default": 1, "pos_role": "Cashier"})
		pos.append("applicable_for_users", {"user": MANAGER, "pos_role": "Manager"})
		pos.append("applicable_for_users", {"user": "Administrator", "pos_role": "Administrator"})
		pos.insert(ignore_permissions=True)
	frappe.db.set_single_value("POS Settings", "invoice_type", "Sales Invoice")
	frappe.clear_cache()


def setup_gift_cards():
	ensure(
		"Account",
		LIABILITY,
		{
			"account_name": "MP Gift Liability",
			"parent_account": "Current Liabilities - _TC",
			"account_type": "Bank",
			"company": COMPANY,
		},
	)
	ensure(
		"Mode of Payment",
		GIFT_MODE,
		{
			"mode_of_payment": GIFT_MODE,
			"type": "General",
			"accounts": [{"company": COMPANY, "default_account": LIABILITY}],
		},
	)
	settings = frappe.get_single(SETTINGS)
	settings.set(
		"companies",
		[
			{
				"company": COMPANY,
				"liability_account": LIABILITY,
				"mode_of_payment": GIFT_MODE,
				"issue_item": GIFT_ITEM,
				"min_amount": 1,
				"max_amount": 1000,
			}
		],
	)
	settings.save(ignore_permissions=True)
	pos = frappe.get_doc("POS Profile", PROFILE)
	pos.xpos_enable_gift_cards = 1
	if not any(p.mode_of_payment == GIFT_MODE for p in pos.payments):
		pos.append("payments", {"mode_of_payment": GIFT_MODE})
	pos.save(ignore_permissions=True)


RESTRICTED = "mp-restricted@example.com"
PASSWORD = "mp-pass-123"


def build_live_site():
	"""Everything a connected run needs, committed: fixtures, gift cards, passwords and one user limited to one customer."""
	from frappe.utils.password import update_password

	setup_fixtures()
	setup_gift_cards()
	ensure_user(RESTRICTED, ["Sales User", "Accounts User", "Stock User"])
	pos = frappe.get_doc("POS Profile", PROFILE)
	if not any(u.user == RESTRICTED for u in pos.applicable_for_users):
		pos.append("applicable_for_users", {"user": RESTRICTED, "pos_role": "Cashier"})
		pos.save(ignore_permissions=True)
	if not frappe.db.exists(
		"User Permission", {"user": RESTRICTED, "allow": "Customer", "for_value": RETAIL}
	):
		frappe.get_doc(
			{"doctype": "User Permission", "user": RESTRICTED, "allow": "Customer", "for_value": RETAIL}
		).insert(ignore_permissions=True)
	for user in (CASHIER, MANAGER, RESTRICTED, "mp-stranger@example.com"):
		ensure_user(user, ["Sales User", "Stock User"])
		update_password(user, PASSWORD)
