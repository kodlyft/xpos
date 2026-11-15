# XPOS Mobile: Overview

XPOS Mobile is the Android app for selling from a phone or tablet. It signs in to your own ERPNext 16 site, uses the same prices, promotions and permissions as the web POS, and looks the same as the web POS (same colours, cards and dark mode).

How to sell with it is in [Selling on XPOS Mobile](33-mobile-selling.md). This page is for the person deciding whether and how to roll it out.

---

## What you need

| Requirement | Detail |
|---|---|
| Server | ERPNext 16 and Frappe 16 with XPOS installed. The app refuses other versions. |
| Address | The server must be reachable over `https://`. Release builds do not accept plain `http://`. |
| User | An ERPNext user assigned to at least one POS Profile. Roles and permissions are set in ERPNext and the web POS, never on the phone. |
| Device | Android 7.0 or newer, phone or tablet. |

---

## First run

1. Open the app and enter your server address.
2. Sign in with your ERPNext user. If you are assigned to more than one POS Profile, choose the one this device sells for.
3. Set a 6-digit PIN. It unlocks this device only; it is not your ERPNext password.
4. Wait for the catalog to download the first time. Later refreshes fetch only what changed.
5. Open a shift if the cart asks for one, then start selling.

---

## What it can do

- Browse and search the whole catalog, including very large ones, and add items by name, code or barcode (handheld scanner or typing).
- Three layouts that share one cart: Catalog, Scan and Fashion (colour and size).
- Search and choose a customer, and create or edit one if your user may.
- Show ERPNext's prices, promotions, discounts, taxes and rounding. The phone never works out prices itself.
- Take cash, card or transfer payments, and gift cards.
- Keep every sale on the device until ERPNext confirms it, and retry a lost reply without ever posting twice.
- Lock with a PIN after a restart or 30 seconds in the background.

## What it cannot do yet

- Charge while offline. You can search the last catalog offline, but **Charge** stays off until the device is online.
- Send sales while the app is closed.
- Returns, closing a shift, and printing receipts. Use the web POS.
- Scan with the camera. A handheld scanner or typing is needed.
- Serial and batch items, weighed-item barcodes, and accounts that sign in with MFA or SSO.
- Price Checker. That is a separate web screen at `/price-checker` for a kiosk (see [Price Checker](36-price-checker.md)), not part of the app.

---

## Permissions and data on the device

- The app asks Android for one permission: **Internet**.
- Your PIN is sealed with the phone's secure key store. The ERPNext password is not stored.
- Android backup is switched off for the app, so its data is not copied to a cloud backup.
- The catalog, customers you searched for and unsent sales are kept in a database on the device. Signing out removes the PIN; sales still waiting to be sent stay and are sent only when the same user signs in again.

---

## Rolling it out

- Pilot with a few devices on one POS Profile before the whole fleet.
- Tell cashiers what is missing above, especially that charging needs a connection and returns happen in the web POS.
- Builds, signing and store publishing are in [mobile/docs/release.md](../../mobile/docs/release.md).
- For problems, see the last section of [Selling on XPOS Mobile](33-mobile-selling.md).
