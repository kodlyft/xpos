# Cashier Settlement

Cashier Settlement separates the act of **creating a bill** from the act of **collecting payment**. A POS terminal operator builds the order and sends it to a cashier, who collects the money and closes the bill from a dedicated screen - typically on a different PC at a central cash counter.

This mirrors how many pharmacies and high-traffic retail counters operate: sales staff ring up items at the terminal, while a single cashier handles all cash collection.

---

## How It Works

1. A POS Profile is configured with **Cashier Settlement** enabled.
2. At the terminal, the operator builds the cart as usual. The checkout button reads **Send to Cashier** instead of **Pay**.
3. Pressing **Send to Cashier** saves the order as an **unsettled draft invoice** - no payment is collected. The cart clears, ready for the next customer.
4. The unsettled invoice appears on the **Cashier** screen on any PC signed in to the same POS Profile. The list refreshes automatically.
5. The cashier selects an invoice, collects payment through the normal payment dialog, and submits it. The settled bill leaves the list, and the genuine tax invoice prints.

Under the hood this reuses the existing draft-invoice workflow. Unsettled bills are drafts (`docstatus = 0`) flagged with a `POS Awaiting Settlement` field, which keeps them separate from ordinary [held orders](07-draft-orders.md). When a bill is settled, the invoice is re-associated with the **cashier's** open shift, so the collected amount is reconciled in the cashier's shift, not the terminal operator's.

> **Not the same as an open tab.** Send to Cashier is a one-way hand-off: once sent, only a cashier may touch the bill, and it is meant to be paid immediately. An [open tab](27-open-tabs.md) stays editable and is meant to be added to over time, by whoever is on shift. Use Cashier Settlement to split ringing up from collecting; use open tabs to keep a customer's order alive across a shift change.

---

## Enabling the Feature

Two settings on the **POS Profile** control the terminal behavior:

| Setting | Description |
|---|---|
| Enable Cashier Settlement | Turns the terminal's checkout into **Send to Cashier**. No payment is collected at the terminal; the order is saved for a cashier to settle. |
| Print Backup Receipt | When enabled, the terminal prints a non-genuine **backup receipt** for the customer at the moment the order is sent. The genuine tax invoice is printed later by the cashier after settlement. (Only available when Cashier Settlement is enabled.) |

---

## Cashier Access Control

Not every user is a cashier. Access is controlled per user on the POS Profile's **Applicable for Users** table:

| Field | Description |
|---|---|
| Is Cashier | When checked, this user may open the Cashier screen and settle (close) bills. |

Access rules:

- Only users with **Is Cashier** checked can open the Cashier screen or settle a bill.
- **Administrator** and any user with the **System Manager** role always have access, so managers/admins are never locked out.
- Enforcement is on the **server**, not just the UI:
  - The Cashier route redirects non-cashiers back to the POS screen.
  - The Cashier nav item is hidden for non-cashiers.
  - The settlement and "list unsettled invoices" APIs reject non-cashiers, so a bill cannot be closed by an unauthorized user even outside the UI.

---

## Terminal Workflow (Sales Operator)

1. Open a shift and build the cart (items, customer, discounts) as normal.
2. The checkout button shows **Send to Cashier**.
3. Press it to save the unsettled bill. If **Print Backup Receipt** is enabled, a backup copy prints for the customer.
4. The cart clears immediately for the next sale.

Returns are unaffected - return mode still uses the normal payment flow even when Cashier Settlement is enabled.

---

## Cashier Workflow (Settlement Screen)

Open the **Cashier** screen from the sidebar, or press `Alt + 0`.

The screen lists every unsettled invoice for the POS Profile - regardless of which terminal or operator created it - and refreshes on its own every few seconds so new bills appear and settled bills disappear without manual reloading.

Each row shows the customer, invoice reference, date/time, item count, and grand total.

### Settling a Bill (Keyboard or Mouse)

| Action | Result |
|---|---|
| `↑` / `↓` | Move the highlight up/down the list |
| `Enter` | Open the payment dialog for the highlighted bill |
| Mouse click | Open the payment dialog for that bill |

In the payment dialog the cashier collects payment exactly like a normal sale. On **Save & Print**, the invoice is submitted, the genuine tax invoice prints, and the bill drops off the unsettled list.

A manual **Refresh** button is available if needed.

---

## Sales Invoice and POS Invoice Support

Cashier Settlement works whether the system is configured for **Sales Invoice** or **POS Invoice** (set in POS Settings).

ERPNext requires at least one mode of payment on a POS Invoice, even as a draft. Because no payment is collected at the terminal, X POS automatically seeds a zero-amount payment row on the draft so it can be saved; the cashier replaces it with the real amounts at settlement time.

---

## Use Cases

### Pharmacy / Retail Cash Counter
1. The counter staff scan items and hand the customer a backup receipt.
2. The customer walks to the cash counter and pays.
3. The cashier finds the bill on the Cashier screen, collects payment, and prints the official invoice.

### Multiple Terminals, One Cashier
Several sales terminals can send bills to a single Cashier screen. The cashier works through the queue using the keyboard, clearing each bill as payment is collected.

### Manager-Controlled Closing
By granting **Is Cashier** only to trusted staff, businesses ensure that bill creation (open to many operators) and money collection (restricted) are handled by different people.

---

## Tips

- The collected amount reconciles in the **cashier's** shift, so make sure the cashier has an open shift before settling.
- Use **Print Backup Receipt** so customers have something to present at the cash counter; it is clearly a draft/backup, not the tax invoice.
- The Cashier screen refreshes automatically, but the **Refresh** button forces an immediate reload.
- Ordinary [held orders](07-draft-orders.md) do **not** appear on the Cashier screen - only bills explicitly sent for settlement.
- See [POS Profile Configuration](24-pos-profile-config.md) for the related settings and [Keyboard Shortcuts](25-keyboard-shortcuts.md) for the full navigation reference.
