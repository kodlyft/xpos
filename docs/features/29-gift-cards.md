# Gift Cards (Stored Value)

A gift card in X POS holds money. One customer pays for it. Whoever holds the code can then spend it over several visits until the balance runs out. The holder does not need to be the buyer, a registered customer or a loyalty member.

It is not the same thing as a **POS Coupon** whose type is "Gift Card":

| | POS Coupon ("Gift Card" type) | Gift Card (this page) |
|---|---|---|
| What it is | A discount code that applies a POS Offer | Money the store owes the holder |
| Bound to | One customer | Nobody: whoever has the code |
| Balance | None. It is used once (`maximum_use` = 1, `used` counter) | A currency amount, for example 100.50, spent in parts |
| Accounting | A discount on the sale | A liability when sold, which goes down when it is spent |

Existing POS Coupons are unchanged and keep working. Nothing converts coupon counters into card money.

---

## Where to find it

In the desk, open **Promotions & Offers** from the X POS dock. Its sidebar groups everything a promotion needs:

| Section | Contains |
|---|---|
| Offers | POS Offer, Promotional Scheme, Pricing Rule, Loyalty Program |
| Coupons & Referrals | POS Coupon, Referral Code |
| Gift Cards | Gift Card, Gift Card Transaction, Gift Card Liability report |
| Setup | Gift Card Settings, Mode of Payment, POS Profile |

---

## Setup

You only need to do this once per company.

1. **Liability account**
   - Create a ledger account under *Current Liabilities*, for example `Gift Card Liability - ABC`.
   - Leave its **Account Type** empty. Receivable and Payable are rejected, because ERPNext would then require a party on every entry.
   - Its currency must be the company currency.
2. **Mode of Payment**
   - Create a Mode of Payment named `Gift Card` with **Type = General**.
   - In its **Accounts** table, add the company and set **Default Account** to the liability account.
   - The Default Account dropdown on the Mode of Payment form only lists Cash, Bank and Receivable accounts. To pick a liability account, type the account name exactly, or set it with Data Import or the REST API. ERPNext itself does not restrict it.
3. **Item**
   - Create an Item, for example `GIFT-CARD`, with *Maintain Stock* **off** and *Is Sales Item* **on**.
   - You don't need to set any price, tax template or income account on it. X POS posts its sales to the liability account.
4. **Gift Card Settings**
   - Open **Gift Card Settings** and add a row: Company, Gift Card Liability Account, Gift Card Mode of Payment, Gift Card Item.
   - Optionally set a Minimum and Maximum card value, and **Valid For (Days)**. Leave it at 0 for cards that never expire.
   - Saving checks every link: the account must be a Liability ledger of that company, the Mode of Payment must be General and post to exactly that account, and the item must be a non-stock sales item.
5. **POS Profile**
   - Tick **Enable Gift Cards**.
   - Add the `Gift Card` Mode of Payment to the profile's **Payments** table.
6. **Permissions**
   - In **POS Role Permissions** there are two rights under *Sales Operations*: **Sell Gift Card** and **Accept Gift Card Payment**.
   - Manager and Administrator get both. Cashier gets neither until you enable them.
   - Only users listed on the POS Profile can use them.

