# XPOS Mobile

Vue + Capacitor app (Android) that sells against a real ERPNext 16 site with XPOS installed. The same UI also runs in a browser (`yarn dev`) for development. Cashier guide: [docs/features/33-mobile-selling.md](../docs/features/33-mobile-selling.md). Overview and rollout: [docs/features/35-xpos-mobile-overview.md](../docs/features/35-xpos-mobile-overview.md). Building and publishing: [docs/release.md](docs/release.md).

## What works

- Real login, authorized POS Profile choice, company/warehouse/currency/payment methods/open shift from `xpos.api.mobile.bootstrap`.
- Real catalog (tested with 72,611 items): staged download, atomic activation, changes-only refresh (`catalog_delta`), digest check, scope-change and expired-cursor restarts. Items with no price in the price list are listed but cannot be sold; an item priced 0.00 is a different thing: the server flags a missing price (`price_missing`) and the POS Profile setting "allow zero rated items" decides whether a free sale is accepted (`quote_sale` refuses it with the same rule `create_invoice` uses).
- Connected checkout: `xpos.api.mobile.quote_sale` (ERPNext's prices, taxes, rounded amount due) -> payments -> the sale is written to the device with its tender and receipt evidence -> `xpos.api.invoices.create_invoice` with a stable sale id. A lost reply is retried with the same id and returns the existing invoice. Server repricing, validation refusals, session expiry and connection loss each have their own state (Sales tab).
- Three layouts (Catalog, Scan Counter, Fashion Assist) sharing one cart; light and dark; phone and tablet.

## Not implemented yet (be aware)

Offline selling (charging is switched off offline: stock, serial/batch and receipt checks need the server), background sending while the app is closed, returns, shift closing, printing, camera scanning, serial/batch items, MFA/SSO accounts, weighed-item barcodes, Urdu Nastaliq font. Card/transfer payments are labelled "cashier-confirmed": XPOS records what the cashier entered and does not check it with the terminal or bank (a reference is required where the company marks the mode as reference-required). Fiscal (FBR) sales that need a local step are shown as "fiscal pending", are kept on the device with their invoice and sale id, block any new sale until finished in the web POS, and are never shown as completed. A sale re-priced by the server stays on the device as one held sale (not put back in the live cart, so it cannot be sold twice). Offline checkout is switched off; the agreed 24-hour offline requirement is NOT implemented.

## Verification status (2026-10-24)

| Status | What |
|---|---|
| Browser verified | `yarn dev` flow (reported by the project owner; not re-run in this pass). `yarn typecheck`, `yarn test` (93), `yarn build` re-run and green. |
| Android compiled | Debug APK, unsigned release APK, release AAB, `lintRelease` not run; Kotlin 2.3.10, AGP 8.13.0, Gradle 8.14.3, JDK 21, compileSdk 36. 15 JVM unit tests pass. |
| Emulator verified | Windows emulator, Android 16 (API 36) x86_64, WHPX. 18 instrumented tests pass: fresh schema, upgrade keeps rows, `priced` column upgrade, downgrade opens read-only and every catalog/transaction/outbox write path refuses, catalog paging/barcode/staging/activation, sale commit atomicity, real Android Keystore sealing, PIN throttle surviving restart, restart starts locked, one cashier per device, 24 h lease cap, expired lease unlocks but refuses writes. The release-style debug app launches and renders styled with the bundled Inter font. |
| Physical-device verified | Nothing. |
| Not verified or blocked | Real connected checkout and duplicate-safe recovery from the app (needs a disposable ERPNext site and an agreed cleanup policy; none run); native cookie jar / session handling against a real server; real catalog download and delta on the device; reboot behaviour of the lease (only the JVM vectors cover it); background auto-lock timing; Kotlin vs TypeScript SchemaSync parity beyond the shared schema JSON; signed release; physical-device performance. |

Defects found by compiling and running on the emulator and fixed: three Kotlin compile errors in `SchemaSync.kt` (`arrayOf` of mixed types), an unclosed KDoc comment and a stale call in the instrumented test, `createScope` writing without the read-only guard, and the release web build losing all CSS (the font-stripping regex cut at the first `;` of the Google Fonts URL and left garbage at the top of the stylesheet; `yarn dev` never ran that step, so the browser looked fine).

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | 22.7 or newer (24 used here) | the schema export uses `--experimental-transform-types` |
| Yarn | 1.22 (classic) | `yarn install` |
| JDK | **21** | Capacitor 8 generates Java 21 settings (`android/app/capacitor.build.gradle`) and the app now builds with 21 |
| Android Studio | current stable (Otter or newer) | includes the SDK manager |
| Android SDK | Platform **36**, Build-Tools 36.x, Platform-Tools | `compileSdk`/`targetSdk` 36, `minSdk` 24 |
| Server | ERPNext **16** + Frappe 16 + XPOS from this repository | the app refuses other versions, and a server that does not report its ERPNext version |

Verified toolchain: Temurin JDK 21 and Android SDK Platform 36 / Build-Tools 36.0.0 (command-line tools, no Android Studio needed). On Windows with WSL: install the JDK and SDK on Windows (`winget install EclipseAdoptium.Temurin.21.JDK`, command-line tools into `C:\Android\Sdk`, `sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0" "emulator" "system-images;android-36;google_apis;x86_64"`) for the emulator and `adb.exe`; to build from WSL you also need Linux builds of the JDK and SDK (aapt2 is a platform binary), for example under `~/android-toolchain`. Run `adb.exe install` and `adb.exe shell am instrument` from WSL against the Windows emulator (do not expose the adb server on the network). Under WSL, set `COREPACK_ENABLE_STRICT=0` so `yarn` 1 runs inside this repository, whose root declares yarn 4.

Set `ANDROID_HOME` (Linux/macOS `~/Android/Sdk`, Windows `%LOCALAPPDATA%\Android\Sdk`) and add `platform-tools` to `PATH` so `adb` works. Enable *USB debugging* on a phone, or create an emulator (API 34+). Gradle needs `JAVA_HOME` pointing at JDK 21.

## Development: `yarn dev`

```bash
cd mobile
yarn install
cp .env.example .env.local     # no credentials in it; edit the target and site name
yarn dev                       # http://localhost:5174, hot module replacement
```

Open the page, enter the dev server's own address (prefilled), sign in with a real ERPNext user, set a PIN. Everything after that is the real app: real catalog download, real quote and invoice.

How it works: Vite proxies `/api/*` to `XPOS_DEV_TARGET` (same origin, so the session cookie and CSRF token behave as on a server; no CORS or TLS is weakened). Only `login`, `logout`, `frappe.auth.get_logged_user` and `xpos.*` methods are forwarded; everything else under `/api` answers 403. `XPOS_DEV_SITE` is sent as `X-Frappe-Site-Name` for multi-site benches (or set `XPOS_DEV_HOST` to send a `Host` header instead). The proxy exists only while `vite` serves; it is not in any build. Do not point it at a production site.

The browser uses IndexedDB instead of SQLite and a PBKDF2-hashed PIN in `localStorage` instead of the Android Keystore. The app says so on screen. Scanner, printer and secure unlock are unavailable in the browser. Use a development or test site: sales you make are real invoices on the target site.

### Live reload on Android

Edits to `src/` (Vue, TypeScript, CSS, shared Pearl components) refresh immediately. Kotlin, `AndroidManifest.xml`, Gradle files, `capacitor.config.ts` and Capacitor plugins need a native rebuild (`yarn android:dev` again). Changes to models (`src/db/models`) need `yarn schema` plus a rebuild so `xpos-schema.json` reaches the app.

1. Emulator: `CAP_LIVE_RELOAD_URL=http://10.0.2.2:5174 XPOS_HMR_HOST=10.0.2.2` (the emulator's name for your computer). Physical device on the same Wi-Fi: use your computer's LAN IP, and set `XPOS_DEV_LAN=1` so Vite listens on the network. Physical device over USB: `adb reverse tcp:5174 tcp:5174`, then `CAP_LIVE_RELOAD_URL=http://localhost:5174`.
2. Put those values in `.env.local` (Vite reads `XPOS_*`) and export `CAP_LIVE_RELOAD_URL` in the shell (Windows PowerShell: `$env:CAP_LIVE_RELOAD_URL="http://10.0.2.2:5174"`).
3. `yarn dev` in one terminal; `yarn android:dev` in another (syncs and installs the debug app). The app loads the dev server; the server field in the app still takes your ERPNext address or the dev server address.

Safety: live reload and cleartext (http://) exist only in **debug** builds. `src/debug/AndroidManifest.xml` enables cleartext; the main manifest does not. `yarn android:bundle` refuses to run with `CAP_LIVE_RELOAD_URL` set, and Gradle's `preReleaseBuild` fails if `capacitor.config.json` contains a server url. Release builds accept https:// servers only.

## Checks

```bash
yarn typecheck     # vue-tsc
yarn test          # vitest: catalog, delta, checkout, schema safety, login, search, 100,000 items
yarn build         # writes xpos-schema.json (generated, gitignored) and dist/
yarn schema        # only regenerate xpos-schema.json
yarn check         # all of the above
yarn android:test  # schema + Android JVM unit tests (needs JDK/SDK); --device adds connectedDebugAndroidTest; other arguments go to Gradle
yarn android:release-guard  # fails if a dev server url, cleartext or dev marker is in the release inputs
```

Server tests (mock based, no database writes): `test_mobile_bootstrap`, `test_mobile_quote` (authorization, missing/zero/positive price, unsupported UOM/serial/batch, no writes), `test_endpoint_exposure`. They passed on `site.local` through a plain unittest runner with `frappe.init`/`connect` (the ERPNext test bootstrap does not run on that site).

The schema is never edited by hand: each table is a model class in `src/db/models`; `yarn build` exports them to `android/app/src/main/assets/xpos-schema.json`, which the Kotlin `SchemaSync` applies when the database opens. Additive changes (new table, nullable or defaulted column, index) are automatic. Renames, drops, type/NOT NULL/default/CHECK/foreign-key changes are refused with a message until you add a step in `src/db/steps.ts`; a step flagged `breaksOlderWriters` raises the device's *writer level*, and an older app build then opens that database read-only instead of writing to it.

## Android build

```bash
yarn cap:sync            # yarn build + cap sync android
yarn android:open        # open the project in Android Studio
yarn android:build       # debug APK (web build + sync + gradlew assembleDebug)
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
yarn android:release     # unsigned release APK + release guard (also on the merged manifest)
yarn android:bundle      # release App Bundle (https servers only)
```

- Debug APK: `android/app/build/outputs/apk/debug/app-debug.apk`.
- Release APK (unsigned): `android/app/build/outputs/apk/release/app-release-unsigned.apk`.
- Release bundle: `android/app/build/outputs/bundle/release/app-release.aab`.
- Signing (release): create `android/keystore.properties` (git-ignored) with `storeFile`, `storePassword`, `keyAlias`, `keyPassword`, or set `XPOS_KEYSTORE_FILE`, `XPOS_KEYSTORE_PASSWORD`, `XPOS_KEY_ALIAS`, `XPOS_KEY_PASSWORD`. Without them the bundle is unsigned and cannot be uploaded. Never commit a keystore or its passwords.
- Windows: the commands are the same in PowerShell (`gradlew.bat` is chosen automatically). Keep the repository on the Windows drive, not under `\\wsl$`, for Gradle.

Public Google Play submission also needs: a finalized application id (the current `com.kodlyft.xpos.mobile.dev` is provisional and permanent after the first upload), your own release signing and Play App Signing enrolment, a target API that meets Play's current rule, the privacy policy and Data safety declarations (the app handles cashier credentials, sales data and customer names), and a review of the native dependencies (WorkManager, Capacitor, Kotlin, AGP) and 64-bit/16 KB page-size compatibility on the release build.

## Troubleshooting

- **`Unsupported class file major version` / `invalid source release: 21`**: Gradle is using the wrong JDK. Install JDK 21 and set `JAVA_HOME`.
- **`SDK location not found`**: set `ANDROID_HOME`, or create `android/local.properties` with `sdk.dir=...`. **`Failed to find target with hash string 'android-36'`**: install Platform 36 in the SDK Manager.
- **`Missing src/main/assets/xpos-schema.json`**: run `yarn schema` (or `yarn build`) first.
- **Login says "unsupported server"**: the user has no POS Profile, XPOS is not installed, or the server does not report an ERPNext 16 version.
- **Browser: 404 "does not exist" for the site**: the bench routes by site name; set `XPOS_DEV_SITE` (or `XPOS_DEV_HOST`). **403 JSON from the proxy**: the path is not on the allow-list (by design).
- **Sign-in works but later calls fail with "session expired"**: cookies are not reaching the server; in the browser use the dev server's address (not the bench's), clear site data, and check the `sid` cookie. A CSRF error after login means the first call after login failed: sign in again.
- **`localhost` on a device**: on the emulator your computer is `10.0.2.2`; on a physical device use the LAN IP (and `XPOS_DEV_LAN=1`) or `adb reverse`. A blank page on the device usually means the URL is unreachable from it.
- **HMR does not update on a device**: set `XPOS_HMR_HOST` to the address the device uses, and allow the dev port through your firewall.
- **Old UI after a change**: Android shows the assets copied by the last `cap sync`; run `yarn cap:sync` (or `yarn android:build`). In a browser, hard-refresh and clear site data if the stored catalog looks stale.
- **When to `cap sync`**: after any web change you want bundled into the APK, after adding a Capacitor plugin, or after changing `capacitor.config.ts`. **When to rebuild native**: Kotlin, manifest, Gradle, plugin changes, or a new `xpos-schema.json`.
