# Offline Mode

X POS includes a comprehensive offline-first architecture that allows full POS operation without internet connectivity, with intelligent data caching and automatic synchronization.

---

## Overview

When offline mode is enabled (`use_offline_mode` on POS Profile), X POS:
- Pre-caches all item, customer, stock, and configuration data to the browser's IndexedDB
- Continues to function fully when the internet connection is lost
- Queues invoices and purchases locally for later synchronization
- Automatically syncs all pending data when connectivity is restored

---

## Enabling Offline Mode

1. Open your POS Profile settings
2. Enable the **Use Offline Mode** option
3. Save the profile
4. Next time a shift is opened, the pre-caching process begins

---

## Data Pre-Caching

The first download is staged, resumable and checked before it replaces anything; later syncs fetch only what changed. See the [offline sync protocol](../offline-sync-protocol.md) for the details.

- **Items and prices**: every item the profile can sell, in pages of 200, with the price from the profile's price list. Items that leave the catalogue (disabled, moved out of the profile's item groups, deleted) are removed on the next sync.
- **Stock**: refreshed whole every 2 minutes while online. Stock taken by sales that have not been sent yet stays deducted.
- **Customers**: every customer the profile may sell to, refreshed hourly.
- **Item groups, configuration, offers, pricing rules, tax templates**: as before.

The status chip shows when the prices were last confirmed. Offline sales need a complete catalogue that was downloaded for the signed-in user, POS Profile, warehouse and price list.

---

## Local Database Structure

The app stores offline data in your browser with dedicated storage for:

| Storage Area | Purpose |
|---|---|
| Items | Full item catalog |
| Item Groups | Item group hierarchy |
| Customers | Customer records |
| Suppliers | Supplier records |
| Pending Invoices | Queued invoices awaiting sync |
| Pending Purchases | Queued purchases awaiting sync |
| Stock Cache | Per-item stock levels |
| Meta | Configuration, timestamps, profiles |

---

## Offline Capabilities

### Item Browsing
- Items are served from the local IndexedDB cache
- Search by name, code, group, and barcode works offline
- Stock quantities reflect the last cached values
- Item groups filtering uses cached group data

### Barcode Scanning
- The catalogue download carries every barcode of each item with the UOM it sells in, its conversion factor and its rate, so a scan works offline after the first download and after a reload
- A box barcode adds a box line priced at the box rate (the price set for that UOM, else unit price x factor); stock is checked in stock units
- A barcode wins over another item's code, as on the server
- A barcode whose UOM has no conversion on the item, or one two cached items claim, is refused with the reason; it is never guessed
- Barcode edits, moves and removals reach the till through the delta feed
- **Scale, serial-number and batch-number scans work online only.** Offline they are not found; add the item by search instead
- Tills with a catalogue downloaded before this change download it again once (the feed version is part of the scope hash)

### Customer Search
- Customer search uses the cached customer list
- Search by name, mobile, and email works offline
- Limited to the pre-cached 1,000 customers

### Tax Calculation
- Item tax templates are cached per item + company
- Tax calculations run entirely in the browser
- No server round-trips needed

### Invoice Creation
- Full invoices are created and validated locally
- Saved to the `pendingInvoices` queue in IndexedDB
- Lines whose customer price is not cached are marked *needs connection* (not *no price configured*); the cart is kept and the lines are re-priced as soon as the connection returns
- Includes all data: items, customer, payments, discounts, taxes, offers
- **Only profile-approved payment modes.** A sale is saved offline only if every payment mode is listed under **Offline Payment Modes** on the POS Profile. The list is empty by default, which means offline checkout is unavailable until a manager sets it up. A listed mode is recorded, not verified.
- **Never offline:** credit sales and part payments, returns, customer credit, and sales that sell or spend a [gift card](29-gift-cards.md). The server also refuses gift card sales that arrive late through the sync queue
- **Saved means saved:** the sale and its receipt are written and read back before the screen says it was saved. If the device is out of storage or the browser's storage is unavailable, the cart is kept and the screen says the sale was NOT saved

### Purchase Orders
- Purchase orders can be created offline
- Saved to the `pendingPurchases` queue
- Synced when connectivity returns

---

## Automatic Sync Engine

### Periodic Sync
- Every **5 minutes**, the system performs a background sync cycle:
  - Refreshes the item cache with any new/updated items
  - Refreshes the customer cache
  - Attempts to sync pending invoices

### Online/Offline Detection
- The app monitors network connectivity via browser events
- **Online event**: Triggers immediate sync of all pending data
- **Offline event**: Activates offline mode, shows toast notification
- Visual indicators show current connectivity status

