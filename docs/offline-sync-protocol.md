# Offline sync protocol

How the browser till keeps selling when the server cannot be reached, and how it catches up. This covers the browser and PWA only.

## What a till promises

- A sale is reported saved only after it and its receipt are written to IndexedDB and read back.
- A queued sale is deleted only when the server confirms it, or when a person deletes it (and only where the profile allows deleting). Nothing deletes a paid sale because the server refused it.
- Credit sales, part payments, returns, customer credit and gift cards are never completed offline.
- A payment mode works offline only if the POS Profile lists it under **Offline Payment Modes**. The list is empty by default. A listed mode is recorded, not verified.
- Prices come from the last complete catalogue. The status chip shows when they were last confirmed.
- It cannot guarantee global stock across disconnected counters. See [offline stock policy](offline-stock-policy.md).

## Setup

1. On the POS Profile, tick **Use Offline Mode**.
2. Under **Offline Payment Modes**, add the modes that may be taken offline. Each must be one of the profile's payment methods. Leave it empty to disable offline checkout.
3. Open a shift while online and let the catalogue finish downloading. The chip shows the time the prices were confirmed.

## Server API (`xpos.api.catalog_sync`)

All methods are POST, check access to the POS Profile on every call and work out the caller's scope on the server. The profile name alone is never trusted.

| Method | Purpose |
|---|---|
| `catalog_begin(pos_profile)` | Scope, item count, retention, and one cursor each for items, stock, customers and delta. The change-log watermark is taken here, before any page is read. |
| `catalog_page(pos_profile, cursor, limit)` | Items after the cursor's last code, in code order, up to 500, with rate. |
| `catalog_stock_page(pos_profile, cursor, limit)` | Stock for the profile warehouse, same paging, up to 2000. |
| `catalog_customers_page(pos_profile, cursor, limit)` | Customers the profile may sell to, same paging. |
| `catalog_delta(pos_profile, cursor, limit)` | `upserts` and `removed` since the cursor, and the next cursor. |
| `catalog_digest(pos_profile)` | Item count and CRC32 sum, for the till to compare with what it staged. |

**Scope** is the site, user, company, warehouse, price list, currency, item-group and customer-group limits, template flags, the user's roles and a digest of their User Permissions. A cursor is signed with the site key and bound to it. A cursor that was tampered with, belongs to another scope, or is older than the retention is answered with `{"resync": "invalid_cursor" | "scope_changed" | "cursor_expired"}` and no data. A change to a POS Profile, Item Group, Price List, Warehouse or Item Tax Template after the cursor is answered with `{"resync": "reset_required"}`.

**Pagination** is keyset (`code > last`), never offset, so rows added or removed during a download cannot make a page skip or repeat a row.

**Delta** candidates are the codes in the change log (`XPOS Catalog Change`) after the cursor, plus any Item or Item Price modified inside a 120 second overlap window. The overlap catches writers whose log row committed out of order and writes that bypass document hooks but still update `modified`. Every candidate is re-checked against the caller's catalogue as it is now. A code that is no longer in it is reported in `removed`, whether it was deleted, disabled, moved to another group, taken off the price list or hidden by a permission. Re-delivery is harmless.

**Retention**: change-log rows older than `xpos_catalog_retention_days` (site config, default 7) are deleted daily. A cursor older than that gets `cursor_expired`.

**Consistency** comes from the watermark taken at `catalog_begin`, the delta catch-up and the digest, not from database isolation between requests. It assumes a writer's transaction commits within the overlap window.

## Download on the till

1. `catalog_begin`, then pages of items, stock and customers are written to staging tables (`itemsStage`, `stockStage`, `customersStage`). The job's position is saved after every page.
2. Changes made during the download are folded into the stage with `catalog_delta`.
3. `catalog_digest` is compared with the stage's count and CRC32 sum. A mismatch triggers another catch-up, up to three rounds, then a restart (at most twice) and then a failure.
4. One transaction replaces items, stock, customers and item groups, writes `catalog_state` and clears the stage. Stock taken by queued sales stays deducted.

The live catalogue is untouched until step 4. A reload resumes from the saved page. A saved job older than the retention, or for another user, profile, warehouse or price list, is discarded.

Afterwards each 5-minute pass applies a delta, refreshes stock every 2 minutes and customers every hour. A `resync` answer starts a full staged download. Queued sales are never touched by a resync.

## State transitions

**Queued sale** (`pendingInvoices.status`)

