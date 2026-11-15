import { db } from "./idbService";
import { tabId } from "./tabId";
import { broadcast, onBroadcast } from "./tabCoordinator";

/**
 * One browser window owns a set of open carts. Another window opening the same site, user and
 * shift must not restore the same carts and sell them a second time, so it is told who holds them.
 * A window can take ownership on purpose; the previous owner then finds out and stops writing.
 */
export type OwnershipState = "owner" | "other" | "lost";

const LEASE_MS = 30_000;
const TAKEOVER = "carts-takeover";

interface LockLike {
	request(
		name: string,
		options: { ifAvailable?: boolean; steal?: boolean },
		callback: (lock: unknown) => Promise<unknown>,
	): Promise<unknown>;
}

export interface OwnershipOptions {
	locks?: LockLike | null;
	windowId?: string;
}

export interface CartOwnership {
	acquire(): Promise<OwnershipState>;
	takeOver(): Promise<OwnershipState>;
	release(): Promise<void>;
	state(): OwnershipState;
	onLost(listener: () => void): () => void;
}

export function createCartOwnership(key: string, options: OwnershipOptions = {}): CartOwnership {
	const name = `xpos-carts:${key}`;
	const me = options.windowId ?? tabId;
	const locks: LockLike | null =
		options.locks !== undefined
			? options.locks
			: ((typeof navigator !== "undefined" ? navigator.locks : null) as LockLike | null);

	let current: OwnershipState = "other";
	let release: (() => void) | null = null;
	let heartbeat: ReturnType<typeof setInterval> | null = null;
	let stopListening: (() => void) | null = null;
	const lostListeners = new Set<() => void>();

	function lose(): void {
		if (current !== "owner") return;
		current = "lost";
		if (heartbeat) clearInterval(heartbeat);
		heartbeat = null;
		release?.();
		release = null;
		lostListeners.forEach((listener) => listener());
	}

	async function leaseHolder(): Promise<{ owner: string; expires: number } | undefined> {
		const row = await db.meta.get(`lease::${name}`);
		return row?.value as { owner: string; expires: number } | undefined;
	}

	async function writeLease(): Promise<void> {
		await db.meta.put({
			key: `lease::${name}`,
			value: { owner: me, expires: Date.now() + LEASE_MS },
			updated_at: new Date().toISOString(),
		});
	}

	function listenForTakeover(): void {
		stopListening?.();
		stopListening = onBroadcast(TAKEOVER, (payload) => {
			const message = payload as { name?: string; by?: string } | undefined;
			if (message?.name === name && message.by !== me) lose();
		});
	}

	async function claimWithLocks(steal: boolean): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			let settled = false;
			const finish = (value: boolean) => {
				if (settled) return;
				settled = true;
				resolve(value);
			};
			void locks!
				.request(name, steal ? { steal: true } : { ifAvailable: true }, (lock) => {
					if (!lock) {
						finish(false);
						return Promise.resolve();
					}
					finish(true);
					// Held until released, or until another window steals it.
					return new Promise<void>((done) => {
						release = done;
					});
				})
				.catch(() => {
					// A stolen lock rejects the holder's request.
					lose();
					finish(false);
				});
		});
	}

	async function claimWithLease(steal: boolean): Promise<boolean> {
		const held = await db.transaction("rw", db.meta, async () => {
			const lease = await leaseHolder();
			if (!steal && lease && lease.owner !== me && lease.expires > Date.now()) return false;
			await writeLease();
			return true;
		});
		if (!held) return false;
		if (heartbeat) clearInterval(heartbeat);
		heartbeat = setInterval(() => {
			void leaseHolder().then((lease) => {
				if (lease && lease.owner !== me && lease.expires > Date.now()) lose();
				else void writeLease();
			});
		}, LEASE_MS / 3);
		return true;
	}

	async function claim(steal: boolean): Promise<OwnershipState> {
		const got = locks?.request ? await claimWithLocks(steal) : await claimWithLease(steal);
		if (got) {
			current = "owner";
			listenForTakeover();
			if (steal) broadcast(TAKEOVER, { name, by: me });
		} else if (current !== "lost") {
			current = "other";
			listenForTakeover();
		}
		return current;
	}

	return {
		acquire: () => claim(false),
		takeOver: () => claim(true),
		async release() {
			if (heartbeat) clearInterval(heartbeat);
			heartbeat = null;
			stopListening?.();
			stopListening = null;
			release?.();
			release = null;
			if (current === "owner" && !locks?.request) {
				const lease = await leaseHolder();
				if (lease?.owner === me) await db.meta.delete(`lease::${name}`);
			}
			current = "other";
		},
		state: () => current,
		onLost(listener) {
			lostListeners.add(listener);
			return () => lostListeners.delete(listener);
		},
	};
}
