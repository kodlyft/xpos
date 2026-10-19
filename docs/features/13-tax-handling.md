# Tax Handling

X POS provides a sophisticated tax engine supporting multiple tax accounts, per-item tax templates, tax-inclusive pricing, and bulk tax resolution.

---

## Tax Configuration

### POS Profile Tax Template
- Taxes are configured via the **Sales Taxes and Charges Template** assigned to the POS Profile
- The template defines one or more tax accounts, each with:
  - **Account Head** - The tax account in the Chart of Accounts
  - **Rate** - The tax percentage
  - **Charge Type** - How the tax is calculated:
    - `On Net Total` - Percentage of item net amounts
    - `Actual` - Fixed amount

### Tax-Inclusive Pricing
- When enabled in your POS Profile, item prices **include tax**
- The system back-calculates the tax component from the inclusive price
- Tax lines in the cart summary show an "included" indicator

---

## Per-Item Tax Templates

### Item Tax Templates
- Individual items can have their own **Item Tax Template** that overrides the global POS Profile rates
- For example, food items might have 5% VAT while electronics have 15%

### How It Works
1. When an item is added to the cart, the system resolves its applicable tax template
2. Resolution follows ERPNext's hierarchy:
   - Checks the item's direct tax configuration first
   - Falls back to the item's parent item group
   - Continues up the item group hierarchy
3. Validity dates are respected (`valid_from` dates)
4. Tax categories are matched if applicable

### Item Tax Map
- Each item's tax template produces an `item_tax_map` - a mapping of tax account → rate
- When calculating taxes, the cart engine uses:
  - The item-specific rate (from `item_tax_map`) if available
  - The global POS Profile rate if no item-specific rate exists

---

## Tax Calculation in the Cart

### Real-Time Calculation
Taxes are calculated in real-time as items are added, modified, or removed from the cart:

1. For each tax account in the POS Profile template:
   - Loop through all cart items
   - Determine the applicable rate (item-specific or global)
   - For `On Net Total`: `tax = item_net_amount × rate / 100`
   - For `Actual`: use the fixed amount
   - Check if tax is `included_in_print_rate`:
     - **Included**: Back-calculate tax from inclusive price - `tax = amount - (amount / (1 + rate/100))`
     - **Not included**: Calculate tax additive - `tax = net_amount × rate / 100`
2. Extra tax accounts from item tax maps (not in the global template) are added as additional tax lines
3. All amounts are rounded to 2 decimal places

### Cart Summary Display
Each tax line shows:
- **Description** - Tax account name or label
- **Rate** - The percentage rate
- **Amount** - Calculated tax amount
- **Included indicator** - Whether the tax is already included in item prices

---

## Bulk Tax Resolution

### API Endpoints
- `get_item_tax_template` - Resolves the applicable tax template for a single item
- `get_item_tax_templates_bulk` - Resolves tax templates for multiple items in one call (used during cart initialization and item loading)

### Offline Tax Caching
- Item tax templates are cached locally for offline use
- Cached per item and company combination
- Refreshed during periodic sync cycles

---

## Tax Summary in Shift Closing

When closing a shift, the POS provides a complete tax summary:
- Aggregated tax amounts across all invoices in the shift
- Breakdown by tax account head
- Rate and total amount per account
- This helps with tax reporting and reconciliation

---

## Special Cases

### Zero-Rated Items
- Items with a 0% tax rate are supported when `allow_zero_rated_items` is enabled
- These items appear in the cart but contribute zero tax

### Mixed Tax Rates
- A single cart can contain items with different tax rates
- Each tax line aggregates correctly across all items
- The grand total reflects the correct total tax amount

### Multi-Company
- Tax templates are resolved per-company
- The selected POS Profile's company determines which tax templates are applicable

---

## Tips

- Configure your tax templates carefully before going live
- Test tax calculations with sample items to verify rates
- Use item tax templates when different products have different tax rates
- Tax-inclusive pricing is popular for retail environments where customers expect to see final prices
