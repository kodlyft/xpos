# Referral Program

X POS includes a referral system where existing customers can refer new customers, and both parties receive promotional rewards.

---

## Overview

The referral system works through:
- **Referral Codes** - Unique codes assigned to customers
- **POS Offers** - Rewards for both the referrer and the referred customer
- **POS Coupons** - Auto-generated coupons linked to referral codes

---

## Referral Code Setup

Each referral code is defined with:

| Field | Description |
|---|---|
| Referral Code | Unique code the customer shares (set once, read-only after creation) |
| Customer | The referring customer |
| Customer Name / Mobile / Email | Customer details (auto-filled) |
| Company | Company scope |
| Campaign | Marketing campaign association |
| Customer Offer | Offer given to the **new** customer |
| Primary Offer | Offer given to the **referring** customer |
| Disabled | Disable this referral code |

---

## How It Works

### For the Referring Customer (Existing Customer)
1. A Referral Code is created and linked to the customer
2. The customer shares their referral code with friends/family
3. When a new customer uses the code, the primary customer receives their reward

### For the Referred Customer (New Customer)
1. During customer creation at the POS, the cashier enters the **referral code**
2. The system validates the referral code
3. A POS Coupon is auto-generated for the new customer linked to the `customer_offer`
4. The new customer can redeem this coupon on their first purchase

### Reward Distribution
- **Customer Offer** - The reward (discount, free item, etc.) given to the new customer
- **Primary Offer** - The reward given to the existing customer who made the referral
- Both offers are configured as POS Offers with full flexibility (percentage discount, free product, etc.)

---

## Customer Fields for Referrals

| Field | Description |
|---|---|
| Referral Code | The customer's referral code (if they are a referrer) |
| Referral Company | Company scoping for the referral |

---

## Using Referral Codes at POS

### New Customer Registration
1. Open the Customer Selection Dialog
2. Click **Create New Customer**
3. Fill in the customer details
4. Enter the **Referral Code** in the referral code field
5. Click **Create & Select**
6. The referral is registered, and the appropriate coupon is generated

### Redemption
- The referred customer's coupon can be redeemed through the normal coupon flow at checkout
- The referring customer's reward coupon is created when the referral's primary offer is configured

---

## Tips

- Referral programs are powerful for organic customer acquisition
- Set compelling offers for both parties to encourage sharing
- Link referrals to marketing campaigns for tracking effectiveness
- Monitor referral code usage through reporting
- Combine with loyalty programs for a comprehensive customer engagement strategy
