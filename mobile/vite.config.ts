import { defineConfig, loadEnv, type ProxyOptions } from "vite";
import vue from "@vitejs/plugin-vue";
import path from "path";

const ALLOWED_METHODS =
	/^\/api\/method\/(login|logout|frappe\.auth\.get_logged_user|xpos\.[A-Za-z0-9_.]+)(\?.*)?$/;

function devProxy(env: Record<string, string>): Record<string, ProxyOptions> | undefined {
	const target = env.XPOS_DEV_TARGET;
	if (!target) return undefined;
	const site = env.XPOS_DEV_SITE;
	return {
		"/api": {
			target,
			changeOrigin: true,
			secure: env.XPOS_DEV_INSECURE_TLS !== "1", // self-signed dev certificates: opt in explicitly, per run
			headers: site
				? { "X-Frappe-Site-Name": site, ...(env.XPOS_DEV_HOST ? { Host: env.XPOS_DEV_HOST } : {}) }
				: {},
			cookieDomainRewrite: "",
			bypass(req, res) {
				if (req.url && ALLOWED_METHODS.test(req.url)) return undefined; // forward
				if (res) {
					res.statusCode = 403;
					res.setHeader("Content-Type", "application/json");
					res.end(
						JSON.stringify({
							error: "Blocked by the XPOS Mobile dev proxy (not an allowed method)",
						}),
					);
				}
				return false;
			},
			configure(proxy) {
				// A plain-http dev origin cannot store Secure cookies: drop that attribute for the dev session only.
				proxy.on("proxyRes", (proxyRes) => {
					const sc = proxyRes.headers["set-cookie"];
					if (sc) proxyRes.headers["set-cookie"] = sc.map((c) => c.replace(/;\s*Secure/i, ""));
				});
			},
		},
	};
}

/**
 * The shared Pearl stylesheet loads Inter and Noto Nastaliq Urdu from Google Fonts, which fails offline. The mobile build
 * serves Inter from the app (@fontsource-variable/inter, imported in main.ts) and drops those network imports. The Urdu
 * face is not bundled yet: Urdu text uses the platform's Nastaliq fallback.
 */
function localFonts() {
	return {
		name: "xpos-mobile-local-fonts",
		apply: "build" as const,
		generateBundle(_: unknown, bundle: Record<string, { type: string; source?: string | Uint8Array }>) {
			for (const file of Object.values(bundle)) {
				if (file.type !== "asset" || typeof file.source !== "string") continue;
				file.source = file.source.replace(
					/@import\s*(?:url\(\s*)?["']?https:\/\/fonts\.googleapis\.com[^)"']*["']?\s*\)?\s*;/g, // the URL itself contains ";" (wght@300;400)
					"",
				);
			}
		},
	};
}

export default defineConfig(({ mode }) => {
	const env = loadEnv(mode, import.meta.dirname, "XPOS_");
	return {
		base: "./",
		publicDir: path.resolve(import.meta.dirname, "../frontend/public"),
		plugins: [localFonts(), vue()],
		resolve: {
			alias: {
				"@mobile": path.resolve(import.meta.dirname, "src"),
				"@": path.resolve(import.meta.dirname, "../frontend/src"),
			},
			dedupe: ["vue", "radix-vue", "clsx", "tailwind-merge", "class-variance-authority"],
		},
		server: {
			port: Number(env.XPOS_DEV_PORT || 5174),
			strictPort: true,
			host: env.XPOS_DEV_LAN === "1" ? true : "localhost",
			proxy: devProxy(env),
			hmr: env.XPOS_HMR_HOST
				? { host: env.XPOS_HMR_HOST, port: Number(env.XPOS_DEV_PORT || 5174) }
				: undefined,
		},
		build: { outDir: "dist", target: "es2022", chunkSizeWarningLimit: 600 },
	};
});