### Sync Process for Invoices
1. Pending invoices are retrieved from IndexedDB
2. Status changes to "syncing"
3. Each invoice is submitted to the server via `create_invoice` API
4. On success (the server returns a finished invoice): invoice is removed from the queue
5. If the server's current prices differ from the prices charged offline, nothing is posted and the entry becomes **Price review**. In the Offline Pending panel the cashier posts it at the new prices, or keeps the charged prices (needs *Allow Change Price*); both resubmit with the same sale id
6. A sale that needs the local FBR service keeps its server draft and sale id. The queue asks the local service for the number and finalizes the draft; a number already issued is reused, never requested twice. If FBR or the local service may have recorded the sale without answering, the entry becomes **FBR check**: it is never retried on its own. A user with **Resolve FBR Check** looks the sale id up in FBR's records and records what they found: the fiscal number shown there, or that it is not there. The queue then sends the same sale again; the server reuses the recorded number, or sends it to FBR once more only after "not there". A cashier without that permission can only press **Check again** after a supervisor records the check
7. A failure that is not the server refusing the sale (no network, timeout, server error, expired sign-in) leaves the sale queued as **failed** and retries it with growing delays (15 seconds up to 15 minutes). It is never parked for being slow to send
8. When the server refuses the sale (validation, insufficient stock, closed shift) it becomes **Refused: review**, with the server's reason. It is kept, never retried on its own and never deleted automatically

### Status Tracking
Pending invoices progress through states:
- **pending** - Awaiting sync
- **syncing** - Currently being submitted
- **failed** - Waiting to retry (shows the next try). Marked Stalled after 8 failed attempts but still retried
- **dead_letter** (shown as Refused: review) - The server refused it. Kept for a person to decide
- **needs_review** - Held for price review (nothi\ng was posted)
- **fiscal_uncertain** - FBR check: FBR may hold the sale. The server keeps the attempt in its fiscal ledger, and a draft too unless the sale spends customer credit

---

## Offline Pending Panel

A dedicated dialog for managing queued offline data.

### Accessing
- Click the **Offline Pending** indicator in the POS toolbar
- Shows the count of pending items

### Panel Features
- Lists all queued offline invoices with:
  - Customer name
  - Grand total amount
  - Status badge (pending/syncing/failed)
  - Item count
  - Payment methods used
- **Sync All** button - Attempts to sync all pending invoices immediately
- **Clear All** button - Removes all pending items when `Allow Delete Offline Invoice` is enabled
- Per-invoice actions:
  - **Retry** - Manually retry a failed invoice
  - **Delete** - Remove a specific pending invoice when `Allow Delete Offline Invoice` is enabled
  - **Load to Cart** - Reopens an offline draft in the cart for editing/resubmission

### Status Indicators
- **"Online"** - Connected and synced
- **"Offline"** - No internet connection
- **"Syncing..."** - Sync in progress
- **"{N} pending"** - Number of invoices awaiting sync

---

## Offline → Online Transition

When connectivity returns:
1. The app detects the network change event
2. A toast notification appears: "Connection restored"
3. Automatic sync begins for all pending invoices
4. Items and customers are refreshed in the background
5. Stock levels are updated to current values
6. The status indicator changes to "Online"

---

## Limitations in Offline Mode

| Feature | Offline Behavior |
|---|---|
| Customer creation | Not available offline (use pre-cached customers) |
| Stock updates | Uses cached stock levels (may not reflect latest) |
| Pricing changes | Uses cached prices (server price changes won't appear until sync) |
| Offers/promotions | Uses cached offers (new offers won't appear until sync) |
| External payment verification | Requires connectivity |
| Order history | Only online orders visible in history |
| Shift closing | Requires connectivity to close the shift |
| Shift opening | Requires connectivity. A shift that is already open keeps working offline |
| Signing in | A fresh sign-in needs connectivity. Once signed in, the session is remembered on the device, so reloading the page while offline keeps the till working; the server still decides what that session may do when it answers |
| Expenses and bank drops | Require connectivity |
| Gift cards and customer credit | Require connectivity |
| Storage | IndexedDB is the browser's best-effort storage. X POS asks for a persistent storage grant on startup, but a browser can still clear the data, and so can a user who clears site data. Sync often, and do not clear site data on a till with queued sales |
| Storage | IndexedDB. X POS asks for persistent storage, but clearing site data can still remove queued sales, so sync (or use **Export** in the Offline Invoices panel) before clearing anything |
| Storage notice | If the browser refuses persistent storage and sales are waiting to sync, a yellow bar says the browser may clear offline data. It sits above the header (it never covers it) and **Dismiss** hides it on this device. Syncing the queue is the real fix |

X POS v3 runs only in the browser. For what the retired desktop app did differently, see [X POS v3: browser and PWA only](../v3-browser-only.md#browser-capability-gaps).

---

## Tips

- Enable offline mode for stores with unreliable internet connectivity
- Pre-caching occurs at shift open - expect a brief loading period for large catalogs
- Monitor the pending panel during the day to ensure invoices are syncing properly
- Failed invoices can be retried manually - check error details for troubleshooting
- Stock levels in offline mode are approximate; consider this for stock-critical businesses
- The 5-minute sync interval keeps data reasonably fresh without excessive bandwidth use
