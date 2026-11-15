# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""Presentation metadata for the reports in the X POS module.

Which reports are offered is decided by the Report records themselves (module "X POS");
this only supplies category, description and permission. A new report added to the module
is offered without an entry here, filed under "Other".
"""

MODULE = "X POS"
PROVIDER = "xpos.reports.providers.bundled_filters"

BUNDLED = {
	"Current Stock Report": {
		"category": "Inventory",
		"description": "Live stock valuation by item, warehouse, supplier, brand, and group.",
		"pos_permission": "current_stock_report",
	},
	"Current Stock By Brand": {
		"category": "Inventory",
		"description": "Brand-wise stock snapshot with quantities and valuation.",
		"pos_permission": "current_stock_by_brand",
	},
	"Current Stock Summary": {
		"category": "Inventory",
		"description": "Compact warehouse stock overview with totals and stock movement levels.",
	},
	"Current Stock With Levels": {
		"category": "Inventory",
		"description": "Stock snapshot grouped with reorder and alert levels.",
	},
	"Dead Stock Report": {
		"category": "Inventory",
		"description": "Stock that has been sitting too long with low value movement.",
	},
	"Stock Value By Warehouse": {
		"category": "Inventory",
		"description": "Warehouse value and quantity summary for quick inventory valuation.",
	},
	"Stock Value Summary By Date": {
		"category": "Inventory",
		"description": "Snapshot stock balance by posting date for trend review.",
	},
	"Warehouse Stock Movement": {
		"category": "Operations",
		"description": "Movement summary by warehouse and voucher type over time.",
	},
	"Branch Item Summary": {
		"category": "Operations",
		"description": "Item movement and sales summary for a branch and warehouse window.",
	},
	"Branch Set Summary": {
		"category": "Operations",
		"description": "Set-level summary for branch stock and movement tracking.",
	},
	"Low Qty Sales Report": {
		"category": "Sales",
		"description": "Items sold in low quantities over a selected period.",
	},
	"Zero Qty Sales Report": {
		"category": "Sales",
		"description": "Sales lines where no quantity was fulfilled during the period.",
	},
	"Slow Fast Moving Items": {
		"category": "Sales",
		"description": "Movement velocity overview to identify fast and slow sellers.",
	},
	"Stock Audit Report": {
		"category": "Inventory",
		"description": "Thermal-printable stock audit by item with available qty. Filter by warehouse, brand, supplier, or item.",
		"thermal_print": 1,
	},
	"Purchase Order Report": {
		"category": "Purchasing",
		"description": "Purchase order summary with supplier, date range, and type filters.",
	},
	"POS Shift Reconciliation": {
		"category": "Sales",
		"description": "Z-report: items sold with quantities plus totals by payment mode for end-of-shift cash-up.",
		"pos_permission": "shift_report",
		"thermal_print": 1,
		"summary": "yes",
	},
	"Gift Card Liability": {
		"category": "Accounting",
		"description": "What the store owes on gift cards, reconciled to the liability account.",
		"pos_permission": "gift_card_liability_report",
		"summary": "yes",
	},
	"Sales By Item": {
		"category": "Sales",
		"description": "What sold in the period, item by item, with quantity and amount.",
	},
	"Sales By Payment Mode": {
		"category": "Sales",
		"description": "Takings by mode of payment, net of change given, for cashing up.",
		"pos_permission": "shift_report",
	},
	"Sales By Cashier": {
		"category": "Sales",
		"description": "Invoices, returns and sales total for each cashier, per currency (the user whose till took the sale).",
	},
	"Low Stock Items": {
		"category": "Inventory",
		"description": "Items at or below their reorder level, to restock from the shop floor.",
	},
}
