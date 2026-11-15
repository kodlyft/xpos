/**
 * @vitest-environment node
 *
 * Offline installs break silently: a missing icon means no install prompt, a
 * stale precache means a blank screen with no connection. The source shell and
 * icons are checked always; the build artifacts are checked when a build is
 * present, since CI runs the suite without one.
 */
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const BUILT = resolve(import.meta.dirname, "../../xpos/public/xpos");
const SHELL = resolve(import.meta.dirname, "../../xpos/www/xpos.html");
const SOURCE_HTML = resolve(import.meta.dirname, "../index.html");
const SOURCE_PUBLIC = resolve(import.meta.dirname, "../public");
const built = existsSync(resolve(BUILT, "sw.js")) && existsSync(SHELL);

/** `/assets/xpos/xpos/<rest>` is served from `xpos/public/xpos/<rest>`. */
function diskPath(url: string): string | null {
	if (/^https?:/.test(url)) return null;
	const rest = url.replace(/^\/assets\/xpos\/xpos\//, "").replace(/^\//, "");
	return resolve(BUILT, rest);
}

describe("app shell source", () => {
	const html = readFileSync(SOURCE_HTML, "utf8");

	it("carries the iOS install metadata", () => {
		expect(html).toContain('name="apple-mobile-web-app-capable"');
		expect(html).toMatch(/rel="apple-touch-icon"[^>]*href="[^"]+\.png"/);
	});

	it("keeps pinch zoom available", () => {
		expect(html).not.toContain("user-scalable=no");
		expect(html).not.toContain("maximum-scale");
	});

	it("ships the install icons as PNG", () => {
		for (const name of [
			"apple-touch-icon.png",
			"pwa-192x192.png",
			"pwa-512x512.png",
			"pwa-maskable-512x512.png",
		]) {
			expect(existsSync(resolve(SOURCE_PUBLIC, name)), name).toBe(true);
		}
	});
});

describe.skipIf(!built)("built PWA artifacts", () => {
	const manifest = JSON.parse(readFileSync(resolve(BUILT, "manifest.webmanifest"), "utf8")) as {
		display: string;
		start_url: string;
		scope: string;
		icons: Array<{ src: string; sizes: string; type: string; purpose?: string }>;
	};
	const sw = readFileSync(resolve(BUILT, "sw.js"), "utf8");
	const precached = [...sw.matchAll(/url:"([^"]+)"/g)].map((match) => match[1]);
	const html = readFileSync(SHELL, "utf8");

	it("installs as a standalone app scoped to /xpos/", () => {
		expect(manifest.display).toBe("standalone");
		expect(manifest.start_url).toBe("/xpos/");
		expect(manifest.scope).toBe("/xpos/");
	});

	it("ships PNG icons, including a maskable one, that exist on disk", () => {
		const pngs = manifest.icons.filter((icon) => icon.type === "image/png");
		expect(pngs.map((icon) => icon.sizes)).toEqual(expect.arrayContaining(["192x192", "512x512"]));
		expect(pngs.some((icon) => icon.purpose === "maskable")).toBe(true);

		for (const icon of manifest.icons) {
			const path = diskPath(icon.src);
			expect(path, icon.src).not.toBeNull();
			expect(existsSync(path as string), icon.src).toBe(true);
		}
	});

	it("precaches the manifest and every file it names", () => {
		expect(precached).toContain("manifest.webmanifest");

		const missing = precached.filter((url) => {
			const path = diskPath(url);
			return path !== null && !existsSync(path);
		});
		expect(missing).toEqual([]);
	});

	it("precaches the app shell entry point", () => {
		expect(precached.some((url) => /\/assets\/index-[\w-]+\.js$/.test(url))).toBe(true);
		expect(precached.some((url) => /\/assets\/index-[\w-]+\.css$/.test(url))).toBe(true);
	});

	it("waits for the cashier before taking over a running shift", () => {
		expect(sw).toContain("SKIP_WAITING");
		// autoUpdate would claim open tabs on install and reload a sale mid-tender.
		expect(sw).not.toContain("clientsClaim()");
	});

	it("links the manifest and the iOS install icon", () => {
		expect(html).toContain('rel="manifest" href="/assets/xpos/xpos/manifest.webmanifest"');
		expect(html).toMatch(/rel="apple-touch-icon"[^>]*href="[^"]+\.png"/);
	});
});
