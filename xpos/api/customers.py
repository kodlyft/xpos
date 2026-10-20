# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

import json

import frappe
from frappe import _
from frappe.utils import cint, flt

from xpos.api.profile_rules import resolve_selling_price_list
from xpos.api.profiles import resolve_pos_profile
from xpos.utils import read_latest_on_lock, row_value


def allowed_customer_groups(pos) -> list[str]:
	"""Customer groups, with their children, a POS Profile is limited to. Empty means no limit."""
	groups = set()
	for row in pos.get("customer_groups") or []:
		groups.update(_get_child_groups("Customer Group", row_value(row, "customer_group")))
	return sorted(groups)


def require_customer_access(customer: str, ptype: str = "read", pos_profile: str | None = None) -> None:
	"""Allow a customer the caller holds `ptype` on, or one inside their POS Profile's customer groups."""
	if not customer or not frappe.db.exists("Customer", customer):
		frappe.throw(_("Customer {0} not found").format(customer), frappe.DoesNotExistError)
	if frappe.has_permission("Customer", ptype, doc=customer):
		return
	allowed = allowed_customer_groups(resolve_pos_profile(pos_profile))
	if allowed and frappe.db.get_value("Customer", customer, "customer_group") not in allowed:
		frappe.throw(
			_("You are not permitted to access customer {0}.").format(customer), frappe.PermissionError
		)


@frappe.whitelist()
def get_customers(search_term: str = "", limit: int = 20, pos_profile: str | None = None):
	"""Search customers by name, mobile, email, or tax ID within the POS Profile's customer groups."""
	pos = resolve_pos_profile(pos_profile)
	conditions = "c.disabled = 0"
	values = {"limit": cint(limit)}

	allowed_groups = allowed_customer_groups(pos)
	if allowed_groups:
		values.update({f"grp_{i}": group for i, group in enumerate(allowed_groups)})
		in_clause = ", ".join(f"%(grp_{i})s" for i in range(len(allowed_groups)))
		conditions += f" AND c.customer_group IN ({in_clause})"

	if search_term:
		search_term = search_term.strip()
		conditions += """ AND (
			c.name LIKE %(search)s
			OR c.customer_name LIKE %(search)s
			OR c.mobile_no LIKE %(search)s
			OR c.email_id LIKE %(search)s
			OR c.tax_id LIKE %(search)s
		)"""
		values["search"] = f"%{search_term}%"

	customers = frappe.db.sql(  # nosemgrep: frappe-sql-format-injection - conditions built from validated allowed-field lists, values parameterized
		f"""
		SELECT
			c.name,
			c.customer_name,
			c.mobile_no,
			c.email_id,
			c.customer_group,
			c.territory,
			c.default_currency,
			c.image,
			c.tax_id,
			c.customer_type,
			c.gender,
			c.discount
		FROM `tabCustomer` c
		WHERE {conditions}
		ORDER BY c.customer_name ASC
		LIMIT %(limit)s
		""",
		values,
		as_dict=True,
	)

	if customers:
		set_pos_price_lists(customers, pos.name)

	return customers


def set_pos_price_lists(customers: list, pos_profile: str) -> None:
	"""Attach the price list each customer's sale lines resolve to, so offline carts know it."""
	pos = frappe.get_cached_doc("POS Profile", pos_profile)
	for customer in customers:
		customer["pos_price_list"] = resolve_selling_price_list(pos, customer.name)


