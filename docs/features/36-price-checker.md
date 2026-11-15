# Price Checker

A full-screen kiosk page where a customer or staff member scans a barcode and sees the item's name, price and whether it is in stock. It does not sell anything and does not need a shift.

The Price Checker is a web screen. It is not part of the [XPOS Mobile](35-xpos-mobile-overview.md) app.

---

## Setting up a kiosk

1. Sign in to your site on the kiosk browser with a user who has XPOS access and is assigned to the POS Profile for that store.
2. Open `/price-checker` (the address of your site followed by `/price-checker`), or choose **Price Checker** in the POS sidebar.
3. Use a handheld or fixed barcode scanner that types the code and presses Enter. The page keeps the scan box focused, so there is nothing to click.

On a touch kiosk the on-screen keyboard stays hidden because the scan box is for scanners; a staff member can still type a code on a physical keyboard.

---

## Using it

1. Scan a barcode (or type an item code and press Enter).
2. The result card shows the picture, item group, name, item code, the price per unit of measure, and **In Stock** or **Out of stock** for stock items.
3. The result stays on screen until the next barcode is scanned. It never clears by itself, so a customer can read it at their own pace.

| You see | Meaning |
|---|---|
| Price in large blue digits | The item's price in the store's price list for that unit of measure. |
| **Price on request** | The item exists but has no price in the price list. Ask a manager to add one in ERPNext. |
| **Barcode not recognised** | Nothing has that barcode or code, or the lookup failed. Scan again or ask a team member. |
| **Online / Offline** badge (top right) | Whether the browser has a connection. Lookups need one. |

If you are assigned to more than one POS Profile, choose the store or register in the top bar. The price comes from that profile's price list.

---

## Limits

- It finds items by exact barcode or exact item code only. It has no name search.
- It shows the plain price-list price. Promotions, coupons, customer prices and discounts are not applied.
- It needs a connection; there is no offline mode.
- Stock shows only as in or out of stock, not a quantity.
- The description is shown in full, but the server sends at most the first 240 characters.
- A scanned item code is accepted only for enabled sales items. A registered barcode is shown as is, so remove the barcode from items that must not be shown.

The page works in light and dark mode and in right-to-left languages.
