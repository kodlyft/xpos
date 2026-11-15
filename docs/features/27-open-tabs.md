# Open Tabs

> Not to be confused with **cart tabs**, the several carts a cashier keeps open on one till. See [Cart Tabs](34-cart-tabs.md).

Open tabs let a customer's unpaid order outlive the cashier who started it, and let a
cashier collect on a sale that was already rung up on credit. Both live behind the
**Recall Order** dialog.

This is written for bars, pubs and restaurants, where a tab stays open across a shift
change, but it applies anywhere an order is started by one person and finished by another.

---

## The problem it solves

A draft invoice ("held order") is normally visible only to the shift that created it. That
is fine for a retail counter, where an order is held and resumed minutes later by the same
cashier. It breaks down when:

- A customer opens a tab, the bartender's shift ends, and the next bartender opens their
  own session. The tab is now invisible.
- A customer settles a credit sale from last week. There is no cart to load: the invoice
  is already submitted.

**Send to cashier** does not cover this. It hands an invoice to a cashier for settlement
and locks it from further edits, which is the opposite of a tab you keep adding drinks to.

---

## Enabling it

Both halves are **off by default**. Each needs two switches turned on.

### On the POS Profile

| Field | Effect |
|---|---|
| **Allow open tab recall** | Adds the *This shift / All shifts* toggle to the Recall Order dialog |
| **Allow outstanding settlement** | Adds the *Unpaid invoices* tab to the Recall Order dialog |

### On the POS Role

| Permission | Effect |
|---|---|
| **Recall Other Shifts' Tabs** | Lets this role widen the tab list past its own shift |
| **Settle Outstanding Invoice** | Lets this role collect against a past submitted invoice |

Both gates must agree. A profile with the flag on will still hide the control from a role
that lacks the permission, so you can enable the feature for a venue and still restrict it
to senior staff. Manager and Administrator roles receive both permissions; Cashier does not
until you grant it.

---

## Open tabs

Open the dialog with the **Restore** button in the cart toolbar, or `Ctrl+D`.

### Scope

- **This shift** (default): tabs raised on your current session, exactly as before.
- **All shifts**: every open tab on this POS Profile, whatever shift raised it.

A tab from another shift is badged with the cashier who opened it, so you always know whose
order you are picking up. A tab that was sent to a cashier for settlement is badged too.

Search filters the visible list by invoice number or customer.

### Picking up someone else's tab

Selecting a tab loads it into the cart exactly like your own held order: items,
quantities, line discounts, customer, order discount and notes.

**The tab becomes yours.** When you save or take payment, the invoice is re-stamped with
*your* opening shift. The sale then counts toward your closing shift and your expected cash
drawer, not the shift that opened it. This is deliberate: the person who takes the money is
the person who reconciles it.

### Two terminals, one tab

If two terminals load the same tab and both save, the second save is refused rather than
silently overwriting the first:

> This tab was changed on another terminal. Reload it and try again.

Your cart is left untouched and the Recall Order dialog reopens so you can pull a fresh
copy. Nothing you typed is lost, but you do need to re-apply it to the current version of
the tab.

### Deleting

A tab from another shift can only be deleted by someone with **Recall Other Shifts' Tabs**.
Without it, the delete is refused, so a cashier browsing the wider list cannot bin a
colleague's live tab by accident.

---

## Unpaid invoices

The second tab lists **submitted** invoices that still have a balance, across all
customers. Use it when a customer comes in to pay off a credit sale.

Each row shows the invoice total and, highlighted, what is still owed. Search covers
invoice number, customer code and customer name, and runs on the server so it reaches the
whole invoice history rather than just the visible page.

Selecting a row opens the settle panel, pre-filled with the full outstanding balance. Pick
a mode of payment and confirm.

### What happens

A **Payment Entry** is created, allocated against that invoice, and submitted. It is
stamped with your opening shift, so the cash lands in your POS Closing Shift's expected
amount alongside your sales. A partial amount is accepted; more than the outstanding
balance is not, because a POS terminal settles a balance rather than taking money on
account.

The cart is never touched. Settling a past sale is not a sale, so an order you have in
progress stays exactly as it was.

---

## What is not covered

- **Offline.** Both halves need the server. The tab list and the unpaid list come from
  live queries, and a Payment Entry cannot be queued locally.
- **Across POS Profiles.** The widened list stops at the POS Profile boundary, so a
  recalled tab always carries a compatible warehouse, currency and price list.
- **Credit notes.** Returns never appear in the tab list.

---

## Related

- [Draft & Held Orders](07-draft-orders.md): the single-shift behaviour this builds on
- [Cashier Settlement](26-cashier-settlement.md): the hand-off flow, and how it differs
- [POS Profile Configuration](24-pos-profile-config.md): where the two flags live
