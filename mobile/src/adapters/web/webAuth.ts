import type { AuthService, BootstrapInfo, Enrolled, UnlockResult } from "@mobile/ports";
import type { OnlineLogin } from "../onlineLogin";

const KEY = "xpos-web-dev-vault";
const MAX_TRIES = 5;
const LOCK_MS = 30_000;

interface Vault extends Enrolled {
	salt: string;
	hash: string;
	issuedAt: number;
	leaseTtlSeconds: number;
}

const hex = (b: ArrayBuffer) =>
	Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");

async function derive(pin: string, salt: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, [
		"deriveBits",
	]);
	const bits = await crypto.subtle.deriveBits(
		{ name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(salt), iterations: 100_000 },
		key,
		256,
	);
	return hex(bits);
}

function read(): Vault | null {
	try {
		return JSON.parse(localStorage.getItem(KEY) ?? "null");
	} catch {
		return null;
	}
}

export class WebAuth implements AuthService {
	readonly kind = "web-dev" as const;
	private failures = 0;
	private lockedUntil = 0;
	constructor(private readonly online: OnlineLogin) {}

	loginOnline = (origin: string, user: string, password: string) =>
		this.online.login(origin, user, password);

	async enroll(info: BootstrapInfo, pin: string): Promise<void> {
		const salt = hex(crypto.getRandomValues(new Uint8Array(16)).buffer);
		const v: Vault = {
			user: info.user,
			site: info.site,
			profile: info.profile,
			currency: info.currency,
			minorDigits: info.minorDigits,
			salt,
			hash: await derive(pin, salt),
			issuedAt: info.issuedAt,
			leaseTtlSeconds: info.leaseTtlSeconds,
		};
		localStorage.setItem(KEY, JSON.stringify(v));
	}
	async enrolled(): Promise<Enrolled | null> {
		const v = read();
		return v
			? {
					user: v.user,
					site: v.site,
					profile: v.profile,
					currency: v.currency,
					minorDigits: v.minorDigits,
				}
			: null;
	}
	async unlock(pin: string): Promise<UnlockResult> {
		const v = read();
		if (!v) return { ok: false, reason: "not_enrolled" };
		const now = Date.now();
		if (now < this.lockedUntil) return { ok: false, reason: "locked", retryInMs: this.lockedUntil - now };
		if (now > v.issuedAt + v.leaseTtlSeconds * 1000) return { ok: false, reason: "lease_expired" };
		if ((await derive(pin, v.salt)) === v.hash) {
			this.failures = 0;
			return { ok: true };
		}
		if (++this.failures >= MAX_TRIES) {
			this.failures = 0;
			this.lockedUntil = now + LOCK_MS;
			return { ok: false, reason: "locked", retryInMs: LOCK_MS };
		}
		return { ok: false, reason: "wrong_pin" };
	}
	async lock(): Promise<void> {}
	async leaseStatus() {
		const v = read();
		if (!v) return null;
		const remainingMs = v.issuedAt + v.leaseTtlSeconds * 1000 - Date.now();
		return {
			status: remainingMs > 0 ? ("valid" as const) : ("expired" as const),
			remainingMs: Math.max(0, remainingMs),
		};
	}
	async signOut(): Promise<void> {
		localStorage.removeItem(KEY);
	}
}
