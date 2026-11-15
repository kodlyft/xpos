/**
 * Notification store behind the Pearl toast host.
 *
 * A module singleton so non-component code (stores, api.ts, main.ts) can notify. At most
 * MAX_VISIBLE toasts are shown; the rest wait in FIFO order. Only an explicit `id` (or opt-in
 * `dedupeKey`) merges events, so distinct events are never swallowed.
 */

import { reactive } from "vue";
import { captureError } from "@/services/errorLog";
import __ from "@/lib/translate";

export type ToastType = "success" | "error" | "warning" | "info" | "loading";

export interface ToastAction {
	label: string;
	onClick: () => void;
}

export interface ToastOptions {
	id?: string | number;
	/** Merge with a live toast carrying the same key instead of adding another. */
	dedupeKey?: string;
	description?: string;
	/** Milliseconds; 0 or Infinity keeps the toast until dismissed or updated. */
	duration?: number;
	action?: ToastAction;
}

export interface ToastItem {
	id: string;
	type: ToastType;
	message: string;
	description?: string;
	action?: ToastAction;
	duration: number;
	remaining: number;
	count: number;
	dedupeKey?: string;
	paused: boolean;
}

export const MAX_VISIBLE = 3;

const DEFAULT_DURATION: Record<ToastType, number> = {
	success: 3000,
	info: 3000,
	warning: 4000,
	error: 5000,
	loading: 0,
};

export const visible = reactive<ToastItem[]>([]);
export const queued = reactive<ToastItem[]>([]);

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const startedAt = new Map<string, number>();
let seq = 0;
let docPaused = false;

const STACK_TRACE =
	/(^|\n)\s*(Traceback \(most recent call last\)|at\s+\S+.*\(.*:\d+:\d+\)|File ".*", line \d+)/;

/** Plain text only: tags stripped, and raw stack traces replaced by a generic line (logged instead). */
export function cleanMessage(raw: unknown): string {
	let text = raw instanceof Error ? raw.message : String(raw ?? "");
	if (/<[a-z][\s\S]*>/i.test(text)) {
		text = (new DOMParser().parseFromString(text, "text/html").body.textContent || "").trim();
	}
	if (STACK_TRACE.test(text)) {
		captureError({ source: "renderer", title: "Hidden from toast", message: text });
		return __("Something went wrong. Please try again.");
	}
	return text;
}

function find(id: string): ToastItem | undefined {
	return visible.find((t) => t.id === id) || queued.find((t) => t.id === id);
}

function clearTimer(id: string) {
	const timer = timers.get(id);
	if (timer !== undefined) clearTimeout(timer);
	timers.delete(id);
	startedAt.delete(id);
}

function schedule(t: ToastItem) {
	clearTimer(t.id);
	if (!t.remaining || !Number.isFinite(t.remaining) || t.paused || docPaused) return;
	startedAt.set(t.id, Date.now());
	timers.set(
		t.id,
		setTimeout(() => dismiss(t.id), t.remaining),
	);
}

function promote() {
	while (visible.length < MAX_VISIBLE && queued.length) {
		const next = queued.shift()!;
		visible.push(next);
		schedule(next);
	}
}

function show(type: ToastType, message: unknown, opts: ToastOptions = {}): string {
	const text = cleanMessage(message);
	const key = opts.id !== undefined ? String(opts.id) : undefined;
	const existing =
		(key && find(key)) ||
		(opts.dedupeKey ? [...visible, ...queued].find((t) => t.dedupeKey === opts.dedupeKey) : undefined);
	const duration = opts.duration ?? DEFAULT_DURATION[type];

	if (existing) {
		const repeat = existing.type === type && existing.message === text;
		Object.assign(existing, {
			type,
			message: text,
			description: opts.description,
			action: opts.action,
			duration,
			remaining: duration,
			count: repeat ? existing.count + 1 : 1,
		});
		if (visible.includes(existing)) schedule(existing);
		return existing.id;
	}

	const item: ToastItem = reactive({
		id: key ?? `toast-${++seq}`,
		type,
		message: text,
		description: opts.description,
		action: opts.action,
		duration,
		remaining: duration,
		count: 1,
		dedupeKey: opts.dedupeKey,
		paused: false,
	});
	if (visible.length < MAX_VISIBLE) {
		visible.push(item);
		schedule(item);
	} else {
		queued.push(item);
	}
	return item.id;
}