| From | Event | To |
|---|---|---|
| (new) | saved and read back | `pending` |
| `pending` / `failed` | a tab claims it to send | `syncing` |
| `syncing` | server returns a finished invoice | deleted |
| `syncing` | no network, timeout, 5xx, 408, 429, expired session, anything unexplained | `failed`, `next_attempt_at` set (15 s doubling to 15 min) |
| `syncing` | server returns new prices | `needs_review` |
| `syncing` | FBR outcome unknown | `fiscal_uncertain` |
| `syncing` | server refuses (validation, stock, closed shift, duplicate id for another user) | `dead_letter` with `rejection` |
| `syncing` | tab closed or crashed, claim expired | `pending` |
| `failed` | `next_attempt_at` passes | `syncing` |
| `dead_letter` | person presses Requeue | `pending` |
| `needs_review` | person posts at new or charged prices | `pending` |
| `fiscal_uncertain` | person records the FBR check | `pending` |
| any | `hold` set because the connection dropped during a sale that cannot be offline | stays; sent only after Retry |

Only the signed-in user's sales are sent (sales saved before owners were recorded are sent by anyone). A pass stops after three transient failures in a row.

**Catalogue download**: `none` → staging (page n) → catching up → verifying → activating → `complete`. A failure leaves the job in place to resume. `complete` stays `complete` through a failed re-download.

**Database** (`dbState`): `ready`, `upgrading`, `needs_reload` (another tab or a newer build changed the schema), `storage_unavailable` (the browser cannot open its storage and the queue could not be backed up).

**App update**: the service worker installs and waits. The banner offers **Update now** only when the cart is empty, no payment is open, nothing is being sent and storage is not upgrading. Then it activates the new worker and reloads once, after the worker has taken control. Other tabs are told to reload. The schema upgrade is additive and never touches queued sales.

## Compatibility

- Existing endpoints, `create_invoice`, the sale-id dedupe, FBR handling and the desktop endpoints are unchanged.
- The IndexedDB database keeps its name. Version 3 adds three staging tables only. Queued sales gain `owner: null` and `attempts` when upgraded.
- The service worker no longer caches `GET /api/method/*` (it was keyed by URL, not by user). The old `xpos-api-cache` is deleted on load. The file cache covers public `/files/` only.
- A browser still running the previous build keeps working against the new server.

## Recovery

| Situation | What to do |
|---|---|
| "Sale NOT saved" (storage full or unavailable) | Keep the cart. Free storage, or reload, or connect and sell online. Do not hand over the goods until the sale shows as saved. |
| Banner: browser may clear offline data | Sync often. Use **Export** in the Offline Invoices panel to keep a JSON copy of queued sales. |
| Sale shows "Waiting to retry" or "Stalled" | It keeps retrying. Check the connection. **Retry** sends it now. |
| Sale shows "Refused: review" | Read the reason. Fix the cause (for example receive stock), then **Requeue**. Delete only if your profile allows it and the sale really must be dropped. |
| Sale shows "Held" | The connection dropped while a sale that cannot be completed offline was being sent. Check in ERPNext whether it was posted, then **Retry** (the same sale id cannot post twice). |
| Sale "rung up by" another user | It sends when that user signs in on this device. |
| Stuck "syncing" after a crash | Recovered to pending the next time the app starts or a send pass runs. |
| "Reload" banner | Another tab or a newer build changed the local database. Reload when idle. Queued sales are kept. |
| Catalogue "not ready" | Connect and wait for the first download. It resumes if interrupted. |
| Browser storage cannot be opened | Queued sales are backed up to a second database before anything is deleted. If the backup cannot be verified, nothing is deleted and offline selling is blocked. Export from another tab if possible. |

## Tested and not tested

Tested (automated):

- Server: keyset paging, delta (price, new, disabled, deleted, group change), forged/foreign/expired cursors, access refusal, permission change, resets, overlap, pruning, offline payment mode validation, repeatable patch (`xpos.api.tests.test_catalog_sync`).
- Browser, against a real IndexedDB implementation: v2 to v3 upgrade, newer-schema open, `versionchange`, durable save and read-back, quota and data-clone failures, claims and crash recovery, unopenable-database backup and refusal to delete, staged download, interrupted download and resume, stale job, delta, resync, digest mismatch, catch-up, stock reservations, session change, freshness, offline policy, retry and backoff, refusal handling, owner and hold gating, two tabs.

Also tested: barcodes in snapshots and deltas (several per item, alternate UOM, UOM price, unconvertible UOM, change, removal, rename), the online scan's UOM, factor and rate (`test_catalog_sync`), and, in the browser, the local barcode index, ambiguous and refused scans, and unit-and-box cart lines (`offlineBarcodes.spec.ts`).

Not tested, or unresolved:

- Scale, serial and batch scans have no offline path. They need the server.

- Real browser eviction, real quota exhaustion, and a real service-worker update across several tabs. These need manual checks on a till.
- Writers whose transactions stay open longer than the 120 second overlap can be missed by a delta until the next full download.
- The server cannot tell that a sale was created offline, so the offline payment limits are enforced by the till only. Posting time is the time of sync.
- A paid sale refused for stock needs a policy decision. See [offline stock policy](offline-stock-policy.md).
- Sales rung up by a user who never signs in again on that device stay queued. Reassigning them needs a decision.
- The Cypress spec for a connection that drops mid-submit was changed to the new held behaviour but not run here.
