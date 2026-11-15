import type { CapacitorConfig } from "@capacitor/cli";
const liveReload = process.env.XPOS_ANDROID_DEV === "1" ? process.env.CAP_LIVE_RELOAD_URL : undefined;

const config: CapacitorConfig = {
	appId: "com.kodlyft.xpos.mobile.dev",
	appName: "XPOS Mobile",
	webDir: "dist",
	android: { allowMixedContent: false, backgroundColor: "#e8ecf2" },
	server: liveReload
		? { url: liveReload, cleartext: liveReload.startsWith("http://") }
		: { androidScheme: "https" },
	plugins: { CapacitorHttp: { enabled: true }, CapacitorCookies: { enabled: true } },
};

export default config;
