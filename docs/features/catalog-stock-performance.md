# Batched catalog stock reads

Catalog loading previously resolved a warehouse and queried Bin separately for
every product. A page now resolves the warehouse once, sums Bin quantities for
all page item codes in one query, and applies unconsolidated POS Invoice deductions
as one map. Missing quantities remain zero; deductions can still produce negative
available quantities. Empty pages do no stock work. Prices and sale-time stock
validation are unchanged.

In an isolated ERPNext 16.36 / Frappe 16.35 site, twelve alternating before/after
calls per query returned identical product payloads. Median 40-item browse time
fell from 72.8 ms to 37.5 ms. Two-result search changed from 19.7 to 17.3 ms;
one-result search from 17.9 to 17.3 ms. These are direct API timings, not browser
latency or a production SLA. Product preload capacity and ranking are independent
of this optimization.
