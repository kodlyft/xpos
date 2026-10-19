# Repeat Orders

X POS allows you to quickly duplicate a past invoice to serve repeat customers who order the same items regularly.

---

## Accessing Repeat Orders

### Keyboard Shortcut
- Press **Ctrl+G** to open the Repeat Invoice Dialog from anywhere in the POS view
- A keyboard shortcut badge is shown in the dialog header

### Menu Access
- Access via the cart actions menu or toolbar

---

## Searching Past Invoices

### Search Criteria
- **Invoice number** - Search by direct invoice name
- **Customer name** - Search by who placed the order
- **Date range** - Filter by from/to dates

### Search Results
- Paginated list of matching past invoices
- Each result shows:
  - Invoice number
  - Customer name
  - Date and time
  - Grand total
  - Item count

---

## Duplicating an Invoice

You can repeat an invoice if it was sold through a POS Profile you are assigned to, or if your ERPNext role lets you read it in Desk.

### Select an Invoice
1. Browse or search for the desired invoice
2. Click on the invoice to select it

### What Gets Cloned
- **Customer** - The original customer is set on the cart
- **All items** - Each item from the original invoice is added to the cart
- **Quantities** - Original quantities are preserved
- **Rates** - Items use **current prices** (not historical prices from the original invoice)
- **Discounts** - Item-level discounts from the original are applied

### What Doesn't Get Cloned
- Payment information (the original payment methods are not duplicated)
- Coupons and time-limited offers (they may have expired)
- Order notes

### After Cloning
- The cart is populated with all items from the selected invoice
- You can then:
  - Modify quantities or remove unwanted items
  - Add new items
  - Adjust prices or discounts
  - Proceed to payment normally

---

## Use Cases

### Regular Customers
- A coffee shop customer who orders the same drinks every morning
- A restaurant with regulars who have a "usual" order
- A wholesale customer who places identical repeat orders

### Template Orders
- Use a past invoice as a template and adjust quantities for the current order
- Faster than building the order from scratch

### Bulk Reordering
- For businesses where customers frequently reorder the same bundle of items

---

## Tips

- Search by customer name to quickly find their most recent orders
- The repeat order uses **current pricing**, so price changes since the original order are reflected
- You can combine repeat orders with additional items - just add more items after cloning
- This feature works best for customers with predictable ordering patterns
