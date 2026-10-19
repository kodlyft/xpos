# POS Profile Settings: Implementation Status

This page tracks how the POS Profile settings that used to be stored but ignored are enforced, which defects the October 2026 review found and fixed, and exactly how each rule was verified.

- **Baseline reviewed:** `develop` at `86425a7` ("feat: update POS Profile settings and permissions"), one commit ahead of `upstream/develop`, not pushed.
- **Changes on top:** uncommitted in the working tree, not deployed, no production migration run. The final acceptance review is recorded in [its own section](#final-acceptance-review). The cloud-fiscalization rollback gap it left open is closed in the [fiscalization rollback review](#fiscalization-rollback-review).
- **Acceptance status:** see [Acceptance status](#acceptance-status). It separates blockers, supported limitations and FBR behaviour that was not verified.
- **Live test stack:** Frappe 16.52.0 and ERPNext 16.51.0 on the disposable site `xpos-pp2.localhost`.
- **Scope:** browser/PWA and server. Electron is unchanged, apart from the server-side permission checks its sync endpoints share.

## Review targets

| # | Target | Finding | Fix or evidence | Verification |
|---|---|---|---|---|
| 1 | Discount authority | **Defect.** The invoice discount was only checked when the till sent `discount_source: "customer"`. Forging or omitting the tag skipped every check. Line discounts ignored the `show_edit_discount_field` permission and the user's Discount Limit. | `validate_sale_discounts` ([profile_rules.py](../../xpos/api/profile_rules.py)) runs on ERPNext's validated invoice and ignores client labels. It derives promotions on the server: customer discount, live POS Offers, and the pricing rules ERPNext applied. Anything beyond them is a manual discount and needs `apply_additional_discount` or `show_edit_discount_field` within the manual cap. Manual line and invoice discounts are combined against that cap. | Live: `TestDiscountAuthority` (8). Mocked: `TestSaleDiscountAuthority` (7). |
| 2 | Zero-price restriction | **Defect.** Only the line rate was checked. A 100% invoice discount, a fixed amount equal to the total, or a mix of line and invoice discounts produced a free sale. | `check_zero_payable` uses ERPNext's `net_amount`, which already includes the invoice discount, plus the grand total. Free-item and offer flags are trusted only after server verification (`verified_pricing_rule_free_line`, `verified_offer_free_line`). The cart preview also flags a zero total. | Live: `TestZeroPayable` (5). Vitest: "zero payable". |
| 3 | Price changes during submission | **Defect.** Without price-change rights the server reset rates after payment was taken and submitted anyway. ERPNext pricing rules could also change rates silently. A price missing from the list was accepted at whatever rate the till sent. | After insert and validate, and before FBR, credit allocation or submit, `repricing_changes` compares each line and the invoice discount with what the till sent. On any difference it rolls back to a savepoint, so no draft, gift-card rows or locks survive, and returns `status: "reprice_required"` with old and new lines. The cart marks the changed lines and blocks payment until the cashier confirms the review. Without price rights, an unlisted price now raises *Price unavailable*. | Live: `TestRepricing` (6). Vitest: "server repricing". Browser flow A. |
| 4 | Header price list | **Defect.** ERPNext `set_pos_fields` writes customer → group → profile into `selling_price_list` on every validate, including the background submit. Pricing rules were then matched against a list the rates did not come from. | The `XposPriceListMixin` (Sales Invoice and POS Invoice, `extend_doctype_class`) sets the header to `resolve_selling_price_list` after ERPNext runs. Pricing rules stay enabled. | Live: `TestHeaderPriceList` (2), including the background `_submit_invoice_job`, and `TestCustomerGroupPriceList` (1). |
| 5 | Customer credit and retries | **Defects.** A reused `local_id` returned the stored invoice for any payload: different customer, lines, user or profile. Two tills spending one receipt concurrently failed ("modified after you pulled it") because ERPNext re-reads the source from a stale REPEATABLE READ snapshot. That failure was safe but refused valid sales. Foreign-currency invoices could spend company-currency credit. | `xpos_request_hash` (customer, company, profile, user, lines, discounts, credit) is stored with `xpos_local_id`. A mismatching retry is refused and an identical retry returns the original invoice. Browser ids (`inv_…`) are checked across warehouses. Credit takes the customer lock first, sources follow in sorted order, and the read-only snapshot is restarted before the locks. Credit is spent only on company-currency sales. Allocation stays on ERPNext's `reconcile_against_document` / `reconcile_dr_cr_note`; neither commits (checked in the source and by failure injection). | Live: `TestCustomerCreditAccounting` (5): receipt plus credit note in one sale, insufficient balance after an earlier allocation, other customer's credit, foreign currency, cancel then reuse, lost-response retry. `TestConcurrentCredit` (3, committed, 5/5 green runs): one credit note raced by two tills, two concurrent partial allocations, and a failure injected after submit that rolls back the invoice and every allocation. `TestLocalIdReuse` (1). |
| 6 | Blind closing | **Defects.** The Desk endpoints `get_closing_shift_overview`, `make_closing_shift_from_opening`, `get_pos_invoices` and `get_payments_entries` checked doctype permission only, not access to the shift's company or document. `close_shift` and the desktop closing push used the user's POS Role from *any* profile. The SPA kept the last shift summary in the store. | `ensure_opening_shift_read` requires read access on the opening shift itself, which applies Company user permissions. Closing rights are resolved on the shift's own profile. The SPA no longer keeps shift figures. Desk policy is documented below. | Live: `TestBlindClosingBoundary` (6). Mocked: `TestBlindClosing` (6). Vitest: `blindClosing.spec.ts` (2). Browser flow B. |
| 7 | Migration compatibility | **Gap.** Only force-price, zero-rate and delivery were given compatibility values. The other activations were unreported. | Read-only preflight report (below). Stored values are kept as they are; the migration neither resets nor infers them. The earlier activation patch is untouched. A new forward patch adds the referral unique index. | Live: `TestPreflight` (1). `bench migrate` run twice, patch logged once. |
| 8 | Offline pricing and printing | **Defects.** Offline lines got a price key and were never re-fetched after reconnecting. "Needs connection" and "no price configured" looked the same. The queue deleted any non-throwing answer, including `fbr_local_required` and the new reprice answer. The reprint right used any profile's role, `/printview` needs only *read* so cashiers could reprint, and `mark_invoice_printed` had no permission check. | Line state is `needs_connection` or `no_price` with separate messages, and the cart is kept. On reconnect, offline-priced lines re-fetch automatically. The queue keeps an entry until a finished invoice comes back. Repriced sales become **Price review** entries the cashier posts at the new prices, or at the charged prices with `allow_change_price`. A `before_print` hook enforces the reprint right on the invoice's own profile. Print tracking needs read access. | Live: `TestPrintFormatRules` (5). Vitest: `profileSettings.spec.ts` (15), `offlineQueue.spec.ts` (5). Browser flow A. |
| 9 | Referral codes | **Defects.** There was no database uniqueness, and the profile came from the user's latest open shift rather than the till's profile. Disabled or foreign offers and missing campaigns were not detected. | Unique index `(customer, company)` is added when no duplicates exist; existing duplicates are reported, not touched. The till's profile is validated and must have an open shift. `referral_setup_problem` explains bad setup. A duplicate-key race re-reads the existing code. No rewards or messages are invented. | Live: `TestReferralCreation` (5). Mocked: `TestReferralOnCreate` (4). |
| 10 | Evidence | **Correction.** The earlier "13 live acceptance scenarios" were 11 + 2 mocked vitest specs, and this page did not exist. | This page, with the counts below. | - |

Cashback (`use_cashback`) stays inert and is shown as *not available* until the business defines it.

## Who sees expected amounts

| Path | Who sees expected amounts and totals |
|---|---|
| XPOS closing dialog, `get_shift_summary`, `close_shift` response | When the profile has **Hide Expected Amount**: only users whose POS Role *on that profile* has **View Expected Amount**, plus Administrator and System Manager. Everyone else gets counts and payment modes only, before and after closing. The shift's cashier, or a user with **Close Shift** on that profile, may open the summary at all. |
| Shift report *POS Shift Reconciliation* | Refused for blind profiles unless the viewer may see expected amounts. |
| Desk: POS Closing Shift form and list, and the Desk-only endpoints above | **Shown to Desk readers.** Users with Desk read on POS Closing Shift (System Manager, Sales Manager) see the figures. They also need read on the opening shift, so Company user permissions apply, and a role name alone is not enough. A user who is both a Sales Manager and a Cashier on the till closes blind in XPOS and sees figures in Desk. |
| Browser storage | Shift figures are never written to localStorage or IndexedDB, and are no longer kept in the store. |

## Discount and promotion policy

- **Promotions:** customer discount, live POS Offers, and pricing rules ERPNext applied. They are worked out on the server and are not limited by the cashier's manual cap. A verified promotional free item stays valid even when the cashier's own cap is below 100%.
- **No stacking of invoice-level promotions:** only one applies. A manual discount on top of a promotion is checked on the excess only.
- **Manual cap:** the profile's *Max Discount %*, further capped by the user's **Discount Limit** on the POS Profile User row. A limit of 0 is the field default and means "no own limit".
- **Zero price:** with *Allow Zero Rated Items* off, no sale line may end at zero after all discounts, and the sale may not total zero. Only server-verified free promotion lines are exempt.

## Migration preflight

```
bench --site <site> execute xpos.api.profile_preflight.print_report
```

The report is read-only. It returns one row per enabled profile and activated setting, with the stored value and what changes. It contains counts only: customers with a discount, customers or groups with their own price list, users who will close blind, items whose Purchase UOM now becomes the purchase-line default, print rules (and unusable ones), and open credit sources. It contains no amounts. Duplicate Referral Codes, which block referral creation, are listed by customer ID and company so an administrator can resolve them.

Behaviour changes on existing profiles, by setting. The report lists, per enabled profile, which of these apply:

- **Customer discount:** the customer's Discount % becomes the invoice discount.
- **Blind closing:** users without View Expected Amount close blind.
- **Referral creation:** a code is created for each customer added at the till, or an explicit note explains why not. While duplicate codes exist, none are created.
- **Default purchase UOM:** purchase lines default to the profile's UOM. Any item whose Purchase UOM differs from its stock UOM now defaults to it, even without a profile UOM.
- **Print-format rules:** online receipts follow the customer-group rules.
- **Customer credit:** cashiers can spend open receipts and credit notes online.

Historical invoices, payments, allocations, stock entries and submitted closings are never modified.

## Printing

- **Format choice, first print and reprint:** both resolve through `resolve_print_format`. The first rule row (in table order) matching the customer's group or one of its parent groups wins; then the profile's Default Print Format; then *XPOS Thermal Receipt*. Disabled, missing or non-invoice formats are refused when the profile is saved, and skipped if they become unusable later. A customer moved to another group later reprints with the new group's format.
- **Offline:** receipts use the fixed XPOS layout with the chosen format's CSS only. Customer-group rules need the server print view and apply online only.
- **Physical printing was not verified.** Browser flow A proves the rule-selected print view opens and calls `window.print()`.

Manual check on a real printer:
1. Open a shift as a cashier without *Reprint Invoice*.
2. Sell to a customer whose group has a rule and press *Save & Print*. The receipt prints in the rule's format.
3. Use *Reprint* from Orders. It is refused.
4. Log in as a supervisor with *Reprint Invoice* on that profile and reprint. It prints.
5. Go offline, sell, and print. The fixed offline layout prints.

## Verification evidence

Re-run on 2026-10-17 for the fiscalization rollback review, against `xpos-pp2.localhost` (Frappe 16.52.0, ERPNext 16.51.0). Every row below ran on the same working tree (fingerprint `4f70a34494c7ee9c`: SHA-256 of the code diff plus untracked files, docs excluded), after `pre-commit` had formatted it and after the SPA was rebuilt from it. Physical printing was not tested. The concurrency classes commit and clean up after themselves. The fiscal ledger commits on its own connection, and the tests delete its rows for their POS ID. Everything else rolls back.

| Kind | Count | Command | Result |
|---|---|---|---|
| Live backend, real ERPNext documents | 86 | `bench --site xpos-pp2.localhost run-tests --module xpos.api.tests.test_profile_settings_hardening` | OK, 86 in 530 s. Includes 22 fiscal tests (FBR's HTTP endpoint mocked) and 4 credit-note hook workflows. An earlier full run during this review had 6 `TestDiscountAuthority` failures while browser flows and console scripts ran against the same site at the same time; that class passed alone (8/8), and the run above, with nothing else running, passed. |
| Live, committed concurrency (two real DB sessions) | 9 | `… --case TestExternalCreditAllocation`, `--case TestConcurrentCredit`, `--case TestConcurrentFiscalCheck` | OK in the full module run and in 2 more runs of each class (3 runs each). This includes the credit-note races after the hook change. |
| Negative control, fiscal ledger | 4 | `--case TestFiscalRecovery` with the ledger made to forget every result | 2 failures, as expected: FBR was called twice (`2 != 1`), and a different sale under a fiscalized id was not refused. The file was then restored. |
| Mocked Python units | 71 | `--module xpos.api.tests.test_profile_settings`, `--module xpos.api.tests.test_fbr_integration` (12, 4 new) | OK (59 + 12) |
| Other xpos modules (regression) | 287 | every other `xpos.api.tests.*` module, plus `gift_card.test_gift_card` (live) and `test_reclass` | OK: 15 modules with 243 tests (including `test_endpoint_exposure` 10 and `test_invoices` 26), `test_gift_card` 30 (live), `test_reclass` 14 |
| Frontend vitest, these settings | 30 | `npx vitest run tests/profileSettings.spec.ts tests/blindClosing.spec.ts tests/offlineQueue.spec.ts` | OK (`offlineQueue.spec.ts` now 12) |
| Frontend vitest, whole suite | 438 | `npx vitest run` | OK. `vue-tsc --noEmit` clean |
| Browser interaction (Playwright + Chromium, built SPA served by `bench --site xpos-pp2.localhost serve`, restarted on the final tree) | 3 flows | session scratch scripts (not in the repo) | A, B and C all re-run in this review. All passed. |
| Lint | - | `pre-commit run --files <changed files>` | OK |

**Flow A** used a cashier without price, discount or reprint rights:
1. Item added at ₹100, then raised to ₹120 on the server.
2. *Save Only* returned `reprice_required` (100 → 120).
3. The banner and the line badge showed, and paying again before reviewing was blocked with no request sent.
4. After confirming the review, the sale posted at ₹120.
5. The print view opened with the rule-selected format and `print()` fired.
6. A cashier reprint through `/printview` returned **403**, and `print_count` was 1.

Re-run: ACC-SINV-2026-00147.

**Flow B:** on a blind profile, the cashier's Close Shift dialog showed the invoice count and a count field only. The `get_shift_summary` response held no totals or expected amounts. Its keys were `blind_closing`, `total_invoices`, `returns_count`, `payment_modes`, `pos_profile` and `company`.

## Final acceptance review

Reviewed revision: `develop` at `86425a7` plus the working tree. Each question was checked against the diff and, where the answer was not already proven, closed with a change and a test.

| # | Question | Finding | Change | Evidence |
|---|---|---|---|---|
| 1 | Referral uniqueness | **Gap.** With duplicates present the unique index was skipped, but codes were still created without the guarantee. | `referral_setup_problem` refuses creation while the `(customer, company)` index is missing, and the till gets a note. Duplicates are listed by `print_report` and never changed. `after_migrate` retries the index, so the first migrate after an administrator resolves them adds it. | Live: `TestReferralCreation` (6). The missing index is simulated with a mock, because this site has the index. |
| 2 | Offer discounts in repriced sales | **Defect.** When a transaction pricing rule set the invoice discount on a cart with POS Offer discounts, the cart kept its own discount, so every retry was refused again. *Keep charged prices* in the queue looped the same way. No manager-review workflow existed. | The combination is blocked with a recoverable explanation. The answer carries `offer_conflict`. The cart blocks payment until the offers are removed, then takes the server's discount and posts normally. A queued sale offers only *Post at new prices*, which posts at ERPNext's discount. | Live: `TestOfferRuleDiscountConflict` (1). Vitest: "server discount with POS Offers". |
| 3 | Customer credit against standard ERPNext | **Defect.** If a till's credit-note allocation committed while a Desk user's Payment Reconciliation was open, ERPNext allocated the same credit note again. `reconcile_dr_cr_note` checks the balance with a plain read. A refund Payment Entry did the same. Receipts were safe, because ERPNext's save does a locking modified check. | `lock_credit_note_spend` runs `before_submit` on Journal Entry and Payment Entry. It locks each credit note being spent and re-reads its balance, so it waits behind a till and refuses an overspend. Balances still come from ERPNext's documents and ledger. | Live, committed: `TestExternalCreditAllocation` (5). Each source is raced in both orders, plus a refund. With the hook removed, the two credit-note races double-spend (negative control). `TestConcurrentCredit` (3) covers till against till and rollback. |
| 4 | Sale identity | **Gaps.** A retry of an invoice without a fingerprint (created before this change) was returned to any user. The fingerprint left out currency, posting date, coupons, offers, write-off, loyalty, delivery and per-line flags. | Only the invoice's creator gets an existing sale back, and the refusal does not name another user's invoice. The fingerprint covers the inputs above. Uniqueness: `xpos_local_id` has a unique index on Sales Invoice and on POS Invoice. Browser ids are global; desktop ids are matched per warehouse, so a collision is refused, never merged. | Live: `TestSaleIdentity` (3), `TestLocalIdReuse` (1). Committed: `TestConcurrentSaleIdentity` (1): two sessions, one invoice. |
| 5 | Fiscalization retries | **Defects.** A queued sale answered `fbr_local_required` was dead-lettered, and a retry hit the unique index. A cloud read timeout fell back to the local service, so a sale FBR may already hold was fiscalized again. The dialog discarded the draft on any local failure, and a lost finalize answer meant asking for a second number. | New draft state `xpos_fiscal_state`: *Awaiting Local* or *Uncertain*. A retry with the same sale id resumes the draft without calling FBR's cloud again. FBR is called only when nothing reached it (connection refused or DNS failure); anything that may have been sent is *Uncertain* and never resent. The queue fetches local numbers itself, reuses an issued number, and holds unknown outcomes as **FBR check**. An uncertain draft cannot be discarded. *How the FBR check is recorded, and how a fiscal number survives a failed submit, were replaced in the [fiscalization rollback review](#fiscalization-rollback-review): the earlier commit-before-submit is gone.* | Live, FBR HTTP mocked: `TestFiscalizationRetry` (6). Mocked: `test_fbr_integration` (8). Vitest: `offlineQueue.spec.ts` (10). Browser flow C. |
| 6 | Migration and permission wording | "As you chose" appears nowhere in the repository. Two judgement phrases on this page were replaced with what the code does. | None to policy. Per-profile behaviour changes come from the preflight report, below. | Preflight run on the test site. |
| 7 | Purchase UOM prices | **Defect.** UOM precedence was right: ERPNext's `get_price_list_rate_for` takes the line UOM's Item Price, else the stock-UOM price times the factor. A buying list in another currency was used unconverted, though the Purchase Invoice is in company currency. | The price is converted with ERPNext's buying exchange rate. With no exchange rate, the price-list price is ignored and the existing fallback is used. | Live: `TestPurchasePrices` (3): UOM price wins, stock price × 12, USD list × 80. |

Behaviour changes introduced by this review, beyond the questions above:
- Submitting any Journal Entry or Payment Entry that spends a credit note now checks its locked balance. This covers Desk users too.
- A sale's creator may finalize it with a number from the local FBR service even without the *Cashier* flag on the profile. Recording an FBR check needs *Resolve FBR Check* (see the rollback review).
- The navbar queue button also shows when entries need attention, such as a price review or an FBR check, even on profiles without offline mode.

## Fiscalization rollback review

**Gap.** The previous review said "no acceptance blockers" and also documented that cloud fiscalization stayed atomic with the sale. Those two statements conflicted. If FBR returned a number and the local submit or customer-credit allocation then failed, the request rolled back and the number was lost. A retry sent the same USIN to FBR again, and nothing showed that FBR deduplicates USINs.

| # | Requirement | Change | Evidence |
|---|---|---|---|
| 1 | Keep fiscal attempts and their outcomes through a rollback, without committing an incomplete sale | New read-only DocType **XPOS Fiscal Attempt** (`fiscal_ledger.py`). Each request to FBR is one row, keyed by FBR POS ID, USIN and attempt number (unique index). The row is written on a separate database connection that commits on its own. It is written as *Sent* before the HTTP call, then updated to *Accepted* (with the number), *Uncertain*, *Rejected* or *Not Sent*. A row left at *Sent*, for example because the process died, is treated as uncertain. Nothing of the sale is committed early. The previous `frappe.db.commit()` of a fiscalized draft before submit was removed. Local-service numbers (`finalize_fiscal_invoice`, or a number sent with the sale) and local-service timeouts (`mark_fiscalization_uncertain`) are recorded the same way. | `TestFiscalRecovery`: after FBR succeeds and the submit fails, no invoice remains and the ledger row is *Accepted*. `frappe.db.commit` is mocked and asserted never called in the fiscal tests. |
| 2 | On retry, reuse a known result and never resend an uncertain request | `prepare_fiscalization` asks the ledger first, under a row lock. A known number is reused with no HTTP call, but only if the rebuilt payload matches what was sent: same SHA-256 of everything except `DateTime`. A different sale under the same id is refused. A *Sent* or *Uncertain* attempt is never sent again. A draft marked *Uncertain* is sent again only after a check records *Not Recorded*. HTTP 5xx answers, and answers with neither a number nor an error code, now count as uncertain, not rejected. Retries reach the ledger by every path: same `local_id` with no draft, a held draft, a queued background-submit draft, `retry_fiscalization`, and the `before_submit` hook. | **Required test** `test_fbr_success_then_failed_submit_is_recovered_without_a_second_fbr_request`: one FBR request in total, and the retry submits with `FBR-CLOUD-1`. Also: the background-submit case, the local-number case, the different-contents refusal, and the 504 case. Unit: `test_fbr_integration` (reuse, hash, 5xx and no-number cases, recorded outcomes). |
| 3 | Customer-credit sales | **Implemented, recoverable.** If FBR succeeds and the credit allocation fails, everything rolls back. The retry reuses the number and allocates once. If FBR's answer is unknown, nothing is saved and no credit is used. The answer is `fbr_uncertain` with the sale id and no draft, and the till holds the sale in its queue as **FBR check**. The ledger keeps the attempt, so the same sale is not resent until the check is recorded. After that, the till sends the same sale again, credit is locked and re-checked, and the recorded number is reused. Credit with the local FBR service is still refused, because the cloud request never reached FBR (*Not Sent*). | `TestFiscalCustomerCredit` (3): recovery after a failed allocation (receipt 100 → 60, one FBR call); unknown outcome with nothing saved and credit untouched, a retry not resent, and after *Recorded* a finish with `FBR-CREDIT-1`; local refusal with the attempt kept as *Not Sent*. Vitest: a credit sale held by its sale id and finished on a recheck. |
| 4 | Secure resolution | `resolve_fiscal_check` (POST only) needs the new POS permission **Resolve FBR Check** on the sale's own profile; Administrator and System Manager always have it. A patch adds it to existing POS Roles: enabled for the default *Manager* and *Administrator* roles, disabled for *Cashier*. Validation: evidence of 10 to 1000 characters is required. A *Recorded* number must be 4 to 100 characters from `A-Z a-z 0-9 * # / _ . : -`, and must not already be on another invoice or another sale id's attempt. Only the latest attempt, while *Sent* or *Uncertain*, can be resolved, and a *Sent* attempt only after 120 s, so an answer still in flight cannot be overridden. Concurrency: the attempt row is locked; the same answer repeated is accepted, and a different answer is refused naming who recorded the first. Audit: `resolution`, `resolved_by`, `resolved_on`, `resolution_evidence` and the number stay on the attempt row, next to every earlier attempt. Desk users get read only, with no create, edit or delete. Resolving records only; the till then sends the same sale again to finish it. A **Record FBR Check** button on the attempt form calls the same endpoint, and the till's **Check again** sends the held sale to finish it. Drafts held as *Uncertain* before this change get an *Unknown*-channel row when resolved. | `TestFiscalCheckResolution` (6): permission refused, then granted through a POS role; evidence, number and state validation; number in use; one answer per attempt and idempotent repeats; in-flight refusal, with a concurrent claim held rather than sent; legacy draft. `TestConcurrentFiscalCheck` (committed, two sessions): of two different answers at once, exactly one is recorded. Browser flow C. |
| 4a | How an external result is verified | **XPOS cannot verify it with FBR.** The IMS `PostData` API it uses only posts invoices; there is no lookup by USIN in this integration. Verification is a person checking FBR's own records (for example, the POS invoice listing for that POS ID in FBR's portal) and recording what they saw. The server records who attested it, when, and their evidence, and validates the format, uniqueness and state. It does not prove that the number exists at FBR. | - |
| 5 | Credit-note hooks on standard ERPNext workflows | Reviewed. `before_submit` only, so cancelling is never blocked. An amendment is checked against the balance restored by the cancellation. Several rows or references to one credit note are added up. Notes are locked in name order, the same order the till uses after its customer lock, and nothing else is locked, so no new lock cycle is possible. **One change:** the hook locked every referenced Sales Invoice `FOR UPDATE` before checking `is_return`, and a key-filter in SQL would not avoid that lock under REPEATABLE READ. Ordinary receipts against normal invoices therefore took new locks. Credit notes are now picked out with a plain read (`is_return` cannot change after submit) and only they are locked. | `TestCreditNoteHookWorkflows` (4): a receipt against an ordinary invoice locks nothing and submits; a refund of two credit notes locks both in name order; journal rows on one note are added up (overspend refused, exact spend submits); cancel, amend, then an over-refund refused. `TestExternalCreditAllocation` (5, committed) re-run. |
| 6 | Verification | See [Verification evidence](#verification-evidence). Every run used the same tree. | - |

**Flow C** (re-run on the final tree; browser, built SPA, `bench --site xpos-pp2.localhost serve`, an FBR stand-in on 127.0.0.1 that accepts and never answers, POS ID 765432):
1. A cashier with the default *Cashier* POS role paid a sale. FBR received one request and timed out after about 26 s. The sale was held as **FBR check**.
2. The cashier's panel had no Delete button and no number field, and said a supervisor records the result.
3. *Check again* sent the sale to the server again, and it stayed held. No new FBR request.
4. The user was given the *Manager* POS role, which has *Resolve FBR Check*. *Recorded: save fiscal number* stayed disabled until evidence was entered.
5. With `FBR-BROWSER-2` and evidence recorded, the same sale finished as ACC-SINV-2026-00148 with that number.
6. Server calls: `create_invoice` ×3 (held, queue sync, check again), `resolve_fiscal_check`, then `create_invoice`. The stand-in received **one** request in total. The ledger holds one Cloud attempt: *Uncertain*, then *Recorded* by the user, with the evidence text.

## Acceptance status

### Acceptance blockers

None open. The one this page previously understated (cloud fiscalization lost on rollback, and resent on retry) is closed above. It was a blocker, not a limitation.

### Supported limitations

- **An FBR check is a person's attestation.** See 4a. A wrong number entered with evidence will be used.
- **A recorded number is reused only for the same sale.** Lines, amounts, buyer and FBR payment mode must match what was first sent. A retry that differs, for example re-tendered from cash to card, is refused, with the attempt named, until it is rung up as sent. The local invoice keeps the retry's posting time, not the time FBR recorded.
- **A resolved sale finishes only when the till sends it again.** The queue entry lives in that till's browser. Recording the check in Desk does not submit anything.
- **Customer credit after an unknown outcome:** when the sale is sent again, credit is re-checked. If it was spent in the meantime the sale is refused, although FBR may hold its number. A supervisor must settle it another way.
- **Customer credit with the local FBR service is refused** (nothing reached FBR).
- **Sales without a client sale id** (API callers that send no `local_id`) use the invoice name as USIN. A rolled-back name can be given to a later, different sale, which is then refused as different contents. Browser and desktop tills always send an id.
- **One extra database connection** per FBR request and per ledger lookup. If the ledger cannot be written before sending, the sale fails without calling FBR. If it cannot be written after FBR answers, the attempt stays *Sent* and is treated as uncertain.
- **Electron** has no FBR-check screen. A held sale is resolved from a browser till, the Desk button or the API.
- Electron offline tills keep their own closing and pricing logic. Electron is being removed and was not extended.
- Repricing compares line rates and the invoice discount, not taxes. Taxes come from the profile template on both sides.
- POS Offer discounts and an invoice discount set by a transaction pricing rule cannot be combined. Such a sale is refused until the offers are removed. There is no manager override.
- A queued (offline) sale whose line prices changed keeps the offer discount amount that was worked out at the old prices. The panel shows the total it will post.
- Duplicate desktop sale ids across warehouses are refused (one database index per doctype), not accepted per warehouse.
- Pre-existing, outside this feature: purchase lines read Buying Settings' price list. *Update Buying Price* (`update_item_prices`) resolves its list with `pos_profile.get("buying_price_list", pos_profile)`. POS Profile has no such field, so that call returns the profile itself rather than a list name. Not changed.
- The test site keeps fixtures from committed runs and these drafts held as *Uncertain*: ACC-SINV-2026-00135 (earlier review) and ACC-SINV-2026-00144 (an interrupted flow C run in this review). It is disposable.

### Unverified external behaviour

- **Whether FBR's IMS deduplicates by USIN.** Not verified, and not relied on: an uncertain request is never resent until a check records *Not Recorded*.
- **Whether FBR can answer HTTP 5xx, or answer without a number, after recording an invoice.** Unknown, so both count as uncertain.
- **FBR's real responses.** No request was sent to FBR's sandbox or production. All FBR answers were mocked, or came from a local stand-in that never answers.
- **The FBR invoice-number format.** Only the characters and length are checked.
- **Physical printing.** Not tested. Flow A proves the print view opens and calls `print()`.
