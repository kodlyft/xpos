import frappe
from frappe.sessions import get, get_csrf_token

from xpos.constants import RTL_LANGUAGES


def get_context(context):
	context.boot = get()
	# get_csrf_token() saves the token on the session. A token generated here and not saved passes
	# only until something else (the desk in another tab) creates the session's real token; after
	# that every POST from this page fails with CSRFTokenError.
	context.csrf_token = get_csrf_token() if frappe.session.user != "Guest" else ""
	context.app_name = "X POS"
	context.lang = frappe.local.lang
	context.layout_direction = "rtl" if frappe.local.lang in RTL_LANGUAGES else "ltr"
