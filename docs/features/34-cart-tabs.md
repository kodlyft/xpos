# Cart Tabs (serving several customers at once)

A cashier can keep several sales open at the same time. Customer A's items are on screen, a
second customer steps up, you open another cart for them, ring them up, and then go back to
Customer A with everything exactly as it was.

Cart tabs are **working carts on this till**. They are not the same as a held order (see
[Draft Orders](07-draft-orders.md)), which is saved on the server and can be picked up on any
terminal.

---

## Using them

- On a desktop the open carts are tabs in the top header, next to POS / Orders / Reports, so they take no room from the cart. On smaller screens they get a row of their own above the sale screen. Each tab shows the customer's name, or
  **Cart 1**, **Cart 2** and so on until a customer is chosen, and the number of items in it.
- **New cart** (the **+** button) opens an empty cart. The button is always visible.
- Click or tap a tab to switch. The cart you leave is kept exactly as it is.
- The **x** on a tab closes it. A cart with items in it asks first. Closing the last cart
  leaves you a fresh empty one.
- A spinner on a tab means its payment is being saved. A warning triangle means it needs
  attention (see below).
- On a phone or a small tablet the strip becomes one button, **Cart 2 of 3**, that opens a
  list of your carts. **New cart** stays next to it.
- With many carts open the strip scrolls, and an **All carts** menu lists them.

Up to **8 carts** can be open. When the limit is reached the **New cart** button is
disabled and says why. Nothing is ever closed for you to make room.

### Where the strip sits

On small screens **Customize view** lets the cashier put the carts row on top or at the bottom (a
phone always shows it on top). A manager can lock the choice with the profile's *cart layout*
lock. The tabs cannot be hidden, so switching is always possible.

---

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Alt+T` | New cart |
| `Alt+→` | Next cart |
| `Alt+←` | Previous cart |
| `Alt+W` | Close the cart on screen (asks first if it has items) |
| `Delete` (a tab focused) | Close that cart |
| `←` `→` `Home` `End` (a tab focused) | Move between carts |

These work in an ordinary browser tab. They do not interfere with typing, barcode scanners,
input methods (IME) or open dialogs, and they are ignored while a payment window is open.
After a switch, the search/scan field gets focus again unless a dialog is open (touch screens
skip this so the on-screen keyboard does not pop up).

### Why not Ctrl+T, Ctrl+Tab, Ctrl+Shift+Tab and Ctrl+W?

Those are what most people expect, but a normal browser tab keeps them for itself (new tab,
next tab, previous tab). A web page is never given them, so X POS does not pretend otherwise.

`Ctrl+W` is never used for closing a cart because it would close the browser tab or app window. The other three are switched on only where the page can really receive them: when X POS runs as an
installed app window or in fullscreen. **Keyboard Shortcuts** (`Ctrl+/`) shows which set is
active in the window you are using.

`Alt+←` and `Alt+→` are Back and Forward in some browsers. If that gets in the way, change
the keys.

### Choosing other keys

Open **Keyboard Shortcuts**, find the **Carts** section and press **Change** next to an
action, then press the new keys. X POS refuses keys that are already used by another
shortcut, keys the browser reserves (such as `Ctrl+W`), and keys with no `Ctrl` or `Alt`
(so typing and scanning are never affected). The choice is remembered on this device.

---

## What each cart keeps

Every cart has its own customer, items (with quantities, units, serial and batch choices),
prices, discounts, offers, coupon, loyalty, taxes, delivery charge, notes, posting date,
return or order details, link to a held order, and sale identity. Totals, tax and stock rules
are the same as for any sale; they are worked out for the cart you are looking at.

The item catalogue and search are shared. Opening a cart does not reload anything.

Adding an item to a cart does **not** reserve stock on the server. Stock is checked again when
you take payment. Two carts holding the same **serial number** is refused, and batch
quantities already in other carts count against the batch.

---

## Taking payment

Payment belongs to the cart it was started from. If an answer arrives after you have moved to
another cart, it finishes the cart it came from and leaves yours alone.

- Only the cart that was paid is closed (or cleared, if it was the last one).
- A cart that is saving a payment cannot be closed, cleared or paid twice, and you cannot
  switch away from the payment window.
- If the connection drops before the server answers, the cart is marked **Payment not
  confirmed** and stays locked. Press **Pay** again: the sale carries the same identity, so
  the server never charges it twice. After a reload the same applies, and a sale that had
  already reached the offline queue is handed to the queue and removed from your carts.

Sales waiting in **Pending invoices** are never turned back into an editable cart. Only held
drafts can be loaded back.

---

## Held orders, returns and loaded orders

- **Hold** saves the cart as a held order and closes that tab.
- **Recall** loads a held order into an empty cart, or opens a new tab if the cart you are on
  has items. If that order is already open in a tab, you are taken to that tab instead.
- Returns, repeat sales, sales orders and quotations load the same way: into the empty cart on
  screen, or a new cart. They never replace a cart that has items in it.

---

## Reloads, other windows and shifts

Open carts are saved on this device a moment after each change, per site, user, company, POS
profile and warehouse. After a reload they come back, with the cart you were on active.
Payment details (card references, tendered amounts) are never saved.

- **Saving fails** (for example, the disk is full): a banner says carts are not being saved.
  Everything keeps working until you reload.
- **Two windows**: only one window owns the saved carts. A second window says so, does not
  restore or overwrite them, and offers **Use carts here** to take them over on purpose. The
  window that lost them cannot take payment.
- **Closing the shift** is refused while a payment is unconfirmed. Carts with items are kept,
  and offered again when the next shift opens: **Bring them back** or **Discard**. They are
  never discarded without asking.
- **Logout** saves the carts first. Another user never sees them.

---

## For administrators

No setting turns cart tabs on or off. The only profile-level control is the existing
*cart layout* lock in the layout policy, which also fixes the strip's position.
