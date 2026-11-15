import { describe, expect, it } from "vitest";

import {
	builtinLayout,
	defaultPolicy,
	deviceClassFor,
	effectiveLayout,
	emptyPersonal,
	layoutCacheKey,
	migrate,
	moveItem,
	personalFromEdit,
	sanitize,
	visibleActionCount,
} from "@/services/posLayout";

const policy = defaultPolicy;

describe("posLayout.migrate", () => {
	it("recovers from unreadable or newer data instead of throwing", () => {
		for (const bad of ["{not json", "[1,2]", 5, { version: 99 }]) {
			expect(migrate(bad)).toEqual({ layout: {}, recovered: true });
		}
	});

	it("treats empty as nothing stored, not as a recovery", () => {
		expect(migrate(null)).toEqual({ layout: {}, recovered: false });
		expect(migrate({})).toEqual({ layout: {}, recovered: false });
	});

	it("upgrades the unversioned flat shape", () => {
		const { layout, recovered } = migrate({ pinned: ["A"], density: "touch", view: "list" });
		expect(recovered).toBe(false);
		const clean = sanitize(layout, policy());
		expect(clean.shared.pinnedItems).toEqual(["A"]);
		expect(clean.device.desktop?.density).toBe("touch");
	});
});

describe("posLayout.sanitize", () => {
	it("drops unknown, duplicate and out-of-range values", () => {
		const clean = sanitize(
			{
				version: 1,
				shared: {
					pinnedItems: ["A", "A", 5, "", "B"],
					view: "cards",
					productDisplay: ["image", "price"],
					quickActions: { footer: ["hold", "nope", "pay"], row: "remove" },
					prices: { A: 1 },
				},
				device: {
					desktop: { density: "huge", cartSide: "left", cartWidth: 99999 },
					watch: { density: "touch" },
				},
			},
			policy(),
		);
		expect(clean.shared.pinnedItems).toEqual(["A", "B"]);
		expect(clean.shared.view).toBeUndefined();
		expect(clean.shared.productDisplay).toEqual(["image"]);
		expect(clean.shared.quickActions).toEqual({ footer: ["hold"], row: [] });
		expect(Object.keys(clean.shared)).not.toContain("prices");
		expect(clean.device).toEqual({ desktop: { cartSide: "left", cartWidth: 900 } });
	});

	it("applies the caps", () => {
		const many = Array.from({ length: 40 }, (_, n) => `I${n}`);
		const clean = sanitize({ shared: { pinnedItems: many } }, { ...policy(), max_pinned_items: 3 });
		expect(clean.shared.pinnedItems).toHaveLength(3);
	});
});

describe("posLayout.effectiveLayout precedence", () => {
	const personal = sanitize(
		{
			shared: { view: "list", favoriteCategories: ["Drinks"] },
			device: { desktop: { density: "touch", cartSide: "left" } },
		},
		policy(),
	);

	it("personal beats the profile default, and a missing device class follows desktop", () => {
		const result = effectiveLayout(personal, builtinLayout("grid"), policy());
		expect(result.shared.view).toBe("list");
		expect(result.device.tablet.density).toBe("touch");
		expect(result.device.desktop.cartSide).toBe("left");
	});

	it("a locked section always uses the profile default", () => {
		const locked = {
			...policy(),
			locks: { ...policy().locks, view_and_density: true, cart_layout: true },
		};
		const result = effectiveLayout(personal, builtinLayout("grid"), locked);
		expect(result.shared.view).toBe("grid");
		expect(result.device.desktop).toMatchObject({ density: "comfortable", cartSide: "right" });
		expect(result.shared.favoriteCategories).toEqual(["Drinks"]);
	});

	it("customization switched off ignores every personal value", () => {
		const result = effectiveLayout(personal, builtinLayout("grid"), {
			...policy(),
			allow_customization: false,
		});
		expect(result.shared.view).toBe("grid");
		expect(result.shared.favoriteCategories).toEqual([]);
	});

	it("keeps every allowed action available and never shows a disallowed one", () => {
		const allowed = ["hold", "discount", "coupon", "clear_cart", "gift_card", "quotation"];
		const p = { ...policy(), allowed_footer_actions: allowed };
		const mine = sanitize(
			{ shared: { quickActions: { footer: ["quotation", "sales_order", "hold"] } } },
			p,
		);
		const footer = effectiveLayout(mine, builtinLayout(), p).shared.quickActions.footer;
		expect(footer.slice(0, 2)).toEqual(["quotation", "hold"]);
		expect([...footer].sort()).toEqual([...allowed].sort());
	});

	it("matches the server for the same inputs", () => {
		// Same fixture as test_pos_preferences.test_precedence_*: list view, left cart, touch density.
		const result = effectiveLayout(personal, builtinLayout("grid"), policy());
		expect(result.shared.view).toBe("list");
		expect(result.device.phone.density).toBe("touch");
	});
});

