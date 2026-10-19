# Cart Management

The cart is the central workspace of X POS where items are collected, quantities adjusted, discounts applied, and orders finalized.

---

## Adding Items to the Cart

### Click to Add
- Click an item in the grid/list to add it to the cart with a quantity of 1
- Click the same item again to increment the quantity by 1
- The newly added item auto-scrolls into view with a brief highlight animation

### Stock Validation
- Before adding an item, the system checks available stock in the POS warehouse
- If the item is out of stock and `block_sale_beyond_available_qty` is enabled, an error message is shown
- Items with `allow_negative_stock` enabled (in Stock Settings) can be sold even with zero stock
- Batch items check batch-specific quantities

### Customer Requirement
- A **customer must be selected** before adding items to the cart
- If you try to add an item without selecting a customer, an error prompt appears
- The customer selection is locked during return mode

### Special Item Types
- **Serialized items** - Each serial number creates a separate cart line item
- **Batch items** - The batch selection dialog opens before adding
- **Bundle items** - Product bundle components are expanded and tracked automatically
- **Variant items** - The variant picker opens for template items

---

## Cart Item Controls

### Quantity Adjustment
- **+/- Buttons** - Click the plus or minus buttons on each line item to adjust quantity
- **Inline Quantity Edit** - Click the quantity value to type a custom quantity directly
- **Arrow Keys** - Use Arrow Up/Down while focused on a quantity input to navigate between cart items
- **Minimum Quantity** - Quantity cannot go below 1 (use Delete to remove items)

### Rate Editing
- If `allow_rate_change` is enabled in the POS Profile, the rate/price field is editable
- Click the rate value to enter a custom price
- Arrow keys navigate between rate inputs of different cart items
- Rate changes are reflected immediately in the line total and cart summary

### UOM Switching
- Click the **UOM label** on a cart item to expand the UOM selector
- Select a different unit of measure from the available options
- The rate auto-recalculates based on the UOM conversion factor
- Example: switching from "Piece" to "Box (12 pcs)" multiplies the unit price accordingly

### Item-Level Discount
- Toggle between **percentage (%)** and **amount** discount per line item
- Enter the discount value - the line total updates in real time
- The POS Profile can set a `max_discount_percentage_allowed` to cap discounts
- Cashiers choose the discount mode directly in the cart when editing a line item

### Delete Item
- Hover over a cart item to reveal the **Delete** (trash) button
- Click to remove the item from the cart
- No confirmation prompt - removal is instant

---

## Cart Summary & Totals

The cart summary at the bottom of the cart area displays a real-time breakdown of the order:

### Subtotal
- Sum of all line item amounts (quantity × rate) after item-level discounts

### Item Discounts Total
- Aggregate of all per-item discount amounts across all line items

### Tax Lines
Each tax from the POS Profile's Sales Taxes and Charges template is shown as a separate row:
- **Description** - Tax account name or label
- **Rate** - The tax rate percentage
- **Amount** - Calculated tax amount
- **Included indicator** - Shows if the tax is already included in the price (tax-inclusive pricing)
- Supports:
  - **On Net Total** - Percentage tax applied to item net amounts
  - **Actual** - Fixed tax amounts
  - **Per-item tax templates** - Items with their own tax template override the global rate
  - **Tax-inclusive pricing** - When `tax_inclusive` is enabled, taxes are back-calculated from prices

### Additional Discount
- Available when `allow_user_to_edit_additional_discount` is enabled
- Apply a **percentage** or **flat amount** discount to the entire order
- Toggle between percentage and amount using the mode switch
- Cashiers choose the discount mode directly in the discount panel
- Receipt output can still be formatted from the POS Profile using the `print_discount_amount` setting

### Loyalty Redemption
- If the customer has redeemed loyalty points, the deducted amount appears as a violet badge
- See [Loyalty Program](12-loyalty-program.md) for details

### Write-Off
- Small amount write-offs appear as an amber badge
- Useful for rounding adjustments
- See [Payment Processing](06-payment-processing.md) for details

### Grand Total
- The final amount due after all discounts, taxes, loyalty, and write-offs
- Rounding is applied unless `disable_rounded_total` is set in Global Defaults

### Multi-Currency
- If using a non-default currency, the conversion rate and currency symbol are displayed
- See [Multi-Currency](19-multi-currency.md) for details

---

## Cart Action Buttons

### Discount Button
- Opens a panel to apply an order-level discount
- Enter percentage or amount
- Discount is applied across the entire order

### Coupon Button
- Opens a panel to enter a **coupon code**
- The code is validated against the server:
  - Checks validity dates
  - Checks usage limits
  - Checks customer eligibility
- Applied coupons appear as tags in the cart
- Error messages are shown for invalid or expired coupons

### Hold Order (Clock Icon)
- Saves the current cart as a **draft invoice** on the server
- All cart data is preserved: items, customer, discounts, notes
- The cart is cleared after holding
- See [Draft & Held Orders](07-draft-orders.md) for details

### Restore Draft (File Icon)
- Opens the **Draft Invoice Dialog** to browse and restore held orders
- See [Draft & Held Orders](07-draft-orders.md) for details

### Clear Cart (Trash Icon)
- Empties all items from the cart
- Resets discounts, coupons, notes, and other order-level data
- Customer selection is preserved

### Pay Button
- Large gradient button at the bottom showing the **grand total**
- Opens the **Payment Dialog** for checkout
- Disabled if the cart is empty

---

## Additional Cart Features

### Order Notes
- A freeform **textarea** for special instructions or notes
- Can be enabled through your POS Profile settings
- Notes are saved with the invoice for reference

### Sales Person Assignment
- Select a **Sales Person** from a dropdown
- The sales person is linked to the invoice for commission tracking

### Per-Item Notes
- When enabled, each cart item can have its own notes field
- Useful for preparation instructions (e.g., "no onions", "extra sauce")
- Saved with each invoice item for reference
