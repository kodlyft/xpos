# XPOS v3 frontend performance

What changed in loading, rendering and search, measured before and after on the same machine with
the same data. Scope is the frontend only; no endpoint was changed.

## Setup

|  |  |
|---|---|
| Baseline | `develop` at `1549b240`, unmodified (results in `frontend/bench/results/before.json`) |
| After | the same commit plus this change (`after.json`) |
| Dependencies | `yarn.lock` as committed for the baseline; `after` adds `@tanstack/vue-virtual` 3.13.47 and, as a dev dependency, `playwright-core` 1.63.0. vue 3.5.30, pinia 2.3.1, dexie 4.3.0, vite 8.2.2 |
| Browser | headless Chromium 153.0.8010.12, 1366×768, no CPU throttling |
| Machine | WSL2 on an 11th-gen Core i5-1135G7 (8 threads), 11 GB RAM, Node 24.19 |
| Build | production `vite build` (the same one that ships), served from a local server that stubs Frappe |
| Data | 10,000 and 100,000 generated items (seeded, identical every run); carts of 10, 50 and 200 lines |
| Runs | cold start 3×, warm start 8×, 30 searches per mode, scans for every cart size |

Every figure is **p50 / p95** in milliseconds unless noted. The backend is a stub, so no backend time
is in any local number; "network" in the search rows is the stub's own time (zero latency here).
Debounce, execution, network and durable storage (IndexedDB) are reported separately. The scan
numbers stop when the line is in the cart; no sale is submitted.

This is one machine and one browser. Treat the absolute numbers as indicative, and the ratios as the
result. "Reference hardware" for the targets below has not been agreed, so the targets are judged
against this machine and should be re-checked on a real till.

## Targets

| Target | Before | After | |
|---|---|---|---|
| Cached scan → visible cart row, p95 < 100 ms | 1,669 ms (100k), 352 ms (10k) | **32.5 ms (100k), 16.5 ms (10k)**; 200-line cart: 67.5 ms | met |
| Local search, p95 < 150 ms after debounce | 2,184 ms (100k), 366 ms (10k) | **23.9 ms (100k), 22.9 ms (10k)** | met |
| Warm synchronised checkout ready < 2 s | 2,587 ms (100k, p95), 565 ms (10k) | **433 ms (100k), 368 ms (10k)** | met |

"Warm checkout ready" here means: shift open, products shown, cart present. "Synchronised" is
measured with the catalogue already cached and fresh; a cold start still has to download the
catalogue (below).

## Results

### Startup

| | 10k before | 10k after | 100k before | 100k after |
|---|---|---|---|---|
| Cold, checkout ready | 1157 / 1260 | 863 / 950 | 1643 / 1691 | 942 / 976 |
| Warm, checkout ready | 517 / 565 | 311 / 368 | 1240 / 2587 | 395 / 433 |
| Warm, long tasks in the 10 s after ready (count / ms) | 4 / 1247 | 0 / 0 | 2 / 406 | 0 / 0 |
| Warm, `get_pos_items` requests in the first 10 s | 103 | 1 | 1003 | 1 |
| Cold, until the whole catalogue and stock are cached offline | 9.5 s | 3.4 s | 124 s | 29 s |
| Initial JS, raw / gzip | 1267 / 365 KB | 770 / 238 KB | same | same |

The warm-start requests are the largest single change: every page load used to download the whole
catalogue again (1,003 requests at 100k).

### Search (offline, from IndexedDB)

| | 10k before | 10k after | 100k before | 100k after |
|---|---|---|---|---|
| Keystroke → results | 540 / 666 | 97 / 103 | 2152 / 2485 | 97 / 104 |
| of which debounce | 300 | 80 | 301 | 80 |
| of which after debounce | 240 / 366 | 17 / 23 | 1851 / 2184 | 17 / 24 |
| · durable storage (IndexedDB) | 235 / 357 | 14 / 18 | 1825 / 2137 | 13 / 19 |
| · execution (JS + render) | 3 / 17 | 2 / 8 | 12 / 47 | 3 / 10 |
| Long-task time per search | 0 | 0 | 362 / 422 | 0 |

Online search (a request to the server) is unchanged in kind: 300 ms debounce plus the server's time
(22 ms execution here). Results were compared with an independent oracle for every query; all 30 of
30 matched, before and after.

### Scan and cart (offline, cached)

| | 10k before | 10k after | 100k before | 100k after |
|---|---|---|---|---|
| Scan → cart row, all adds | 165 / 352 | 11 / 17 | 895 / 1669 | 12 / 33 |
| 10-line cart, add / change qty | 124 / 129 | 12 / 13 | 1100 / 811 | 12 / 13 |
| 50-line cart, add / change qty | 190 / 108 | 10 / 14 | 776 / 745 | 9 / 23 |
| 200-line cart, add / change qty | 196 / 128 | 58 / 25 | 833 / 758 | 52 / 26 |

The cart itself (`cartStore`) was not touched. Its cost grows with the number of lines (the 200-line
add is about 50–55 ms); the old numbers were dominated by reading the whole item table for every scan.

### Scrolling and memory (100k catalogue, eight pages loaded online)

