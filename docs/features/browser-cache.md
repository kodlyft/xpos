# Browser cache selection and status

POS Profile administrators can set Browser Customer Limit and Browser Product Limit.
Zero means all eligible records. Defaults are 5,000 customers and all products.
Stock quantities are cached for the selected products in the profile warehouse;
this is a product-count limit, not a limit on the number of units in stock.
Reload the register after changing its configuration.

Customer Order offers Alphabetical, Most Recent Purchase, Most Revenue and Most
Transactions. Product Order additionally offers Item Code and Recently Updated.
Purchase-based ordering uses the profile company's submitted history, excludes
consolidated Sales Invoices when counting their original POS tickets, nets
returns against revenue, and excludes returns from purchase counts and recency.
Revenue uses company currency and excludes tax. Unpurchased records follow ranked
records. Rankings use available lifetime history, not a rolling date window.

The configured order controls online browsing and which records a limited cache
selects. The browser preserves that selection order offline. Online search still
searches beyond the preload. Searching for one customer no longer overwrites the
whole offline customer cache. Customer group restrictions, product group filters
and Hide Unavailable Items remain in effect.

The navigation bar's data status expands to show customer and product/stock
counts, full versus deliberately limited coverage, refresh time, pending sales
and failed refreshes. In sync requires both complete selections refreshed within
five minutes in this session, online connectivity and no pending/dead-letter sales.
It does not mean every ERP Item is eligible, or that another till cannot change
stock after the displayed refresh. Reloading starts with unverified status until
refresh completes. Refresh now reloads both selections and retries pending sales.

The controls and completeness indicator apply to the browser cache. Electron's
separate database/sync implementation is unchanged.
