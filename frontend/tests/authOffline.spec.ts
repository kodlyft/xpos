/**
 * @vitest-environment jsdom
 *
 * A till reloaded with no connection must not be stranded on the sign-in screen:
 * the session that last reached the server is remembered and reused while the
 * server is out of reach. A server that answers is still believed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const { call, loadPermissions } = vi.hoisted(() => ({
	call: vi.fn(),
	loadPermissions: vi.fn(async () => {}),
}));

vi.mock("@/services/api", () => ({ call, showError: vi.fn() }));
vi.mock("@/services/userRights", () => ({
	loadPermissions,
	resetPermissions: vi.fn(),
}));

import { useAuthStore } from "@/stores/authStore";

const CACHED = { user: "cashier@shop.test", user_email: "cashier@shop.test", user_fullname: "Cashier" };

beforeEach(() => {
	setActivePinia(createPinia());
	call.mockReset();
	localStorage.clear();
});

describe("checkAuth without a connection", () => {
	it("restores the remembered session instead of the sign-in screen", async () => {
		localStorage.setItem("xpos:last-user", JSON.stringify(CACHED));
		call.mockRejectedValue(new Error("Failed to fetch"));

		const auth = useAuthStore();
		await expect(auth.checkAuth()).resolves.toBe(true);
		expect(auth.isAuthenticated).toBe(true);
		expect(auth.userName).toBe(CACHED.user);
		expect(loadPermissions).toHaveBeenCalledWith(CACHED.user);
	});

	it("stays signed out when nothing was ever remembered", async () => {
		call.mockRejectedValue(new Error("Failed to fetch"));

		const auth = useAuthStore();
		await expect(auth.checkAuth()).resolves.toBe(false);
		expect(auth.isAuthenticated).toBe(false);
	});
});

describe("checkAuth with a server that answers", () => {
	it("believes a server that says the user is gone", async () => {
		localStorage.setItem("xpos:last-user", JSON.stringify(CACHED));
		call.mockResolvedValue("Guest");

		const auth = useAuthStore();
		await expect(auth.checkAuth()).resolves.toBe(false);
		expect(auth.isAuthenticated).toBe(false);
		expect(localStorage.getItem("xpos:last-user")).toBeNull();
	});

	it("does not fall back to the cache on a server-side error", async () => {
		localStorage.setItem("xpos:last-user", JSON.stringify(CACHED));
		call.mockRejectedValue(new Error("Not permitted"));

		const auth = useAuthStore();
		await expect(auth.checkAuth()).resolves.toBe(false);
		expect(auth.isAuthenticated).toBe(false);
	});

	it("remembers the session it just confirmed", async () => {
		(window as unknown as Record<string, unknown>).xpos = {
			boot: { user_info: { [CACHED.user]: { email: CACHED.user_email, fullname: CACHED.user_fullname } } },
		};
		call.mockResolvedValue(CACHED.user);

		const auth = useAuthStore();
		await auth.checkAuth();

		expect(JSON.parse(String(localStorage.getItem("xpos:last-user"))).user).toBe(CACHED.user);
		delete (window as unknown as Record<string, unknown>).xpos;
	});
});
