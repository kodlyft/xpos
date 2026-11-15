import { clearCatalogCache } from "@/services/idbService";
import { setSessionScope } from "@/services/sessionScope";

export async function clearSessionData(): Promise<void> {
	setSessionScope(null);
	await clearCatalogCache().catch((error) =>
		console.warn("[XPOS] Could not clear the catalogue cache", error),
	);
	if (typeof caches === "undefined") return;
	const names = await caches.keys().catch(() => [] as string[]);
	await Promise.all(
		names
			.filter((name) => name.startsWith("xpos-") && name !== "xpos-assets-cache")
			.map((name) => caches.delete(name)),
	);
}
