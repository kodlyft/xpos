/**
 * Release guard. Fails (exit 1) when a build meant for release could carry anything developer-only.
 * Usage: node scripts/release-guard.mjs [--manifest <merged release AndroidManifest.xml>]
 *
 * Checked: the environment (no live-reload server), the Capacitor config synced into the app (no server url,
 * no cleartext), the web bundle in dist (no dev host, no HMR client, no Google Fonts import left over), and the merged release manifest (no cleartext).
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];
const fail = (m) => problems.push(m);

if (process.env.XPOS_ANDROID_DEV) fail("XPOS_ANDROID_DEV is set (live reload).");
if (process.env.CAP_LIVE_RELOAD_URL)
	fail(
		`CAP_LIVE_RELOAD_URL is set (${process.env.CAP_LIVE_RELOAD_URL}): the app would load code from a developer machine.`,
	);
if (process.env.VITE_ALLOW_CLEARTEXT)
	fail("VITE_ALLOW_CLEARTEXT is set: release builds accept https:// servers only.");

const cfgPath = join(root, "android/app/src/main/assets/capacitor.config.json");
if (!existsSync(cfgPath)) fail("capacitor.config.json is missing: run `yarn cap sync android` first.");
else {
	const server = JSON.parse(readFileSync(cfgPath, "utf8")).server ?? {};
	if (server.url) fail(`capacitor.config.json has server.url (${server.url}).`);
	if (server.cleartext) fail("capacitor.config.json has server.cleartext enabled.");
}

const DEV_MARKERS = [
	/10\.0\.2\.2/,
	/localhost:5\d{3}/,
	/127\.0\.0\.1:5\d{3}/,
	/@vite\/client/,
	/vite-hmr/,
	/__vite_ping/,
	/fonts\.googleapis\.com/,
	/display=swap/,
];
const dist = join(root, "dist");
if (!existsSync(dist)) fail("dist is missing: run `yarn build` first.");
else {
	const walk = (d) =>
		readdirSync(d).flatMap((n) => {
			const p = join(d, n);
			return statSync(p).isDirectory() ? walk(p) : [p];
		});
	for (const f of walk(dist).filter((p) => /\.(js|css|html|json|map)$/.test(p) && !p.endsWith(".map"))) {
		const text = readFileSync(f, "utf8");
		for (const re of DEV_MARKERS)
			if (re.test(text)) fail(`${f.slice(root.length + 1)} contains a development marker (${re}).`);
	}
}

const mi = process.argv.indexOf("--manifest");
const manifests = [join(root, "android/app/src/main/AndroidManifest.xml")];
if (mi > -1) manifests.push(resolve(process.argv[mi + 1]));
for (const m of manifests) {
	if (!existsSync(m)) fail(`manifest not found: ${m}`);
	else if (/usesCleartextTraffic\s*=\s*"true"/.test(readFileSync(m, "utf8")))
		fail(`${m.replace(root + "/", "")} allows cleartext traffic.`);
}

if (problems.length) {
	console.error("Release guard FAILED:\n - " + problems.join("\n - "));
	process.exit(1);
}
console.log("Release guard passed: no dev server, no cleartext, no dev markers in the bundle.");