@frappe.whitelist()
def get_customer_info(customer: str, pos_profile: str | None = None):
	"""
	Get detailed customer information including loyalty, addresses, balance, credit, and discount.
	"""
	if not customer:
		return None

	require_customer_access(customer, pos_profile=pos_profile)

	cust = frappe.get_cached_doc("Customer", customer)
	balance = get_customer_balance(customer)
	loyalty = get_loyalty_points(customer)

	addresses = frappe.get_all(
		"Dynamic Link",
		filters={
			"link_doctype": "Customer",
			"link_name": customer,
			"parenttype": "Address",
		},
		fields=["parent"],
	)
	address_names = [row_value(addr, "parent") for addr in addresses if row_value(addr, "parent")]
	address_list = []
	if address_names:
		address_docs = frappe.get_all(
			"Address",
			filters={"name": ["in", address_names]},
			fields=[
				"name",
				"address_title",
				"address_line1",
				"address_line2",
				"city",
				"state",
				"country",
				"pincode",
				"phone",
				"is_primary_address",
				"is_shipping_address",
			],
		)
		for a in address_docs:
			address_list.append(
				{
					"name": a.name,
					"address_title": a.address_title,
					"address_line1": a.address_line1,
					"address_line2": a.address_line2,
					"city": a.city,
					"state": a.state,
					"country": a.country,
					"pincode": a.pincode,
					"phone": a.phone,
					"is_primary_address": a.is_primary_address,
					"is_shipping_address": a.get("is_shipping_address", 0),
				}
			)

	pos_discount = flt(getattr(cust, "discount", 0))

	default_price_list = cust.default_price_list

	loyalty_program = None
	loyalty_program_name = cust.loyalty_program
	if loyalty_program_name:
		try:
			from erpnext.accounts.doctype.loyalty_program.loyalty_program import (
				get_loyalty_program_details_with_points,
			)

			lp_details = get_loyalty_program_details_with_points(customer, loyalty_program_name)
			loyalty_program = {
				"name": loyalty_program_name,
				"loyalty_points": (lp_details.get("loyalty_points", 0) if lp_details else 0),
				"conversion_factor": (lp_details.get("conversion_factor", 0) if lp_details else 0),
			}
		except Exception:
			loyalty_program = {
				"name": loyalty_program_name,
				"loyalty_points": loyalty,
				"conversion_factor": 0,
			}

	referral_code = getattr(cust, "referral_code", None)
	birthday = getattr(cust, "birthday", None)

	credit_limit = 0
	from erpnext.selling.doctype.customer.customer import get_credit_limit

	credit_limit = flt(get_credit_limit(customer, frappe.defaults.get_user_default("Company")))

	return {
		"name": cust.name,
		"customer_name": cust.customer_name,
		"mobile_no": cust.mobile_no,
		"email_id": cust.email_id,
		"customer_group": cust.customer_group,
		"territory": cust.territory,
		"default_currency": cust.default_currency,
		"default_price_list": default_price_list,
		"image": cust.image,
		"tax_id": cust.tax_id,
		"customer_type": cust.customer_type,
		"gender": getattr(cust, "gender", None),
		"balance": balance,
		"credit_limit": credit_limit,
		"loyalty_points": loyalty,
		"loyalty_program": loyalty_program,
		"discount": pos_discount,
		"referral_code": referral_code,
		"birthday": birthday,
		"addresses": address_list,
	}


@frappe.whitelist()
def create_customer(
	customer_name: str,
	mobile_no: str = "",
	email_id: str = "",
	customer_group: str = None,
	territory: str = None,
	customer_type: str = "Individual",
	gender: str = None,
	tax_id: str = None,
	referral_code: str = None,
	birthday: str = None,
	company: str = None,
	pos_profile: str = None,
	address_line1: str = None,
	city: str = None,
	country: str = None,
):
	"""
	Create a new customer with optional address.
	"""
	if not customer_name:
		frappe.throw(_("Customer name is required"))

	if not customer_group:
		customer_group = (
			frappe.db.get_single_value("Selling Settings", "customer_group") or "All Customer Groups"
		)

	if not territory:
		territory = frappe.db.get_single_value("Selling Settings", "territory") or "All Territories"

	customer = frappe.get_doc(
		{
			"doctype": "Customer",
			"customer_name": customer_name,
			"customer_type": customer_type or "Individual",
			"customer_group": customer_group,
			"territory": territory,
			"mobile_no": mobile_no,
			"email_id": email_id,
		}
	)

	if tax_id:
		customer.tax_id = tax_id
	if gender:
		customer.gender = gender
	if referral_code:
		try:
			customer.referral_code = referral_code
		except Exception:
			pass
	if birthday:
		try:
			customer.birthday = birthday
		except Exception:
			pass
	if company:
		customer.company = company

	customer.insert(ignore_permissions=True)
	referral = create_pos_referral_code(customer.name, pos_profile)

	if address_line1 and city:
		make_address(
			{
				"customer": customer.name,
				"address_line1": address_line1,
				"city": city,
				"country": country or frappe.db.get_single_value("Global Defaults", "country"),
				"is_primary_address": 1,
			}
		)

	return {
		"name": customer.name,
		"customer_name": customer.customer_name,
		"mobile_no": customer.mobile_no,
		"email_id": customer.email_id,
		"customer_group": customer.customer_group,
		"territory": customer.territory,
		**referral,
	}


