# Shift Management

X POS uses a shift-based workflow. Every POS session starts with opening a shift and ends with closing it. Shifts provide accountability, cash reconciliation, and transaction tracking.

---

## Opening a Shift

### Automatic Session Check
- When you open X POS, the app automatically checks if you already have an **open shift**
- If a shift is found, it resumes your session immediately with all settings loaded
- If no shift is found, the **Opening Dialog** appears

### Opening Dialog
1. **Select POS Profile** - Choose from available POS Profiles assigned to your user account
   - If only one profile is available, it is auto-selected
   - The company name auto-fills based on the selected profile
2. **Enter Opening Balances** - For each payment method (Cash, Card, Bank Transfer, etc.), enter the starting cash/balance amount
   - Cash amount typically reflects the float (starting cash in the register)
   - Other payment modes can have zero opening balances
3. **Click "Open Shift"** - This creates a POS Opening Shift document and initializes the POS session

### What Happens on Shift Open
- A **POS Opening Shift** document is created and submitted
- The POS loads all configuration from the selected POS Profile:
  - Payment methods, tax templates, print settings
  - Stock settings, warehouse assignments
  - Feature flags (returns, discounts, offline mode, etc.)
- If offline mode is enabled, items, customers, and stock data are pre-cached

---

## During a Shift

- All invoices created during the shift are linked to the POS Opening Shift
- The shift tracks:
  - Total number of invoices
  - Grand total and net total of all sales
  - Returns count and amounts
  - Payment method breakdowns
  - Tax summaries

---

## Closing a Shift

### Shift Summary Preview
Before closing, you can review a complete summary of the shift:
- **Total invoices** processed
- **Grand total** of all sales
- **Net total** (excluding taxes)
- **Returns count** and return amounts
- **Tax breakdown** by tax account (account head, rate, total amount)
- **Payment breakdown** by mode of payment

### Closing Dialog
1. The dialog shows a **payment reconciliation table** with columns:
   - **Payment Method** - Each mode of payment used during the shift
   - **Opening Amount** - Balance entered at shift start
   - **Expected Amount** - System-calculated amount based on invoices
   - **Closing Amount** - The actual amount you count and enter
   - **Difference** - Calculated surplus or shortage (over/short)
2. Enter the **actual closing amounts** for each payment method
3. Review any discrepancies between expected and actual amounts
4. Click **Close Shift** to finalize

Gift cards sold for cash count in the Cash row. Gift-card payments appear on their own **Gift Card** row, which is filled in for you and cannot be edited, because no money reaches the till. See [Gift Cards](29-gift-cards.md#shifts-and-reports).

### What Happens on Shift Close
- A **POS Closing Shift** document is created with:
  - All invoices linked as child records (Sales Invoice Reference table)
  - Payment reconciliation details
  - Tax summary breakdown
  - Shift period (start/end times)
- The POS Opening Shift status changes from "Open" to "Closed"
- All POS state is reset
- The Opening Dialog reappears for the next shift

---

## Tips

- Always reconcile cash carefully before closing the shift - discrepancies are recorded permanently
- If you need to leave temporarily, you can hold orders and return to the same shift later
- The shift closing document serves as a complete audit trail for the POS session
- Multiple users can have separate open shifts on different POS Profiles simultaneously
