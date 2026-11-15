# X POS v3: browser and PWA only

X POS v3 runs only in the browser, either as a tab or as an installed PWA. The Electron desktop app is not part of v3. It was never finished, and v3 does not build, ship or update it.

This page covers:

- what changed
- what a browser till cannot do that the desktop app tried to do
- what an upgrade keeps
- how to retire a desktop install without losing sales it never sent

| Line | Branch | Desktop app |
|---|---|---|
| v3 | `develop` | Removed |
| v16 maintenance | `version-16-hotfix` / `version-16` | Unchanged. The release workflow on `version-16` still publishes the Windows installer. |

## What was removed

- The Electron main process, preload bridge and IPC, the local MariaDB database layer, the desktop sync engine, the hub/till LAN sync and the auto-updater (`frontend/electron/`).
- The desktop build and packaging: `vite.config.electron.ts`, `tsconfig.electron.json`, `index.electron.html`, `electron-builder.yml`, `scripts/build-electron.mjs`, `scripts/build-win.mjs`, `scripts/afterPack.mjs`, `build/` icons, the `dev:electron`, `build:electron`, `pack` and `dist*` scripts, and these packages: `electron`, `electron-builder`, `electron-updater`, `@electron/fuses`, `vite-plugin-electron`, `vite-plugin-electron-renderer`, `resedit`, `mysql2` and `socket.io-client`.
- The Windows installer job in `.github/workflows/release.yml`. That workflow only runs from the `version-16` branch's own copy, so `version-16` keeps building installers until `develop` is merged into it.
- Desktop-only screens and options:
  - The first-run Setup Wizard (`/setup`) and the Settings page (`/settings`), which held the server URL, local database, sync interval and data reset.
  - The desktop menu bar and the "Sync now" status pill.
  - The Settings entries in the sidebar and the command search.
  - The `Ctrl+,` (Settings) and `Ctrl+Shift+S` (manual sync) shortcuts.
  - The Logs tab in the error inspector.
  - The platform and hub/till rows in About.
  - The "Unsynced (local)" list in Orders. In the browser, unsynced sales are in the Offline Pending Panel.
- Code paths that only ran in the desktop app:
  - local password sign-in
  - local shift open and close
  - local expense and bank-drop lists
  - local receipt printing over IPC
  - local FBR calls through the main process
  - the stub database functions that returned empty results in the browser

The browser keeps everything it had before:

- the IndexedDB offline cache and sale queue
- the service worker
- printing through the print view and the offline receipt
- keyboard-wedge and camera barcode scanning
- the ERPNext API

## Browser capability gaps

These are things the desktop app did, or tried to do, that a browser till does not do. None of them were working features of a released desktop build, but do not assume a browser till matches a desktop till on any of these points.

| Capability | Desktop app (unfinished) | Browser / PWA in v3 |
|---|---|---|
| Sign in with no connection | Checked a password hash stored locally | A fresh sign-in needs the server. Once signed in, the session is remembered on the device: reloading while offline keeps the till running. The server still authorises every request it receives. |
| Open or close a shift offline | Wrote the shift locally and synced it later | Needs a connection. An already open shift keeps working offline. |
| Expenses and bank drops offline | Stored locally | Need a connection (they post `POS Cash Movement` directly). |
| Several tills sharing one local hub with no internet | Hub/till LAN sync | Not available. Each till talks to the ERPNext server. Sales queue on each till while it is offline. |
| Live stock push | Socket.IO subscription in the main process | No push. Stock is refreshed when the till fetches it, and cached stock is used offline. |
| Full local copy of masters (prices, pricing rules, taxes, bins) in MariaDB | Yes | Partial copy in IndexedDB when **Use Offline Mode** is on: items, stock, customers, groups, offers, pricing rules, item taxes and receipt layout. See [Offline Mode](features/16-offline-mode.md). |
| Storage durability | MariaDB on disk | IndexedDB. X POS asks the browser for persistent storage and warns when it is refused or the device is nearly full, but a browser can still lose data a user clears. A sale is reported saved only after it is written and read back. See [Offline sync protocol](offline-sync-protocol.md). Sync often, and do not clear site data on a till with queued sales. |
| Printing | Electron print window. It still showed the OS print dialog (`silent: false`). | Browser print dialog. Online receipts open the server print view in a new window, so allow pop-ups for the site. Offline receipts print from a hidden frame. Silent printing to a fixed printer needs a browser kiosk setup (for example Chrome `--kiosk-printing`). X POS does not configure that. |
| Local FBR fiscalization service (`http://localhost:8524`) | Called from the main process, with no CORS or mixed-content limits | Called with `fetch` from the page. The local service must answer CORS preflights for the POS origin, and Chrome's local-network-access permission must be granted. Otherwise the request is blocked and the sale is held for the FBR check. |
| Gift cards and customer credit | Hidden, because the desktop app queued every sale | Available online. Unchanged. |
| App log files on disk | Main-process logs, shown in the Logs tab | Error inspector events only (kept in `localStorage`, last 200). |
| Auto-update | `electron-updater` from GitHub releases | Service worker update prompt. Unchanged. |

