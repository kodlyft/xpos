/** Explicit server origin validation. Tenant identity never comes from the WebView hostname. */

export type OriginCheck = { ok: true; origin: string; secure: boolean } | { ok: false; reason: string };

/** Accepts https:// (encrypted) and http:// (NOT encrypted: callers must warn). Never trusts the WebView host. */
export function validateServerOrigin(input: string, opts: { allowCleartext?: boolean } = {}): OriginCheck {
	let url: URL;
	try {
		url = new URL(input.trim());
	} catch {
		return { ok: false, reason: "Enter a full address such as https://shop.example.com" };
	}
	if (url.protocol !== "https:" && url.protocol !== "http:")
		return { ok: false, reason: "The server address must start with https:// or http://" };
	if (url.protocol === "http:" && opts.allowCleartext === false)
		return {
			ok: false,
			reason: "This build only connects over https:// (encrypted). Use your server's https address.",
		};
	if (url.username || url.password)
		return { ok: false, reason: "The address must not contain a username or password" };
	if (url.pathname !== "/" || url.search || url.hash)
		return { ok: false, reason: "Use only the site address, without a path or query" };
	return { ok: true, origin: url.origin, secure: url.protocol === "https:" };
}

/** True for http:// origins: traffic (password, sales data) is readable on the network. */
export function isCleartext(origin: string | null | undefined): boolean {
	return !!origin && origin.trim().toLowerCase().startsWith("http://");
}

export type LoginOutcome =
	| { kind: "ok"; user: string }
	| { kind: "invalid_credentials" }
	| { kind: "mfa_unsupported" }
	| { kind: "sso_unsupported" }
	| { kind: "unexpected"; detail: string };

/** Classify a Frappe /api/method/login response body without trusting unknown shapes. */
export function classifyLoginResponse(status: number, body: unknown): LoginOutcome {
	const b = (body ?? {}) as Record<string, unknown>;
	if (b.verification || b.tmp_id) return { kind: "mfa_unsupported" };
	if (typeof b.redirect_to === "string" && /oauth|saml|login\?/.test(b.redirect_to))
		return { kind: "sso_unsupported" };
	if (status === 401 || status === 403) return { kind: "invalid_credentials" };
	if (status === 200 && (b.message === "Logged In" || b.message === "No App")) {
		return { kind: "ok", user: typeof b.full_name === "string" ? b.full_name : "" };
	}
	return { kind: "unexpected", detail: `HTTP ${status}` };
}

export const MIN_ERPNEXT_MAJOR = 16;
export function supportedVersion(versionText: string | null | undefined): boolean {
	const major = Number.parseInt(versionText ?? "", 10);
	return Number.isInteger(major) && major === MIN_ERPNEXT_MAJOR;
}
