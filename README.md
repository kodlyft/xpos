<div align="center">

<img src="xpos/public/images/xpos-logo-light.svg" alt="X POS" width="96" height="96">

# X POS

**A modern, offline-capable Point of Sale for Frappe & ERPNext**

License: MIT · Frappe v16 · ERPNext v16

</div>

> [!IMPORTANT]
> **Contributors: choose the right branch.** `develop` is where **XPOS v3** is being prepared (Pearl redesign, browser/PWA architecture changes, breaking changes). It is not a stable release. Fixes for the existing ERPNext v16 release go to `version-16-hotfix`, which is not published yet. Until it is, open an issue first. See [CONTRIBUTING.md](CONTRIBUTING.md#choosing-a-branch) before opening a pull request.

---

X POS is a feature-rich, offline-first Point of Sale application built on Frappe and ERPNext. It delivers a fast, keyboard-driven, and fully offline-capable POS experience for retail, hospitality, and service businesses, deployable as a web app or installable PWA.

> **v3 is browser/PWA only.** The unfinished Electron desktop app is not part of v3. See [docs/v3-browser-only.md](docs/v3-browser-only.md) for what changed, the browser limits, and how to retire a desktop install without losing unsynced sales.

## Highlights

| Feature | Description |
|---|---|
| **Offline-First** | Keep selling without internet on an open shift. Queued sales sync when reconnected. |
| **PWA Ready** | Install from browser on any device. Works offline with service-worker caching. |
| **Keyboard-Driven** | 15+ shortcuts, command palette (Ctrl+K), and full keyboard navigation. |
| **Dark Mode & RTL** | System theme detection, manual toggle, and full Right-to-Left layout support. |
| **Multi-Payment** | Split payments across cash, card, mobile money, and custom modes in one transaction. |
| **Full Purchasing** | Purchase orders, purchase invoices, and stock receiving, all from the POS. |
| **Customizing** | Customize the theme of the X POS as per your brand for look and feel |

---

## Features

### Point of Sale

- **Real-time cart** – Add items, adjust quantities, apply line-level discounts
- **Multi-payment** – Accept cash, card, mobile wallet, and custom modes per transaction
- **Draft invoices** – Save, retrieve, and manage multiple open orders per session
- **Return mode** – Process returns linked to original invoices with automatic credit notes
- **Repeat sales** – Quickly duplicate previous invoices
- **Customer credit** – Auto-detect unallocated advances and credit notes at checkout
- **Outstanding settlement** – View and pay against a customer's open invoices

### Offline & Sync

- **Continuous offline operation** – Keep selling on an open shift with no internet ([limits](docs/features/16-offline-mode.md#limitations-in-offline-mode))
- **Auto background sync** – Pending invoices queue and retry on reconnection
- **Master data caching** – Items, customers, pricing rules, and tax templates cached locally
- **Sync status indicator** – Real-time display of pending transactions and connection state

### Inventory & Purchasing

- **Real-time stock display** – Actual quantities per warehouse
- **Batch & serial tracking** – Select specific batch/serial numbers during sale or return
- **Purchase orders** – Create, search, and invoice against POs
- **Purchase invoices** – Direct invoice entry with multi-line tax
- **Stock receiving** – Goods receipt workflow with PO matching and variance handling
- **Barcode scanning** – Automatic item lookup via integrated barcode scanner

### Customer Management

- **Quick search & inline creation** – Find or add customers without leaving the POS
- **Loyalty programs** – Point accumulation, redemption, and multi-program support
- **Credit limits** – Enforce customer credit policies during checkout
- **Address management** – Multiple billing and shipping addresses per customer

### Pricing & Discounts

- **Price list selection** – Per-transaction selling price list with currency support
- **Pricing rules** – Volume, customer, time-based, and brand/group rules
- **Free-item promotions** – "Buy X get Y free" rules with auto-apply
- **Coupon codes** – Validate and apply promotional and customer-bound coupon codes (discounts, not stored value)
- **Gift cards** – Sell stored-value cards anyone can spend in parts, with a liability ledger reconciled to the GL (online only)
- **Multi-level discounts** – Item-level, order-level, and permission-controlled additional discounts
- **Delivery charges** – Dynamic delivery fee calculation per basket or customer

### Shift & Cash Management

- **Opening shift** – Define opening balance with cash denomination breakdown
- **Closing shift** – Reconcile all payment modes with tax collection summary
- **Cash expenses** – Record till expenses with GL account allocation
- **Cash deposits** – Move cash from till to bank/safe accounts mid-shift

### Receipts & Printing

- **Dynamic print format** – Select from available ERPNext print formats
- **Print format rules** – Conditional printing based on payment type or other criteria
- **Barcode printing** – Generate and print item barcodes and QR codes
- **Thermal printer support** – Optimized for ESC/POS printers

### Payments

- **Mixed Currency Cash Tender** – Allow user to tender mixed currencies. e.g. USD -> PKR
- **Multi Currency** – Featuring multi currency in one system
- **Cash Movemenet Tracking** – Generating Cash Movement (Expense or Bank Drop) based on profiles
- **Credit Mode** – Enables the credit sales and credit payments

### User Interface

- **Command palette** (Ctrl+K) – Navigate pages, execute actions, search items, and calculate all from one bar
- **Keyboard shortcuts** – 15+ shortcuts for all major operations with in-app shortcut reference
- **Dark mode** – System theme detection and manual light/dark/system toggle
- **RTL support** – Full Right-to-Left interface for Arabic, Hebrew, and other RTL languages
- **Touch-optimized** – Large buttons and responsive grid layout for retail touchscreens
- **Responsive design** – Adapts to phones, tablets, and desktop displays
- **About dialog** – Version, git info, system details, and environment information

### Deployment Options

| Mode | Description |
|---|---|
| **Web** | Standard browser-based deployment via Frappe site |
| **PWA** | Installable progressive web app with offline service worker |

### Security & Access Control

- **26+ permission flags** per user discount authority, return privileges, expense access, price overrides, and more
- **POS Profile assignment** – Granular per-location access control
- **Warehouse-level permissions** – Restrict users to specific inventory locations
- **Frappe authentication** – Standard login with 2FA, API key, and offline auth cache

---

## Requirements

| Dependency | Version |
|---|---|
| Python | >= 3.14 |
| Frappe Framework | v16 |
| ERPNext | v16 |
| Node.js | >= 24 (for builds) |

---

## Installation

### Frappe Cloud

X POS is available on Frappe Cloud. Add it as a marketplace app to your site.

### Self-Hosted

```bash
cd $PATH_TO_YOUR_BENCH
bench get-app xpos --branch version-16
bench --site your-site.com install-app xpos
```

Releases are published from the `version-16` branch. The default `develop` branch is preparing XPOS v3 and is not intended for production sites.

Then open your site and launch **X POS** from the app launcher.

---

## Mobile (Android)

XPOS Mobile is an Android app (Vue + Capacitor) that sells against the same ERPNext 16 site, with the same look, prices, promotions and permissions as the web POS.

- Sign in with your ERPNext user, pick a POS Profile, unlock with a 6-digit PIN.
- Search a large catalog, choose customers, take cash, card, transfer and gift-card payments, in three layouts (Catalog, Scan, Fashion).
- Needs ERPNext 16, an `https://` server and Android 7+. Charging needs a connection; returns, shift closing and printing are done in the web POS.
- The Price Checker kiosk is a web screen at `/price-checker`, not part of the app.

Start with [docs/features/35-xpos-mobile-overview.md](docs/features/35-xpos-mobile-overview.md) (what it needs and what it cannot do yet). For builds and publishing see [mobile/docs/release.md](mobile/docs/release.md). See [mobile/README.md](mobile/README.md) for `yarn dev` (browser development with hot reload against a real dev site), Android Studio/Gradle builds, live reload on an emulator or phone, signing and troubleshooting, and [docs/features/33-mobile-selling.md](docs/features/33-mobile-selling.md) for the cashier guide.

---

## Configuration

1. Create or update a **POS Profile** in ERPNext and assign it to the relevant users.
2. Set the default warehouse, payment methods, and print format on the POS Profile.
3. Configure user permissions via the **XPOS Settings** page for granular access control.
4. Open **X POS** from the app launcher to start selling.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Vue 3, TypeScript, Pinia, Tailwind CSS, Radix Vue |
| Build | Vite, vite-plugin-pwa |
| Backend | Frappe Framework (Python) |
| Offline storage | IndexedDB (Dexie) and a service worker |
| Linting | Ruff, ESLint, Prettier |
| Testing | Vitest |
| CI/CD | GitHub Actions, Semantic Release |

---

## Contributing

We welcome contributions from the community! Whether it's bug reports, feature requests, documentation improvements, or code contributions every bit helps.

Please read our [Contributing Guide](CONTRIBUTING.md) before submitting a pull request. It explains which branch to use:

| Work | Branch from and target |
|---|---|
| Fixes for the existing ERPNext v16 release | `version-16-hotfix` (not published yet; open an issue first) |
| XPOS v3 features and breaking changes | `develop` |
| Security vulnerabilities | Private report, see [SECURITY.md](SECURITY.md) |

### Quick Start for Contributors

```bash
cd $PATH_TO_YOUR_BENCH
bench get-app https://github.com/kodlyft/xpos.git --branch develop
bench --site your-site.com install-app xpos
cd apps/xpos
pre-commit install
```

This sets up `develop` for XPOS v3 work. For v16 maintenance fixes, follow the branch steps in [CONTRIBUTING.md](CONTRIBUTING.md#getting-started).

### Translations

```
bench generate-pot-file --app <app> - extracted each app's own translatable strings into locale/main.pot.
bench migrate-csv-to-po --app <app> --locale ar - merged the CSV translations into locale/ar.po.
bench compile-po-to-mo --app <app> --locale ar --force
bench update-csv-from-po <app> --locale ar
```

### Code Quality

This project uses `pre-commit` for code formatting and linting:

- **ruff** – Python linting, import sorting, and formatting
- **eslint** – JavaScript / TypeScript linting
- **prettier** – Code formatting for JS, Vue, and SCSS

All commits must follow Conventional Commits format:

```
feat: add barcode printing support
fix: correct tax calculation for returns
docs: update installation instructions
```

### Community

- Report a Bug: See the issue tracker in the source repository
- Request a Feature: See the issue tracker in the source repository
- [Security Policy](SECURITY.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)

---

## License

MIT @ [LICENSE](LICENSE)

---
