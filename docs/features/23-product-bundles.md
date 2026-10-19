# Product Bundles

X POS supports ERPNext's Product Bundle feature, allowing stores to sell predefined groups of items as a single unit while tracking individual component items for inventory.

---

## Overview

A Product Bundle (also known as a "kit" or "combo") is a parent item that represents a collection of component items. When sold at the POS:
- The **parent item** appears on the invoice
- The **component items** are tracked for stock and accounting purposes

---

## How It Works

### Adding a Bundle to the Cart
1. Browse or search for a bundle item (it appears like any regular item)
2. Click to add it to the cart
3. X POS automatically resolves the bundle components in the background

### Bundle Component Resolution
The `get_bundle_components` API:
- Takes a list of bundle item codes
- Returns the component items for each bundle with:
  - **Item code** - The component item
  - **Quantity** - Qty of the component per bundle
  - **UOM** - Unit of measure
  - **Is batch item** - Whether the component uses batch tracking
  - **Is serial item** - Whether the component uses serial numbers
  - **Is stock item** - Whether the component is a stock item

### Example
A "Breakfast Combo" bundle might contain:
- 1x Coffee (stock item)
- 1x Croissant (stock item, batch tracked)
- 1x Orange Juice (stock item)

When the cashier adds "Breakfast Combo" to the cart, X POS knows it needs 1 Coffee, 1 Croissant, and 1 OJ from inventory.

---

## Inventory Impact

### Stock
- Component items are deducted from stock when the invoice is submitted
- The parent bundle item itself does not have a stock entry
- Each component's stock is tracked independently

### Batch & Serial Number Support
- Components with batch tracking require batch selection
- Components with serial numbers require serial number selection
- The Item Detail Dialog opens for components that need this information

---

## Invoice Display

- The parent bundle item appears as the line item on the invoice
- Component items are tracked as **Packed Items** in ERPNext
- Print formats can be customized to show either:
  - Only the bundle name (simple view)
  - Bundle name with component details (detailed view)

---

## Configuration

### Setting Up Product Bundles
1. In ERPNext, navigate to **Product Bundle** doctype
2. Create a new Product Bundle
3. Set the **Parent Item** - the bundle item customers see
4. Add **Component Items** with quantities
5. Save and use the parent item in your POS

### Requirements
- The parent item should be a non-stock item (it represents the bundle concept)
- Component items can be stock or non-stock items
- Pricing is set on the parent item in the Price List

---

## Tips

- Product bundles are great for combo deals, kits, and gift sets
- Combine with POS Offers for "buy this bundle, get a discount" promotions
- Use different bundles for different meal deals or seasonal combos
- Monitor component stock levels - running out of any component affects the bundle's availability
- Bundle pricing can be set independently of component prices (allowing bundle discounts)
