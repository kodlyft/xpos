# Order History

X POS provides a comprehensive Order History view where you can browse, search, filter, and inspect past transactions.

---

## Accessing Order History

- Navigate to the **Orders** tab from the POS navigation bar
- The Orders View displays a paginated list of all invoices

---

## Order List

### Order Cards
Each order is displayed as a card showing:
- **Invoice name/number**
- **Status badge** - Draft, Submitted, Paid, Cancelled, Return, etc.
- **Customer name**
- **Date and time** of the transaction
- **Grand total** amount
- **Paid amount**
- **Tax amount**

### Pagination
- Orders are loaded in pages with a configurable page size
- Navigate between pages using pagination controls
- Total order count is displayed

---

## Filtering Orders

### Date Range
- **From date** - Shows orders from this date onwards
- **To date** - Shows orders up to this date

### Status Filter
- Filter by invoice status (e.g., Submitted, Paid, Cancelled)

### Return Filter
- Toggle to show only return invoices or exclude returns

### Customer Search
- Autocomplete customer name search to filter by customer

### Sort Order
- Sort orders by date, name, or amount (ascending/descending)

### Advanced Filters
The order history supports powerful filter operators:
| Operator | Example | Description |
|---|---|---|
| `=` | Status = Paid | Exact match |
| `!=` | Status ≠ Cancelled | Not equal |
| `>` | Amount > 100 | Greater than |
| `<` | Amount < 500 | Less than |
| `like` | Customer like "John%" | Partial match |
| `in` | Status in [Paid, Submitted] | Multiple values |
| `between` | Date between [2024-01-01, 2024-12-31] | Range |
| `is` / `is not` | Return is Set / Return is Not Set | Null checks |

---

## Order Detail View

Click on an order to open its full detail dialog:

### Header Information
- **Invoice name and status badge**
- **Customer name** with link
- **Date and time**
- **POS Profile**
- **Created by** (user)
- **Sales partner** (if assigned)
- **Coupon code** (if applied)

### Items Table
| Column | Description |
|---|---|
| Item Name | Product name |
| Qty | Quantity sold |
| Rate | Unit price |
| Amount | Line total |
| Discount | Any item-level discount |
| Additional notes | Per-item notes |

### Summary Section
- **Net total** - Before taxes
- **Taxes & charges** - Breakdown by tax account with rates and amounts
- **Additional discount** - Order-level discount amount
- **Loyalty redemption** - Points redeemed and value
- **Grand total** - Final amount

### Tax Breakdown
For each tax applied:
- Account head name
- Tax rate
- Tax amount
- Whether the tax is included in prices

### Payment Details
- Each payment method used with amounts
- Change given (if any)

### Loyalty Information
- Loyalty program name
- Points earned from this transaction
- Points redeemed (if any)
- Remaining balance after transaction

### Remarks
- Any saved order notes or remarks

---

## Actions from Order Detail

### Print
- Click **Print** to open the invoice in a print preview window
- Uses the configured print format from the POS Profile
- Supports both POS Invoice and Sales Invoice doctypes

### Return
- Click **Return** to initiate a return against this invoice
- The system fetches returnable items (accounting for already-returned quantities)
- Redirects to the POS view in return mode with items pre-loaded
- See [Returns & Refunds](08-returns.md) for full details

### Close
- Close the detail dialog to return to the order list

---

## Tips

- Use the date range filter to quickly narrow down to a specific day's transactions
- The customer search autocomplete makes it easy to find all orders for a specific customer
- Sort by amount to find the highest/lowest value transactions
- The order detail view shows the complete audit trail for each transaction
- Use the return action directly from order history for faster return processing
