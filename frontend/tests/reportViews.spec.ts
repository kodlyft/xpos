import { beforeEach, describe, expect, it } from "vitest";
import {
	createReportViewStore,
	MAX_RECENTS,
	resetReportViewSession,
	validateStored,
} from "@/services/reportViews";
import { createRunGuard } from "@/services/reportRunGuard";
import { documentPath, drillTarget } from "@/services/reportDrill";
import { emptyLayout } from "@/services/reportGrid";

function memory() {
	const data = new Map<string, string>();
	return {
		getItem: (k: string) => data.get(k) ?? null,
		setItem: (k: string, v: string) => void data.set(k, v),
	};
}

const blocked = () => ({
	getItem: () => {
		throw new Error("blocked");
	},
	setItem: () => {
		throw new Error("full");
	},
});

describe("view store", () => {
	beforeEach(() => resetReportViewSession());

	it("toggles favorites and keeps recents newest-first and capped", () => {
		let t = 0;
		const store = createReportViewStore("k", memory(), () => ++t);
		expect(store.toggleFavorite("a")).toBe(true);
		expect(store.toggleFavorite("a")).toBe(false);
		for (let i = 0; i < MAX_RECENTS + 3; i++) store.touchRecent(`r${i}`);
		store.touchRecent("r5");
		const recents = store.recents();
		expect(recents[0]).toBe("r5");
		expect(recents).toHaveLength(MAX_RECENTS);
	});

	it("saves, defaults (one at a time) and deletes views", () => {
		const store = createReportViewStore("k", memory());
		const first = store.saveView("r", { name: "One", layout: emptyLayout(), sort: null })[0];
		const list = store.saveView("r", { name: "Two", layout: emptyLayout(), sort: null, isDefault: true });
		expect(list.filter((v) => v.isDefault)).toHaveLength(1);
		expect(store.setDefault("r", first.id).find((v) => v.isDefault)?.id).toBe(first.id);
		expect(store.deleteView("r", first.id)).toHaveLength(1);
	});

	it("survives blocked or corrupt storage", () => {
		const broken = {
			getItem: () => {
				throw new Error("blocked");
			},
			setItem: () => {
				throw new Error("full");
			},
		};
		const store = createReportViewStore("k", broken);
		expect(store.favorites()).toEqual([]);
		expect(() => store.toggleFavorite("a")).not.toThrow();
		const corrupt = createReportViewStore("k", { getItem: () => "{nope", setItem: () => {} });
		expect(corrupt.views("r")).toEqual([]);
		expect(createReportViewStore("k", null).recents()).toEqual([]);
	});
});

describe("view store when storage refuses writes", () => {
	beforeEach(() => resetReportViewSession());

	it("keeps a favorite and a saved view for the session and says they are not durable", () => {
		const store = createReportViewStore("k", blocked());
		expect(store.durable()).toBe(true);
		expect(store.toggleFavorite("a")).toBe(true);
		expect(store.favorites()).toEqual(["a"]);
		const views = store.saveView("r", { name: "Mine", layout: emptyLayout(), sort: null });
		expect(views).toHaveLength(1);
		expect(store.views("r")).toEqual(views);
		expect(store.durable()).toBe(false);
	});

	it("shares the session copy between stores and defers to storage once a write is accepted", () => {
		const first = createReportViewStore("k", blocked());
		first.toggleFavorite("a");
		const data = new Map<string, string>();
		const working = {
			getItem: (k: string) => data.get(k) ?? null,
			setItem: (k: string, v: string) => void data.set(k, v),
		};
		const second = createReportViewStore("k", working);
		expect(second.favorites()).toEqual(["a"]);
		second.toggleFavorite("b");
		expect(second.durable()).toBe(true);
		expect(JSON.parse(data.get("k")!).favorites).toEqual(["a", "b"]);
	});

	it("keeps working with no storage at all", () => {
		const store = createReportViewStore("k", null);
		store.toggleFavorite("a");
		expect(store.favorites()).toEqual(["a"]);
		expect(store.durable()).toBe(false);
	});
});

describe("stored view shape validation", () => {
	beforeEach(() => resetReportViewSession());

	it("drops malformed favorites, recents and views instead of passing them on", () => {
		const good = { id: "v1", name: "Good", layout: emptyLayout(), sort: null };
		const state = validateStored({
			favorites: ["a", 3, null],
			recents: [{ id: "a", at: 1 }, { id: "b" }, { id: "c", at: "x" }, null],
			views: {
				r: [
					good,
					{ id: "v2" },
					{ id: "v3", name: "Bad layout", layout: { order: "no" }, sort: null },
					7,
				],
				s: "not a list",
				t: [{ ...good, id: "v4", sort: { fieldname: "x", direction: "sideways" } }],
			},
		});
		expect(state.favorites).toEqual(["a"]);
		expect(state.recents).toEqual([{ id: "a", at: 1 }]);
		expect(state.views).toEqual({ r: [good], t: [] });
		expect(validateStored([]).views).toEqual({});
		expect(validateStored(null).favorites).toEqual([]);
	});

	it("never serves damaged stored views", () => {
		const store = createReportViewStore("k", {
			getItem: () =>
				JSON.stringify({ views: { r: { not: "a list" } }, recents: [{ id: "a", at: "x" }] }),
			setItem: () => {},
		});
		expect(store.views("r")).toEqual([]);
		expect(store.recents()).toEqual([]);
	});
});

describe("run guard", () => {
	it("invalidates older tokens when a newer run or cancel happens", () => {
		const guard = createRunGuard();
		const a = guard.next();
		const b = guard.next();
		expect(guard.isCurrent(a)).toBe(false);
		expect(guard.isCurrent(b)).toBe(true);
		guard.cancel();
		expect(guard.isCurrent(b)).toBe(false);
	});
});

describe("drill-down targets", () => {
	it("resolves Link and Dynamic Link cells and builds a desk path", () => {
		const link = { fieldname: "inv", label: "Inv", fieldtype: "Link", options: "POS Invoice" };
		const dyn = { fieldname: "doc", label: "Doc", fieldtype: "Dynamic Link", options: "doctype" };
		expect(drillTarget(link, { inv: "INV-1" })).toEqual({ doctype: "POS Invoice", name: "INV-1" });
		expect(drillTarget(dyn, { doc: "X-1", doctype: "Sales Order" })).toEqual({
			doctype: "Sales Order",
			name: "X-1",
		});
		expect(drillTarget(dyn, { doc: "X-1" })).toBeNull();
		expect(drillTarget(link, { inv: "" })).toBeNull();
		expect(documentPath({ doctype: "POS Invoice", name: "A/B 1" })).toBe("/desk/pos-invoice/A%2FB%201");
	});
});
