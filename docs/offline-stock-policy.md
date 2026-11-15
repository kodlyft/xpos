# Offline stock, serial numbers and batches

Status: **proposal, not enabled.** This stage does not change what the till does about stock.

A browser-only deployment cannot guarantee that two disconnected counters do not sell the same last unit. Nothing below changes that. It only bounds how far a counter can go.

## What happens today

- The till sells offline against the last downloaded stock minus what this till already sold and has not sent. It will not go below that.
- On reconnect the server checks stock when it posts each sale. A sale that would take stock below zero is refused with `XPosInsufficientStockError` unless Stock Settings `allow_negative_stock` is on or the profile's `block_sale_beyond_available_qty` is off.
- A refused sale was already paid for and handed over. It is kept in the queue as **Refused: review** with the server's reason. It is never deleted automatically.
- Serial number lists are not downloaded, so a serial item cannot be sold offline from a list of available serials.
- Batch quantities come from the cached item, as of the last download.

## Proposed rule (disabled by default)

A new POS Profile setting would choose between the current behaviour and a share-based allowance.

1. **Plain stock items**: a counter may sell offline up to `floor(downloaded quantity / offline counters)`, minus what it has already sold offline. `offline counters` is a number the manager sets on the profile.
2. **Serial items**: not sold offline.
3. **Batch items**: the same share, per batch, only for batches in the download that are not expired on the sale date, earliest expiry first.
4. **Non-stock items**: no limit.

## Decisions needed before this can be enabled

1. Who decides what happens to a paid sale the server refuses for stock: post it into negative stock, hold it until stock is received, or refund the customer.
2. How negative stock is valued and accounted for, if it is allowed.
3. Where the number of offline counters comes from, and what happens when a shop adds a counter.
4. Whether serial items may ever be sold offline.
5. The oldest download a stock-critical item may be sold from.

Until these are decided, leave `block_sale_beyond_available_qty` as it is and expect refused sales after a long outage.
