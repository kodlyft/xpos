# Draft & Held Orders

X POS allows you to hold (park) an order and resume it later, enabling you to serve multiple customers simultaneously without losing any cart data.

---

## Holding an Order

### How to Hold
1. Build your cart with items, customer, discounts, and notes as usual
2. Click the **Hold** button (clock icon) in the cart actions toolbar
3. The entire cart state is saved as a **draft invoice** on the server

### What Gets Saved
- All cart items with quantities, rates, and discounts
- Selected customer
- Order-level additional discount
- Applied coupons and offers
- Order notes (additional notes)
- Delivery dates (if set)

### After Holding
- The cart is cleared immediately after the draft is saved
- The POS is ready for the next customer
- A success notification confirms the order was held

---

## Restoring a Held Order

### Opening the Draft List
1. Click the **Restore** button (file icon) in the cart actions toolbar
2. The **Draft Invoice Dialog** opens

### Browsing Drafts
The dialog shows all held orders for the current shift. A profile can also be configured to
let a cashier pull tabs raised on *other* shifts, which is how a bar keeps a customer's tab
alive across a shift change. See [Open Tabs](27-open-tabs.md).

Each entry shows:
- **Customer name** - Who the order belongs to
- **Date & time** - When the order was held
- **Item count** - Number of items in the order
- **Grand total** - Total amount of the draft

### Loading a Draft
- Click on a draft to **fully restore** it into the cart
- All saved data is loaded:
  - Items with their quantities, rates, and discounts
  - Customer selection
  - Discounts

### Refreshing the List
- Click the **Refresh** button to reload the draft list from the server

---

## Deleting a Draft

- Each draft entry has a **Delete** button
- Click Delete to remove the draft permanently
- A confirmation prompt appears before deletion
- Deleted drafts cannot be recovered

---

## Updating a Draft

- When you restore a draft, make changes, and hold it again, the existing draft is updated rather than creating a new one
- This keeps the draft list clean and avoids duplicates

---

## Use Cases

### Serving Multiple Customers
1. Start an order for Customer A
2. Customer A steps away to browse more items
3. **Hold** Customer A's order
4. Start and complete Customer B's order normally
5. When Customer A returns, **Restore** their order and continue

### Layaway / Pre-Orders
1. Build the order with desired items and quantities
2. Hold the order for the customer to pick up or pay later
3. Restore and complete payment when the customer is ready

### Order Review
1. Hold the order for a manager to review before completing
2. Manager restores, reviews, and either completes or modifies the order

---

## Tips

- Draft invoices are automatically cleaned up based on your profile settings
- Use draft orders to manage busy periods efficiently
- Each draft shows the customer name, item count, and total for quick identification
- Held orders and [Cashier Settlement](26-cashier-settlement.md) bills are kept separate - bills sent to a cashier do not appear in the held-orders list, and vice versa
