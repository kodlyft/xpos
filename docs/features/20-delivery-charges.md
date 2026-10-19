# Delivery Charges

X POS supports configurable delivery and shipping charges that can be applied to orders, with per-POS-Profile rate overrides.

---

## Overview

Delivery charges allow POS operators to:
- Add a delivery/shipping fee to an order
- Select from pre-configured delivery options
- Apply profile-specific delivery rates
- Track delivery charges in accounting

---

## Configuration

### Delivery Charges Setup
Each delivery charge option is defined in the system:

| Field | Description |
|---|---|
| Name | Name of the delivery option (e.g., "Standard Delivery", "Express Delivery") |
| Company | Company to which this charge belongs |
| Default Rate | Default delivery charge amount |
| Disabled | Disable this option |
| Shipping Account | Revenue account for the charge |
| Cost Center | Cost center for accounting |
| Per-Profile Rates | Rate overrides for different POS Profiles |

### Per-Profile Rate Overrides
You can configure different rates per POS Profile:

| Field | Description |
|---|---|
| POS Profile | The POS Profile |
| Rate | Override rate for this profile |

This means the same delivery option (e.g., "Standard Delivery") can cost different amounts at different POS locations.

---

## Using Delivery Charges

### Applying a Charge
1. When enabled in your POS Profile, delivery options are available
2. Select a delivery option from the available choices
3. The charge amount is added to the invoice

### Auto-Apply
When auto-apply is enabled:
- Delivery charges are automatically applied based on the customer, shipping address, and POS Profile
- No manual selection needed

### Invoice Impact
- The delivery charge is recorded on the Sales Invoice
- The charge posts to the configured shipping account and cost center

---

## Rate Resolution

The system resolves the delivery rate in this order:
1. **Per-profile rate** - If the POS Profile has an override rate, use it
2. **Default rate** - If no profile override exists, use the default rate
3. Only active (non-disabled) delivery charges are shown

---

## Tips

- Create multiple delivery options for different speed/price tiers (Standard, Express, Same-Day)
- Use per-profile rate overrides when different store locations have different delivery costs
- The shipping account allows proper revenue recognition for delivery services
- Combine with delivery dates per item for scheduled delivery workflows
