# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt


import json

import frappe
from erpnext.accounts.doctype.loyalty_program.loyalty_program import (
	get_loyalty_program_details_with_points,
)
from frappe import _
from frappe.utils import cstr, flt, get_datetime
from frappe.utils.caching import redis_cache

from xpos.api.customers import require_customer_access, user_may_see_address
from xpos.api.profiles import resolve_pos_profile

from .utils import fetch_sales_person_names


def get_customer_groups(pos_profile: dict) -> list:
	customer_groups = []
	if pos_profile.get("customer_groups"):
		for data in pos_profile.get("customer_groups"):
			group_name = data.get("customer_group") if data else None
			if not group_name:
				continue
			customer_groups.extend([d.get("name") for d in get_child_nodes("Customer Group", group_name)])

	return list(set(customer_groups))


def get_child_nodes(group_type: str, root: str) -> list:
	if not root:
		return []
	result = frappe.db.get_value(group_type, root, ["lft", "rgt"])
	if not result:
		return []
	lft, rgt = result
	return frappe.get_all(
		group_type,
		filters={"lft": [">=", lft], "rgt": ["<=", rgt]},
		fields=["name", "lft", "rgt"],
		order_by="lft",
	)


def get_customer_group_condition(pos_profile: dict) -> str:
	cond = "disabled = 0"
	customer_groups = get_customer_groups(pos_profile)
	if customer_groups:
		escaped_groups = [frappe.db.escape(g) for g in customer_groups]
		cond = " customer_group in ({})".format(", ".join(escaped_groups))

	return cond


def server_pos_profile(pos_profile: str) -> str:
	"""The caller's own POS Profile as JSON, so its customer groups come from the server, not the request."""
	name = (json.loads(pos_profile) or {}).get("name") if pos_profile else None
	return frappe.as_json(resolve_pos_profile(name).as_dict())


@frappe.whitelist()
def get_customer_balance(customer: str) -> dict:
	if not customer:
		return {"balance": 0, "customer_name": None}

	pos = require_customer_access(customer)

	try:
		customer_doc = frappe.get_doc("Customer", customer)
		customer_name = customer_doc.customer_name

		balance = frappe.db.sql(
			"""
            SELECT SUM(debit - credit) AS balance
            FROM `tabGL Entry`
            WHERE party_type = 'Customer' AND party = %(customer)s AND company = %(company)s
                AND docstatus = 1
        """,
			{"customer": customer, "company": pos.company},
			as_dict=True,
		)

		return {
			"balance": flt(balance[0].get("balance", 0)) if balance else 0,
			"customer_name": customer_name,
		}
	except Exception as e:
		frappe.log_error(f"Error fetching customer balance: {e}")
		return {"balance": 0, "customer_name": None}


@frappe.whitelist()
def get_customer_names(
	pos_profile: str,
	limit: int | None = None,
	offset: int | None = None,
	start_after: str | None = None,
	modified_after: str | None = None,
) -> list:
	pos_profile = server_pos_profile(pos_profile)
	_pos_profile = json.loads(pos_profile)
	ttl = _pos_profile.get("server_cache_duration")
	if ttl:
		ttl = int(ttl) * 60

	@redis_cache(ttl=ttl or 1800)
	def __get_customer_names(
		pos_profile: str,
		limit: int | None = None,
		offset: int | None = None,
		start_after: str | None = None,
		modified_after: str | None = None,
	) -> list:
		return _get_customer_names(pos_profile, limit, offset, start_after, modified_after)

	def _get_customer_names(
		pos_profile: str,
		limit: int | None = None,
		offset: int | None = None,
		start_after: str | None = None,
		modified_after: str | None = None,
	) -> list:
		pos_profile = json.loads(pos_profile)
		filters = {"disabled": 0}

		customer_groups = get_customer_groups(pos_profile)
		if customer_groups:
			filters["customer_group"] = ["in", customer_groups]

		if modified_after:
			try:
				parsed_modified_after = get_datetime(modified_after)
			except Exception:
				frappe.throw(_("modified_after must be a valid ISO datetime"))
			filters["modified"] = [">", parsed_modified_after.isoformat()]

		if start_after:
			filters["name"] = [">", start_after]

		customers = frappe.get_all(
			"Customer",
			filters=filters,
			fields=[
				"name",
				"mobile_no",
				"email_id",
				"tax_id",
				"customer_name",
				"primary_address",
			],
			order_by="name",
			limit_start=None if start_after else offset,
			limit_page_length=limit,
		)
		return customers

	if _pos_profile.get("use_server_cache") and not (limit or offset or start_after or modified_after):
		return __get_customer_names(pos_profile, limit, offset, start_after, modified_after)
	else:
		return _get_customer_names(pos_profile, limit, offset, start_after, modified_after)


