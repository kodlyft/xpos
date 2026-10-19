# Keyboard Shortcuts

X POS is designed for fast operation with extensive keyboard support for power users and cashiers who prefer keyboard-driven workflows.

---

## Global Shortcuts

| Key | Action | Context |
|---|---|---|
| Any alphanumeric key | Focus search bar and start typing | When no input is focused |
| `F2` | Focus barcode input field | Anywhere in POS view |
| `Ctrl+G` | Open Repeat Invoice dialog | POS view |
| `Esc` | Close current dialog | Any open dialog |

---

## Item Search & Navigation

| Key | Action | Context |
|---|---|---|
| Type any text | Search items by name/code | When search bar is focused |
| `Arrow Up` | Highlight previous item in results | In search results |
| `Arrow Down` | Highlight next item in results | In search results |
| `Enter` | Add highlighted item to cart | In search results |

---

## Cart Navigation

| Key | Action | Context |
|---|---|---|
| `Arrow Up` | Navigate to previous cart item | In quantity/rate input |
| `Arrow Down` | Navigate to next cart item | In quantity/rate input |
| `Tab` | Move focus to next field | In cart area |
| `Enter` | Confirm quantity change | In quantity input |

---

## Payment Dialog

| Key | Action | Context |
|---|---|---|
| `Enter` | Save & Print invoice | Payment dialog |
| `Shift+Enter` | Save Only (no print) | Payment dialog |
| `Esc` | Cancel / Close dialog | Payment dialog |
| `←` (Left Arrow) | Previous payment method | Payment method selector |
| `→` (Right Arrow) | Next payment method | Payment method selector |
| `↑` (Up Arrow) | Navigate up through dialog sections | Payment dialog |
| `↓` (Down Arrow) | Navigate down through dialog sections | Payment dialog |

---

## Customer Selection

| Key | Action | Context |
|---|---|---|
| Type any text | Search customers by name/phone/email | Customer selection dialog |
| `Arrow Up` | Highlight previous customer | In customer list |
| `Arrow Down` | Highlight next customer | In customer list |
| `Enter` | Select highlighted customer | In customer list |

---

## Cashier Settlement

| Key | Action | Context |
|---|---|---|
| `Alt+0` | Open the Cashier screen | Anywhere (cashier users only) |
| `↑` (Up Arrow) | Highlight previous unsettled bill | Cashier screen |
| `↓` (Down Arrow) | Highlight next unsettled bill | Cashier screen |
| `Enter` | Open the payment dialog to settle the highlighted bill | Cashier screen |

See [Cashier Settlement](26-cashier-settlement.md) for the full workflow.

---

## Workflow Examples

### Fast Checkout (Keyboard Only)
```
1. Type item name → Enter (adds to cart)
2. Type next item → Enter
3. Adjust qty with arrows + number keys
4. Click Pay (or tab to Pay button + Enter)
5. Enter → Save & Print
```

### Barcode-Driven Checkout
```
1. F2 (focus barcode input)
2. Scan barcode (auto-adds to cart)
3. F2 → Scan next barcode
4. Repeat as needed
5. Click Pay → Enter (Save & Print)
```

### Quick Repeat Order
```
1. Ctrl+G (open repeat dialog)
2. Search customer name → select invoice
3. Items auto-load to cart
4. Click Pay → Enter
```

---

## Tips

- Barcode scanners function as keyboard input - scanned codes are typed into the focused field and auto-submitted
- Combine keyboard and mouse for optimal speed - keyboard for search/entry, mouse for selection
- The `F2` shortcut is essential for quick switching between item search and barcode scanning
- Train cashiers on `Enter` (Save & Print) vs. `Shift+Enter` (Save Only) for consistent workflow
- Use arrow keys in the payment dialog to quickly switch between Cash and Card without reaching for the mouse
