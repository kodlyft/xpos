# X POS - Feature Overview

**X POS** is a modern, full-featured Point of Sale application built on Frappe Framework and ERPNext. It delivers a fast, touch-friendly, and fully offline-capable POS experience designed for retail, restaurant, and service businesses.

---

## Feature Index

| # | Feature Area | Description |
|---|---|---|
| 01 | [Authentication & Login](01-authentication.md) | Secure login, session management, password reset |
| 02 | [Shift Management](02-shift-management.md) | Open/close POS shifts with cash reconciliation |
| 03 | [Item Browsing & Search](03-item-browsing.md) | Grid/list views, search, barcode scanning, variants |
| 04 | [Cart Management](04-cart-management.md) | Add items, edit quantities, discounts, notes |
| 05 | [Customer Management](05-customer-management.md) | Search, create, edit customers from POS |
| 06 | [Payment Processing](06-payment-processing.md) | Multi-payment, split payments, change calculation |
| 07 | [Draft & Held Orders](07-draft-orders.md) | Hold, restore, and manage draft invoices |
| 08 | [Returns & Refunds](08-returns.md) | Full and partial returns with validation |
| 09 | [Repeat Orders](09-repeat-orders.md) | Clone past invoices for repeat customers |
| 10 | [Order History](10-order-history.md) | Browse, filter, and view past orders |
| 11 | [Promotions & Offers](11-promotions-offers.md) | POS Offers, coupons, pricing rules |
| 12 | [Loyalty Program](12-loyalty-program.md) | Points, tiers, redemption, enrollment |
| 13 | [Tax Handling](13-tax-handling.md) | Multi-tax, per-item tax, inclusive pricing |
| 14 | [Cash Movements](14-cash-movements.md) | Expenses and deposits during shift |
| 15 | [Printing & Receipts](15-printing-receipts.md) | Thermal receipts, barcodes, QR codes |
| 16 | [Offline Mode](16-offline-mode.md) | Full offline operation with auto-sync |
| 17 | [Purchasing Module](17-purchasing.md) | Purchase orders, stock receiving, in-transit |
| 19 | [Multi-Currency](19-multi-currency.md) | Invoice currency vs payment-mode currency |
| 20 | [Delivery Charges](20-delivery-charges.md) | Configurable delivery/shipping charges |
| 21 | [Referral Program](21-referral-program.md) | Customer referral codes and rewards |
| 22 | [Scale Barcode Support](22-scale-barcodes.md) | Weighted item barcode parsing |
| 23 | [Product Bundles](23-product-bundles.md) | Bundle items with component expansion |
| 24 | [POS Profile Configuration](24-pos-profile-config.md) | Complete POS Profile settings reference |
| 25 | [Keyboard Shortcuts](25-keyboard-shortcuts.md) | Full keyboard shortcut reference |
| 26 | [Cashier Settlement](26-cashier-settlement.md) | Create bills at the terminal, collect payment at a separate cashier |
| 27 | [Open Tabs](27-open-tabs.md) | Recall a customer's tab across shifts, and settle past credit sales |
| 28 | [Mixed-Currency Tender Setup](28-mixed-currency-setup.md) | Configure a store that prices in one currency and takes cash in another |
| 29 | [Gift Cards](29-gift-cards.md) | Stored-value cards: sell, spend in parts, refund, liability report |

---

## System Requirements

| Requirement | Version |
|---|---|
| Python | ≥ 3.14 |
| Frappe Framework | v16 |
| ERPNext | v16 |
| Node.js | ≥ 24 |

---

## Architecture

X POS consists of:

- **Vue.js 3 Frontend** - A single-page application (SPA) with Pinia state management, served at `/xpos`
- **Python Backend API** - 56+ whitelisted API endpoints built on Frappe
- **13 Custom Doctypes** - POS Offer, POS Coupon, POS Cash Movement, Delivery Charges, Referral Code, Scale Barcode Settings, and more
- **80+ Custom Fields** - Added to POS Profile, Sales Invoice, Customer, and Sales Order for extended POS functionality
- **IndexedDB Offline Storage** - 8 object stores for items, customers, invoices, stock, and metadata caching
- **ERPNext Integration** - Deep integration with Sales Invoice, POS Profile, Payment Entry, Pricing Rules, Loyalty Programs, and Inventory
