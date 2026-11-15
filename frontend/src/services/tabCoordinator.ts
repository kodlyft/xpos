import { db } from "./idbService";
import { tabId } from "./tabId";

export { tabId };

const LEASE_MS = 90_000;
const CHANNEL = "xpos-sync";

export interface LockContext {
	renew: () => Promise<void>;
}

type LockResult<T> = { ran: true; value: T } | { ran: false };

async function takeLease(name: string): Promise<boolean> {
	const key = `lease::${name}`;
	return db.transaction("rw", db.meta, async () => {
		const row = await db.meta.get(key);
		const lease = row?.value as { owner: string; expires: number } | undefined;
		if (lease && lease.owner !== tabId && lease.expires > Date.now()) return false;
		await db.meta.put({
			key,
			value: { owner: tabId, expires: Date.now() + LEASE_MS },
			updated_at: new Date().toISOString(),
		});
		return true;
	});
}

async function dropLease(name: string): Promise<void> {
	const key = `lease::${name}`;
	await db.transaction("rw", db.meta, async () => {
		const row = await db.meta.get(key);
		if ((row?.value as { owner?: string } | undefined)?.owner === tabId) await db.meta.delete(key);
	});
}

export async function runExclusive<T>(
	name: string,
	work: (context: LockContext) => Promise<T>,
): Promise<LockResult<T>> {
	const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
	if (locks?.request) {
		return locks.request(name, { ifAvailable: true }, async (lock) => {
			if (!lock) return { ran: false } as const;
			return { ran: true, value: await work({ renew: async () => {} }) } as const;
		});
	}
	if (!(await takeLease(name))) return { ran: false };
	try {
		return { ran: true, value: await work({ renew: async () => void (await takeLease(name)) }) };
	} finally {
		await dropLease(name).catch(() => {});
	}
}

type Message = { type: string; from: string; payload?: unknown };

let channel: BroadcastChannel | null = null;
const listeners = new Map<string, Set<(payload: unknown) => void>>();

function ensureChannel(): BroadcastChannel | null {
	if (channel || typeof BroadcastChannel === "undefined") return channel;
	channel = new BroadcastChannel(CHANNEL);
	channel.onmessage = (event: MessageEvent<Message>) => {
		const message = event.data;
		if (!message || message.from === tabId) return;
		listeners.get(message.type)?.forEach((listener) => listener(message.payload));
	};
	return channel;
}

export function broadcast(type: string, payload?: unknown): void {
	ensureChannel()?.postMessage({ type, from: tabId, payload } satisfies Message);
}

export function onBroadcast(type: string, listener: (payload: unknown) => void): () => void {
	ensureChannel();
	const set = listeners.get(type) ?? new Set();
	set.add(listener);
	listeners.set(type, set);
	return () => set.delete(listener);
}
