app_name = "xpos"
app_title = "X POS"
app_publisher = "Ali Raza"
app_description = "A modern, offline-capable Point of Sale application for Frappe and ERPNext"
app_email = "ar.frappe.dev@gmail.com"
app_license = "mit"

# Apps
# ------------------

required_apps = ["erpnext"]

# Each item in the list will be shown as an app in the apps page
add_to_apps_screen = [
	{
		"name": "xpos",
		"logo": "/assets/xpos/images/xpos-logo-light.svg",
		"title": "X POS",
		"route": "/xpos",
	}
]

# Includes in <head>
# ------------------

# include js, css files in header of desk.html
# app_include_css = "/assets/xpos/css/xpos.css"
# app_include_js = "/assets/xpos/js/xpos.js"

# include js, css files in header of web template
# web_include_css = "/assets/xpos/css/xpos.css"
# web_include_js = "/assets/xpos/js/xpos.js"

# include custom scss in every website theme (without file extension ".scss")
# website_theme_scss = "xpos/public/scss/website"

# include js, css files in header of web form
# webform_include_js = {"doctype": "public/js/doctype.js"}
# webform_include_css = {"doctype": "public/css/doctype.css"}

# include js in page
# page_js = {"page" : "public/js/file.js"}

# include js in doctype views
doctype_js = {
	"POS Profile": "x_pos/api/pos_profile.js",
	"Sales Invoice": "x_pos/api/invoice.js",
	"Company": "x_pos/api/company.js",
}

extend_bootinfo = "xpos.startup.boot.extend_bootinfo"

page_renderer = ["xpos.pwa.ServiceWorkerPage"]
# doctype_list_js = {"doctype" : "public/js/doctype_list.js"}
# doctype_tree_js = {"doctype" : "public/js/doctype_tree.js"}
# doctype_calendar_js = {"doctype" : "public/js/doctype_calendar.js"}

# Svg Icons
# ------------------
# include app icons in desk
app_include_icons = ["/assets/xpos/icons/module-icons.svg"]

# Home Pages
# ----------

# application home page (will override Website Settings)
# home_page = "login"

# website user home page (by Role)
# role_home_page = {
# 	"Role": "home_page"
# }

# Generators
# ----------

# automatically create page for each record of this doctype
# website_generators = ["Web Page"]

# Jinja
# ----------

# add methods and filters to jinja environment
jinja = {
	"methods": [
		"xpos.x_pos.api.jinja_helpers.xpos_barcode",
		"xpos.x_pos.api.jinja_helpers.xpos_barcode_uri",
		"xpos.x_pos.api.jinja_helpers.xpos_qrcode",
		"xpos.x_pos.api.jinja_helpers.xpos_qrcode_uri",
		"xpos.x_pos.api.jinja_helpers.xpos_item_barcode",
		"xpos.x_pos.api.jinja_helpers.xpos_tender_rate",
		"xpos.x_pos.api.jinja_helpers.xpos_number",
		"xpos.x_pos.api.jinja_helpers.xpos_qty",
		"xpos.x_pos.api.jinja_helpers.xpos_gift_card_line",
	],
}

# Installation
# ------------

# before_install = "xpos.install.before_install"
after_install = "xpos.install.after_install"

# Migration
# ---------

after_migrate = [
	"xpos.patches.add_pos_query_indexes.execute",
	"xpos.x_pos.doctype.referral_code.referral_code.add_customer_company_unique",
]

# Uninstallation
# ------------

# before_uninstall = "xpos.uninstall.before_uninstall"
after_uninstall = "xpos.uninstall.after_uninstall"

# Integration Setup
# ------------------
# To set up dependencies/integrations with other apps
# Name of the app being installed is passed as an argument

# before_app_install = "xpos.utils.before_app_install"
# after_app_install = "xpos.utils.after_app_install"

# Integration Cleanup
# -------------------
# To clean up dependencies/integrations with other apps
# Name of the app being uninstalled is passed as an argument

# before_app_uninstall = "xpos.uninstall.before_uninstall"
# after_app_uninstall = "xpos.uninstall.after_app_uninstall"

# Desk Notifications
# ------------------
# See frappe.core.notifications.get_notification_config

# notification_config = "xpos.notifications.get_notification_config"

# Permissions
# -----------

# permission_query_conditions = {
# 	"Event": "frappe.desk.doctype.event.event.get_permission_query_conditions",
# }

has_permission = {
	"Sales Invoice": "xpos.api.print_formats.invoice_has_permission",
	"POS Invoice": "xpos.api.print_formats.invoice_has_permission",
}

# DocType Class
# ---------------
# Extend standard doctype classes (mixin - does not miss upstream fixes)

extend_doctype_class = {
	"Sales Invoice": "xpos.x_pos.overrides.sales_invoice.XposSalesInvoice",
	"POS Invoice": "xpos.x_pos.overrides.pos_invoice.CustomPOSInvoice",
	"POS Invoice Merge Log": "xpos.x_pos.overrides.pos_invoice_merge_log.CustomPOSInvoiceMergeLog",
}