def create_pos_referral_code(customer: str, pos_profile: str | None = None) -> dict:
	"""``auto_create_referral_for_new_customers``: a Referral Code for a customer XPOS just created.

	The profile is the one the till sent, checked against the caller's access and
	open shift; without it, the caller's only open shift. Missing or invalid
	referral setup is reported in ``referral_note`` and nothing is invented.
	Re-running for the same customer and company never creates a second code.
	"""
	user = frappe.session.user
	open_profiles = frappe.get_all(
		"POS Opening Shift",
		filters={"user": user, "status": "Open", "docstatus": 1},
		pluck="pos_profile",
		distinct=True,
	)
	if pos_profile:
		profile = resolve_pos_profile(pos_profile)
		if profile.name not in open_profiles:
			return {}
	elif len(open_profiles) == 1:
		profile = frappe.get_cached_doc("POS Profile", open_profiles[0])
	else:
		return {}
	if not cint(profile.get("auto_create_referral_for_new_customers")):
		return {}

	company = frappe.get_cached_doc("Company", profile.company)
	problem = referral_setup_problem(company)
	if problem:
		return {"referral_note": _("No referral code was created: {0}").format(problem)}

	# Serialise concurrent retries for this customer before checking for an existing code.
	read_latest_on_lock()
	frappe.db.get_value("Customer", customer, "name", for_update=True)
	existing = frappe.db.get_value(
		"Referral Code", {"customer": customer, "company": company.name}, "referral_code"
	)
	if existing:
		return {"referral_code": existing}

	from xpos.x_pos.doctype.referral_code.referral_code import create_referral_code

	primary_offer = company.get("primary_customer_offer")
	if primary_offer and not frappe.db.exists("DocType", "XPOS Offer"):
		primary_offer = None  # the field links to a DocType this app does not ship
	try:
		doc = create_referral_code(
			company.name,
			customer,
			company.final_customer_offer,
			primary_offer,
			company.get("referral_campaign"),
		)
	except (frappe.UniqueValidationError, frappe.DuplicateEntryError):
		# Another request created it first (unique customer + company).
		existing = frappe.db.get_value(
			"Referral Code", {"customer": customer, "company": company.name}, "referral_code"
		)
		if not existing:
			raise
		return {"referral_code": existing}
	return {"referral_code": doc.referral_code}


def referral_setup_problem(company) -> str | None:
	"""Why ``company`` cannot issue referral codes, or None when its setup is usable."""
	from xpos.x_pos.doctype.referral_code.referral_code import has_customer_company_unique

	if not has_customer_company_unique():
		return _(
			"some customers have more than one Referral Code. An administrator must resolve the "
			"duplicates (see xpos.api.profile_preflight.print_report) and run bench migrate."
		)
	offer = company.get("final_customer_offer")
	if not offer:
		return _("set a Final Customer Offer on company {0}.").format(company.name)
	row = frappe.db.get_value("POS Offer", offer, ["disabled", "company"], as_dict=True)
	if not row:
		return _("the Final Customer Offer {0} of company {1} does not exist.").format(offer, company.name)
	if row.disabled:
		return _("the Final Customer Offer {0} is disabled.").format(offer)
	if row.company and row.company != company.name:
		return _("the Final Customer Offer {0} belongs to company {1}.").format(offer, row.company)
	campaign = company.get("referral_campaign")
	if campaign and not frappe.db.exists("Campaign", campaign):
		return _("the referral Campaign {0} does not exist.").format(campaign)
	return None