export function update(
	id: string | number,
	patch: Partial<Pick<ToastItem, "type" | "message" | "description" | "action">> & { duration?: number },
): void {
	const t = find(String(id));
	if (!t) return;
	const type = patch.type ?? t.type;
	const duration = patch.duration ?? (patch.type ? DEFAULT_DURATION[type] : t.duration);
	t.type = type;
	if (patch.message !== undefined) t.message = cleanMessage(patch.message);
	if ("description" in patch) t.description = patch.description;
	if ("action" in patch) t.action = patch.action;
	t.duration = duration;
	t.remaining = duration;
	t.count = 1;
	if (visible.includes(t)) schedule(t);
}

export function dismiss(id?: string | number): void {
	if (id === undefined) {
		[...visible, ...queued].forEach((t) => clearTimer(t.id));
		visible.splice(0);
		queued.splice(0);
		return;
	}
	const key = String(id);
	clearTimer(key);
	const vi = visible.findIndex((t) => t.id === key);
	if (vi >= 0) visible.splice(vi, 1);
	const qi = queued.findIndex((t) => t.id === key);
	if (qi >= 0) queued.splice(qi, 1);
	promote();
}

export function pause(id: string): void {
	const t = visible.find((x) => x.id === id);
	if (!t || t.paused) return;
	const started = startedAt.get(id);
	if (started !== undefined && Number.isFinite(t.remaining) && t.remaining > 0) {
		t.remaining = Math.max(0, t.remaining - (Date.now() - started));
	}
	t.paused = true;
	clearTimer(id);
}

export function resume(id: string): void {
	const t = visible.find((x) => x.id === id);
	if (!t || !t.paused) return;
	t.paused = false;
	schedule(t);
}

/** Document hidden: freeze every countdown without touching per-toast hover/focus pauses. */
export function setDocumentHidden(hidden: boolean): void {
	if (docPaused === hidden) return;
	docPaused = hidden;
	for (const t of visible) {
		if (hidden) {
			const started = startedAt.get(t.id);
			if (started !== undefined && t.remaining > 0 && Number.isFinite(t.remaining)) {
				t.remaining = Math.max(0, t.remaining - (Date.now() - started));
			}
			clearTimer(t.id);
		} else {
			schedule(t);
		}
	}
}

export function promise<T>(
	p: Promise<T>,
	msgs: {
		loading: string;
		success: string | ((v: T) => string);
		error: string | ((e: unknown) => string);
	},
	opts: ToastOptions = {},
): Promise<T> {
	const id = show("loading", msgs.loading, opts);
	p.then(
		(v) =>
			update(id, {
				type: "success",
				message: typeof msgs.success === "function" ? msgs.success(v) : msgs.success,
			}),
		(e) =>
			update(id, {
				type: "error",
				message: typeof msgs.error === "function" ? msgs.error(e) : msgs.error,
			}),
	);
	return p;
}

/** Clears timers and state; used on host unmount and between tests. */
export function dispose(): void {
	timers.forEach((timer) => clearTimeout(timer));
	timers.clear();
	startedAt.clear();
	visible.splice(0);
	queued.splice(0);
	docPaused = false;
}

export const toast = {
	success: (m: unknown, o?: ToastOptions) => show("success", m, o),
	error: (m: unknown, o?: ToastOptions) => show("error", m, o),
	warning: (m: unknown, o?: ToastOptions) => show("warning", m, o),
	info: (m: unknown, o?: ToastOptions) => show("info", m, o),
	loading: (m: unknown, o?: ToastOptions) => show("loading", m, o),
	update,
	dismiss,
	promise,
};