# Document Events
# ---------------
# Hook on document methods and events

doc_events = {
	"Journal Entry": {
		"before_insert": "xpos.api.customer_credit.read_latest_before_spend",
		"before_validate": "xpos.api.customer_credit.read_latest_before_spend",
		"before_update_after_submit": "xpos.api.customer_credit.read_latest_before_spend",
		"before_submit": "xpos.api.customer_credit.lock_credit_note_spend",
	},
	"Payment Entry": {
		"before_insert": "xpos.api.customer_credit.read_latest_before_spend",
		"before_validate": "xpos.api.customer_credit.read_latest_before_spend",
		"before_update_after_submit": "xpos.api.customer_credit.read_latest_before_spend",
		"before_submit": "xpos.api.customer_credit.lock_credit_note_spend",
	},
	"Sales Invoice": {
		"validate": "xpos.x_pos.api.invoice.validate",
		"before_print": "xpos.api.print_formats.enforce_reprint_right",
		"before_submit": "xpos.x_pos.api.invoice.before_submit",
		"before_cancel": "xpos.x_pos.api.invoice.before_cancel",
		"on_cancel": "xpos.x_pos.api.invoice.on_cancel",
	},
	"POS Invoice": {
		"validate": "xpos.x_pos.api.invoice.validate",
		"before_print": "xpos.api.print_formats.enforce_reprint_right",
		"before_submit": "xpos.x_pos.api.invoice.before_submit",
		"before_cancel": "xpos.x_pos.api.invoice.before_cancel",
		"on_cancel": "xpos.x_pos.api.invoice.on_cancel",
	},
	"Mode of Payment": {
		"validate": "xpos.x_pos.doctype.pos_closing_shift.closing_processing.reclass.validate_mode_of_payment",
	},
	"Customer": {
		"validate": "xpos.x_pos.api.customer.validate",
		"after_insert": "xpos.x_pos.api.customer.after_insert",
	},
	"POS Profile": {
		"validate": "xpos.api.print_formats.validate_print_format_rules",
	},
}

# Scheduled Tasks
# ---------------

# scheduler_events = {
# 	"all": [
# 		"xpos.tasks.all"
# 	],
# 	"daily": [
# 		"xpos.tasks.daily"
# 	],
# 	"hourly": [
# 		"xpos.tasks.hourly"
# 	],
# 	"weekly": [
# 		"xpos.tasks.weekly"
# 	],
# 	"monthly": [
# 		"xpos.tasks.monthly"
# 	],
# }

# Testing
# -------

# before_tests = "xpos.install.before_tests"

# Overriding Methods
# ------------------------------
#
# override_whitelisted_methods = {
# 	"frappe.desk.doctype.event.event.get_events": "xpos.event.get_events"
# }
#
# each overriding function accepts a `data` argument;
# generated from the base implementation of the doctype dashboard,
# along with any modifications made in other Frappe apps
# override_doctype_dashboards = {
# 	"Task": "xpos.task.get_dashboard_data"
# }

# exempt linked doctypes from being automatically cancelled
#
# auto_cancel_exempted_doctypes = ["Auto Repeat"]

# Ignore links to specified DocTypes when deleting documents
# -----------------------------------------------------------

# ignore_links_on_delete = ["Communication", "ToDo"]

# Request Events
# ----------------
# before_request = ["xpos.utils.before_request"]
# after_request = ["xpos.utils.after_request"]

# Job Events
# ----------
# before_job = ["xpos.utils.before_job"]
# after_job = ["xpos.utils.after_job"]

# User Data Protection
# --------------------

# user_data_fields = [
# 	{
# 		"doctype": "{doctype_1}",
# 		"filter_by": "{filter_by}",
# 		"redact_fields": ["{field_1}", "{field_2}"],
# 		"partial": 1,
# 	},
# 	{
# 		"doctype": "{doctype_2}",
# 		"filter_by": "{filter_by}",
# 		"partial": 1,
# 	},
# 	{
# 		"doctype": "{doctype_3}",
# 		"strict": False,
# 	},
# 	{
# 		"doctype": "{doctype_4}"
# 	}
# ]

# Authentication and authorization
# --------------------------------

# auth_hooks = [
# 	"xpos.auth.validate"
# ]

# Automatically update python controller files with type annotations for this app.
export_python_type_annotations = True

# default_log_clearing_doctypes = {
# 	"Logging DocType Name": 30  # days to retain logs
# }


# Website Route Rules
# -------------------
# Serve the X POS SPA for deep links under /xpos

website_route_rules = [
	{"from_route": "/xpos", "to_route": "xpos"},
	{"from_route": "/xpos/<path:app_path>", "to_route": "xpos"},
]
