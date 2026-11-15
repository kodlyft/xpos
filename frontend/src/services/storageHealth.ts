export type StorageFailure = "quota" | "unavailable" | "data" | "unknown";

export class StorageWriteError extends Error {
	reason: StorageFailure;
	constructor(reason: StorageFailure, cause?: unknown) {
		super(`Local storage write failed (${reason})`);
		this.name = "StorageWriteError";
		this.reason = reason;
		if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
	}
}

export function classifyStorageError(error: unknown): StorageFailure {
	if (error instanceof StorageWriteError) return error.reason;
	const name = (error as { name?: string })?.name ?? "";
	const inner = (error as { inner?: unknown })?.inner;
	if (name === "QuotaExceededError" || /quota/i.test(String((error as Error)?.message ?? "")))
		return "quota";
	if (inner && classifyStorageError(inner) === "quota") return "quota";
	if (name === "DataCloneError" || name === "DataError") return "data";
	if (
		[
			"DatabaseClosedError",
			"OpenFailedError",
			"VersionError",
			"UnknownError",
			"InvalidStateError",
			"SecurityError",
			"AbortError",
			"BlockedError",
		].includes(name)
	)
		return "unavailable";
	return "unknown";
}

export interface StorageHealth {
	persisted: boolean | null;
	usage: number | null;
	quota: number | null;
	level: "ok" | "low" | "full" | "unknown";
}

export const STORAGE_WARN_RATIO = 0.75;
export const STORAGE_BLOCK_RATIO = 0.9;
export const STORAGE_MIN_FREE_BYTES = 20 * 1024 * 1024;

export function levelFor(usage: number, quota: number): StorageHealth["level"] {
	if (!quota) return "unknown";
	if (quota - usage < STORAGE_MIN_FREE_BYTES || usage / quota >= STORAGE_BLOCK_RATIO) return "full";
	if (usage / quota >= STORAGE_WARN_RATIO) return "low";
	return "ok";
}

export async function getStorageHealth(): Promise<StorageHealth> {
	const storage = typeof navigator !== "undefined" ? navigator.storage : undefined;
	const health: StorageHealth = { persisted: null, usage: null, quota: null, level: "unknown" };
	try {
		if (storage?.persisted) health.persisted = await storage.persisted();
		if (storage?.estimate) {
			const estimate = await storage.estimate();
			health.usage = estimate.usage ?? null;
			health.quota = estimate.quota ?? null;
			if (health.usage !== null && health.quota) health.level = levelFor(health.usage, health.quota);
		}
	} catch {
		/* a browser that cannot say is treated as unknown, not as full */
	}
	return health;
}

export async function requestPersistence(): Promise<boolean | null> {
	try {
		const storage = navigator.storage;
		if (!storage?.persist) return null;
		if (storage.persisted && (await storage.persisted())) return true;
		return await storage.persist();
	} catch {
		return null;
	}
}