| | before | after |
|---|---|---|
| Product cards in the DOM | 360 | 24 |
| DOM nodes | 11,483 | 2,304 |
| Next page → rendered (online / offline) | 36 / 2482 | 17 / 15 |

## What was wrong, and what changed

| Pattern | Finding | Change |
|---|---|---|
| Full IndexedDB read, then JS filter | Confirmed: every offline search and every offline scan read all items (1.8 s at 100k) | `src/services/catalogIndex.ts`: an in-memory index of one lower-cased string per item and a code/barcode map. Search scans it in item_code order and stops at the end of the page; the page is then read by key (`bulkGet`). Same matches and order as before, covered by a differential test |
| Full cached stock read during search | Confirmed: all stock rows were read and every item re-spread | Stock is read by key for the page only |
| Arrays copied while accumulating | Confirmed in `cacheAllItems` (spread per 200-row page) and in paging | One array, `concat` per page |
| Infinite scroll keeps every card | Confirmed | `ItemGrid` renders only the rows near the viewport (`@tanstack/vue-virtual`) in grid and list view |
| Requests skipped while another is active | Partly: a new search was queued but the old answer was still shown first, and an older next-page could land on a new list | Each fetch belongs to a query generation; older answers are dropped; a next-page requested mid-fetch is run afterwards |
| Eager secondary dialogs | Confirmed: 12 dialogs, the error inspector and the camera scanner (with its decoder, 436 KB) were in the startup bundle | Loaded on demand; Payment, Item detail and Customer are prefetched when the browser is idle. Initial JS 1267 → 770 KB |
| Not on the list | `cacheAllItems` re-downloaded the whole catalogue on every page load, every sync tick and every cleared search | One download at a time, none while the stored catalogue is under 4 minutes old for the same POS Profile and warehouse, stock requested in chunks of 5,000, index built while idle |

Also: `itemStore.items` is a `shallowRef` (rows are replaced, never edited), the offline search
debounce is 80 ms (300 ms stays for searches that go to the server), and the keyboard highlight now
survives a next page instead of resetting.

Search, the catalogue and the index never import cart state; the cart still receives a plain copy of
the item when it is added.

### Web Worker: evaluated, not adopted

`node bench/worker-eval.mjs` runs the real index at 100,000 items on the main thread and in a module
worker.

| | main thread | worker |
|---|---|---|
| Build the index | 122 ms (blocks) | 117 ms in the worker, but 321 ms until ready, and the hand-off still blocks the page for 78 ms |
| A search (p95) | 3 ms | 3.8 ms round trip |
| Startup | none | 19 ms |

A search is already 3 ms, so moving it off the thread cannot help; handing the catalogue to the worker
costs about as much as building it. The index is built while idle, not on the first search.

## Remaining bottlenecks

- **Cold start downloads everything.** At 100k items the catalogue is 502 requests and about 29 s
  before offline use is ready (124 s before). There is no incremental or bulk endpoint; adding one
  is a backend change.
- **Online scans always ask the server** (needed for scale, batch and serial barcodes). The cached
  path is used offline or after a failure.
- **Real barcodes are not available offline.** `get_pos_items` does not return the Item Barcode
  child table, so the cached `barcode` is empty and only the item code can be scanned offline. The
  index uses `barcode` when it is present. Fixing this needs the endpoint to return barcodes.
- **Offline group filter is an exact match** on item group; the server includes sub-groups. This is
  the previous behaviour, kept.
- **Building the index** takes about 120 ms of main thread for 100,000 items (one long task, at idle
  after startup). It is invisible in the benchmark; a slow till will feel it more.
- **The cart is not virtualized.** A 200-line cart costs about 55 ms per add and a heavier DOM
  (the cart renders in both the desktop and mobile panels).
- **Offline reload could not be verified.** Headless Chromium's offline switch also blocks the service
  worker's own cache fallback, so reloading the PWA offline is untested here. The service worker was
  not changed.
- **Unmeasured:** real tills and real network latency (`--latency` simulates the latter), Safari and
  Firefox, and memory on low-end devices.

## Regression checks

- `yarn typecheck`, and the unit suite: 33 files / 516 tests.
- New: `catalogIndex.spec.ts` (search and lookup against the old implementation), `itemGridVirtual.spec.ts`
  (bounded window, list semantics), `itemStoreCache.spec.ts` (single download, freshness, chunking,
  reload, profile change), stale-answer cases in `itemStoreFetch.spec.ts`.
- Cypress: new `catalog-virtual.cy.ts` (windowed DOM, arrow-key navigation and scroll, Enter opens
  the highlighted item and returns focus to search, list semantics, new search starts at the top);
  `catalog-shell`, `cart-payment`, `smoke`, `open-tabs`, `shortcuts` and `scale-barcodes` pass.
  One existing step in `catalog-shell` ("checkout one tap away on a phone") now clicks with
  `scrollBehavior: "nearest"`: Cypress's default scroll-to-top before a click re-renders the windowed tile
  out of the DOM while it retries, although the same click works in a real browser.

## Reproducing

See `frontend/bench/README.md`.

```bash
cd frontend
yarn bench --label before --build      # on the baseline commit
yarn bench --label after --build       # on the changed code
yarn bench:report before after
node bench/worker-eval.mjs 100000
```