describe("posLayout.personalFromEdit", () => {
	it("stores only what changed, on the current device, and leaves the rest following the default", () => {
		const before = effectiveLayout(emptyPersonal(), builtinLayout(), policy());
		const after = JSON.parse(JSON.stringify(before));
		after.shared.view = "list";
		after.device.tablet.density = "touch";
		const next = personalFromEdit(emptyPersonal(), before, after, "tablet", policy());
		expect(next.shared).toEqual({ view: "list" });
		expect(next.device).toEqual({ tablet: { density: "touch" } });
	});

	it("never writes a locked section", () => {
		const locked = { ...policy(), locks: { ...policy().locks, view_and_density: true } };
		const before = effectiveLayout(emptyPersonal(), builtinLayout(), locked);
		const after = JSON.parse(JSON.stringify(before));
		after.shared.view = "list";
		after.device.desktop.density = "touch";
		expect(personalFromEdit(emptyPersonal(), before, after, "desktop", locked)).toEqual(emptyPersonal());
	});
});

describe("posLayout helpers", () => {
	it("classifies device widths", () => {
		expect([deviceClassFor(390), deviceClassFor(800), deviceClassFor(1440)]).toEqual([
			"phone",
			"tablet",
			"desktop",
		]);
	});

	it("scopes the cache key by user, company and profile", () => {
		const a = layoutCacheKey("h", "alice", "C", "P1");
		expect(a).not.toBe(layoutCacheKey("h", "bob", "C", "P1"));
		expect(a).not.toBe(layoutCacheKey("h", "alice", "C", "P2"));
		expect(a).not.toBe(layoutCacheKey("h", "alice", "D", "P1"));
	});

	it("never shows fewer than five actions inline when five exist", () => {
		expect(visibleActionCount(10, 1)).toBe(5);
		expect(visibleActionCount(3, 5)).toBe(3);
		expect(visibleActionCount(10, 7)).toBe(7);
	});

	it("moves items within bounds", () => {
		expect(moveItem(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
		expect(moveItem(["a", "b", "c"], 2, -4)).toEqual(["c", "a", "b"]);
		expect(moveItem(["a", "b"], 5, 0)).toEqual(["a", "b"]);
	});
});

describe("posLayout cart tabs placement", () => {
	it("defaults to the top and accepts only top or bottom, never hidden", () => {
		expect(builtinLayout().device.phone.cartTabs).toBe("top");
		const clean = sanitize(
			{ device: { desktop: { cartTabs: "bottom" }, tablet: { cartTabs: "hidden" } } },
			policy(),
		);
		expect(clean.device.desktop).toEqual({ cartTabs: "bottom" });
		expect(clean.device.tablet).toBeUndefined();
	});

	it("follows the profile default when locked and the personal choice otherwise", () => {
		const personal = sanitize({ device: { desktop: { cartTabs: "bottom" } } }, policy());
		const defaults = builtinLayout();
		expect(effectiveLayout(personal, defaults, policy()).device.desktop.cartTabs).toBe("bottom");
		const locked = { ...policy(), locks: { ...policy().locks, cart_layout: true } };
		expect(effectiveLayout(personal, defaults, locked).device.desktop.cartTabs).toBe("top");
	});

	it("stores a change to the placement on the current device only", () => {
		const before = builtinLayout();
		const after = JSON.parse(JSON.stringify(before));
		after.device.tablet.cartTabs = "bottom";
		const next = personalFromEdit(emptyPersonal(), before, after, "tablet", policy());
		expect(next.device).toEqual({ tablet: { cartTabs: "bottom" } });
	});
});
