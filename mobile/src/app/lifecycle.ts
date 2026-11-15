import { Capacitor } from "@capacitor/core";
import type { Lifecycle } from "@mobile/ports";

/** Browser visibility/online events, plus the Capacitor App plugin on Android. */
export function createLifecycle(): Lifecycle {
	const bg = new Set<() => void>();
	const fg = new Set<() => void>();
	const net = new Set<(o: boolean) => void>();
	const emit = (hidden: boolean) => (hidden ? bg : fg).forEach((f) => f());
	if (typeof document !== "undefined") {
		document.addEventListener("visibilitychange", () => emit(document.visibilityState === "hidden"));
		window.addEventListener("online", () => net.forEach((f) => f(true)));
		window.addEventListener("offline", () => net.forEach((f) => f(false)));
	}
	if (Capacitor.isNativePlatform()) {
		import("@capacitor/app").then(({ App }) =>
			App.addListener("appStateChange", (s) => emit(!s.isActive)),
		);
	}
	return {
		onBackground: (cb) => (bg.add(cb), () => bg.delete(cb)),
		onForeground: (cb) => (fg.add(cb), () => fg.delete(cb)),
		onConnectivity: (cb) => (net.add(cb), () => net.delete(cb)),
		isOnline: () => (typeof navigator === "undefined" ? true : navigator.onLine),
	};
}