Gift cards need a live connection to the server, so they are not offered in the desktop (Electron) app or while the till is offline. See [Limitations](#limitations).

---

## Walkthrough

### A buys a 100.50 card

1. Click the **gift** button in the cart footer, enter `100.50`, and click **Add gift card**.
2. The line carries no tax and is not rounded. A gift card sale holds only gift-card lines; a mixed cart is refused.
3. Take payment as usual, for example 100.50 in cash. The sale must be paid in full, and it cannot be paid with another gift card, loyalty points or a coupon.
4. When the sale is saved, a window shows the full code, for example `7Q2M-KX4P-9DTR-W258`, with a **Print card slip** button.
   - **This is the only time the code is shown.** The server keeps only a hash of it.
   - The invoice receipt shows the card masked (`••••-W258`) and its value.

Accounting (one Sales Invoice; ERPNext posts it):

| Account | Debit | Credit |
|---|---|---|
| Cash | 100.50 | |
| Gift Card Liability | | 100.50 |

No sales income is booked. Income is recognised when the card is spent on goods.

### B spends 30.25

1. Ring up the goods. In **Payment**, click **Pay with Gift Card**, type or scan the code, and click **Apply**.
2. The server checks the card is active, belongs to this company and currency, has not expired, and has a balance. It then applies the lower of the balance and what is due.
3. Submit. The card now holds 70.25. The receipt shows `Gift Card ••••-W258 · Balance 70.25`.

| Account | Debit | Credit |
|---|---|---|
| Gift Card Liability | 30.25 | |
| Sales (and tax accounts, as usual) | | 30.25 |

B can come back later and spend the remaining 70.25. When the balance reaches 0, the card is **Depleted**.

### Split payment: 120 of goods with a 100 card

Apply the card (100), then add **Cash 20** as a split payment. Change can only ever come from cash, never from card value. A card can never pay more than the invoice total.

Once a gift card is in the tender, the total is not rounded, so the card pays to the cent.

---

## Returns, cancellations and adjustments

| What happens | Effect on the card |
|---|---|
| A sale paid by card is **returned** | Use **Refund to gift card ••••1234** in the payment window. The refund is capped at what that card paid on the original sale, less earlier refunds. Any rest goes back in cash. |
| A sale paid by card is **cancelled** | Each amount taken from the card is put back, exactly once. |
| A return is cancelled | The refund is taken off the card again. This is refused if the card no longer holds it. |
| The card sale itself is returned or cancelled | Allowed only while the card still holds its full value, that is, nothing has been spent, or every spend was reversed. The card becomes **Voided** and the buyer is refunded. Partial returns of a card are refused. |
| A voided card | Cannot be spent, refunded to, or adjusted. |
| **Balance adjustment** (damaged card, goodwill and so on) | An Accounts Manager posts a Journal Entry against the gift card liability account, then calls `xpos.api.gift_cards.adjust_gift_card(gift_card, journal_entry, remarks)`. The card moves by exactly what the Journal Entry moved on the liability, and each Journal Entry can be used once. Balances are never edited by hand. |

Every movement is a **Gift Card Transaction**:
- Types are Issue, Redeem, Refund, Void and Adjustment.
- Each row records the voucher, the user and a `reverses` link to the row it undoes.
- Transactions cannot be edited or deleted. Gift Card records are read-only.

---

## Shifts and reports

- **Shift close:**
  - Gift cards sold for cash count in the till's **Cash** expected amount.
  - Spending a card adds **no** cash. It shows on its own **Gift Card** row, which is filled in automatically and cannot be edited, because there is nothing to count.
- **Gift Card Liability** report (*Promotions & Offers > Gift Cards*). Filters: Company, From/To Date, Gift Card. For each card it shows opening, issued, redeemed, refunded, voided, adjusted and outstanding amounts, with the code masked. The summary reconciles the card ledger with the books:
  - **Ledger outstanding:** the sum of all card balances.
  - **Pending shift consolidation:** card movements on POS Invoices not yet consolidated, which have not reached the GL yet.
  - **GL balance:** the balance of the liability account.
  - **Difference:** ledger − pending − GL. It should be 0.
  - **Cards out of step with their ledger:** it should be 0.

---

## Security

- **Codes:** 16 characters from a 32-letter alphabet (80 random bits), stored only as a SHA-256 hash. Logs, receipts and lists show only the last four characters.
- **Balance checks:** checking a balance is limited per IP. After 10 unknown codes in 10 minutes, the cashier is locked out for that period.
- **Tender tokens:** a balance check hands the till a 15-minute token tied to the card, the cashier and the POS Profile. A payment row is only accepted with a live token from the same cashier. Building an invoice in the desk with the Gift Card mode is refused.
- **No cached lists:** cashiers and offline caches never receive lists of cards or codes.

---

## Limitations

- **Online only.**
  - Selling or spending a card needs a live connection. Gift cards are hidden in the desktop (Electron) app, which saves every sale locally first.
  - Sales with gift cards never enter the offline queue. A sale queued some other way is refused when it syncs, because its token has expired.
  - If the connection drops after you press Pay, press Pay again: the same sale is recognised and never charged twice.
- **One currency:** cards are in the company currency and can be spent only on invoices in that currency.
- **No reprint of a lost code:** if the customer loses the code before using the card, return the card sale (which voids it) and sell a new one.
- **No sales tax on the card sale:** tax is charged on the goods when the card is spent. If your jurisdiction taxes gift-card sales, do not use this feature as it stands.
- **No expiry or breakage accounting:** expired cards stop being accepted, but their balance stays in the liability until an Accounts Manager adjusts it with a Journal Entry.
- **No transfer to store credit:** a card cannot be converted into a customer's credit balance. This is not supported in this version.
- **Payment terminals:** card-terminal payments are recorded the way the cashier enters them. There is no payment-gateway authorisation step.

---

## Architecture notes (for developers)

### Records
- **Gift Card** holds the code hash, last four characters, company, currency, issued value, a cached balance and a status.
- **Gift Card Transaction** is the immutable, signed ledger. A unique `operation_id` makes every movement exactly-once, for example `redeem:Sales Invoice:SINV-1:<payment row>`.
- The cached balance is checked against a locking `SUM` of the ledger on every write.

### Where the logic runs
- Everything happens in the invoice's own `validate`, `before_submit` and `before_cancel` hooks (`xpos/x_pos/gift_cards.py`).
- So value moves in the same MariaDB transaction as the invoice, whether it is submitted directly, by the background job, or after local FBR fiscalisation.
- Drafts move nothing.
- The card row is locked with `SELECT … FOR UPDATE`. Two tills spending the last balance queue on the lock, and the second one sees the reduced balance.

### Accounting
ERPNext posts every entry; nothing writes GL rows directly.
- **Issue:** a Sales Invoice line whose income account is forced to the liability. The result is Dr Cash, Cr Liability.
- **Redeem:** a payment row on the General Mode of Payment that maps to the liability. The result is Dr Liability, Cr Debtors.
- **Rejected alternatives:** a Payment Entry would need a party and lands in Debtors. A Journal Entry would sit outside the shift and the receipt. A discount would understate revenue.

### POS Invoice mode
- Card movements are recorded when the POS Invoice is submitted.
- The consolidated Sales Invoice (`is_consolidated`) carries the merged Gift Card payment row and posts the GL once. It never moves card value again.

### Idempotency
- Invoices are deduplicated by `local_id` before any token check.
- A retried card sale returns the same code once, for 15 minutes, to the same cashier.

### Future work: offline support
Offline redemption would need:
- Server-issued reservations (holds) with expiry.
- Per-terminal reconciliation of holds against synced sales.
- A policy for sales that sync after their hold has lapsed.

None of this exists yet.
