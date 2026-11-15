# Selling on XPOS Mobile

For cashiers using the XPOS Mobile app (Android). Needs ERPNext 16 with XPOS, and a user assigned to a POS Profile. For requirements and what the app cannot do yet, see the [XPOS Mobile overview](35-xpos-mobile-overview.md).

## Start of day

1. Open the app, enter your server address, sign in with your ERPNext user. If you are assigned to more than one POS Profile, choose the one this device sells for.
2. Set a 6-digit PIN (first time only). It unlocks this device; it is not your ERPNext password.
3. Wait for the catalog the first time (a large catalog takes a short while). Later it only fetches changes. **Device** shows when it was last refreshed.
   A catalog of tens of thousands of items downloads in pages of 500 with a progress count; a dropped connection retries that page instead of starting over. **Device > Catalog** shows how many items are on this device. The Sell list loads 40 items at a time (**load more**); search always looks at the whole catalog.
4. If the cart shows **Open shift to start selling**, tap it and enter the opening amount for each payment method.

## Making a sale

1. Search by the start of a name or code, or scan a barcode. Items marked **No price** cannot be sold: ask a manager to add a price in ERPNext. An item priced 0.00 can be added, but ERPNext refuses the sale unless the POS Profile allows zero-priced items. A barcode printed for a box or case that the phone does not have is looked up on the server and adds the box at the box price (needs a connection); a weighed-item barcode is not supported yet.
2. Change layout any time (Catalog, Scan, Fashion). The cart stays.
3. Check the **customer** at the top of the cart (see below). The cart shows what ERPNext will charge this customer: the price list rate, any promotion or discount on a line, taxes and the rounded total. Prices appear a moment after each change; **Charge** waits until they are ready.
4. Tap **Charge**. The app asks ERPNext once more for the amount due. Choose how the customer pays; for cash enter what they hand over and the app shows the change. For card or transfer, enter the terminal or transfer reference (required when your company marks that method as needing one) and tick the cashier-confirmed box. The receipt shows "(cashier-confirmed)": XPOS does not check the payment with the terminal or bank, and the sale records what you entered.
5. Tap **Take payment**. The sale is saved on the device first, then sent to ERPNext. The receipt shows **Posted to ERPNext as <invoice>** when ERPNext has created it. Printing is not available yet.

## Customers

The customer on the sale is shown at the top of the cart. Until you choose one it is the POS Profile's default (walk-in) customer.

- Tap it to **search** by name or mobile number. Only customers you are allowed to sell to are listed (your POS Profile's customer groups and your ERPNext User Permissions), and the phone never downloads a customer list. Searching needs a connection.
- A chosen customer shows their price list, discount, balance, credit limit and loyalty points.
- **Changing the customer** re-prices the whole cart for the new customer. Coupons, loyalty points, manual discounts and prices you set for the previous customer are removed, and a message says so. Use **Use the default customer** to go back.
- **New customer** and **Edit** appear only if your ERPNext user may create or edit customers. You enter a name, mobile number and email. A mobile number that already belongs to a customer is refused; sending the same new customer twice gives you the one customer. The customer group and discount are changed in ERPNext.

## Prices, promotions and discounts

All prices come from ERPNext, using the same rules as the web POS: the customer's price list and customer prices, quantity and promotion rules (including free items), the customer's own discount, taxes and rounding. The phone does not calculate prices itself.

- A line with a promotion or discount shows the percentage and the price it was reduced from.
- If ERPNext cannot price part of the sale on a phone (for example serial or batch items, or a coupon that gives a product), **Charge** is switched off and the reason is shown. Use the web POS for that sale.
- **Coupons, points, discount** on the cart: enter a coupon code; redeem loyalty points (shown when the customer is in a loyalty program); and, if you hold the Additional Discount permission, give an extra percentage off the whole sale.
- The slider button on a line (shown only if you hold the permission) sets a discount percentage or a price for that line. Your discount limit and the POS Profile's maximum apply. When ERPNext turns a change down, the cart shows why, for example "not permitted to discount" or "exceeds maximum allowed".
- There is no manager PIN: what you can do is set by your XPOS role.

## Gift cards

Gift cards need a connection and a POS Profile with gift cards switched on.

- **Sell a gift card** (empty cart, needs the Sell Gift Card permission): enter the value, confirm, take payment. The card code is shown once on the receipt screen and is not stored on the phone. Give it to the customer, tick that they have it, then close. A card is sold on its own, without tax or discount.
- **Pay with a gift card** (needs the Redeem Gift Card permission): on the payment screen type the code and tap **Check**. The card shows its masked number and balance; the amount is limited to the balance and to the amount due. The receipt shows the balance left on the card.
- If the connection drops while a card sale or redemption is being sent, the sale is retried with the same sale id, so a card is never issued or spent twice.

## Account

The **Account** tab shows who is signed in, the POS Profile, company, warehouse, price list, default customer and shift, and the XPOS permissions your role gives you on this profile.

- **Lock the app**; unlock with your PIN (works offline, only for the signed-in cashier).
- **Confirm your ERPNext password** renews the server session.
- **Switch POS Profile** (when you are assigned to more than one) clears the cart and asks for a new PIN. Sales still waiting under the old profile stay on the phone and are sent when you switch back.
- **Sign out / change user** removes the PIN. Sales waiting to be sent stay on the phone and are sent only when the same user signs in again; another user never sends them.

Users and roles are not created or changed on the phone. An administrator does that in ERPNext and in the web POS under Role Permissions.

## When something goes wrong

Errors and warnings (wrong PIN, a failed sign-in, a refused payment, a catalog refresh problem, a barcode that is not found) appear as a short message at the top of the screen. Tap **x** to dismiss it, or wait a few seconds. The **Device** screen scrolls to the bottom (Sign out, Lock now).

Nothing you have charged is ever lost or deleted. The **Sales** tab lists every sale with its status:

- **Held / no answer**: the connection or your session was lost. The sale will be sent again automatically with the same sale id, so it can never be posted twice. If your session expired, a **Sign in again** box appears; your cart is kept.
- **Prices changed**: ERPNext priced the sale differently from what you were shown. Tap **Review new prices**, take payment for the new amount, and it is sent again.
- **Rejected**: ERPNext refused the sale (for example stock or a rule). It stays on the device for a manager to reconcile; tell your manager.
- **Fiscal pending**: the invoice exists but its fiscal (FBR) step is not finished. It is not complete and no new sale can start on this device until it is finished in the web POS.

Offline: you can still search the last catalog, but **Charge** is switched off until the device is online, because stock, serial/batch and receipt checks need the server. Sales already saved are sent when you are back online.