@frappe.whitelist()
def get_customers_count(pos_profile: str) -> int:
	pos_profile = json.loads(server_pos_profile(pos_profile))
	filters = {"disabled": 0}
	customer_groups = get_customer_groups(pos_profile)
	if customer_groups:
		filters["customer_group"] = ["in", customer_groups]
	return frappe.db.count("Customer", filters)


@frappe.whitelist()
def get_customer_info(customer: str | None = None) -> dict:
	customer = cstr(customer or "").strip()
	if not customer:
		return {}

	pos = require_customer_access(customer)
	customer = frappe.get_doc("Customer", customer)

	res = {"loyalty_points": None, "conversion_factor": None}

	res["email_id"] = customer.email_id
	res["mobile_no"] = customer.mobile_no
	res["image"] = customer.image
	res["loyalty_program"] = customer.loyalty_program
	res["customer_price_list"] = customer.default_price_list
	res["customer_group"] = customer.customer_group
	res["customer_type"] = customer.customer_type
	res["territory"] = customer.territory
	res["birthday"] = customer.birthday
	res["gender"] = customer.gender
	res["tax_id"] = customer.tax_id
	res["discount"] = flt(customer.get("discount"))
	res["name"] = customer.name
	res["customer_name"] = customer.customer_name
	res["customer_group_price_list"] = frappe.get_value(
		"Customer Group", customer.customer_group, "default_price_list"
	)

	effective_price_list = res.get("customer_price_list") or res.get("customer_group_price_list")
	if effective_price_list:
		res["price_list_currency"] = frappe.get_value("Price List", effective_price_list, "currency")
	else:
		res["price_list_currency"] = None

	if customer.loyalty_program:
		lp_details = get_loyalty_program_details_with_points(
			customer.name,
			customer.loyalty_program,
			company=pos.company,
			silent=True,
			include_expired_entry=False,
		)
		res["loyalty_points"] = lp_details.get("loyalty_points")
		res["conversion_factor"] = lp_details.get("conversion_factor")

	addresses = frappe.db.sql(
		"""
	SELECT
	    address.name as address_name,
	    address.address_line1,
	    address.address_line2,
	    address.city,
	    address.state,
	    address.country,
	    address.address_type
	FROM `tabAddress` address
	INNER JOIN `tabDynamic Link` link
	    ON (address.name = link.parent)
	WHERE
	    link.link_doctype = 'Customer'
	    AND link.link_name = %(customer_name)s
	    AND address.disabled = 0
	    AND address.address_type = 'Shipping'
	ORDER BY address.creation DESC
	LIMIT 1
	""",
		{"customer_name": customer.name},
		as_dict=True,
	)

	addresses = [row for row in addresses if user_may_see_address(row.address_name)]
	if addresses:
		addr = addresses[0]
		res["address_line1"] = addr.address_line1 or ""
		res["address_line2"] = addr.address_line2 or ""
		res["city"] = addr.city or ""
		res["state"] = addr.state or ""
		res["country"] = addr.country or ""

	return res


