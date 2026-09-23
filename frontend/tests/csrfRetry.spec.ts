/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/composables/useToast", () => ({
	showSuccess: vi.fn(),
	showError: vi.fn(),
	showInfo: vi.fn(),
}));
vi.mock("@/utils", () => ({
	isOnline: () => true,
	isNetworkError: () => false,
}));
vi.mock("@/services/electronBridge", () => ({
	isElectron: () => false,
	getApiBaseUrlSync: () => "",
	getApiCredentialsSync: () => ({}),
}));
vi.mock("@/services/errorLog", () => ({ captureError: vi.fn() }));
vi.mock("@/services/idbService", () => ({ getMeta: vi.fn() }));
vi.mock("@/composables/useCurrency", () => ({ formatWithSymbol: vi.fn() }));

import { call, refreshCsrfToken } from "@/services/api";

const CSRF_ERROR = {
	exc_type: "CSRFTokenError",
	_server_messages: JSON.stringify([JSON.stringify({ message: "Invalid Request" })]),
};

function jsonResponse(status: number, body: unknown) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

/** The CSRF token each POST carried, in order. */
function sentTokens(fetchMock: ReturnType<typeof vi.fn>): string[] {
	return fetchMock.mock.calls
		.filter(([, init]) => init?.method === "POST")
		.map(([, init]) => (init.headers as Record<string, string>)["X-Frappe-CSRF-Token"]);
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
	(window as any).xpos = { csrf_token: "stale-token" };
	fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("CSRF token recovery", () => {
	it("fetches the session's token and retries once when the page's token is stale", async () => {
		fetchMock
			.mockResolvedValueOnce(jsonResponse(400, CSRF_ERROR))
			.mockResolvedValueOnce(jsonResponse(200, { message: "fresh-token" }))
			.mockResolvedValueOnce(jsonResponse(200, { message: { name: "ACC-SINV-0001" } }));

		const result = await call("xpos.api.invoices.create_invoice", { data: "{}" });

		expect(result).toEqual({ name: "ACC-SINV-0001" });
		expect(sentTokens(fetchMock)).toEqual(["stale-token", "fresh-token"]);
		const [url, init] = fetchMock.mock.calls[1];
		expect(url).toBe("/api/method/xpos.api.auth.get_csrf_token");
		expect(init.method).toBe("GET");
		expect(init.cache).toBe("no-store");
		expect(window.xpos!.csrf_token).toBe("fresh-token");
	});

	it("keeps using the fresh token for later calls", async () => {
		fetchMock
			.mockResolvedValueOnce(jsonResponse(400, CSRF_ERROR))
			.mockResolvedValueOnce(jsonResponse(200, { message: "fresh-token" }))
			.mockResolvedValueOnce(jsonResponse(200, { message: 1 }))
			.mockResolvedValueOnce(jsonResponse(200, { message: 2 }));

		await call("xpos.api.invoices.create_invoice");
		await call("xpos.api.invoices.create_invoice");

		expect(sentTokens(fetchMock)).toEqual(["stale-token", "fresh-token", "fresh-token"]);
	});

	it("retries only once, so a persistent CSRF failure surfaces instead of looping", async () => {
		fetchMock
			.mockResolvedValueOnce(jsonResponse(400, CSRF_ERROR))
			.mockResolvedValueOnce(jsonResponse(200, { message: "fresh-token" }))
			.mockResolvedValueOnce(jsonResponse(400, CSRF_ERROR));

		await expect(call("xpos.api.invoices.create_invoice")).rejects.toMatchObject({
			excType: "CSRFTokenError",
		});
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("does not retry when a fresh token cannot be fetched (e.g. logged out)", async () => {
		fetchMock
			.mockResolvedValueOnce(jsonResponse(400, CSRF_ERROR))
			.mockResolvedValueOnce(jsonResponse(401, { exc_type: "AuthenticationError" }));

		await expect(call("xpos.api.invoices.create_invoice")).rejects.toMatchObject({
			excType: "CSRFTokenError",
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(window.xpos!.csrf_token).toBe("stale-token");
	});

	it("does not retry other 400 errors", async () => {
		fetchMock.mockResolvedValueOnce(
			jsonResponse(400, { exc_type: "ValidationError", _server_messages: "[]" }),
		);

		await expect(call("xpos.api.invoices.create_invoice")).rejects.toThrow();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("does not refresh the token when the call succeeds", async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse(200, { message: "ok" }));

		await expect(call("frappe.ping")).resolves.toBe("ok");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe("refreshCsrfToken", () => {
	it("returns null rather than throwing when offline", async () => {
		fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));

		await expect(refreshCsrfToken()).resolves.toBeNull();
		expect(window.xpos!.csrf_token).toBe("stale-token");
	});

	it("ignores an empty token", async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse(200, { message: "" }));

		await expect(refreshCsrfToken()).resolves.toBeNull();
		expect(window.xpos!.csrf_token).toBe("stale-token");
	});
});
