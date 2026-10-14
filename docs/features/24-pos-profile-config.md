# POS Profile Configuration

The POS Profile is the central configuration hub for X POS. It controls every aspect of the POS behavior — from item display to payments, permissions, and advanced features.

---

## View & Display Settings

| Setting | Description |
|---|---|
| Default View | Default item display mode: Card (grid) or List |
| Display Item Code | Show item codes in the POS interface |
| Display Items in Stock | Only display items that have positive stock |
| Display Additional Notes | Show notes input per line item and order |
| Enable Quantity Input | Enable manual quantity input mode |
| Hide Variant Items | Hide individual variant items in the grid |
| Show Template Items | Show template (parent) items in the grid |
| Hide Expected Amount | Hide expected amounts in the closing dialog |
| Hide Closing Shift | Hide the close shift button |
| Hide Images | Hide item images (text-only display) |
| Hide Unavailable Items | Hide items with zero stock |

---

## Pricing & Discounts

| Setting | Description |
|---|---|
| Tax Inclusive | Item prices include tax |
| Maximum Discount Percentage | Maximum allowed discount percentage |
| Allow Rate Change | Allow editing item rates in the cart |
| Allow Discount Change | Allow editing item-level discounts |
| Allow Additional Discount | Allow order-level additional discount |
| Apply Customer Discount | Auto-apply customer-stored discount |
| Use Customer Price List | Force prices from customer's assigned price list |
| Allow Zero Rated Items | Allow items with zero price |

---

## Offers, Coupons & Referrals

| Setting | Description |
|---|---|
| Auto Fetch Coupons & Gifts | Enable coupon entry and automatic cart-offer refresh |
| Enable Gift Cards | Sell and accept [stored-value gift cards](29-gift-cards.md); needs a company row in Gift Card Settings and the Gift Card mode in Payments |

---

## Delivery

| Setting | Description |
|---|---|
| Use Delivery Charges | Enable delivery charges feature |
| Auto Set Delivery Charges | Auto-apply delivery charges |

---

## Sales & Invoicing

| Setting | Description |
|---|---|
| Allow Credit Sale | Allow sales on credit (no payment required) |
| Allow Change Posting Date | Allow backdating invoices |
| Allow Return | Enable the return feature |
| Allow Return Without Invoice | Allow returns without original invoice |
| Allow Free Batch Return | Allow returning to any batch |
| Enable Return Validity | Enforce a return time window |
| Return Validity Days | Days allowed for returns after purchase |
| Allow Delete | Allow invoice deletion |
| Allow Delete Offline Invoice | Allow manual delete and clear actions in the offline invoices panel |
| Auto Delete Draft Invoice | Auto-cleanup draft invoices |
| Allow Print Draft Invoices | Allow printing before submission |
| Allow Print Last Invoice | Quick-print last invoice |
| Use POS Invoice | Use POS Invoice instead of Sales Invoice |
| Allow Multi Currency | Enable multi-currency transactions |
| Block Sale Beyond Available Qty | Prevent selling beyond available stock |
| Enable Cashier Settlement | Create unsettled bills at the terminal for a cashier to settle later (see [Cashier Settlement](26-cashier-settlement.md)) |
| Print Backup Receipt | Print a non-genuine backup receipt at the terminal when a bill is sent to the cashier |
| Allow Open Tab Recall | Let a cashier pull draft invoices raised on any shift of this profile, not just their own. Also needs the *Recall Other Shifts' Tabs* role permission (see [Open Tabs](27-open-tabs.md)) |
| Allow Outstanding Settlement | Let a cashier collect payment against past submitted invoices that still carry a balance. Also needs the *Settle Outstanding Invoice* role permission (see [Open Tabs](27-open-tabs.md)) |

---

## Payments

