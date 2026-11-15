# Purchasing Module

X POS includes a built-in purchasing module that allows POS operators to create purchase orders, receive stock, and manage in-transit transfers - all from the POS interface.

---

## Overview

The purchasing module provides a complete procurement workflow directly from the POS screen:
- Search and select suppliers
- Browse and select items for purchase
- Create purchase orders
- Receive stock from suppliers
- Handle in-transit stock transfers
- Full offline support with sync

---

## Accessing the Purchase Module

- Navigate to the **Purchase** tab from the POS navigation bar
- The Purchase View has a three-tab layout:
  1. **Suppliers** - Select or create a supplier
  2. **Items** - Browse and add items to the purchase cart
  3. **Receive** - Receive incoming stock

---

## Supplier Management

### Search Suppliers
- Type in the supplier search field to find suppliers
- Search matches supplier name, ID, and other fields
- Results show supplier name and key details

### Select a Supplier
- Click a supplier from the search results to select them
- The selected supplier appears in the purchase header

### Create a New Supplier
When enabled in your profile:
1. Click **Create New Supplier**
2. Fill in the details:
   - Supplier name (required)
   - Supplier group
   - Supplier type
   - Mobile number
   - Email
   - Tax ID
3. Click **Create** to save

### Offline Supplier Support
- Suppliers are cached in IndexedDB for offline search
- New suppliers created online are added to the cache

---

## Adding Purchase Items

### Search Items for Purchase
- Browse available items or search by name/code
- Results show item details and current stock

### Barcode Search
- Scan or type a barcode to find an item for purchase

### Create New Items
When enabled in your profile:
- Create new items directly from the purchase interface
- New items are auto-associated with the POS Profile

---

## Purchase Cart

### Managing Cart Items
- Add items to the purchase cart with quantity, rate, and UOM
- Edit quantity, rate, and UOM per line item
- Cart displays:
  - Item name and code
  - Quantity ordered
  - Unit rate
  - Line total
  - Cart total and item count

### Options
- **Receive Immediately** (toggle) - Auto-create a Purchase Receipt along with the Purchase Order
- **Create Invoice** (toggle) - Auto-create a Purchase Invoice along with the Purchase Order
- **Warehouse Selection** - Defaults to the POS Profile's warehouse, can be changed

---

## Creating a Purchase Order

1. Select a supplier
2. Add items to the purchase cart
3. Configure quantities and rates
4. Optionally enable "Receive Immediately" and/or "Create Invoice"
5. Click **Submit Purchase Order**

### What Gets Created
Depending on the options selected:
- **Purchase Order** - Always created
- **Purchase Receipt** (optional) - If "Receive Immediately" is enabled
- **Purchase Invoice** (optional) - If "Create Invoice" is enabled

### Success Confirmation
- A compound success message shows all created document names
- Example: "PO-2024-001 created. Receipt PR-2024-001 created. Invoice PI-2024-001 created."

---

## Stock Receiving

### Pending Receipts
The **Receive** tab shows Purchase Orders that are pending receipt for the POS warehouse.

### Receiving Process
1. Open a pending Purchase Order from the list
2. View the line items with ordered quantities
3. Enter **received quantity** per item:
   - Supports partial receipt (receive fewer items than ordered)
   - Track rejections or shortages
4. Click **Receive Stock**
5. A **Purchase Receipt** document is created in ERPNext

### Partial Receipts
- You don't have to receive all items at once
- Remaining items can be received in subsequent operations
- The PO tracks fulfilled vs. outstanding quantities

---

## Stock Receiving (In-Transit Transfers)

**Stock Receiving** (sidebar, or the shortcut to go to Stock Receiving) receives stock another warehouse sent with **Add to Transit**. Purchase Orders and Purchase Invoices keep their own pages.

### Sending a transfer to a branch
In ERPNext, create a **Stock Entry** of type **Material Transfer**, tick **Add to Transit**, and set:
- **From Warehouse**: where the stock leaves.
- **To Warehouse**: a **Transit** warehouse of the same company.
- **Receiving Warehouse**: the branch warehouse that will receive it. It is required for in-transit entries.

Submit it. Only the POS profile whose warehouse (or warehouse tree) contains the Receiving Warehouse sees it on Stock Receiving. A transfer made from a Material Request without a Receiving Warehouse falls back to the warehouse on the request line. A transfer with neither is shown to no one.

### The list
- Opens on **Awaiting receipt**: the in-transit transfers addressed to your warehouse, shown as source warehouse → your warehouse, with the quantity still in transit and the percentage already received.
- **Saved drafts** lists receipts you saved but have not submitted; **Submit** posts them.
- Search by transfer number; **Refresh** reloads.

### Receiving a transfer
1. Pick a transfer. Every row opens with the full quantity still in transit, showing **Sent**, **Received** and **In transit**. The stock goes into the warehouse shown under **Receiving at**; it cannot be changed on the page.
2. Lower a quantity for a partial receipt, or tap **None**/**All**. Scanning a barcode counts one more unit into the matching row, up to what is still in transit.
3. Set the **Received on** date if it is not today.
4. **Receive stock** submits the receipt; **Save draft** creates the Stock Entry without moving stock.
5. A transfer can be received in several goes until nothing is left in transit.

### Shortages
Enter a **Return** quantity on a row, then **Return to source**: the missing or damaged quantity goes from the transit warehouse back to the source warehouse. Received plus returned cannot exceed what is in transit.

### Batches, serial numbers, units
Batch and serial numbers are taken from what the sender dispatched, so a partial receipt carries the right batches and serials. Rows keep the sender's unit and show the conversion to the stock unit.

### Rights
POS roles carry three rights: **Save Stock Receipt Draft**, **Submit Stock Receipt** and **View and Edit Receiving Rates** (without it, no rates or values are sent to the page). Managers and Administrators have all three by default; Cashiers have none. The POS Profile must also have **Allow Purchase Receipt** on.

### Safe retries and connection loss
- Receiving is online only. Offline, the page says so and disables saving; what you entered stays on this device and is restored on reload.
- Each receipt carries a request id. A double click or a retry returns the document the first attempt made. After a dropped connection, saving again first asks the server whether the receipt was already made.
- A draft is never reported as received: the page says "saved as a draft, no stock has moved" until it is submitted.
- Leaving the page with unsaved work asks for confirmation.

---

## Offline Purchase Support

### Creating Orders Offline
- Purchase orders can be created when the POS is offline
- They are saved locally awaiting sync
- Status tracking: pending → syncing → synced/failed

### Sync Mechanism
- Pending purchases sync automatically when connectivity returns
- Manual sync available via the **Sync** button in the purchase header
- Failed purchases can be retried

### Offline Data
- Suppliers are cached locally for offline selection
- Items are available from the offline cache
- The purchase view shows offline status and pending sync count

---

## Tips

- Use "Receive Immediately" for deliveries where goods are already in hand
- Create invoices along with POs for streamlined supplier billing
- Monitor in-transit transfers to know when stock is arriving
- Document shortages immediately to maintain accurate inventory records
- Use offline purchasing when receiving deliveries in areas with poor connectivity
