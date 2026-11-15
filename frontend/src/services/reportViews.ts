import type { ReportLayout, ReportSort } from "@/services/reportGrid";

/**
 * Favorites, recents and saved views live on this device only (the backend has no per-user
 * report storage). Every access is guarded: storage can be blocked or full, and the workspace
 * must work without it.
 */
export interface ReportView {
	id: string;
	name: string;
	layout: ReportLayout;
	sort: ReportSort | null;
	/** Present only when the user chose to save the filters with the view. */
	filters?: Record<string, unknown>;
	isDefault?: boolean;
}

interface StoredState {
	favorites: string[];
	recents: { id: string; at: number }[];
	views: Record<string, ReportView[]>;
}

export const MAX_RECENTS = 8;

const empty = (): StoredState => ({ favorites: [], recents: [], views: {} });

export function reportStorageKey(site: string, user: string): string {
	return `xpos:reports:v1:${site}:${user}`;
}

export interface ReportViewStore {
	favorites(): string[];
	toggleFavorite(reportId: string): boolean;
	recents(): string[];
	touchRecent(reportId: string): void;
	views(reportId: string): ReportView[];
	saveView(reportId: string, view: Omit<ReportView, "id"> & { id?: string }): ReportView[];
	deleteView(reportId: string, viewId: string): ReportView[];
	setDefault(reportId: string, viewId: string | null): ReportView[];
	durable(): boolean;
}

const unsaved = new Map<string, StoredState>();

export function resetReportViewSession(): void {
	unsaved.clear();
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isStringList = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((entry) => typeof entry === "string");

function validLayout(value: unknown): value is ReportLayout {
	return (
		isRecord(value) &&
		isStringList(value.order) &&
		isStringList(value.hidden) &&
		isRecord(value.widths) &&
		Object.values(value.widths).every((width) => typeof width === "number" && Number.isFinite(width)) &&
		typeof value.frozen === "number" &&
		Number.isFinite(value.frozen)
	);
}

function validSort(value: unknown): value is ReportSort | null {
	return (
		value === null ||
		(isRecord(value) &&
			typeof value.fieldname === "string" &&
			(value.direction === "asc" || value.direction === "desc"))
	);
}

function validView(value: unknown): value is ReportView {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		value.id !== "" &&
		typeof value.name === "string" &&
		validLayout(value.layout) &&
		validSort(value.sort ?? null) &&
		(value.filters === undefined || isRecord(value.filters))
	);
}

/** Keep only well-formed entries; a damaged part of the stored state never reaches the UI. */
export function validateStored(parsed: unknown): StoredState {
	if (!isRecord(parsed)) return empty();
	const views: Record<string, ReportView[]> = {};
	if (isRecord(parsed.views)) {
		for (const [reportId, list] of Object.entries(parsed.views)) {
			if (Array.isArray(list))
				views[reportId] = list.filter(validView).map((v) => ({ ...v, sort: v.sort ?? null }));
		}
	}
	return {
		favorites: Array.isArray(parsed.favorites)
			? parsed.favorites.filter((id): id is string => typeof id === "string")
			: [],
		recents: Array.isArray(parsed.recents)
			? parsed.recents.filter(
					(entry): entry is { id: string; at: number } =>
						isRecord(entry) &&
						typeof entry.id === "string" &&
						typeof entry.at === "number" &&
						Number.isFinite(entry.at),
				)
			: [],
		views,
	};
}

export function createReportViewStore(
	key: string,
	storage: Pick<Storage, "getItem" | "setItem"> | null = safeLocalStorage(),
	now: () => number = Date.now,
): ReportViewStore {
	function read(): StoredState {
		const kept = unsaved.get(key);
		if (kept) return structuredClone(kept);
		try {
			const raw = storage?.getItem(key);
			return raw ? validateStored(JSON.parse(raw)) : empty();
		} catch {
			return empty();
		}
	}

	function write(state: StoredState): void {
		try {
			if (!storage) throw new Error("no storage");
			storage.setItem(key, JSON.stringify(state));
			unsaved.delete(key);
		} catch {
			unsaved.set(key, structuredClone(state));
		}
	}

	return {
		favorites: () => read().favorites,
		toggleFavorite(reportId) {
			const state = read();
			const on = !state.favorites.includes(reportId);
			state.favorites = on
				? [...state.favorites, reportId]
				: state.favorites.filter((id) => id !== reportId);
			write(state);
			return on;
		},
		recents: () =>
			read()
				.recents.sort((a, b) => b.at - a.at)
				.map((entry) => entry.id),
		touchRecent(reportId) {
			const state = read();
			state.recents = [
				{ id: reportId, at: now() },
				...state.recents.filter((entry) => entry.id !== reportId),
			]
				.sort((a, b) => b.at - a.at)
				.slice(0, MAX_RECENTS);
			write(state);
		},
		views: (reportId) => read().views[reportId] ?? [],
		saveView(reportId, view) {
			const state = read();
			const list = state.views[reportId] ?? [];
			const id = view.id ?? `v${now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
			const saved: ReportView = { ...view, id };
			const next = list.some((entry) => entry.id === id)
				? list.map((entry) => (entry.id === id ? saved : entry))
				: [...list, saved];
			state.views[reportId] = saved.isDefault
				? next.map((entry) => ({ ...entry, isDefault: entry.id === id }))
				: next;
			write(state);
			return state.views[reportId];
		},
		deleteView(reportId, viewId) {
			const state = read();
			state.views[reportId] = (state.views[reportId] ?? []).filter((entry) => entry.id !== viewId);
			write(state);
			return state.views[reportId];
		},
		durable: () => !unsaved.has(key),
		setDefault(reportId, viewId) {
			const state = read();
			state.views[reportId] = (state.views[reportId] ?? []).map((entry) => ({
				...entry,
				isDefault: entry.id === viewId,
			}));
			write(state);
			return state.views[reportId];
		},
	};
}

function safeLocalStorage(): Storage | null {
	try {
		return typeof localStorage === "undefined" ? null : localStorage;
	} catch {
		return null;
	}
}