| Setting | Description |
|---|---|
| Allow Partial Payment | Allow submitting with partial payment |
| Use POS Payments | Use X POS payment handling |
| Allow New Payments | Create new payment entries |
| Allow Reconcile Payments | Enable payment reconciliation |
| Use Cashback | Enable cashback feature |
| Use Customer Credit | Allow payment via customer credit |
| Allow Write Off Change | Allow small write-off amounts |
| Cash Mode of Payment | Default cash payment mode |

---

## Cash Movement

| Setting | Description |
|---|---|
| Enable Cash Movement | Enable cash deposit/expense feature |
| Allow Cash Deposit | Allow cash deposits |
| Allow POS Expense | Allow POS expenses |
| Allow Cancel Cash Movement | Allow cancelling submitted movements |
| Allow Delete Cancelled Movement | Allow deleting cancelled movements |
| Require Cash Movement Remarks | Require remarks on movements |
| Cash Movement Max Amount | Maximum amount per movement |
| Default Expense Account | Default expense account |
| Default Source Account | Default source (cash) account |
| Back Office Cash Account | Back-office deposit account |
| Allow Source Account Override | Allow changing the source account |
| Allowed Source Accounts | List of allowed source accounts |
| Allowed Expense Accounts | List of allowed expense accounts |

---

## Purchasing

| Setting | Description |
|---|---|
| Allow Purchase Order | Create Purchase Orders from POS |
| Allow Purchase Receipt | Create Purchase Receipts from POS |
| Allow Create Suppliers | Create new suppliers from POS |
| Allow Create Items | Create new items from POS |

---

## Search & Performance

| Setting | Description |
|---|---|
| Item Search Limit | Max items returned per search |
| Use Limit Search | Enable search result limit |
| Search Batch No | Include batch numbers in search |
| Search Serial No | Include serial numbers in search |
| Auto Set Batch | Auto-assign first available batch |
| Fetch Items From Server | Always fetch from server (skip cache) |
| Use Server Cache | Enable server-side item caching |
| Server Cache Duration | Server cache TTL in minutes |
| Force Reload Items | Force reload the item list |
| Use Offline Mode | Enable offline POS mode |

---

## Submission & Data

| Setting | Description |
|---|---|
| Background Submissions | Submit invoices asynchronously |
| Allow Duplicate Customer Names | Allow duplicate customer names |

---

## Print & Formatting

| Setting | Description |
|---|---|
| Default Print Format | Default receipt/print format for the POS profile |
| Print Format Rules | Conditional print format rules |
| Print Discounts as Amounts | On receipts, show percentage-based discounts as currency amounts instead of percent labels |
| Allowed Sales Persons | Restrict available sales persons |

---

## Standard POS Profile Fields

In addition to the X POS settings, the standard POS Profile provides:

| Setting | Description |
|---|---|
| Warehouse | Default selling warehouse |
| Company | Associated company |
| Price List | Default selling price list |
| Customer Group | Allowed customer groups |
| Income Account | Default income account |
| Cost Center | Default cost center |
| Write Off Account | Account for write-offs |
| Payment Methods | Table of allowed payment modes |
| Tax Template | Sales Taxes and Charges template |
| Item Groups | Restrict to specific item groups |
| Print Format | Default print format |
| Letter Head | Company letter head for printing |

---

## User Access (Applicable for Users)

The **Applicable for Users** table assigns users to the POS Profile. X POS adds one field to each row:

| Field | Description |
|---|---|
| Is Cashier | Allows this user to open the Cashier screen and settle bills. See [Cashier Settlement](26-cashier-settlement.md). |

---

## Configuration Tips

- Start with a minimal configuration and enable features as needed
- Test each new setting in a staging environment before enabling in production
- Use the "Allow" settings to control which operations POS operators can perform
- Configure proper accounts (expense, source, back-office) for cash movements
- Set reasonable limits on discount percentages and cash movement amounts to prevent errors
- Enable "Use Offline Mode" for locations with unreliable connectivity
- Use "Background Submissions" for high-traffic POS stations to speed up checkout
