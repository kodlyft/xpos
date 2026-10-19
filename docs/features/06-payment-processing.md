# Payment Processing

X POS supports flexible payment processing with multiple payment methods, split payments, loyalty redemption, and write-offs.

---

## Payment Dialog

Clicking the **Pay** button opens a full-screen payment dialog where you complete the transaction.

### Dialog Layout
- **Amount Due / Refund Amount** - Large, prominent display of the total amount to be paid (or refunded for returns)
- **Tax Summary** - Subtotal, individual tax lines with inclusive indicators
- **Payment Method Selector** - Buttons for each configured mode of payment
- **Amount Input** - Editable field for the tendered amount
- **Quick Amount Buttons** - Pre-calculated rounded amounts near the total
- **On-Screen Numpad** - Touch-friendly number pad (hidden on mobile devices for space)

---

## Payment Methods

Payment modes are configured in the POS Profile and typically include:

| Mode | Icon | Description |
|---|---|---|
| Cash | Banknotes | Physical cash payment |
| Card | Credit card | Debit/credit card payments |
| Bank Transfer | Building | Direct bank transfers |
| Mobile Money | Phone | Mobile money payments |
| Check | Document | Payment by check |
| Custom modes | - | Any other mode defined in ERPNext |

### Selecting a Payment Method
- Click the payment method button to select it
- Use **Left/Right arrow keys** to navigate between methods
- The selected method is highlighted

---

## Single Payment

1. Select a payment method (default is Cash)
2. The **tendered amount** auto-fills with the grand total
3. Adjust the amount if the customer pays a different amount
4. **Quick amount buttons** offer convenient options:
   - **Exact amount** - Matches the grand total exactly
   - **Next 10** - Rounds up to the nearest 10
   - **Next 50** - Rounds up to the nearest 50
   - **Next 100** - Rounds up to the nearest 100
5. If the tendered amount exceeds the grand total, the **change amount** is automatically calculated and displayed

---

## Split Payments

Enable split payments to accept multiple payment methods on a single transaction.

### How to Use
1. Toggle **Split Payment** mode in the payment dialog
2. Select the first payment method and enter the amount
3. Click **Add** to record this payment
4. Select the next payment method and enter its amount
5. Repeat until the full amount is covered
6. The dialog shows:
   - Running list of payments with method and amount
   - **Remaining amount** still due
   - **Total tendered** across all methods

### Example
- Order total: $150
- Cash: $100
- Card: $50
- ✅ Fully paid

---

## Quick Amount Buttons

For faster checkout, quick buttons appear based on the grand total:

| Button | Calculation |
|---|---|
| Exact | Grand total amount |
| ↑10 | Ceiling to next multiple of 10 |
| ↑50 | Ceiling to next multiple of 50 |
| ↑100 | Ceiling to next multiple of 100 |

Clicking a quick button fills the tendered amount and auto-calculates change.

---

## Change Calculation

- When the tendered amount exceeds the amount due, the **change** is calculated and displayed
- Change = Tendered Amount − Grand Total
- Change is shown prominently so the cashier knows the exact amount to return

---

## Mixed-Currency Cash Payment and Change

Some stores take more than one currency of cash across the same counter: a Beirut shop prices in
LBP but accepts US dollar notes at a rate the owner sets by hand each morning. Turning on
`pos_mixed_currency_tender` in the POS Profile lets one invoice be settled with a mix of both, and
lets the change go back as a mix of both.

**The invoice itself stays single-currency.** Only the payment legs are mixed. This is not the same
feature as `allow_multi_currency`, which switches the whole invoice into another currency - see
[Multi-Currency](19-multi-currency.md) for the distinction.

### Setup

| Setting | Where | Why |
|---|---|---|
| `pos_tender_currency` | Mode of Payment | Tags the mode as taking foreign notes. Blank means the invoice currency. |
| `type = Cash` | Mode of Payment | Change can only be handed back through a cash mode. |
| Mode of Payment Account | Mode of Payment | Must point at a **company-currency** cash account, shared by both modes. |
| `pos_mixed_currency_tender` | POS Profile | Shows the change allocator. |
| `cash_mode_of_payment` | POS Profile | The drawer change comes out of by default. |
| `post_change_gl_entries` | POS Settings | Must stay enabled. A server guard refuses the sale if it is turned off. |
| Currency Exchange record | Daily | One row per day, with **For Selling** ticked. |

The drawer is a single company-currency account. The dollar figure is reconciliation metadata, not
a second ledger: there is no FX gain or loss tracking.

### Taking the payment

1. Select the foreign cash mode. The tendered field switches to that currency's own decimals.
2. Type the note value the customer handed over, e.g. `100`.
3. A line underneath shows the conversion and the rate's date: `$100.00 at 90,000 = L£9,000,000`.
   An amber warning appears if the rate was not set today.
4. The change due is calculated in the invoice currency as usual.

### Splitting the change

When change is due, the allocator lists one row per currency being handed back.

1. A single row in the invoice currency is seeded automatically, so the ordinary case needs no
   interaction at all.
2. Edit that row down and click a currency button to add another leg. The button shows what the
   outstanding change works out to in that currency, so the cashier does not have to divide.
