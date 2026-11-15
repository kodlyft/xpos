/**
 * Composition root. In the Android (Capacitor) app every port is backed by the native plugin, and the server session
 * uses the platform HTTP stack and cookie jar. Under `yarn dev` (Vite serve, never a production build) the same ports
 * are backed by browser adapters and a same-origin proxy to a real development ERPNext site.
 */
import { Capacitor } from "@capacitor/core";
import type {
	AuthService,
	CatalogRepository,
	Printer,
	Scanner,
	SyncEngine,
	TransactionStore,
} from "@mobile/ports";
import { FrappeHttpTransport } from "@mobile/adapters/frappeHttp";
import { FrappeOnlineLogin } from "@mobile/adapters/onlineLogin";
import { WebStore } from "@mobile/adapters/web/webStore";
import { WebAuth } from "@mobile/adapters/web/webAuth";
import {
	NativeAuth,
	NativeCatalog,
	NativeTransactions,
	NoSync,
	UnsupportedPrinter,
	UnsupportedScanner,
} from "@mobile/adapters/native/nativeAdapters";

export class NotAndroidError extends Error {
	constructor() {
		super("XPOS Mobile runs inside the Android app.");
		this.name = "NotAndroidError";
	}
}

export interface Container {
	kind: "native" | "web-dev";
	catalog: CatalogRepository;
	transactions: TransactionStore;
	auth: AuthService;
	sync: SyncEngine;
	scanner: Scanner;
	printer: Printer;
	/** HTTP session for the configured server. The CSRF token is fetched once per app run, after sign-in or unlock. */
	session(origin: string): Promise<FrappeHttpTransport>;
}

export const WEB_DEV = import.meta.env.DEV;

export function createContainer(): Container {
	if (Capacitor.isNativePlatform()) return createNativeContainer();
	if (WEB_DEV) return createWebContainer();
	throw new NotAndroidError();
}

function createWebContainer(): Container {
	const transports = new Map<string, FrappeHttpTransport>();
	const transport = (origin: string) => {
		let t = transports.get(origin);
		if (!t)
			transports.set(origin, (t = new FrappeHttpTransport(origin, (u, i) => fetch(u, i), "web-dev")));
		return t;
	};
	const store = new WebStore();
	return {
		kind: "web-dev",
		catalog: store,
		transactions: store,
		auth: new WebAuth(new FrappeOnlineLogin((origin) => transport(origin))),
		sync: new NoSync("web-dev"),
		scanner: new UnsupportedScanner(),
		printer: new UnsupportedPrinter(),
		session: async (origin) => {
			const t = transport(origin);
			await t.refreshCsrf();
			return t;
		},
	};
}

function createNativeContainer(): Container {
	const transports = new Map<string, FrappeHttpTransport>();
	const transport = (origin: string) => {
		let t = transports.get(origin);
		if (!t)
			transports.set(origin, (t = new FrappeHttpTransport(origin, (u, i) => fetch(u, i), "native")));
		return t;
	};
	return {
		kind: "native",
		catalog: new NativeCatalog(),
		transactions: new NativeTransactions(),
		auth: new NativeAuth(new FrappeOnlineLogin((origin) => transport(origin))),
		sync: new NoSync("native"),
		scanner: new UnsupportedScanner(),
		printer: new UnsupportedPrinter(),
		session: async (origin) => {
			const t = transport(origin);
			await t.refreshCsrf(); // throws SessionExpiredError when the cookie session is gone
			return t;
		},
	};
}
