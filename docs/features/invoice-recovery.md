# Recovering browser invoice submissions

Previously, an online invoice did not carry the local identity generated only
when offline fallback queued it. If the server committed but its response was
lost, that fallback submitted the same sale under a new identity.

Each cart now gets a random identity before submission. Browser submission
persists the exact payload and receipt in the existing IndexedDB recovery queue
before making the first request. A lost response, malformed proxy response or
page reload retains the payload and identity for replay. The offline queue reuses
that identity and refuses to overwrite an existing pending payload with different
sale data. Separate cleared carts receive new identities. If local storage fails,
the first server request is not sent.

Confirmed responses remove the journal record. A structured Frappe exception
removes a rejected request; uncertain transport outcomes remain recoverable.
Receipt printing happens after clearing the confirmed cart, so a printer failure
cannot enqueue another sale. Pending recovery remains accessible in the navbar
even when offline catalog mode is disabled.

Server deduplication now resolves the profile warehouse when omitted in the
payload. Concurrent naming-series contention rolls back and looks up the winning
invoice just like a unique-key conflict; unrelated errors are re-raised. Existing
unique invoice identity fields remain the final duplicate guard.

This is invoice recovery, not payment-processor idempotency. It does not make an
external card charge idempotent. Electron's existing queue-first transport remains
unchanged. Existing queued browser invoices remain compatible.
