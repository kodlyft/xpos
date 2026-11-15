/**
 * POS view layout preferences: schema, migration, validation and precedence.
 *
 * Mirrors xpos/api/pos_preferences.py so a cashier's layout resolves the same way offline
 * as on the server. Only ids and enums live here, never prices, stock or permissions.
 */

export const SCHEMA_VERSION = 1;
export const DEVICE_CLASSES = ["desktop", "tablet", "phone"] as const;
export const DENSITIES = ["compact", "comfortable", "touch"] as const;
export const VIEWS = ["grid", "list"] as const;
export const CART_SIDES = ["left", "right"] as const;
export const CART_TAB_PLACEMENTS = ["top", "bottom"] as const;
export const CART_WIDTH_RANGE: [number, number] = [320, 900];
export const MIN_VISIBLE_ACTIONS = 5;

export const FOOTER_ACTIONS = [
	"hold",
	"discount",
	"coupon",
	"clear_discounts",
	"delivery_charge",
	"restore_draft",
	"gift_card",
	"sales_order",
	"quotation",
	"clear_cart",
] as const;
export const ROW_ACTIONS = ["uom", "tracking", "item_discount", "remove"] as const;
export const DISPLAY_FIELDS = ["image", "item_code", "stock", "uom"] as const;
export const DEFAULT_DISPLAY = ["image", "item_code", "stock"] as const;

export type DeviceClass = (typeof DEVICE_CLASSES)[number];
export type Density = (typeof DENSITIES)[number];
export type ViewMode = (typeof VIEWS)[number];
export type CartSide = (typeof CART_SIDES)[number];
export type CartTabPlacement = (typeof CART_TAB_PLACEMENTS)[number];
export type Section =
	| "pinned_items"
	| "favorite_categories"
	| "view_and_density"
	| "product_display"
	| "cart_layout"
	| "quick_actions";

export const SECTION_NAMES: Section[] = [
	"pinned_items",
	"favorite_categories",
	"view_and_density",
	"product_display",
	"cart_layout",
	"quick_actions",
];

export interface LayoutPolicy {
	allow_customization: boolean;
	max_pinned_items: number;
	max_favorite_categories: number;
	min_visible_actions: number;
	locks: Record<Section, boolean>;
	allowed_footer_actions: string[];
	allowed_row_actions: string[];
	allowed_display_fields: string[];
}

export interface SharedLayout {
	pinnedItems: string[];
	favoriteCategories: string[];
	quickActions: { footer: string[]; row: string[] };
	productDisplay: string[];
	view: ViewMode;
}

export interface DeviceLayout {
	density: Density;
	cartSide: CartSide;
	cartWidth: number | null;
	cartTabs: CartTabPlacement;
}

export interface Layout {
	version: number;
	shared: SharedLayout;
	device: Record<DeviceClass, DeviceLayout>;
}

/** A personal layout: any section may be absent, meaning "use the profile default". */
export interface PersonalLayout {
	version: number;
	shared: Partial<Omit<SharedLayout, "quickActions">> & {
		quickActions?: Partial<SharedLayout["quickActions"]>;
	};
	device: Partial<Record<DeviceClass, Partial<DeviceLayout>>>;
}

export function defaultPolicy(): LayoutPolicy {
	return {
		allow_customization: true,
		max_pinned_items: 24,
		max_favorite_categories: 12,
		min_visible_actions: MIN_VISIBLE_ACTIONS,
		locks: Object.fromEntries(SECTION_NAMES.map((name) => [name, false])) as Record<Section, boolean>,
		allowed_footer_actions: [...FOOTER_ACTIONS],
		allowed_row_actions: [...ROW_ACTIONS],
		allowed_display_fields: [...DISPLAY_FIELDS],
	};
}

export function builtinLayout(view: ViewMode = "grid", display?: string[]): Layout {
	const device = {} as Record<DeviceClass, DeviceLayout>;
	for (const name of DEVICE_CLASSES)
		device[name] = { density: "comfortable", cartSide: "right", cartWidth: null, cartTabs: "top" };
	return {
		version: SCHEMA_VERSION,
		shared: {
			pinnedItems: [],
			favoriteCategories: [],
			quickActions: { footer: [...FOOTER_ACTIONS], row: [...ROW_ACTIONS] },
			productDisplay: display ?? [...DEFAULT_DISPLAY],
			view,
		},
		device,
	};
}

