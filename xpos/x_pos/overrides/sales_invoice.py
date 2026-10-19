import frappe
from frappe.utils import cint


class XposPriceListMixin:
	"""Keep a POS sale's header price list on the list its line rates come from.

	ERPNext's ``set_pos_fields`` writes customer → customer group → profile into
	``selling_price_list`` on every validate, even when the POS Profile does not
	force customer prices. Pricing rules are then matched against that list. XPOS
	prices sale lines from ``resolve_selling_price_list``, so the header follows
	the same rule; pricing rules themselves stay enabled.
	"""

	def set_pos_fields(self, for_validate=False):
		result = super().set_pos_fields(for_validate)
		if (
			cint(self.is_pos)
			and self.pos_profile
			and not cint(self.is_return)
			and frappe.db.exists("POS Profile", self.pos_profile)
		):
			from xpos.api.profile_rules import resolve_selling_price_list

			price_list = resolve_selling_price_list(
				frappe.get_cached_doc("POS Profile", self.pos_profile), self.customer
			)
			if price_list:
				self.selling_price_list = price_list
		return result


class XposSalesInvoice(XposPriceListMixin):
	pass
