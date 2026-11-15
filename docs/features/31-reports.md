# Reports

The POS lists the reports the signed-in user may run and runs them through Frappe's report runner, after the POS checks below.

## What a report shows

| Report | Source | Notes |
|---|---|---|
| Sales By Item, Sales By Cashier, Sales By Payment Mode | The configured invoice type (POS Settings). In POS Invoice mode, POS Invoices are read **whether or not they have been consolidated**; the merged Sales Invoice is never read, so closing a shift neither drops nor doubles a sale. Sales Invoice mode reads `is_pos` Sales Invoices. | A date range is required. A site that changed invoice type mid-life shows only the current type's history. |
| POS Shift Reconciliation | Open or chosen shift, not consolidated invoices | Unchanged: pending-stock and open-shift code keep their own consolidation filter. |

- **Currency.** Amounts in different currencies are never added. Rows and summaries are grouped by invoice currency and carry a Currency column; there is no cross-currency total row.
- **UOM.** Sales By Item groups by item, UOM and currency.
- **Cashier.** Sales By Cashier names the user whose till (opening shift) took the sale, else the invoice creator. The invoice owner can be the waiter of a sale parked for settlement.

## Blind closing

A profile that hides expected amounts hides every report that reveals them (POS Shift Reconciliation, Sales By Payment Mode) from users without the **View Expected Amount** POS permission. The check runs on every request, in the POS, in the desk report runner, and for export and print, and it follows permission changes at once. Holding the POS Closing Shift read right no longer bypasses it.

Sales By Payment Mode now also needs the **Shift Report** POS permission, like the Z-report.

## Scope for restricted users

A user restricted to companies or warehouses (User Permissions, or their POS Profiles) can run a report only if the report limits its own rows and totals:

- reports shipped in the X POS module do;
- any other report needs an administrator to tick **Report Applies Scope Itself** on its XPOS Report Setting, after confirming the query applies `xpos.reports.scope` (or the company and warehouse filters) to rows and totals.

Unverified reports are hidden from restricted users, refused by the POS runner, and refused by the desk runner (`frappe.desk.query_report.run`, `export_query`) for reports in the catalog. Filters can only narrow the scope; a lone permitted company is filled in. Scope can't be set from the browser. The **Scope** setting says which limits are enforced on filters (Company and Warehouse, Company, or None for reports with no such data).

## Limits

- A report returning more than 100,000 rows is refused with a request to narrow the filters. It is never cut, because a clipped result would give wrong totals. This bounds what is sent, not what the database reads.
- The viewer's 50,000-row export limit is a browser limit on top of that.
- Tables are virtualised in the browser; there is no server pagination.
- Prepared (background) reports are not supported and are not offered.
- Favorites, recent reports and saved views are stored on this device only. If the browser refuses to store them, they last for the session and the page says so. They do not follow the user to another device.
- Charts: only bar and line are drawn. Other types show a notice; the figures are in the table and under "Show values". A chart shows at most 4 series and 40 points and says when it cut either.
- Reports that need filters only their desk script defines need a filter provider before the POS can run them.
