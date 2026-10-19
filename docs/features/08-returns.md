# Returns & Refunds

X POS provides a comprehensive return system with invoice lookup, partial/full returns, return validity enforcement, and quantity tracking.

---

## Starting a Return

There are two ways to initiate a return:

### From the Cart (Return Dialog)
1. Click the **Return** button in the cart actions area
2. The **Return Dialog** opens with a two-step process

### From Order History
1. Navigate to the **Orders** view
2. Find and open the original invoice
3. Click the **Return** button on the invoice detail page
4. You are redirected to the POS view in return mode with items pre-loaded

---

## Return Dialog - Step 1: Search Invoices

### Search Fields
You can search for the original invoice by multiple criteria:
- **Invoice number** - Direct invoice name/number lookup
- **Customer name** - Search by who made the purchase
- **Customer ID** - Search by customer ID
- **Mobile number** - Search by the customer's phone number
- **Date range** - Filter by from/to dates
- **Amount range** - Filter by minimum/maximum invoice amount

### Search Results
- Results show invoice name, customer, date, and grand total
- Paginated results with "Load More" option
- Only submitted, non-cancelled invoices are shown
- Return validity is checked - expired invoices are flagged

---

## Return Dialog - Step 2: Select Return Items

After selecting an invoice:

### Item Table
For each item on the original invoice:
- **Item name** - The product being returned
- **Original qty** - Quantity originally sold
- **Already returned qty** - Quantity from previous returns against this invoice
- **Remaining returnable qty** - Maximum quantity that can still be returned
- **Return qty** - Adjustable input (capped at remaining returnable qty)
- **Calculated refund amount** - Return qty × original rate

### Selecting Items to Return
1. Enter the **return quantity** for each item (cannot exceed remaining returnable qty)
2. The refund amount auto-calculates based on the original rate
3. Skip items not being returned (leave qty as 0)
4. Click **Process Return** to load the return into the cart

---

## Return Mode

Once a return is initiated, the POS enters **return mode**:

### Visual Indicators
- **Amber banner** across the top of the POS screen
- **"Return Mode" label** clearly visible
- Cart items show negative quantities
- Grand total is negative (refund)

### Locked State
- **Customer is locked** - Cannot change the customer during a return (matches the original invoice)
- **Return against** reference is set - Links the return to the original invoice
- All items have **negative quantities** by default

### Payment in Return Mode
- The payment dialog adapts:
  - Shows "Refund Amount" instead of "Amount Due"
  - Submit button reads "Return & Print"
  - All items must have negative quantities
  - Grand total must be negative
  - If the original sale was paid by gift card, **Refund to gift card ••••1234** puts the money back on that card, up to what it paid. See [Gift Cards](29-gift-cards.md#returns-cancellations-and-adjustments)

---

## Return Validation

X POS enforces several validations before processing a return:

### Pre-Return Checks
- **Stock availability** - Ensures items can be received back into stock
- **Quantity limits** - Return qty cannot exceed the original qty minus already-returned qty
- **Customer match** - Return customer must match the original invoice customer
- **Item existence** - All return items must exist on the original invoice

### Return Validity
When `enable_return_validity` is enabled on the POS Profile:
- A **return validity period** is set (in days) via `return_validity_days`
- The original invoice records a `return_valid_upto` date
- Returns cannot be processed after this date expires
- Expired invoices show a clear "return expired" indicator

### Already Returned Quantities
- The system tracks quantities already returned across all previous returns against the same invoice
- The "remaining returnable qty" is calculated as: original qty − sum of all previous return quantities
- If an item is fully returned, its returnable qty is 0 and it cannot be returned again

---

## Return Without Original Invoice

When enabled in your settings:
- Returns can be processed without searching for an original invoice
- Items are added directly to the cart with negative quantities
- The return is not linked to any specific original invoice
- Useful for businesses that accept returns based on receipts or other proof

---

## Batch Returns

When enabled in your settings:
- Returned items can be assigned to any available batch, not just the original batch
- Useful when the original batch information is unknown or when items are interchangeable

---

## Return Flow Summary

```
┌─────────────────────┐
│ Click Return Button  │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Search for Invoice   │──── by name, customer, mobile, date, amount
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Select Return Items  │──── set qty per item (≤ remaining returnable)
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Enter Return Mode    │──── negative qtys, locked customer, amber banner
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Process Refund       │──── payment dialog with refund amount
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Return Invoice       │──── submitted with return_against reference
└─────────────────────┘
```

---

## Tips

- Always verify the original invoice before processing a return
- Use the quantity limits to ensure partial returns are captured correctly
- Return validity helps prevent abuse by limiting the return window
- The return flow is fully auditable through the linked invoices
