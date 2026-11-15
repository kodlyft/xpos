# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""Which companies and warehouses a user's POS reports may read.

Scope comes from Frappe User Permissions on Company/Warehouse when the user has any;
otherwise a user bound to POS Profiles is held to those profiles' companies and
warehouse trees; a user with neither is unrestricted, as is a System Manager.
"""

import frappe
from frappe import _

from xpos.api.auth import is_superuser
from xpos.api.items import get_warehouse_list


class ReportScope:
	def __init__(self, companies: set[str] | None = None, warehouses: set[str] | None = None):
		self.companies = companies
		self.warehouses = warehouses

	@property
	def restricted(self) -> bool:
		return self.companies is not None or self.warehouses is not None

	def allows_company(self, company: str | None) -> bool:
		return not company or self.companies is None or company in self.companies

	def allows_warehouse(self, warehouse: str | None) -> bool:
		return not warehouse or self.warehouses is None or warehouse in self.warehouses

	def allows_profile(self, pos_profile: str | None) -> bool:
		if not pos_profile or not self.restricted:
			return True
		company, warehouse = frappe.db.get_value("POS Profile", pos_profile, ["company", "warehouse"]) or (
			None,
			None,
		)
		return self.allows_company(company) and self.allows_warehouse(warehouse)


def permitted_docs(permissions: dict, doctype: str) -> set[str] | None:
	"""Docs a user is limited to by unqualified User Permissions; rules limited to one doctype do not scope reports."""
	rows = [row for row in permissions.get(doctype) or [] if not row.get("applicable_for")]
	return {row.get("doc") for row in rows} if rows else None


def profile_scope(user: str) -> ReportScope | None:
	profiles = frappe.db.sql(
		"""
		SELECT p.company, p.warehouse
		FROM `tabPOS Profile User` u
		INNER JOIN `tabPOS Profile` p ON p.name = u.parent
		WHERE u.user = %(user)s AND u.parenttype = 'POS Profile' AND p.disabled = 0
		""",
		{"user": user},
		as_dict=True,
	)
	if not profiles:
		return None

	companies = {row.company for row in profiles if row.company}
	warehouses = set()
	for row in profiles:
		if not row.warehouse:
			return ReportScope(companies, None)
		warehouses.update({row.warehouse, *get_warehouse_list(row.warehouse)})
	return ReportScope(companies or None, warehouses)


def get_scope(user: str | None = None) -> ReportScope:
	user = user or frappe.session.user
	memo = getattr(frappe.local, "xpos_report_scopes", None)
	if memo is None:
		memo = frappe.local.xpos_report_scopes = {}
	if user not in memo:
		memo[user] = resolve_scope(user)
	return memo[user]


def resolve_scope(user: str) -> ReportScope:
	if user == "Administrator" or is_superuser(user):
		return ReportScope()

	permissions = frappe.permissions.get_user_permissions(user) or {}
	companies = permitted_docs(permissions, "Company")
	warehouses = permitted_docs(permissions, "Warehouse")

	if companies is None and warehouses is None:
		return profile_scope(user) or ReportScope()

	if companies is not None:
		by_company = set(
			frappe.get_all("Warehouse", filters={"company": ("in", list(companies))}, pluck="name")
		)
		warehouses = by_company if warehouses is None else warehouses & by_company
	return ReportScope(companies, warehouses)


def as_list(value) -> list[str]:
	if not value:
		return []
	if isinstance(value, str):
		return [value]
	return [str(v) for v in value if v]


def enforce(filters, user: str | None = None) -> ReportScope:
	"""Refuse a request that names a company or warehouse outside the user's scope."""
	scope = get_scope(user)
	if not scope.restricted:
		return scope

	for company in as_list(filters.get("company")):
		if not scope.allows_company(company):
			frappe.throw(
				_("You are not permitted to report on company {0}.").format(company), frappe.PermissionError
			)
	for warehouse in as_list(filters.get("warehouse")):
		if not scope.allows_warehouse(warehouse):
			frappe.throw(
				_("You are not permitted to report on warehouse {0}.").format(warehouse),
				frappe.PermissionError,
			)
	return scope


def warehouse_clause(column: str, params: dict) -> str:
	"""SQL limiting ``column`` to the user's warehouses (adds its parameters), empty when unrestricted."""
	scope = get_scope()
	if scope.warehouses is not None:
		if not scope.warehouses:
			return "1 = 0"
		params["scope_warehouses"] = tuple(sorted(scope.warehouses))
		return f"{column} IN %(scope_warehouses)s"
	if scope.companies is not None:
		if not scope.companies:
			return "1 = 0"
		params["scope_companies"] = tuple(sorted(scope.companies))
		return f"{column} IN (SELECT name FROM `tabWarehouse` WHERE company IN %(scope_companies)s)"
	return ""


def warehouse_condition(column: str, params: dict) -> str:
	clause = warehouse_clause(column, params)
	return f" AND {clause}" if clause else ""


def company_condition(column: str, params: dict) -> str:
	scope = get_scope()
	if scope.companies is None:
		return ""
	if not scope.companies:
		return " AND 1 = 0"
	params["scope_companies"] = tuple(sorted(scope.companies))
	return f" AND {column} IN %(scope_companies)s"