export function emptyPersonal(): PersonalLayout {
	return { version: SCHEMA_VERSION, shared: {}, device: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function textList(value: unknown, allowed?: readonly string[], limit?: number): string[] {
	if (!Array.isArray(value)) return [];
	const seen: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string" || !entry || entry.length > 140 || seen.includes(entry)) continue;
		if (allowed && !allowed.includes(entry)) continue;
		seen.push(entry);
		if (limit !== undefined && seen.length >= limit) break;
	}
	return seen;
}

/** Bring stored data to the current schema. `recovered` is set when it had to be dropped. */
export function migrate(data: unknown): { layout: Record<string, unknown>; recovered: boolean } {
	let value = data;
	if (typeof value === "string") {
		try {
			value = JSON.parse(value);
		} catch {
			return { layout: {}, recovered: true };
		}
	}
	if (value === null || value === undefined || value === "") return { layout: {}, recovered: false };
	if (!isRecord(value)) return { layout: {}, recovered: true };
	if (Object.keys(value).length === 0) return { layout: {}, recovered: false };

	const version = value.version;
	if (version === SCHEMA_VERSION || (version === undefined && ("shared" in value || "device" in value))) {
		return { layout: value, recovered: false };
	}
	if (version === undefined || version === 0) {
		return {
			recovered: false,
			layout: {
				version: SCHEMA_VERSION,
				shared: {
					pinnedItems: value.pinned ?? value.pinnedItems,
					favoriteCategories: value.favorites ?? value.favoriteCategories,
					view: value.view,
				},
				device: { desktop: { density: value.density, cartWidth: value.cartWidth } },
			},
		};
	}
	return { layout: {}, recovered: true };
}

/** A personal layout reduced to known, bounded values. Missing sections stay missing. */
export function sanitize(data: unknown, policy: LayoutPolicy): PersonalLayout {
	const { layout } = migrate(data);
	const shared = isRecord(layout.shared) ? layout.shared : {};
	const device = isRecord(layout.device) ? layout.device : {};
	const out = emptyPersonal();

	if ("pinnedItems" in shared)
		out.shared.pinnedItems = textList(shared.pinnedItems, undefined, policy.max_pinned_items);
	if ("favoriteCategories" in shared) {
		out.shared.favoriteCategories = textList(
			shared.favoriteCategories,
			undefined,
			policy.max_favorite_categories,
		);
	}
	if ((VIEWS as readonly unknown[]).includes(shared.view)) out.shared.view = shared.view as ViewMode;
	if ("productDisplay" in shared) {
		out.shared.productDisplay = textList(shared.productDisplay, policy.allowed_display_fields);
	}
	if (isRecord(shared.quickActions)) {
		const actions = shared.quickActions;
		const clean: Partial<SharedLayout["quickActions"]> = {};
		if ("footer" in actions) clean.footer = textList(actions.footer, policy.allowed_footer_actions);
		if ("row" in actions) clean.row = textList(actions.row, policy.allowed_row_actions);
		out.shared.quickActions = clean;
	}

	for (const name of DEVICE_CLASSES) {
		const entry = device[name];
		if (!isRecord(entry)) continue;
		const clean: Partial<DeviceLayout> = {};
		if ((DENSITIES as readonly unknown[]).includes(entry.density))
			clean.density = entry.density as Density;
		if ((CART_SIDES as readonly unknown[]).includes(entry.cartSide))
			clean.cartSide = entry.cartSide as CartSide;
		if ((CART_TAB_PLACEMENTS as readonly unknown[]).includes(entry.cartTabs))
			clean.cartTabs = entry.cartTabs as CartTabPlacement;
		if (typeof entry.cartWidth === "number" && Number.isFinite(entry.cartWidth)) {
			clean.cartWidth = Math.trunc(
				Math.min(Math.max(entry.cartWidth, CART_WIDTH_RANGE[0]), CART_WIDTH_RANGE[1]),
			);
		}
		if (Object.keys(clean).length) out.device[name] = clean;
	}
	return out;
}

/** Chosen actions first, then every other allowed action, so none drops out of the menu. */
export function completeActions(chosen: string[], allowed: string[], order: readonly string[]): string[] {
	const rest = order.filter((name) => allowed.includes(name) && !chosen.includes(name));
	return [...chosen.filter((name) => allowed.includes(name)), ...rest];
}

/** Locked section -> profile default; else personal; else profile default. */
export function effectiveLayout(personal: PersonalLayout, defaults: Layout, policy: LayoutPolicy): Layout {
	const off = !policy.allow_customization;
	const mine = off ? {} : personal.shared;
	const devices = off ? {} : personal.device;
	const base = defaults.shared;
	const locks = policy.locks;

	const chosen = locks.quick_actions ? base.quickActions : (mine.quickActions ?? {});
	const shared: SharedLayout = {
		pinnedItems: (locks.pinned_items ? base.pinnedItems : (mine.pinnedItems ?? base.pinnedItems)).slice(
			0,
			policy.max_pinned_items,
		),
		favoriteCategories: (locks.favorite_categories
			? base.favoriteCategories
			: (mine.favoriteCategories ?? base.favoriteCategories)
		).slice(0, policy.max_favorite_categories),
		view: locks.view_and_density ? base.view : (mine.view ?? base.view),
		productDisplay: textList(
			locks.product_display ? base.productDisplay : (mine.productDisplay ?? base.productDisplay),
			policy.allowed_display_fields,
		),
		quickActions: {
			footer: completeActions(
				chosen.footer ?? base.quickActions.footer,
				policy.allowed_footer_actions,
				FOOTER_ACTIONS,
			),
			row: completeActions(
				chosen.row ?? base.quickActions.row,
				policy.allowed_row_actions,
				ROW_ACTIONS,
			),
		},
	};

	const device = {} as Record<DeviceClass, DeviceLayout>;
	for (const name of DEVICE_CLASSES) {
		const fallback = defaults.device[name];
		const own = devices[name] ?? devices.desktop ?? {};
		device[name] = {
			density: locks.view_and_density ? fallback.density : (own.density ?? fallback.density),
			cartSide: locks.cart_layout ? fallback.cartSide : (own.cartSide ?? fallback.cartSide),
			cartWidth: locks.cart_layout ? fallback.cartWidth : (own.cartWidth ?? fallback.cartWidth),
			cartTabs: locks.cart_layout ? fallback.cartTabs : (own.cartTabs ?? fallback.cartTabs),
		};
	}
	return { version: SCHEMA_VERSION, shared, device };
}

function same(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The personal layout that turns `before` into `after` on top of `existing`, touching only
 * what changed and only for the given device class, so untouched sections keep following
 * the profile default and other devices keep their own values.
 */
export function personalFromEdit(
	existing: PersonalLayout,
	before: Layout,
	after: Layout,
	deviceClass: DeviceClass,
	policy: LayoutPolicy,
): PersonalLayout {
	const next: PersonalLayout = JSON.parse(JSON.stringify(existing));
	const locks = policy.locks;
	const shared = next.shared;

	if (!locks.pinned_items && !same(before.shared.pinnedItems, after.shared.pinnedItems)) {
		shared.pinnedItems = [...after.shared.pinnedItems];
	}
	if (
		!locks.favorite_categories &&
		!same(before.shared.favoriteCategories, after.shared.favoriteCategories)
	) {
		shared.favoriteCategories = [...after.shared.favoriteCategories];
	}
	if (!locks.view_and_density && before.shared.view !== after.shared.view) shared.view = after.shared.view;
	if (!locks.product_display && !same(before.shared.productDisplay, after.shared.productDisplay)) {
		shared.productDisplay = [...after.shared.productDisplay];
	}
	if (!locks.quick_actions) {
		const actions = { ...(shared.quickActions ?? {}) };
		if (!same(before.shared.quickActions.footer, after.shared.quickActions.footer)) {
			actions.footer = [...after.shared.quickActions.footer];
		}
		if (!same(before.shared.quickActions.row, after.shared.quickActions.row)) {
			actions.row = [...after.shared.quickActions.row];
		}
		if (Object.keys(actions).length) shared.quickActions = actions;
	}

	const was = before.device[deviceClass];
	const now = after.device[deviceClass];
	const entry = { ...(next.device[deviceClass] ?? {}) };
	if (!locks.view_and_density && was.density !== now.density) entry.density = now.density;
	if (!locks.cart_layout) {
		if (was.cartSide !== now.cartSide) entry.cartSide = now.cartSide;
		if (was.cartWidth !== now.cartWidth && now.cartWidth !== null) entry.cartWidth = now.cartWidth;
		if (was.cartTabs !== now.cartTabs) entry.cartTabs = now.cartTabs;
	}
	if (Object.keys(entry).length) next.device[deviceClass] = entry;
	return next;
}

export function deviceClassFor(width: number): DeviceClass {
	if (width < 640) return "phone";
	if (width < 1024) return "tablet";
	return "desktop";
}

export function layoutCacheKey(host: string, user: string, company: string, profile: string): string {
	return [host, user, company, profile].join("|");
}

/** How many of `count` actions show inline; the rest go into the More menu. */
export function visibleActionCount(count: number, minVisible: number): number {
	return Math.min(count, Math.max(minVisible, MIN_VISIBLE_ACTIONS));
}

export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
	if (from === to || from < 0 || from >= list.length) return [...list];
	const clamped = Math.min(Math.max(to, 0), list.length - 1);
	const next = [...list];
	const [entry] = next.splice(from, 1);
	next.splice(clamped, 0, entry);
	return next;
}
