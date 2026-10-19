import frappe

from xpos.patches.add_pos_query_indexes import INDEXES
from xpos.patches.common import drop_index


def after_uninstall():
	clear_custom_fields_and_properties()
	drop_pos_query_indexes()


def clear_custom_fields_and_properties():
	frappe.db.delete("Custom Field", {"module": "X POS"})
	frappe.db.delete("Property Setter", {"module": "X POS"})
	frappe.db.commit()  # nosemgrep: frappe-manual-commit - uninstall must commit deletions immediately


def drop_pos_query_indexes():
	"""Remove the indexes this app added to core Frappe/ERPNext tables."""
	for doctype, _columns, index_name in INDEXES:
		frappe.logger("xpos").info(drop_index(doctype, index_name))

	frappe.db.commit()  # nosemgrep: frappe-manual-commit - uninstall must commit immediately
