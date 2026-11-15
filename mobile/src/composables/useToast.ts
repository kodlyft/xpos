import { reactive, watch, type WatchSource } from "vue";

export type ToastKind = "error" | "warning" | "info";
export type Toast = { id: number; kind: ToastKind; text: string };

const DURATION: Record<ToastKind, number> = { error: 6000, warning: 5000, info: 3500 };
const MAX = 3;

export const toasts = reactive<Toast[]>([]);
let seq = 0;

export function dismissToast(id: number) {
	const i = toasts.findIndex((t) => t.id === id);
	if (i >= 0) toasts.splice(i, 1);
}

function push(kind: ToastKind, text: string) {
	if (!text) return;
	const same = toasts.find((t) => t.kind === kind && t.text === text);
	if (same) dismissToast(same.id);
	const id = ++seq;
	toasts.push({ id, kind, text });
	if (toasts.length > MAX) toasts.splice(0, toasts.length - MAX);
	setTimeout(() => dismissToast(id), DURATION[kind]);
}

export const toast = {
	error: (text: string) => push("error", text),
	warning: (text: string) => push("warning", text),
	info: (text: string) => push("info", text),
};

/** Shows a toast whenever `source` becomes a non-empty message (replaces an inline error paragraph). */
export function toastOn(source: WatchSource<string | undefined>, kind: ToastKind = "error") {
	watch(source, (text) => text && toast[kind](text), { immediate: true });
}
