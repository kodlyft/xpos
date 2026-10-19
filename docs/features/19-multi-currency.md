# Multi-Currency

X POS handles two different currency problems, and they are easy to confuse. This page separates
them.

| | Invoice currency | Payment-mode currency |
|---|---|---|
| What varies | The whole invoice, including item rates | A single payment leg |
| Setting | `allow_multi_currency` (POS Profile) | `pos_tender_currency` (Mode of Payment) |
| Rate applies to | Every line and total | Only the tendered notes |
| Frontend support | **Not implemented** - see below | Implemented |

If you are looking for "the customer paid in dollars but we bill in pounds", you want the
payment-mode currency, documented in
[Payment Processing](06-payment-processing.md#mixed-currency-cash-payment-and-change).

---

## Invoice Currency

`allow_multi_currency` is an ERPNext-level capability: a Sales Invoice can be denominated in a
currency other than the company's, with `conversion_rate` translating every figure back to the
base currency for the ledger.

**The X POS frontend does not expose this.** There is no cart currency selector and no
dual-currency totals display in the POS screen; earlier versions of this page described both, and
neither has ever existed in the Vue app. The cart is always denominated in the POS Profile's
currency.

Invoices in another currency can still be created in the ERPNext Desk UI, and X POS reads them
correctly - the closing shift's overview groups totals by `(mode of payment, currency)` and
records both transaction and base amounts. What is missing is a way to *ring one up* from the POS.

`allow_multi_currency` should stay **off** for a store using mixed-currency tender. The two are
independent, and turning it on adds an invoice-level conversion that the tender feature neither
needs nor expects.

---

## Payment-Mode Currency

A Mode of Payment tagged with `pos_tender_currency` accepts notes in that currency while the
invoice stays in the company's own. The tendered amount is converted at the latest **Currency
Exchange** rate and both figures are recorded on the payment row.

Key properties:

- The invoice, its items and its totals never leave the company currency
- The linked Mode of Payment Account must stay in the company currency - there is one shared cash
  account, and the foreign figure is drawer-reconciliation metadata rather than a second ledger
- No FX gain or loss is tracked
- Change can be split across currencies, one `POS Change Leg` row each
- Rates are resolved server-side; a rate supplied by the till is only a checksum

Full walkthrough and setup table: [Payment Processing](06-payment-processing.md#mixed-currency-cash-payment-and-change).

---

## Exchange Rates

Both features read the same **Currency Exchange** doctype.

| Field | Requirement |
|---|---|
| `from_currency` / `to_currency` | The tender currency, then the company currency |
| `exchange_rate` | Company-currency units per one unit of the tender currency |
| `date` | Today. The resolver takes the newest record dated on or before the posting date |
| `for_selling` | **Must be ticked.** The resolver filters on it |

If no matching record exists, X POS falls back to the newest rate in either direction and writes
an error-log entry recording that it did so. A missing rate for a foreign tender mode is a hard
failure: the sale is refused rather than guessed at.

---

## Currency Precision

Decimal places come from each `Currency.number_format`, not from a global setting. LBP set to
`#,###` renders as whole pounds; USD set to `#,###.##` renders cents. Both can appear on the same
receipt at their own precision.

This matters more than it sounds. `System Settings.currency_precision` is currency-blind, so
leaving LBP at `#,###.##` gives every LBP amount phantom cents that will not reconcile against a
drawer count.

---

## Tips

- Keep one Currency Exchange record per trading day, with **For Selling** ticked
- Set `number_format` on every currency you handle before taking the first payment
- Review the base-currency total to confirm the accounting impact
- Do not enable `allow_multi_currency` for mixed-currency tender; they solve different problems
- Deploy tender-currency changes between shifts, since tagging a mode changes the units its drawer
  is counted in
