import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { VitePWA } from "vite-plugin-pwa";
import path from "path";

export default defineConfig({
	base: "/xpos/",
	plugins: [
		vue(),
		VitePWA({
			registerType: "prompt",
			injectRegister: false,
			manifest: {
				name: "X POS - Point of Sale",
				short_name: "X POS",
				description: "Modern Point of Sale application with offline support",
				theme_color: "#1d4ed8",
				background_color: "#e8ecf2",
				display: "standalone",
				orientation: "any",
				scope: "/xpos/",
				start_url: "/xpos/",
				id: "/xpos/",
				categories: ["business", "finance"],
				icons: [
					{
						src: "/assets/xpos/xpos/pwa-192x192.png",
						sizes: "192x192",
						type: "image/png",
					},
					{
						src: "/assets/xpos/xpos/pwa-512x512.png",
						sizes: "512x512",
						type: "image/png",
					},
					{
						src: "/assets/xpos/xpos/pwa-maskable-512x512.png",
						sizes: "512x512",
						type: "image/png",
						purpose: "maskable",
					},
				],
				screenshots: [
					{
						src: "/assets/xpos/xpos/pwa-512x512.png",
						sizes: "512x512",
						type: "image/png",
						form_factor: "wide",
						label: "X POS Dashboard",
					},
					{
						src: "/assets/xpos/xpos/pwa-512x512.png",
						sizes: "512x512",
						type: "image/png",
						form_factor: "narrow",
						label: "X POS Mobile",
					},
				],
			},
			devOptions: {
				enabled: false,
			},
			workbox: {
				globPatterns: ["**/*.{js,css,svg,png,ico,woff,woff2,ttf,eot}"],
				globIgnores: ["**/index.html"],
				// The shell is a Jinja template, so it cannot be precached. Cache the
				// rendered HTML at runtime instead.
				navigateFallback: null,
				modifyURLPrefix: { "": "/assets/xpos/xpos/" },
				maximumFileSizeToCacheInBytes: 5 * 1024 * 1024, // 5 MB
				runtimeCaching: [
					{
						urlPattern: /^https?:\/\/[^/]+\/xpos(\/.*)?$/,
						handler: "NetworkFirst",
						options: {
							cacheName: "xpos-html-cache",
							expiration: {
								maxEntries: 5,
								maxAgeSeconds: 60 * 60 * 24 * 7, // 7 days
							},
							networkTimeoutSeconds: 3,
							cacheableResponse: {
								statuses: [0, 200],
							},
						},
					},
					{
						urlPattern: /^https?:\/\/.*\/assets\//,
						handler: "CacheFirst",
						options: {
							cacheName: "xpos-assets-cache",
							expiration: {
								maxEntries: 200,
								maxAgeSeconds: 60 * 60 * 24 * 30, // 30 days
							},
							cacheableResponse: {
								statuses: [0, 200],
							},
						},
					},
					{
						urlPattern: /^https?:\/\/[^/]+\/files\//,
						handler: "CacheFirst",
						options: {
							cacheName: "xpos-files-cache",
							expiration: {
								maxEntries: 100,
								maxAgeSeconds: 60 * 60 * 24 * 7, // 7 days
							},
							cacheableResponse: {
								statuses: [0, 200],
							},
						},
					},
				],
			},
		}),
	],
	css: {
		postcss: "./postcss.config.js",
	},
	resolve: {
		alias: {
			"@": path.resolve(import.meta.dirname, "src"),
		},
	},
	server: {
		port: 5174,
		middlewareMode: false,
		proxy: {
			"/api": {
				target: "http://localhost:8000",
				changeOrigin: true,
				rewrite: (path) => path.replace(/^\/api/, "/api"),
				configure: (proxy) => {
					proxy.on("proxyReq", (_proxyReq, req) => {
						console.log("Request:", req.method, req.url);
					});
				},
			},
			"/method": {
				target: "http://localhost:8000",
				changeOrigin: true,
				rewrite: (path) => path.replace(/^\/method/, "/method"),
			},
			"/assets": {
				target: "http://localhost:8000",
				changeOrigin: true,
			},
			"/files": {
				target: "http://localhost:8000",
				changeOrigin: true,
			},
			"/upload_file": {
				target: "http://localhost:8000",
				changeOrigin: true,
			},
			"/api/resource": {
				target: "http://localhost:8000",
				changeOrigin: true,
			},
			"/socket.io": {
				target: "http://localhost:9000",
				changeOrigin: true,
				ws: true,
				rewrite: (path) => path.replace(/^\/socket.io/, "/socket.io"),
			},
		},
	},
	optimizeDeps: {
		exclude: ["@vite/client", "@vite/env"],
	},
	build: {
		outDir: path.resolve(import.meta.dirname, "../xpos/public/xpos"),
		emptyOutDir: true,
		sourcemap: true,
		rollupOptions: {
			input: path.resolve(import.meta.dirname, "index.html"),
			output: {
				manualChunks(id) {
					if (!id.includes("node_modules")) return;

					if (
						id.includes("node_modules/vue") ||
						id.includes("node_modules/vue-router") ||
						id.includes("node_modules/pinia")
					) {
						return "vendor-vue";
					}

					const parts = id.split("node_modules/")[1]?.split("/") || [];
					const pkgName = parts[0]?.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
					if (pkgName) return `vendor-${pkgName.replace("/", "-")}`;
				},
			},
		},
	},
});
