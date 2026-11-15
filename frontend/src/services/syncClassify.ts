import { isNetworkError } from "@/utils";

export type FailureKind = "transient" | "rejected";

export interface ClassifiedFailure {
	kind: FailureKind;
	code: string;
	message: string;
}

export const BACKOFF_BASE_MS = 15_000;
export const BACKOFF_MAX_MS = 15 * 60_000;
export const STALLED_AFTER_ATTEMPTS = 8;

const TRANSIENT_EXCEPTIONS = new Set([
	"CSRFTokenError",
	"SessionExpired",
	"QueryDeadlockError",
	"QueryTimeoutError",
	"RateLimitExceededError",
	"TooManyRequestsError",
	"ServiceUnavailableError",
	"InternalServerError",
	"ConnectionError",
	"TimeoutError",
	"RequestTimeoutError",
	"DocumentLockedError",
]);

interface FailureLike {
	message?: string;
	excType?: string;
	status?: number;
}

/** Decide whether a failed send may succeed later (retry with backoff, never dead-letter) or is the server refusing the sale (hold it for a person to review). */
export function classifySyncError(error: unknown): ClassifiedFailure {
	const failure = (error ?? {}) as FailureLike;
	const message = error instanceof Error ? error.message : String(error ?? "");
	const status = Number(failure.status) || 0;
	const excType = failure.excType || "";

	if (isNetworkError(error)) return { kind: "transient", code: "network", message };
	if (status >= 500 || status === 408 || status === 429) {
		return { kind: "transient", code: `http_${status}`, message };
	}
	if (excType && !TRANSIENT_EXCEPTIONS.has(excType)) return { kind: "rejected", code: excType, message };
	return { kind: "transient", code: excType || "unknown", message };
}

export function backoffDelayMs(attempts: number, random: () => number = Math.random): number {
	const exponent = Math.max(attempts - 1, 0);
	const base = Math.min(BACKOFF_BASE_MS * 2 ** exponent, BACKOFF_MAX_MS);
	return Math.round(base * (1 + random() * 0.2));
}

export function nextAttemptAt(attempts: number, now: number = Date.now(), random = Math.random): string {
	return new Date(now + backoffDelayMs(attempts, random)).toISOString();
}
