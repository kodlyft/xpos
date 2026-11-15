# Releasing XPOS Mobile

Runbook for building and shipping the Android app. Setup, `yarn dev` and troubleshooting are in [../README.md](../README.md). The rollout view for non-developers is [docs/features/35-xpos-mobile-overview.md](../../docs/features/35-xpos-mobile-overview.md).

## Before you build

1. `cd mobile && yarn install`.
2. `yarn check` (typecheck, tests, build) must be green.
3. `yarn android:test` (schema export and Android unit tests; needs JDK 21 and the Android SDK).
4. Make sure `CAP_LIVE_RELOAD_URL`, `XPOS_ANDROID_DEV` and `VITE_ALLOW_CLEARTEXT` are not set in your shell. The guard fails the build if they are.

## Build

| Command | Output |
|---|---|
| `yarn android:build` | Debug APK: `android/app/build/outputs/apk/debug/app-debug.apk`. For testing only. |
| `yarn android:release` | Release APK (unsigned unless signing is set), then the release guard. |
| `yarn android:bundle` | Release App Bundle: `android/app/build/outputs/bundle/release/app-release.aab`. This is what Google Play takes. |

## Signing

Create `android/keystore.properties` (git-ignored) with `storeFile`, `storePassword`, `keyAlias`, `keyPassword`, or set `XPOS_KEYSTORE_FILE`, `XPOS_KEYSTORE_PASSWORD`, `XPOS_KEY_ALIAS` and `XPOS_KEY_PASSWORD`. Without them the output is unsigned and cannot be installed on a normal device or uploaded.

Never commit the keystore or its passwords. Keep a backup of the upload key somewhere safe: losing it blocks updates.

## What the release guard checks

`yarn android:release-guard` (also run by the release tasks) fails when a release could carry anything developer-only:

- a live-reload server or cleartext setting in the environment;
- a `server.url` or cleartext flag in the synced `capacitor.config.json`;
- developer hosts, Vite HMR code or a Google Fonts import in `dist`;
- cleartext in the merged release manifest.

Release builds accept `https://` servers only. Cleartext exists only in the debug build.

## Before the first store upload

- **Application id.** The current `com.kodlyft.xpos.mobile.dev` is provisional. It is permanent after the first upload, so decide the final id first.
- **Play App Signing** enrolment and your own upload key.
- **Target API** must meet Google Play's current requirement; the app uses compileSdk/targetSdk 36 and minSdk 24.
- **Privacy policy and Data safety form.** The app handles cashier sign-in, sales data and customer names. It requests only the Internet permission, does not use analytics or advertising, and turns Android backup off. State this accurately and have the policy reviewed.
- **Store listing:** name, short and long description, icon, phone and tablet screenshots (take them from a release build).
- **Dependencies:** review the native ones (Capacitor, WorkManager, Kotlin, Android Gradle Plugin) and check 64-bit and 16 KB page-size compatibility on the release build.

## Known gaps at the time of writing

- No mobile CI job; builds and checks run by hand.
- Not verified on a physical device. It has been checked on the Android 16 emulator only (see the verification table in the README).
- Real connected checkout from the app against a disposable site, and a signed release, have not been exercised.

## Updating

Bump the version in `android/app/build.gradle` (`versionCode` must increase on every upload), rebuild the bundle, and upload. The server API is shared with the web POS, so deploy the XPOS server update first when an app release depends on it.
