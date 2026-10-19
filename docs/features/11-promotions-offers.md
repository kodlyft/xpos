# Promotions & Offers

X POS includes a powerful promotions engine supporting automatic discounts, coupon codes, pricing rules, and promotional schemes.

In the desk, all of it lives under **Promotions & Offers** in the X POS dock: offers, coupons and referral codes, gift cards, and their setup.

> Looking for gift cards a customer can buy and someone else can spend over several visits? Those are **[stored-value Gift Cards](29-gift-cards.md)**, not coupons. The "Gift Card" coupon type below is a one-time discount for one customer and holds no balance.

---

## POS Offers

POS Offers are the primary way to configure promotions in X POS.

### Offer Types

| Offer Type | Description |
|---|---|
| **Item Price** | Discounts on specific items - rate override, percentage off, or fixed amount off |
| **Give Product** | Free item giveaways - buy X, get Y free |
| **Grand Total** | Discount on the entire order total |
| **Loyalty Point** | Award bonus loyalty points for qualifying purchases |

### Qualifying Criteria (Apply On)

Offers can be triggered based on:
- **Item Code** - Specific item purchased
- **Item Group** - Any item from a group
- **Brand** - Any item from a brand
- **Transaction** - Any transaction meeting thresholds

### Conditions

| Condition | Description |
|---|---|
| Minimum / Maximum Qty | Quantity thresholds to activate the offer |
| Minimum / Maximum Amount | Amount thresholds to activate the offer |
| Valid From / Valid Until | Date validity period |
| Company | Restrict to a specific company |
| POS Profile | Restrict to a specific POS Profile |
| Warehouse | Restrict to a specific warehouse |
| Coupon Based | Requires a coupon code to activate |

### Automatic vs. Manual Offers
- **Auto offers** - Applied automatically when conditions are met
- **Coupon-based offers** - Require the customer to provide a coupon code
- When enabled, auto offers are fetched and applied every time items change in the cart

### Discount Types for Item Price Offers
- **Rate** - Override the item price to a fixed rate
- **Discount Percentage** - Apply a percentage discount on the item
- **Discount Amount** - Deduct a fixed amount from the item price

### Give Product Offers
- Configure the **free item** and **quantity to give**
- Options:
  - Replace the triggering item with the free item
  - Replace the cheapest item in the cart
  - Only apply if the item rate is below a threshold

---

## Coupon Codes

### POS Coupon Setup

| Field | Description |
|---|---|
| Coupon Code | Unique code the customer provides |
| Coupon Type | Promotional or Gift Card (a single-use, customer-bound discount; see below) |
| POS Offer | The POS Offer this coupon activates |
| Valid From / Valid Until | Validity dates |
| Maximum Use | Maximum number of total redemptions; `0` means unlimited |
| Used Count | Counter of submitted sales that redeemed the coupon |
| One Use Per Customer | Limit to one submitted sale per customer for this coupon |
| Customer | Required for the Gift Card coupon type; it is the only customer who can use it |
| Campaign | Marketing campaign association |

### Applying a Coupon
The **Coupon** button is shown when **Allow coupon entry** is enabled on the POS Profile. It is independent of **Auto fetch coupons gifts**, which only controls fetching and auto-applying offers as items are added.

1. Click the **Coupon** button in the cart area
2. Enter the coupon code in the input field
3. Click **Apply** or press Enter
4. The system validates the coupon:
   - Is the code valid and active?
   - Are the dates within the validity window?
   - Has the maximum usage been reached?
   - Is the customer eligible? (for customer-specific coupons)
   - Has this customer already used a One Use Per Customer coupon?
   - Is the linked POS Offer enabled and in date, and does the coupon belong to this company?
5. If valid, the coupon's associated POS Offer is applied to the cart
6. Applied coupons appear as violet tags in the cart
7. Error messages are shown for invalid or expired coupons

### How Usage Is Counted
- The check in the cart is a preview. The same rules are enforced again when the invoice is submitted, and a sale that no longer qualifies is rejected.
- A use is a submitted Sales Invoice or POS Invoice carrying the coupon. Drafts and held orders do not count, and cancelling the invoice gives the use back.
- Returns and the consolidated Sales Invoice created at shift closing are not uses: the original sale was already counted.
- One Use Per Customer is counted per coupon and per customer, so using one coupon never blocks a different one.
- Validity dates are checked against the invoice's posting date when it is submitted.
- If two terminals redeem the same One Use Per Customer coupon at the same moment, one of them may be asked to try again.

### Promotional Coupons
- Open to every customer of the coupon's company unless a customer is set on the coupon
- Limited by Maximum Use (overall) and One Use Per Customer; with neither set they can be reused freely

### Gift Card Coupons
- A Gift Card coupon is a **discount**, not money: it applies its POS Offer once, for the one customer it names
- It has **no balance**. `maximum_use` is always 1 and `used` counts sales, so the first submitted sale uses it up, whatever the amount
- It cannot be bought by one person and spent by another, and it cannot be spent in parts
- For a card that holds an amount, can be given to anyone and spent over several visits, use [stored-value Gift Cards](29-gift-cards.md)

---

## Promotional Scheme Integration

X POS integrates with ERPNext's **Promotional Scheme** feature:

### How It Works
- Promotional Schemes defined in ERPNext are automatically converted to POS Offer-compatible format
- Both **Product Discount** rules (free items) and **Price Discount** rules (rate changes) are supported
- The conversion includes:
  - Discount type mapping
  - Item/group/brand qualification
  - Quantity and amount thresholds
  - Date validity

### Automatic Conversion
- When offers are loaded for the POS, Promotional Scheme rules linked to the POS Profile's price list are included
- No additional configuration needed - existing ERPNext Promotional Schemes work in X POS

---

## Pricing Rules

X POS also integrates with ERPNext's **Pricing Rules** engine for advanced pricing control.

### Features
- Active selling pricing rules are fetched based on:
  - Company and price list
  - Customer, customer group, and territory
  - Validity dates
- Rules can apply to specific items, item groups, or brands
- Cart prices are automatically reconciled with pricing rules

### Cart Price Reconciliation
- When pricing rules are active, cart prices are automatically calculated
- Adjusts per-line rates as needed
- Can add free item lines automatically
- Supports invoice-level adjustments

---

## Offer Application in the Cart

### Visual Display
- Applied auto offers appear as **green tags** on affected cart items
- Applied coupons appear as **violet tags**
- The offer description is shown alongside the tag
- Users can **manually remove** individual offers by clicking the remove button on the tag

### Offer Tracking
When the invoice is created, offer information is tracked:
- Which offers were applied to the order
- Which coupons were used
- Per-item offer details for reporting
- Free items are marked separately

---

## Tips

- Combine POS Offers with Promotional Schemes for maximum flexibility
- Use coupon-based offers for targeted promotions (email campaigns, loyalty rewards)
- Auto offers work best for store-wide or always-on promotions (e.g., "Buy 2 Get 1 Free")
- Monitor coupon usage through the system
- Gift Card coupons suit one-off goodwill discounts for a named customer; sell [stored-value Gift Cards](29-gift-cards.md) when the customer pays money for a card
