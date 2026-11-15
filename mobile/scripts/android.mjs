/**
 * Android build helper (works on Windows, macOS and Linux). Usage: node scripts/android.mjs <debug|dev|bundle|open>
 *
 *  debug   web build (cleartext http:// servers allowed in the UI) -> cap sync -> assembleDebug
 *  dev     live-reload debug app: cap sync with the dev server URL baked in -> installDebug. Needs CAP_LIVE_RELOAD_URL.
 *  bundle  RELEASE: web build (https only) -> cap sync -> bundleRelease. Refuses a dev server URL and needs signing.
 *  release unsigned release APK (no signing needed): web build (https only) -> cap sync -> assembleRelease -> release guard
 *  open    cap open android (Android Studio)
 *
 * Anything after the subcommand goes to Gradle, for example: node scripts/android.mjs debug --info
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const android = resolve(root, "android");
const win = process.platform === "win32";
const gradlew = win ? "gradlew.bat" : "./gradlew";

function run(cmd, args, cwd = root, env = {}) {
	console.log(`\n> ${cmd} ${args.join(" ")}`);
	const r = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: win, env: { ...process.env, ...env } });
	if (r.status !== 0) {
		console.error(`\nFailed: ${cmd} ${args.join(" ")}`);
		process.exit(r.status ?? 1);
	}
}

function fail(msg) {
	console.error(`\n${msg}`);
	process.exit(1);
}

const sub = process.argv[2];
const extra = process.argv.slice(3);
if (sub === "open") {
	run("yarn", ["cap", "open", "android"]);
} else if (sub === "debug") {
	// never let a leftover live-reload setting leak into a normal debug build
	const env = { VITE_ALLOW_CLEARTEXT: "1", XPOS_ANDROID_DEV: "", CAP_LIVE_RELOAD_URL: "" };
	run("yarn", ["build"], root, env);
	run("yarn", ["cap", "sync", "android"], root, env);
	run(gradlew, ["assembleDebug", ...extra], android);
	console.log("\nAPK: android/app/build/outputs/apk/debug/app-debug.apk");
} else if (sub === "dev") {
	const url = process.env.CAP_LIVE_RELOAD_URL;
	if (!url)
		fail(
			"Set CAP_LIVE_RELOAD_URL (for example http://10.0.2.2:5174 for the emulator) before running android:dev.",
		);
	const env = { XPOS_ANDROID_DEV: "1", VITE_ALLOW_CLEARTEXT: "1" };
	run("yarn", ["schema"], root, env); // the app still needs the schema asset; web assets come from the dev server
	run("yarn", ["cap", "sync", "android"], root, env);
	run(gradlew, ["installDebug", ...extra], android);
	console.log(
		`\nInstalled. Start the dev server with: yarn dev   (XPOS_DEV_LAN=1, XPOS_HMR_HOST set; see README)\nThe app loads ${url}`,
	);
} else if (sub === "bundle") {
	if (process.env.XPOS_ANDROID_DEV || process.env.CAP_LIVE_RELOAD_URL)
		fail(
			"A release bundle must not point at a dev server. Unset XPOS_ANDROID_DEV and CAP_LIVE_RELOAD_URL.",
		);
	const env = { VITE_ALLOW_CLEARTEXT: "", XPOS_ANDROID_DEV: "", CAP_LIVE_RELOAD_URL: "" };
	run("yarn", ["build"], root, env);
	run("yarn", ["cap", "sync", "android"], root, env);
	const cfg = resolve(android, "app/src/main/assets/capacitor.config.json");
	if (existsSync(cfg) && /"url"\s*:/.test(readFileSync(cfg, "utf8")))
		fail("capacitor.config.json still contains a server url. Re-run cap sync without XPOS_ANDROID_DEV.");
	run("node", ["scripts/release-guard.mjs"], root, env);
	run(gradlew, ["bundleRelease", ...extra], android);
	console.log("\nBundle: android/app/build/outputs/bundle/release/app-release.aab");
} else if (sub === "release") {
	if (process.env.XPOS_ANDROID_DEV || process.env.CAP_LIVE_RELOAD_URL)
		fail(
			"A release build must not point at a dev server. Unset XPOS_ANDROID_DEV and CAP_LIVE_RELOAD_URL.",
		);
	const env = { VITE_ALLOW_CLEARTEXT: "", XPOS_ANDROID_DEV: "", CAP_LIVE_RELOAD_URL: "" };
	run("yarn", ["build"], root, env);
	run("yarn", ["cap", "sync", "android"], root, env);
	run("node", ["scripts/release-guard.mjs"], root, env);
	run(gradlew, ["assembleRelease", ...extra], android);
	run(
		"node",
		[
			"scripts/release-guard.mjs",
			"--manifest",
			"android/app/build/intermediates/merged_manifests/release/processReleaseManifest/AndroidManifest.xml",
		],
		root,
		env,
	);
	console.log("\nAPK (unsigned unless signing is configured): android/app/build/outputs/apk/release/");
} else {
	fail("Usage: node scripts/android.mjs <debug|dev|release|bundle|open>");
}