@frappe.whitelist()
def update_customer(customer: str, data: str | dict, pos_profile: str | None = None):
	"""
	Update an existing customer.
	"""
	if isinstance(data, str):
		data = json.loads(data)

	require_customer_access(customer, "write", pos_profile)
	doc = frappe.get_doc("Customer", customer)

	updatable_fields = [
		"customer_name",
		"mobile_no",
		"email_id",
		"customer_group",
		"territory",
		"customer_type",
		"gender",
		"tax_id",
	]

	for field in updatable_fields:
		if field in data:
			doc.set(field, data[field])

	pos_fields = ["referral_code", "birthday", "discount"]
	for field in pos_fields:
		if field in data:
			try:
				doc.set(field, data[field])
			except Exception:
				pass

	doc.save(ignore_permissions=True)

	return {
		"name": doc.name,
		"customer_name": doc.customer_name,
		"mobile_no": doc.mobile_no,
		"email_id": doc.email_id,
	}


@frappe.whitelist()
def get_customer_addresses(customer: str, pos_profile: str | None = None):
	"""
	List all addresses for a customer.
	"""
	if not customer:
		return []

	require_customer_access(customer, pos_profile=pos_profile)

	links = frappe.get_all(
		"Dynamic Link",
		filters={
			"link_doctype": "Customer",
			"link_name": customer,
			"parenttype": "Address",
		},
		fields=["parent"],
	)

	address_names = [link.parent for link in links if link.parent]
	if not address_names:
		return []

	address_docs = frappe.get_all(
		"Address",
		filters={"name": ["in", address_names]},
		fields=[
			"name",
			"address_title",
			"address_line1",
			"address_line2",
			"city",
			"state",
			"country",
			"pincode",
			"phone",
			"is_primary_address",
			"is_shipping_address",
		],
	)

	addresses = []
	for a in address_docs:
		addresses.append(
			{
				"name": a.name,
				"address_title": a.address_title,
				"address_line1": a.address_line1,
				"address_line2": a.address_line2,
				"city": a.city,
				"state": a.state,
				"country": a.country,
				"pincode": a.pincode,
				"phone": a.phone,
				"is_primary_address": a.is_primary_address,
				"is_shipping_address": a.get("is_shipping_address", 0),
			}
		)

	return addresses


@frappe.whitelist()  # nosemgrep: overusing-args - args is a JSON-encoded dict from the client, standard Frappe pattern
def make_address(args: str | dict):
	"""
	Create a new address linked to a customer.
	"""
	if isinstance(args, str):
		args = json.loads(args)

	customer = args.get("customer")
	if not customer:
		frappe.throw(_("Customer is required to create an address"))
	require_customer_access(customer, "write", args.get("pos_profile"))

	address = frappe.get_doc(
		{
			"doctype": "Address",
			"address_title": args.get("address_title") or customer,
			"address_line1": args.get("address_line1"),
			"address_line2": args.get("address_line2"),
			"city": args.get("city"),
			"state": args.get("state"),
			"country": args.get("country") or frappe.db.get_single_value("Global Defaults", "country"),
			"pincode": args.get("pincode"),
			"phone": args.get("phone"),
			"is_primary_address": cint(args.get("is_primary_address", 0)),
			"is_shipping_address": cint(args.get("is_shipping_address", 0)),
		}
	)

	address.append(
		"links",
		{
			"link_doctype": "Customer",
			"link_name": customer,
		},
	)

	address.insert(ignore_permissions=True)

	return {
		"name": address.name,
		"address_title": address.address_title,
		"address_line1": address.address_line1,
		"city": address.city,
	}


@frappe.whitelist()
def get_customer_credit(customer: str, company: str | None = None, pos_profile: str | None = None):
	"""Spendable customer credit through the caller's POS Profile (see xpos.api.customer_credit)."""
	from xpos.api.customer_credit import get_customer_credit as profile_credit

	return profile_credit(customer, pos_profile=pos_profile)


def get_allowed_sales_persons(pos_profile: str | None = None) -> list[str]:
	"""Sales Person names allow-listed on the POS Profile."""
	profile = resolve_pos_profile(pos_profile)
	return [
		name
		for name in (row_value(row, "sales_person") for row in profile.get("allowed_sales_persons") or [])
		if name
	]


