# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

import hashlib

import frappe
from frappe import _
from frappe.model.document import Document


class XPOSUserLayout(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		company: DF.Link
		data: DF.Code | None
		pos_profile: DF.Link
		revision: DF.Int
		schema_version: DF.Int
		user: DF.Link
	# end: auto-generated types

	def autoname(self):
		self.name = hashlib.sha1(f"{self.user}|{self.company}|{self.pos_profile}".encode()).hexdigest()[:20]

	def validate(self):
		exists = frappe.db.exists(
			"XPOS User Layout",
			{
				"user": self.user,
				"company": self.company,
				"pos_profile": self.pos_profile,
				"name": ["!=", self.name],
			},
		)
		if exists:
			frappe.throw(_("A layout already exists for this user and POS Profile."))


def get_permission_query_conditions(user=None):
	user = user or frappe.session.user
	if "System Manager" in frappe.get_roles(user):
		return ""
	return f"`tabXPOS User Layout`.`user` = {frappe.db.escape(user)}"


def has_permission(doc, ptype=None, user=None):
	user = user or frappe.session.user
	return "System Manager" in frappe.get_roles(user) or doc.user == user
