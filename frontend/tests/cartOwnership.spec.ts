/**
 * @vitest-environment jsdom
 *
 * One window owns a set of open carts. A second window is told, and can take over on purpose;
 * the first then finds out and stops.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCartOwnership } from "@/services/cartOwnership";
import { db } from "@/services/idbService";

/** The part of navigator.locks the ownership code uses. */
function fakeLocks() {
	const holders = new Map<string, { abort: () => void }>();
	return {
		holders,
		request(
			name: string,
			options: { ifAvailable?: boolean; steal?: boolean },
			callback: (lock: unknown) => Promise<unknown>,
		): Promise<unknown> {
			const held = holders.get(name);
			if (held && options.steal) {
				held.abort();
				holders.delete(name);
			} else if (held) {
				return callback(null);
			}
			return new Promise((resolve, reject) => {
				holders.set(name, { abort: () => reject(new DOMException("stolen", "AbortError")) });
				callback({ name }).then((value) => {
					holders.delete(name);
					resolve(value);
				}, reject);
			});
		},
	};
}

describe("with Web Locks", () => {
	it("gives the carts to the first window and tells the second", async () => {
		const locks = fakeLocks();
		const first = createCartOwnership("site|amy", { locks, windowId: "w1" });
		const second = createCartOwnership("site|amy", { locks, windowId: "w2" });
		expect(await first.acquire()).toBe("owner");
		expect(await second.acquire()).toBe("other");
		expect(first.state()).toBe("owner");
		expect(second.state()).toBe("other");
	});

	it("lets another user's carts be owned independently", async () => {
		const locks = fakeLocks();
		const amy = createCartOwnership("site|amy", { locks, windowId: "w1" });
		const bob = createCartOwnership("site|bob", { locks, windowId: "w2" });
		expect(await amy.acquire()).toBe("owner");
		expect(await bob.acquire()).toBe("owner");
	});

	it("moves to the window that takes over, and the old owner learns it", async () => {
		const locks = fakeLocks();
		const first = createCartOwnership("site|amy", { locks, windowId: "w1" });
		const second = createCartOwnership("site|amy", { locks, windowId: "w2" });
		let lost = 0;
		first.onLost(() => (lost += 1));
		await first.acquire();
		await second.acquire();
		expect(await second.takeOver()).toBe("owner");
		await Promise.resolve();
		expect(first.state()).toBe("lost");
		expect(lost).toBe(1);
	});

	it("frees the carts when the owner lets go", async () => {
		const locks = fakeLocks();
		const first = createCartOwnership("site|amy", { locks, windowId: "w1" });
		await first.acquire();
		await first.release();
		await Promise.resolve();
		const second = createCartOwnership("site|amy", { locks, windowId: "w2" });
		expect(await second.acquire()).toBe("owner");
	});
});

describe("without Web Locks (lease in storage)", () => {
	beforeEach(async () => {
		await db.meta.clear();
	});
	afterEach(async () => {
		await db.meta.clear();
	});

	it("refuses a second window while the lease is live", async () => {
		const first = createCartOwnership("site|amy", { locks: null, windowId: "w1" });
		const second = createCartOwnership("site|amy", { locks: null, windowId: "w2" });
		expect(await first.acquire()).toBe("owner");
		expect(await second.acquire()).toBe("other");
		await first.release();
		expect(await second.acquire()).toBe("owner");
		await second.release();
	});

	it("takes over on request and the previous owner notices", async () => {
		const first = createCartOwnership("site|amy", { locks: null, windowId: "w1" });
		const second = createCartOwnership("site|amy", { locks: null, windowId: "w2" });
		await first.acquire();
		expect(await second.takeOver()).toBe("owner");
		const lease = await db.meta.get("lease::xpos-carts:site|amy");
		expect((lease?.value as { owner: string }).owner).toBe("w2");
		await first.release();
		await second.release();
	});
});