@frappe.whitelist()
def sales_person_query(
	doctype: str, txt: str, searchfield: str, start: int, page_len: int, filters: dict | str, **kwargs
):
	"""Link query behind the POS sales person field."""
	filters = filters or {}
	if isinstance(filters, str):
		filters = json.loads(filters)
	pos_profile = filters.get("pos_profile") if isinstance(filters, dict) else None

	allowed = get_allowed_sales_persons(pos_profile)
	if not allowed:
		return []

	txt = (txt or "").strip()
	return frappe.get_all(
		"Sales Person",
		filters={"enabled": 1, "name": ["in", allowed]},
		or_filters=(
			{"name": ["like", f"%{txt}%"], "sales_person_name": ["like", f"%{txt}%"]} if txt else None
		),
		fields=["name"],
		order_by="name asc",
		offset=cint(start),
		limit=cint(page_len) or 20,
		as_list=True,
	)


@frappe.whitelist()
def get_sales_person_names(pos_profile: str | None = None):
	"""Enabled sales persons allowed for the given POS Profile."""
	allowed = get_allowed_sales_persons(pos_profile)
	if not allowed:
		return []

	return frappe.get_all(
		"Sales Person",
		filters={"enabled": 1, "name": ["in", allowed]},
		fields=["name", "sales_person_name"],
		order_by="name asc",
	)


def get_customer_balance(customer: str):
	"""Get outstanding balance for a customer."""
	balance = frappe.db.sql(
		"""
		SELECT SUM(debit - credit) AS balance
		FROM `tabGL Entry`
		WHERE party_type = 'Customer' AND party = %(customer)s AND docstatus = 1
		""",
		{"customer": customer},
		as_dict=True,
	)
	if not balance:
		return 0

	first_row = balance[0]
	if isinstance(first_row, dict):
		return flt(first_row.get("balance", 0))
	if isinstance(first_row, (list, tuple)) and first_row:
		return flt(first_row[0])
	return flt(first_row or 0)


def get_loyalty_points(customer: str):
	"""Get loyalty points balance for a customer."""
	try:
		points = frappe.db.sql(
			"""
			SELECT SUM(loyalty_points) AS points
			FROM `tabLoyalty Point Entry`
			WHERE customer = %(customer)s AND expiry_date >= CURDATE()
			""",
			{"customer": customer},
			as_dict=True,
		)
		return flt(points[0].get("points", 0)) if points else 0
	except Exception:
		return 0


@frappe.whitelist()
def get_loyalty_programs(company: str = None):
	"""Get all active loyalty programs for the given company."""
	filters = {}
	if company:
		filters["company"] = company

	programs = frappe.get_all(
		"Loyalty Program",
		filters=filters,
		fields=[
			"name",
			"loyalty_program_name",
			"company",
			"conversion_factor",
			"expiry_duration",
		],
		order_by="loyalty_program_name asc",
	)

	# Get tiers for each program
	for program in programs:
		tiers = frappe.get_all(
			"Loyalty Program Collection",
			filters={"parent": program["name"]},
			fields=["tier_name", "min_spent", "collection_factor"],
			order_by="min_spent asc",
		)
		program["tiers"] = tiers

	return programs


@frappe.whitelist()
def register_customer_loyalty(customer: str, loyalty_program: str, pos_profile: str | None = None):
	"""Register a customer for a loyalty program.

	Args:
	            customer: Customer name/ID
	            loyalty_program: Loyalty Program name

	Returns:
	        Updated customer info with loyalty details
	"""
	if not customer:
		frappe.throw(_("Customer is required"))
	if not loyalty_program:
		frappe.throw(_("Loyalty Program is required"))

	if not frappe.db.exists("Customer", customer):
		frappe.throw(_("Customer {0} not found").format(customer))

	if not frappe.db.exists("Loyalty Program", loyalty_program):
		frappe.throw(_("Loyalty Program {0} not found").format(loyalty_program))

	require_customer_access(customer, "write", pos_profile)
	cust_doc = frappe.get_doc("Customer", customer)

	if cust_doc.loyalty_program:
		if cust_doc.loyalty_program == loyalty_program:
			frappe.throw(_("Customer is already enrolled in {0}").format(loyalty_program))
		else:
			frappe.throw(
				_(
					"Customer is already enrolled in {0}. Please unenroll from the current program first."
				).format(cust_doc.loyalty_program)
			)

	cust_doc.loyalty_program = loyalty_program
	cust_doc.loyalty_program_tier = None
	cust_doc.save(ignore_permissions=True)

	lp = frappe.get_cached_doc("Loyalty Program", loyalty_program)

	return {
		"name": cust_doc.name,
		"customer_name": cust_doc.customer_name,
		"loyalty_program": loyalty_program,
		"loyalty_program_name": lp.loyalty_program_name or loyalty_program,
		"conversion_factor": lp.conversion_factor,
		"loyalty_points": 0,
		"message": _("Successfully enrolled {0} in {1}").format(
			cust_doc.customer_name, lp.loyalty_program_name or loyalty_program
		),
	}


