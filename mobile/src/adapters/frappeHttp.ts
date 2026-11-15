/**
 * Frappe session transport for an EXPLICIT server origin. The session cookie is held by the platform
 * HTTP stack (CapacitorHttp / native cookie jar on Android), never read or stored by this code, and
 * CSRF tokens are fetched from the server after login. Secrets are never logged.
 */
import type { ApiTransport, AdapterKind } from "@mobile/ports";

export class OfflineError extends Error {
	constructor() {
		super("The server cannot be reached");
		this.name = "OfflineError";
	}
}
export class SessionExpiredError extends Error {
	constructor() {
		super("The session has expired; sign in again");
		this.name = "SessionExpiredError";
	}
}
export class ServerError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly excType?: string,
	) {
		super(message);
		this.name = "ServerError";
	}
}

export function serverMessageOf(body: unknown, status: number): string {
	const b = (body ?? {}) as Record<string, unknown>;
	try {
		const msgs = JSON.parse(String(b._server_messages ?? "[]")) as string[];
		const texts = msgs
			.map((m) => String((JSON.parse(m) as { message?: string }).message ?? ""))
			.map((t) => t.replace(/<[^>]*>/g, "").trim())
			.filter(Boolean);
		if (texts.length) return texts.join(" ");
	} catch {
		/* fall through */
	}
	const exc = String(b.exception ?? "");
	if (exc) return exc.replace(/^[\w.]+:\s*/, "").slice(0, 300);
	return `Server returned ${status}`;
}

export interface RawResponse {
	status: number;
	body: unknown;
}

export class FrappeHttpTransport implements ApiTransport {
	readonly kind: AdapterKind;
	private csrf: string | null = null;

	constructor(
		readonly origin: string,
		private readonly fetchImpl: typeof fetch,
		kind: AdapterKind = "native",
	) {
		this.kind = kind;
	}

	async refreshCsrf(): Promise<string> {
		const r = await this.request("xpos.api.auth.get_csrf_token", {}, { get: true, retryCsrf: false });
		const token = (r.body as { message?: unknown })?.message;
		if (r.status !== 200 || typeof token !== "string" || !token) throw new SessionExpiredError();
		this.csrf = token;
		return token;
	}

	/** Low-level call returning status + parsed body (used by login, which must inspect the shape). */
	async request(
		method: string,
		args: Record<string, unknown> = {},
		opts: { get?: boolean; retryCsrf?: boolean } = {},
	): Promise<RawResponse> {
		const url = new URL(`/api/method/${method}`, this.origin);
		const init: RequestInit = { credentials: "include", headers: { Accept: "application/json" } };
		if (opts.get) {
			for (const [k, v] of Object.entries(args)) url.searchParams.set(k, String(v));
		} else {
			init.method = "POST";
			(init.headers as Record<string, string>)["Content-Type"] = "application/json";
			if (this.csrf) (init.headers as Record<string, string>)["X-Frappe-CSRF-Token"] = this.csrf;
			init.body = JSON.stringify(args);
		}
		let res: Response;
		try {
			res = await this.fetchImpl(url.toString(), init);
		} catch {
			throw new OfflineError();
		}
		let body: unknown = null;
		try {
			body = await res.json();
		} catch {
			/* non-JSON error pages are reported by status only */
		}
		if (
			!opts.get &&
			opts.retryCsrf !== false &&
			(res.status === 400 || res.status === 403) &&
			/CSRF/i.test(JSON.stringify(body ?? ""))
		) {
			await this.refreshCsrf();
			return this.request(method, args, { ...opts, retryCsrf: false });
		}
		return { status: res.status, body };
	}

	async call<T>(
		method: string,
		args: Record<string, unknown> = {},
		opts: { get?: boolean } = {},
	): Promise<T> {
		const r = await this.request(method, args, opts);
		if (r.status === 401) throw new SessionExpiredError();
		if (r.status === 403 && !/CSRF/i.test(JSON.stringify(r.body ?? ""))) {
			await this.refreshCsrf();
		}
		if (r.status < 200 || r.status >= 300)
			throw new ServerError(
				r.status,
				serverMessageOf(r.body, r.status),
				String((r.body as { exc_type?: string })?.exc_type ?? ""),
			);
		return (r.body as { message: T }).message;
	}
}
