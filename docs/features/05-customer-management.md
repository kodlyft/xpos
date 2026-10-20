# Customer Management

X POS provides full customer management directly from the POS screen - search existing customers, create new ones, view details, and manage loyalty programs.

---

## Selecting a Customer

### Customer Selection Button
- Click the **Customer** button at the top of the cart area
- Opens the Customer Selection Dialog

### Search Customers
- Type in the search field to find customers by:
  - **Customer name**
  - **Mobile number**
  - **Email address**
  - **Tax ID**
- Search is debounced for performance (waits briefly after you stop typing)
- Results show a list with:
  - Customer avatar/initials
  - Full name
  - Phone number
  - Email address

### Keyboard Navigation
- **Arrow Up / Arrow Down** - Navigate through the customer list
- **Enter** - Select the highlighted customer
- Start typing immediately to filter results

### Customer Groups
- If the POS Profile has customer group restrictions, only customers belonging to allowed groups are shown
- Customer group hierarchy is respected - child groups are included
- The same limit applies everywhere in the POS, not just the search list. A cashier cannot open, edit, enrol in loyalty, or see the addresses or credit of a customer outside the allowed groups. Asking for one shows a "not permitted" message
- Users who can open that customer in ERPNext Desk (through their roles and User Permissions) are not limited by the POS Profile's groups

---

## Creating a New Customer

Directly from the Customer Selection Dialog, you can create a new customer without leaving the POS screen.

### Quick Create Form Fields
| Field | Required | Description |
|---|---|---|
| Customer Name | Yes | Full name of the customer |
| Tax ID | No | Tax identification number |
| Mobile No | No | Phone number |
| Email | No | Email address |
| Gender | No | Dropdown selection |
| Birthday | No | Date of birth (for birthday promotions) |
| Referral Code | No | Referral code if referred by another customer |
| Customer Group | No | Dropdown populated from your system |
| Territory | No | Dropdown populated from your system |
| Address Line 1 | No | Street address |
| City | No | City name |
| Country | No | Dropdown of countries |

### Create & Select
- Click **Create & Select** to save the customer and immediately select them for the current transaction
- The customer is saved and available for all future searches
- If company-level auto-referral is configured, a referral code is generated for the new customer

---

## Updating Customer Information

- Select a customer and use the **Edit** option to update their details
- Editable fields include:
  - Customer name, mobile, email
  - Tax ID, gender, birthday
  - Customer group, territory
- Changes are saved immediately to ERPNext

---

## Customer Information Display

Once a customer is selected, X POS can display:

### Basic Info
- Customer name, mobile, email
- Customer group and territory
- Tax ID

### Financial Info
- **Outstanding balance** - Total unpaid amount from GL entries when available at checkout
- **Customer credit** - Unallocated payment entries and credit notes available for use

### Customer-Specific Pricing
- **Customer discount** - A percentage discount stored on the customer record
- **Customer price list** - If the customer has a specific price list assigned
- Auto-applied when `apply_customer_discount` is enabled in the POS Profile

### Addresses
- List of all addresses linked to the customer
- Each address shows: address line, city, country
- Addresses can be selected for shipping/billing on the invoice

---

## Adding Customer Addresses

- Create a new address directly from the POS interface
- Fields include:
  - Address Line 1 (required)
  - City
  - Country
- The address is linked to the customer in ERPNext
- Available for future orders and delivery purposes

---

## Customer Credit

X POS tracks customer credit from two sources:

1. **Unallocated Payment Entries** - Advance payments not yet applied to invoices
2. **Credit Notes** - Return/refund credit available for the customer

### Using Credit for Payment
- When `use_customer_credit` is enabled, credit can be applied during checkout
- Available credits are listed in the payment dialog
- See [Payment Processing](06-payment-processing.md) for details

---

## Sales Person Assignment

- A **sales person** can be assigned to each transaction
- Sales persons are fetched from ERPNext's Sales Person doctype
- The POS Profile can restrict available sales persons via the `allowed_sales_persons` table
- The assigned sales person is recorded on the invoice

---

## Offline Customer Support

- When offline mode is enabled, X POS pre-caches up to **1,000 customers** locally
- Customer search works offline using the cached data
- New customers created offline are synced when the connection is restored