@frappe.whitelist()
def unenroll_customer_loyalty(customer: str, pos_profile: str | None = None):
	"""Remove a customer from their loyalty program.

	Args:
	    customer: Customer name/ID

	Returns:
	    Updated customer info
	"""
	if not customer:
		frappe.throw(_("Customer is required"))

	if not frappe.db.exists("Customer", customer):
		frappe.throw(_("Customer {0} not found").format(customer))

	require_customer_access(customer, "write", pos_profile)
	cust_doc = frappe.get_doc("Customer", customer)

	if not cust_doc.loyalty_program:
		frappe.throw(_("Customer is not enrolled in any loyalty program"))

	old_program = cust_doc.loyalty_program
	cust_doc.loyalty_program = None
	cust_doc.loyalty_program_tier = None
	cust_doc.save(ignore_permissions=True)

	return {
		"name": cust_doc.name,
		"customer_name": cust_doc.customer_name,
		"loyalty_program": None,
		"message": _("Successfully unenrolled {0} from {1}").format(cust_doc.customer_name, old_program),
	}


@frappe.whitelist()
def get_customer_loyalty_info(customer: str, pos_profile: str | None = None):
	"""Get detailed loyalty information for a customer.

	Args:
	    customer: Customer name/ID

	Returns:
	    Loyalty program details, points balance, and tier info
	"""
	if not customer:
		return None

	if not frappe.db.exists("Customer", customer):
		return None

	require_customer_access(customer, pos_profile=pos_profile)
	cust_doc = frappe.get_cached_doc("Customer", customer)

	if not cust_doc.loyalty_program:
		return {
			"enrolled": False,
			"customer": customer,
			"customer_name": cust_doc.customer_name,
			"loyalty_program": None,
		}

	lp = frappe.get_cached_doc("Loyalty Program", cust_doc.loyalty_program)

	points = get_loyalty_points(customer)

	conversion_factor = flt(lp.conversion_factor) or 1
	points_value = flt(points) * conversion_factor if conversion_factor else 0

	current_tier = cust_doc.loyalty_program_tier

	tiers = frappe.get_all(
		"Loyalty Program Collection",
		filters={"parent": lp.name},
		fields=["tier_name", "min_spent", "collection_factor"],
		order_by="min_spent asc",
	)

	return {
		"enrolled": True,
		"customer": customer,
		"customer_name": cust_doc.customer_name,
		"loyalty_program": lp.name,
		"loyalty_program_name": lp.loyalty_program_name or lp.name,
		"conversion_factor": conversion_factor,
		"loyalty_points": points,
		"points_value": points_value,
		"current_tier": current_tier,
		"tiers": tiers,
		"expiry_duration": lp.expiry_duration,
	}


def _get_child_groups(group_type: str, root: str):
	"""Get all child groups including self."""
	if not root:
		return []
	result = frappe.db.get_value(group_type, root, ["lft", "rgt"])
	if not result:
		return [root]
	lft, rgt = result
	return frappe.get_all(
		group_type,
		filters={"lft": [">=", lft], "rgt": ["<=", rgt]},
		pluck="name",
	)


@frappe.whitelist()
def get_customer_groups():
	"""Return list of customer group names for dropdown."""
	return frappe.get_all(
		"Customer Group",
		filters={"is_group": 0},
		pluck="name",
		order_by="name asc",
		limit_page_length=0,
	)
