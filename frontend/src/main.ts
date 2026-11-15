import "./style.css";
import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import { router } from "./router";
import { showError } from "@/services/api";
import { captureError } from "@/services/errorLog";
import { initializeNamespaces } from "./utils";
import { dayjs } from "@/utils/datetime";
import translate from "./lib/translate";
import "./services/idbService";
import { noteWaitingWorker, reloadNeeded } from "./services/appUpdate";

if (typeof caches !== "undefined") void caches.delete("xpos-api-cache");
window.addEventListener("vite:preloadError", () => {
	reloadNeeded.value = true;
});

if (import.meta.env.PROD) {
	if ("serviceWorker" in navigator) {
		navigator.serviceWorker
			.register("/xpos/sw.js", { scope: "/xpos/" })
			.then((registration) => {
				console.log("[XPOS PWA] Service worker registered for", registration.scope);

				// A waiting worker is offered through the status banner, which knows when
				// a sale or a sync is in flight; it is never swapped mid-tender.
				if (registration.waiting && navigator.serviceWorker.controller) {
					noteWaitingWorker(registration.waiting);
				}

				registration.addEventListener("updatefound", () => {
					const installing = registration.installing;
					if (!installing) return;
					installing.addEventListener("statechange", () => {
						if (installing.state === "installed" && navigator.serviceWorker.controller) {
							noteWaitingWorker(installing);
						}
					});
				});

				setInterval(
					() => {
						registration.update();
					},
					60 * 60 * 1000,
				);
			})
			.catch((error) => {
				console.error("[XPOS PWA] Service worker registration failed:", error);
			});
	}
}

async function initializeBrowserStorage(): Promise<void> {
	// The persistent-storage grant and its warning are the offline store's job; this
	// only makes sure the database is open before the first screen asks for items.
	try {
		const { ensureDatabaseReady } = await import("@/services/idbService");
		await ensureDatabaseReady();
	} catch (error) {
		console.warn("[XPOS] Browser storage initialization failed", error);
	}
}

async function initializeCurrencyMeta(): Promise<void> {
	try {
		const { primeCurrencyCache } = await import("@/composables/useCurrency");
		await primeCurrencyCache();
	} catch (error) {
		console.warn("[XPOS] Currency metadata initialization failed", error);
	}
}

async function initializeNumberFormat(): Promise<void> {
	try {
		const { numberFormatSettings, setNumberFormatSettings } = await import("@/utils/numberFormat");
		if ((window.xpos?.boot as any)?.xpos_number_format) {
			numberFormatSettings();
			return;
		}

		const { getCachedERPSettings } = await import("@/services/dbBridge");
		const cached = (await getCachedERPSettings()) as { number_format?: unknown } | null;
		if (cached?.number_format) {
			setNumberFormatSettings(cached.number_format as Parameters<typeof setNumberFormatSettings>[0]);
		}
	} catch (error) {
		console.warn("[XPOS] Number format initialization failed", error);
	}
}

(async () => {
	const app = createApp(App);
	const pinia = createPinia();
	window.__ = translate;
	app.use(pinia);
	app.use(router);
	initializeNamespaces();
	await initializeBrowserStorage();
	await initializeCurrencyMeta();
	await initializeNumberFormat();
	app.config.globalProperties.$dayjs = dayjs;
	app.config.errorHandler = (err: unknown, _instance: unknown, info: string) => {
		console.error("X POS Error:", err, info);
		const message = err instanceof Error ? err.message : String(err);
		captureError({
			source: "renderer",
			title: `Vue error: ${message}`,
			message,
			traceback: err instanceof Error ? err.stack : undefined,
			meta: { info },
		});
		showError(`Error: ${message}`);
	};

	window.addEventListener("error", (event) => {
		const err = event.error;
		captureError({
			source: "renderer",
			title: `Uncaught: ${event.message}`,
			message: err instanceof Error ? err.message : event.message,
			traceback: err instanceof Error ? err.stack : undefined,
			meta: { filename: event.filename, lineno: event.lineno, colno: event.colno },
		});
	});
	window.addEventListener("unhandledrejection", (event) => {
		const reason = event.reason;
		const message = reason instanceof Error ? reason.message : String(reason);
		captureError({
			source: "promise",
			title: `Unhandled rejection: ${message}`,
			message,
			traceback: reason instanceof Error ? reason.stack : undefined,
		});
	});

	app.mount("#app");
})();