3. The legs must account for the change exactly, within one minor unit of the invoice currency.
   The submit button stays disabled until they do.

### Worked example

Invoice 5,892,300 LBP. Customer hands over a $100 note at 90,000.

| Leg | Native | In LBP |
|---|---|---|
| Tender - Cash USD | $100.00 | 9,000,000 |
| Change - Cash USD | $30.00 | 2,700,000 |
| Change - Cash LBP | 407,700 | 407,700 |

The drawer nets **+$70 and −407,700 LBP**, and `70 × 90,000 − 407,700` is 5,892,300 exactly.

### What gets recorded

| Field | Holds |
|---|---|
| `Sales Invoice Payment.amount` | Always the invoice-currency value. ERPNext sums it into `paid_amount`. |
| `pos_tender_currency` / `pos_tender_amount` | The notes actually handed over. ERPNext never touches these. |
| `pos_exchange_rate` | The rate at submit time, frozen so a later rate change never restates the invoice. |
| `POS Change Leg` rows | One per currency handed back, positive, summing to `change_amount`. |

The rate is always resolved **server-side**. A rate sent by the till is treated as a checksum: if
it disagrees with the server's, the sale is rejected and the cashier is told to reload. That is
also why a foreign-currency invoice queued offline and replayed after the rate changed will error
loudly and has to be re-rung.

### At shift close

The count sheet asks for each mode in its own currency - `$270` and `592,300 LBP` as separate
lines, never one blended figure. Change is subtracted from the mode that actually gave it, not
spread across every mode used on the invoice.

---

## Loyalty Point Redemption

If the selected customer is enrolled in a loyalty program and has available points:

1. The dialog shows the customer's **loyalty points balance** and its **monetary value**
2. Click **Redeem Points** to apply loyalty points toward the payment
3. The system auto-calculates how many points to redeem (capped at the order total)
4. The redeemed amount is deducted from the amount due
5. Click **Remove Loyalty** to undo the redemption before submitting
6. See [Loyalty Program](12-loyalty-program.md) for full details

---

## Gift Card Payment

When gift cards are enabled on the POS Profile and the till is online:

1. Click **Pay with Gift Card**, then scan or type the code and click **Apply**
2. The server returns the card's balance. The lower of the balance and the amount due is added as a split-payment row showing the masked card (`••••-1234`)
3. Pay any rest with another method. Change is only ever given from cash
4. Once a card is tendered the total is no longer rounded, so the card pays to the cent

The Gift Card mode never appears as a plain payment button: it can only be used through a checked card. See [Gift Cards](29-gift-cards.md).

---

## Write-Off

- A small **write-off** field is available when `allow_write_off_change` is enabled
- Use it to write off minor rounding differences
- Example: Order total is $10.02, customer pays $10.00 - write off $0.02
- Written-off amounts appear as an amber badge in the cart summary

---

## Customer Credit

When `use_customer_credit` is enabled:

1. Available customer credits are shown in the payment dialog
2. Credits come from:
   - **Unallocated Payment Entries** - Advance payments from the customer
   - **Credit Notes** - Refunds or return credits
3. Enter how much to use from each source; the rest can be paid by any other method
4. The applied credit reduces the amount due

Credit needs a live connection (it is not offered offline or on the desktop app) and Sales Invoice mode. The server re-checks every amount when the sale is saved, so two tills cannot spend the same credit. See [POS Profile Settings: Implementation Status](pos-profile-settings-status.md#business-rules).

---

## Submitting the Invoice

### Validation Before Submit
- Cart must not be empty
- Customer must be selected
- For returns: all items must have negative quantities
- Grand total must have the correct sign (positive for sales, negative for returns)
- Stock validation: checks batch quantities and stock availability

### Submit Actions
- **Save & Print** - Creates and submits the invoice, then opens print preview (keyboard: **Enter**)
- **Save Only** - Creates and submits the invoice without printing (keyboard: **Shift+Enter**)

### What Happens After Submit
1. The invoice is created via the `create_invoice` API
2. The invoice is submitted (or queued for background submission if enabled)
3. If printing is selected, the print preview opens in a new window
4. The `lastInvoiceName` is stored for "Print Last" functionality
5. The cart is completely cleared
6. The POS is ready for the next transaction

### Background Submission
- When `allow_submissions_in_background_job` is enabled, invoices are submitted asynchronously
- This speeds up the checkout process for busy POS stations
- The invoice is created as a draft and submitted in a background job

---

## Offline Payment Handling

- If the POS is **offline** when you submit a payment, the invoice is automatically saved to the IndexedDB queue
- If a **network error** occurs during submission, the system falls back to offline save
- Queued invoices sync automatically when the connection is restored
- See [Offline Mode](16-offline-mode.md) for details

---

## Return Payments

When processing returns, the payment dialog adapts:
- Labels change to "Refund Amount" and "Return & Print"
- The grand total is negative
- The refund amount is clearly displayed
- All items must have negative quantities

---

## Keyboard Shortcuts

| Key | Action |
|---|---|
| `Enter` | Save & Print |
| `Shift+Enter` | Save Only |
| `Esc` | Cancel / Close dialog |
| `←` / `→` | Navigate payment methods |
| `↑` / `↓` | Navigate between input areas |
