import { describe, expect, it } from "vitest";
import { FrappeHttpTransport, OfflineError, SessionExpiredError } from "../src/adapters/frappeHttp";
import { FrappeOnlineLogin, LoginError } from "../src/adapters/onlineLogin";

const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ORIGIN = "https://shop.example.com";

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;
function fakeFetch(
	handlers: Record<string, Handler>,
	calls: { url: string; init: RequestInit }[] = [],
): typeof fetch {
	return (async (input: string, init: RequestInit = {}) => {
		const url = new URL(input);
		calls.push({ url: url.toString(), init });
		const h = handlers[url.pathname.replace("/api/method/", "")];
		if (!h) return json(404, {});
		return h(url, init);
	}) as unknown as typeof fetch;
}

const bootstrapOk = {
	message: {
		user: "c@x.com",
		site: "shop",
		pos_profile: "Main",
		company: "Acme",
		warehouse: "S",
		currency: "KWD",
		minor_digits: 3,
		permissions: { sell: true },
		erpnext_version: "16.4.0",
		supported: true,
		lease_ttl_seconds: 999999,
		issued_at: 1000,
	},
};

describe("Frappe login flow", () => {
	const mk = (handlers: Record<string, Handler>, calls: { url: string; init: RequestInit }[] = []) =>
		new FrappeOnlineLogin((o) => new FrappeHttpTransport(o, fakeFetch(handlers, calls)));

	it("logs in, fetches CSRF, bootstraps, caps the lease at 24h, never sends the origin from location", async () => {
		const calls: { url: string; init: RequestInit }[] = [];
		const login = mk(
			{
				login: () => json(200, { message: "Logged In", full_name: "C" }),
				"xpos.api.auth.get_csrf_token": () => json(200, { message: "tok123" }),
				"xpos.api.mobile.bootstrap": (_u, init) => {
					expect(init.method ?? "GET").toBe("GET");
					return json(200, bootstrapOk);
				},
			},
			calls,
		);
		const info = await login.login(ORIGIN, "c@x.com", "pw");
		expect(info).toMatchObject({
			user: "c@x.com",
			site: ORIGIN,
			profile: "Main",
			minorDigits: 3,
			currency: "KWD",
		});
		expect(info.leaseTtlSeconds).toBe(24 * 3600);
		expect(calls.every((c) => c.url.startsWith(ORIGIN))).toBe(true);
		expect(calls.every((c) => c.init.credentials === "include")).toBe(true);
	});

	it("rejects unsupported schemes before any network call", async () => {
		const calls: { url: string; init: RequestInit }[] = [];
		await expect(mk({}, calls).login("ftp://shop.example.com", "u", "p")).rejects.toMatchObject({
			code: "bad_origin",
		});
		expect(calls).toHaveLength(0);
	});

	it("logs in over plain http when the server is http (cleartext is allowed, and flagged by the UI)", async () => {
		const calls: { url: string; init: RequestInit }[] = [];
		const info = await mk(
			{
				login: () => json(200, { message: "Logged In" }),
				"xpos.api.auth.get_csrf_token": () => json(200, { message: "t" }),
				"xpos.api.mobile.bootstrap": () => json(200, bootstrapOk),
			},
			calls,
		).login("http://192.168.1.20:8000", "u", "p");
		expect(info.site).toBe("http://192.168.1.20:8000");
		expect(calls.every((c) => c.url.startsWith("http://192.168.1.20:8000/"))).toBe(true);
	});

	it.each([
		[json(200, { verification: { method: "OTP" }, tmp_id: "t" }), "mfa_unsupported"],
		[
			json(200, { redirect_to: "/api/method/frappe.integrations.oauth2_logins.login_via_google" }),
			"sso_unsupported",
		],
		[json(401, { message: "Incorrect password" }), "invalid_credentials"],
	])("handles unsupported/failed login: %#", async (resp, code) => {
		const calls: { url: string; init: RequestInit }[] = [];
		await expect(mk({ login: () => resp }, calls).login(ORIGIN, "u", "p")).rejects.toMatchObject({
			code,
		});
		expect(calls.some((c) => c.url.includes("bootstrap"))).toBe(false); // never proceeds past a failed login
	});

	it("refuses non-16 servers and servers without the bootstrap endpoint", async () => {
		const base = {
			login: () => json(200, { message: "Logged In" }),
			"xpos.api.auth.get_csrf_token": () => json(200, { message: "t" }),
		};
		await expect(
			mk({
				...base,
				"xpos.api.mobile.bootstrap": () =>
					json(200, {
						message: { ...bootstrapOk.message, erpnext_version: "15.9.0", supported: false },
					}),
			}).login(ORIGIN, "u", "p"),
		).rejects.toMatchObject({ code: "unsupported_server" });
		await expect(mk({ ...base }).login(ORIGIN, "u", "p")).rejects.toMatchObject({
			code: "unsupported_server",
		}); // 404
	});

	it("never puts the password in a URL", async () => {
		const calls: { url: string; init: RequestInit }[] = [];
		await mk(
			{
				login: () => json(200, { message: "Logged In" }),
				"xpos.api.auth.get_csrf_token": () => json(200, { message: "t" }),
				"xpos.api.mobile.bootstrap": () => json(200, bootstrapOk),
			},
			calls,
		).login(ORIGIN, "u", "s3cret");
		expect(calls.some((c) => c.url.includes("s3cret"))).toBe(false);
	});
});

describe("transport", () => {
	it("retries once with a fresh CSRF token on a CSRF failure", async () => {
		let n = 0;
		const t = new FrappeHttpTransport(
			ORIGIN,
			fakeFetch({
				"xpos.api.auth.get_csrf_token": () => json(200, { message: "fresh" }),
				"some.method": (_u, init) => {
					n++;
					const h = init.headers as Record<string, string>;
					return h["X-Frappe-CSRF-Token"] === "fresh"
						? json(200, { message: "ok" })
						: json(400, { exc_type: "CSRFTokenError" });
				},
			}),
		);
		expect(await t.call("some.method", {})).toBe("ok");
		expect(n).toBe(2);
	});
	it("maps network failure and expired sessions to typed errors", async () => {
		const down = new FrappeHttpTransport(ORIGIN, (async () => {
			throw new TypeError("net");
		}) as unknown as typeof fetch);
		await expect(down.call("x")).rejects.toBeInstanceOf(OfflineError);
		const exp = new FrappeHttpTransport(ORIGIN, fakeFetch({ x: () => json(401, {}) }));
		await expect(exp.call("x")).rejects.toBeInstanceOf(SessionExpiredError);
	});
});
