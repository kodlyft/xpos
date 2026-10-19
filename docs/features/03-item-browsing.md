# Item Browsing & Search

X POS provides multiple ways to find and add items to the cart - from visual browsing to barcode scanning and text search.

---

## Item Grid & List Views

### Card (Grid) View
- Items are displayed as visual cards in a responsive grid layout
- Each card shows:
  - **Item image** (can be hidden via POS Profile setting `hide_images`)
  - **Item name**
  - **Item code** (if `display_item_code` is enabled)
  - **Price** (from the POS Profile's price list)
  - **Stock quantity** (actual qty in the POS warehouse)
- Out-of-stock items can be hidden entirely with the `hide_unavailable_items` setting

### List View
- Compact row-based layout showing item name, code, price, and stock in columns
- More items visible per page compared to grid view

### Switching Views
- Toggle between grid and list view using the **view mode buttons** in the toolbar
- The default view is set in the POS Profile (`default_view`: Card or List)

### Infinite Scroll
- Items load in batches of 40
- As you scroll down, the next batch loads automatically (via IntersectionObserver)
- Skeleton loading placeholders appear while items are loading

---

## Text Search

- Type in the **search bar** at the top of the item area to filter items
- Search matches against:
  - Item name
  - Item code
  - Barcode
  - Serial number (if `search_serial_no` is enabled)
  - Batch number (if `search_batch_no` is enabled)
- Results update in real-time as you type (debounced)

### Keyboard Navigation
- **Arrow Up / Arrow Down** - Navigate between highlighted items in the search results
- **Enter** - Add the currently highlighted item to the cart
- **Any alphanumeric key** (when no input is focused) - Automatically focuses the search bar and starts typing, so you can begin searching immediately

---

## Item Group Filtering

- **Pill filters** shown above the item grid for quick group switching (e.g., "Beverages", "Food", "Electronics")
- An **autocomplete dropdown** for selecting item groups when there are many groups
- Groups support hierarchical filtering - selecting a parent group shows items from all child groups
- Item groups can be restricted at the POS Profile level

---

## Barcode Scanning

### Supported Input Methods
1. **Physical barcode scanner** - Scanner types characters into the barcode input field and auto-submits
2. **Manual entry** - Type a barcode number and press Enter
3. **Clipboard paste** - Paste a barcode value directly

### Using the Barcode Scanner
- Press **F2** to focus the barcode input field at any time
- Scan or type the barcode and press Enter
- The system searches for the barcode across:
  - Item Barcode records
  - Direct item code matches
  - Scale barcodes (for weighted items, see [Scale Barcode Support](22-scale-barcodes.md))

### Visual Feedback
- **Green flash** - Successful barcode scan, item added to cart
- **Red flash** - Barcode not found, no item matched

### Automatic Cart Addition
- When a barcode resolves to an item, it is immediately added to the cart
- If the item is already in the cart, the quantity is incremented
- For items requiring batch or serial number selection, the Item Detail Dialog opens instead

---

## Item Detail Dialog

The Item Detail Dialog opens when an item requires additional information before being added to the cart.

### When It Opens
- Items with **batch tracking** enabled
- Items with **serial number** tracking
- Items with **multiple UOMs** available

### Batch Selection
- Displays all available batches with:
  - Batch number
  - Available quantity
  - Expiry date
- Select a batch before adding to cart
- If enabled in your profile settings, the first available batch is automatically pre-selected

### Serial Number Selection
- Shows a multi-select list of available serial numbers
- Search/filter serial numbers by typing
- The quantity auto-updates to match the number of selected serial numbers
- Each serial number creates a separate cart line item

### UOM Selection
- Switch between available units of measure (e.g., Piece, Box, Dozen)
- Displays the conversion factor for each UOM
- Price auto-recalculates based on the selected UOM

### Quantity Input
- Enter the desired quantity before adding to cart
- Supports fractional quantities for weighted items

---

## Item Variants

### Template Items
- If a template item (parent item with variants) is clicked, a **Variant Picker** dialog opens
- Shows all available variant items organized by their attribute values (e.g., Size, Color)
- Displays available attribute combinations

### Variant Selection
- Browse variants by their attributes
- Select a specific variant to add to the cart
- Variant items show their own price and stock levels

---

## Stock Display

- Each item shows its **actual stock quantity** in the POS warehouse
- Stock levels update when items are sold
- Items with zero stock can be hidden from the grid through profile settings
- Selling beyond available stock can be blocked through your profile settings