Barcode scanners that act as a keyboard (USB or Bluetooth HID) work the same in the browser, because they only type. The desktop app had no cash-drawer, serial, scale or customer-display integration, so the browser has nothing to replace there.

## Upgrading a browser till keeps its data

Upgrading from a v2 browser build to v3 keeps pending sales and settings. The upgrade does not change any of the following:

- **IndexedDB**: the same database name, the same schema versions (1 and 2) and the same stores. Opening it needs no migration, and nothing is cleared. `pendingInvoices`, `pendingPurchases`, the sync id map and the offline caches stay as they are.
- **Code that reads and writes the queue**: `idbService.ts`, `offlineStore.ts`, `invoiceSubmission.ts` and `useOfflineSale.ts` are unchanged.
- **`localStorage` keys**:
  - theme (`xpos-theme`)
  - cart width (`xpos_setting_pos_cart_width`)
  - the error log (`xpos:error-log`)
  - pending FBR numbers (`xpos:fbr-number:*`)
- **Origin and path**: `/xpos` on the same site, served by the same service worker. The new service worker waits until the cashier accepts the "new version" prompt.

The only setting keys that are no longer read are `server_url`, `last_logged_user`, `sync_interval` and `auto_sync`. Only the desktop app wrote them.

To check a till before upgrading, open the Offline Pending Panel. It should be empty, or every row should be one you know about. Pending rows survive the upgrade, but it is still good practice to sync before any change.

## Retiring a desktop install

Do not assume desktop installs exist, and do not assume none do. If a site ever ran the desktop app, check every machine that ran it. That means the hub and each till: each one keeps its own local database, `xpos_local` by default.

**Never uninstall MariaDB or drop `xpos_local` until its records are accounted for.**

1. **Clear held carts on the till.** The desktop sync engine sends held carts and send-to-cashier drafts to the server as ordinary sales, because the server's invoice endpoint ignores the draft flag. Settle or delete them in the desktop app before it syncs again.
2. **Let the app drain.** v3 does not remove the server endpoints the desktop app pushes to, so an existing desktop app keeps syncing to the server. Leave it running online until its pending count reaches zero. Sales and shifts are deduplicated on the desktop's local id, so a retry does not post them twice. Purchase orders have no such check, so look for duplicates in ERPNext afterwards.
3. **Back up the local database.** Run this on the desktop machine, even when the queue is empty:

   ```
   mariadb-dump -u root -p --single-transaction xpos_local > xpos_local-<machine>-<date>.sql
   ```

   Keep this file. It is the complete record.
4. **Enter anything that could not sync by hand.** If a record stays in the desktop app's dead-letter list, or the machine can no longer reach the server, find it in the backup and enter it in ERPNext. The tables to check are `pending_invoices` and `pending_purchases` (rows whose `status` is not `synced`), and `pos_opening_shifts` and `pos_closing_entries` (rows whose `sync_status` is not `synced`). Expenses, bank drops, stock adjustments and quotations were never pushed reliably, so check their tables too. Desktop shift ids are numbered per machine, so match a shift by user, POS Profile and date, not by id.

## Server endpoints kept for desktop installs

Only the desktop app calls these endpoints. They stay in v3 so that existing desktop installs can drain their queues. Remove them in a later release, once no site has a desktop install with unsynced records:

- `xpos.api.sync.get_child_table_data`
- `xpos.api.sync.get_item_prices`
- `xpos.api.shifts.create_opening_shift`
- `xpos.api.shifts.create_closing_shift` (also covered by `test_profile_settings`)
- `xpos.api.auth.get_pos_users`

The desktop app also calls these, but the browser uses them too, so they are not candidates for removal: `xpos.api.invoices.create_invoice`, `xpos.x_pos.api.purchase_orders.create_purchase_order` and `frappe.client.get_list`. The `xpos_local_id` custom fields and their duplicate checks also stay, because browser sales use them too.

## Remaining "electron" references

These are intentional:

- `.gitignore` (`frontend/dist-electron/`, `frontend/release/`), `.prettierignore` and the `.pre-commit-config.yaml` exclude. They keep old local build output out of commits and lint runs.
- `frontend/cypress.config.ts`, `frontend/scripts/run-cypress.mjs` and `frontend/tests/e2e/README.md`. These refer to Cypress's own bundled Electron browser and to the `ELECTRON_RUN_AS_NODE` variable set by VS Code-family editors. They are not about the X POS desktop app.
- `frontend/yarn.lock` (`electron-to-chromium`). This is browser-compatibility data used by the build tooling.
- Server code: the endpoints listed above, `test_electron_push_recomputes_expected`, and a comment in `xpos/patches/v2/activate_pos_profile_settings.py`. These remain while existing installs drain.
- This page, `docs/features/pos-profile-settings-status.md` and `docs/features/invoice-recovery.md`. They describe the desktop app as history, or explain how to retire it.
- `CONTRIBUTING.md` (the `version-16-hotfix` rules) and `SECURITY.md`. The v16 line still ships the desktop app.
- The `README.md` notice that links to this page.