@frappe.whitelist()
def create_customer(
	customer_name: str,
	company: str,
	pos_profile_doc: str,
	customer_id: str | None = None,
	tax_id: str | None = None,
	mobile_no: str | None = None,
	email_id: str | None = None,
	referral_code: str | None = None,
	birthday: str | None = None,
	customer_group: str | None = None,
	territory: str | None = None,
	customer_type: str | None = None,
	gender: str | None = None,
	method: str = "create",
	address_line1: str | None = None,
	city: str | None = None,
	country: str | None = None,
):
	pos_profile = json.loads(pos_profile_doc)

	formatted_birthday = None
	if birthday:
		try:
			if "-" in birthday:
				date_parts = birthday.split("-")
				if len(date_parts) == 3:
					day, month, year = date_parts
					formatted_birthday = f"{year}-{month.zfill(2)}-{day.zfill(2)}"
			elif len(birthday) == 10 and birthday[4] == "-" and birthday[7] == "-":
				formatted_birthday = birthday
		except Exception:
			frappe.log_error(f"Error formatting birthday: {birthday}", "XPOS")

	if method == "create":
		is_exist = frappe.db.exists("Customer", {"customer_name": customer_name})
		if pos_profile.get("allow_duplicate_customer_names") or not is_exist:
			customer = frappe.get_doc(
				{
					"doctype": "Customer",
					"customer_name": customer_name,
					"referral_company": company,
					"tax_id": tax_id,
					"mobile_no": mobile_no,
					"email_id": email_id,
					"referral_code": referral_code,
					"birthday": formatted_birthday,
					"customer_type": customer_type,
					"gender": gender,
				}
			)
			if customer_group:
				customer.customer_group = customer_group
			else:
				customer.customer_group = "All Customer Groups"
			if territory:
				customer.territory = territory
			else:
				customer.territory = "All Territories"

			customer.save()

			if address_line1 or city:
				args = {
					"name": f"{customer.customer_name} - Shipping",
					"doctype": "Customer",
					"customer": customer.name,
					"address_line1": address_line1 or "",
					"address_line2": "",
					"city": city or "",
					"state": "",
					"pincode": "",
					"country": country or "",
				}
				make_address(json.dumps(args))

			return customer
		else:
			frappe.throw(_("Customer already exists"))

	elif method == "update":
		customer_doc = frappe.get_doc("Customer", customer_id)
		customer_doc.customer_name = customer_name
		customer_doc.tax_id = tax_id
		customer_doc.mobile_no = mobile_no
		customer_doc.email_id = email_id
		customer_doc.referral_code = referral_code
		customer_doc.birthday = formatted_birthday
		customer_doc.customer_type = customer_type
		customer_doc.gender = gender
		customer_doc.save()

		if mobile_no:
			set_customer_info(customer_doc.name, "mobile_no", mobile_no)
		if email_id:
			set_customer_info(customer_doc.name, "email_id", email_id)

		existing_address_name = frappe.db.get_value(
			"Dynamic Link",
			{
				"link_doctype": "Customer",
				"link_name": customer_id,
				"parenttype": "Address",
			},
			"parent",
		)

		if existing_address_name:
			address_doc = frappe.get_doc("Address", existing_address_name)
			address_doc.address_line1 = address_line1 or ""
			address_doc.city = city or ""
			address_doc.country = country or ""
			address_doc.save()
		else:
			if address_line1 or city:
				args = {
					"name": f"{customer_doc.customer_name} - Shipping",
					"doctype": "Customer",
					"customer": customer_doc.name,
					"address_line1": address_line1 or "",
					"address_line2": "",
					"city": city or "",
					"state": "",
					"pincode": "",
					"country": country or "",
				}
				make_address(json.dumps(args))

		return customer_doc


@frappe.whitelist()
def set_customer_info(customer: str, fieldname: str, value: str | None = None):
	require_customer_access(customer, "write")
	if fieldname == "loyalty_program":
		frappe.db.set_value("Customer", customer, "loyalty_program", value)

	contact = frappe.get_cached_value("Customer", customer, "customer_primary_contact") or ""

	if contact:
		contact_doc = frappe.get_doc("Contact", contact)
		if fieldname == "email_id":
			contact_doc.set("email_ids", [{"email_id": value, "is_primary": 1}])
			frappe.db.set_value("Customer", customer, "email_id", value)
		elif fieldname == "mobile_no":
			contact_doc.set("phone_nos", [{"phone": value, "is_primary_mobile_no": 1}])
			frappe.db.set_value("Customer", customer, "mobile_no", value)
		contact_doc.save()

	else:
		contact_doc = frappe.new_doc("Contact")
		contact_doc.first_name = customer
		contact_doc.is_primary_contact = 1
		contact_doc.is_billing_contact = 1
		if fieldname == "mobile_no":
			contact_doc.add_phone(value, is_primary_mobile_no=1, is_primary_phone=1)

		if fieldname == "email_id":
			contact_doc.add_email(value, is_primary=1)

		contact_doc.append("links", {"link_doctype": "Customer", "link_name": customer})

		contact_doc.flags.ignore_mandatory = True
		contact_doc.save()
		frappe.set_value("Customer", customer, "customer_primary_contact", contact_doc.name)


@frappe.whitelist()
def get_customer_addresses(customer: str) -> list:
	require_customer_access(customer)
	addresses = frappe.db.sql(
		"""
        SELECT
            address.name,
            address.address_line1,
            address.address_line2,
            address.address_title,
            address.city,
            address.state,
            address.country,
            address.address_type
        FROM `tabAddress` as address
        INNER JOIN `tabDynamic Link` AS link
                                ON address.name = link.parent
        WHERE link.link_doctype = 'Customer'
            AND link.link_name = %(customer)s
            AND address.disabled = 0
        ORDER BY address.name
        """,
		{"customer": customer},
		as_dict=1,
	)
	return [row for row in addresses if user_may_see_address(row.name)]


@frappe.whitelist()
def make_address(*args: str) -> dict:
	address = frappe.get_doc(
		{
			"doctype": "Address",
			"address_title": args.get("name"),
			"address_line1": args.get("address_line1"),
			"address_line2": args.get("address_line2"),
			"city": args.get("city"),
			"state": args.get("state"),
			"pincode": args.get("pincode"),
			"country": args.get("country"),
			"address_type": "Shipping",
			"links": [{"link_doctype": args.get("doctype"), "link_name": args.get("customer")}],
		}
	).insert()

	return address


@frappe.whitelist()
def get_sales_person_names() -> list:
	return fetch_sales_person_names()
