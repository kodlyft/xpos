# Printing & Receipts

X POS supports configurable receipt printing with thermal printer compatibility, barcode/QR code generation, and conditional print format rules.

---

## Print Options

### Print After Payment
- When completing a payment, click **Save & Print** to create the invoice and immediately open a print preview
- The print preview opens in a new browser window/tab
- Uses the configured print format from the POS Profile's print settings

### Print Last Invoice
- After a payment, you can reprint the last invoice using the **Print Last** feature (if `allow_print_last_invoice` is enabled)
- The system stores the last invoice name for quick access

### Print from Order History
- Open any order in the Order History view
- Click the **Print** button to open its print preview
- Works for both current and past invoices

### Print Draft Invoices
- When enabled, held/draft invoices can be printed before submission
- Useful for order tickets (kitchen/preparation areas) before payment

---

## Print Format Configuration

### Available Print Formats
- X POS lists all available print formats for the invoice doctype (Sales Invoice or POS Invoice)
- The default print format is configured in the POS Profile
- The POS Profile can also switch receipt discount labels between percentage and amount using `print_discount_amount`

### Built-in Print Formats
X POS ships with:
- **XPOS Thermal Receipt** - Optimized for 80mm thermal printers, compact layout
- **XPOS Item Barcode Label** - Barcode labels for items

### Custom Print Formats
- Create custom Jinja or HTML print formats in ERPNext
- They automatically appear in the POS print format selection
- Full access to invoice data, items, payments, and customer information

### Conditional Print Format Rules
- Your POS Profile supports configuring different print formats based on conditions
- Useful for scenarios like:
  - Different format for returns vs. sales
  - Different format for specific item groups
  - Different format for high-value transactions

---

## Letter Head Support

- Letter head inclusion is controlled by POS Profile print settings
- Conditional letter head based on the `print_with_letterhead` option
- Configure company letter head in ERPNext's Letter Head doctype

---

## Barcode Generation

X POS provides Jinja template helpers for generating barcodes in print formats:

### `xpos_barcode(data, barcode_type)`
- Generates an SVG barcode element
- Parameters:
  - `data` - The string to encode (e.g., invoice number, item code)
  - `barcode_type` - Barcode format (e.g., "Code128", "EAN13")
- Returns: SVG markup for embedding in print templates

### `xpos_barcode_uri(data, barcode_type)`
- Generates a base64-encoded barcode image URI
- Useful for embedding barcodes as `<img src="...">` tags
- Same parameters as `xpos_barcode`

### `xpos_item_barcode(item_code)`
- Looks up the barcode associated with a specific item in X POS
- Returns the barcode string for the item

---

## QR Code Generation

### `xpos_qrcode(data)`
- Generates an SVG QR code element
- Parameter: `data` - The string to encode (e.g., invoice URL, payment link)
- Returns: SVG markup

### `xpos_qrcode_uri(data)`
- Generates a base64-encoded QR code image URI
- Useful for `<img>` tags in print templates

---

## Print Format Template Example

In a custom Jinja print format, you can use the helpers like this:

```html
<!-- Invoice barcode -->
{{ xpos_barcode(doc.name, "Code128") }}

<!-- QR code with invoice URL -->
{{ xpos_qrcode("https://yoursite.com/invoice/" + doc.name) }}

<!-- Item barcodes -->
{% for item in doc.items %}
  <div>{{ item.item_name }}: {{ xpos_barcode(xpos_item_barcode(item.item_code), "Code128") }}</div>
{% endfor %}
```

---

## Invoice Data Available in Print

When designing print formats, the following data is available:

### Invoice Header
- Invoice name/number
- Posting date and time
- Customer name, address, phone, email
- POS Profile name
- Company and company address

### Items
- Item name, code, description
- Quantity, rate, amount
- UOM
- Batch number (if applicable)
- Serial numbers (if applicable)
- Item-level discount
- Additional notes per item
- Whether the item was an offer/free item

### Totals
- Net total
- Individual tax lines with descriptions and amounts
- Additional discount
- Loyalty redemption amount
- Write-off amount
- Grand total
- Rounded total

### Payments
- Each payment method with amount
- Change given

### Custom Fields
- POS notes
- Delivery date
- Delivery charges
- Applied coupons
- Applied offers
- Print count

---

## Invoice Type Support

X POS supports printing for both:
- **Sales Invoice** - Standard invoice type
- **POS Invoice** - POS-specific invoice type (when configured in your profile)
