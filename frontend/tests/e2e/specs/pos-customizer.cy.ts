/**
 * POS View Customizer: personal layout, Customize mode (preview / Save / Cancel / Reset),
 * ordered cart buttons with a More menu, offline edits, concurrent saves and scanner focus.
 *
 * The backend is a small stateful fake of xpos.api.pos_preferences (one row per user, revision
 * checked) so users, devices and conflicts behave the way the real endpoints do.
 * `CYPRESS_shotSet` names the screenshot set.
 */
import { ITEM_A, ITEM_B, ITEM_GROUPS, OPEN_SHIFT, POS_PROFILE_DOC } from "../fixtures/pos";
import { callsTo, stub } from "../support/frappeStub";

const SET = String(Cypress.env("shotSet") || "after");
const API = "xpos.api.pos_preferences";

const FOOTER = [
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
];
const ROW = ["uom", "tracking", "item_discount", "remove"];

type Personal = {
	version: number;
	shared: Record<string, unknown>;
	device: Record<string, Record<string, unknown>>;
};

function builtin(view = "grid") {
	const device: Record<string, unknown> = {};
	for (const name of ["desktop", "tablet", "phone"]) {
		device[name] = { density: "comfortable", cartSide: "right", cartWidth: null };
	}
	return {
		version: 1,
		shared: {
			pinnedItems: [],
			favoriteCategories: [],
			quickActions: { footer: FOOTER, row: ROW },
			productDisplay: ["image", "item_code", "stock"],
			view,
		},
		device,
	};
}

const POLICY = {
	allow_customization: true,
	max_pinned_items: 24,
	max_favorite_categories: 12,
	min_visible_actions: 5,
	locks: {
		pinned_items: false,
		favorite_categories: false,
		view_and_density: false,
		product_display: false,
		cart_layout: false,
		quick_actions: false,
	},
	allowed_footer_actions: FOOTER,
	allowed_row_actions: ROW,
	allowed_display_fields: ["image", "item_code", "stock", "uom"],
};

function resolveLayout(personal: Personal) {
	const layout = builtin() as ReturnType<typeof builtin> & { shared: Record<string, unknown> };
	Object.assign(layout.shared, personal.shared);
	for (const [name, entry] of Object.entries(personal.device)) {
		Object.assign((layout.device as Record<string, Record<string, unknown>>)[name], entry);
	}
	const mine = personal.shared.quickActions as { footer?: string[]; row?: string[] } | undefined;
	const complete = (chosen: string[] | undefined, all: string[]) => [
		...(chosen || []),
		...all.filter((id) => !(chosen || []).includes(id)),
	];
	layout.shared.quickActions = { footer: complete(mine?.footer, FOOTER), row: complete(mine?.row, ROW) };
	// a device class without its own entry follows desktop, as the server does
	const devices = layout.device as Record<string, Record<string, unknown>>;
	for (const name of ["tablet", "phone"]) {
		if (!personal.device[name] && personal.device.desktop)
			Object.assign(devices[name], personal.device.desktop);
	}
	return layout;
}

interface Row {
	personal: Personal;
	revision: number;
}

/** Fake pos_preferences server. `as(user)` switches who the session belongs to. */
function layoutServer(initial: Record<string, Row> = {}) {
	const rows: Record<string, Row> = { ...initial };
	let user = "cashier@example.com";
	const payload = () => {
		const row = rows[user] ?? { personal: { version: 1, shared: {}, device: {} }, revision: 0 };
		return {
			pos_profile: "Main",
			company: "Test Co",
			revision: row.revision,
			recovered: false,
			policy: POLICY,
			defaults: builtin(),
			personal: row.personal,
			layout: resolveLayout(row.personal),
		};
	};
	return {
		rows,
		as: (name: string) => (user = name),
		routes: {
			[`${API}.get_layout`]: () => payload(),
			[`${API}.get_pinned_items`]: () => {
				const codes = (payload().layout.shared.pinnedItems as string[]) || [];
				return [ITEM_A, ITEM_B].filter((item) => codes.includes(item.item_code));
			},
			[`${API}.save_layout`]: (args: Record<string, unknown>) => {
				const row = rows[user] ?? { personal: { version: 1, shared: {}, device: {} }, revision: 0 };
				if (Number(args.base_revision) !== row.revision) return { status: "conflict", ...payload() };
				rows[user] = { personal: JSON.parse(String(args.layout)), revision: row.revision + 1 };
				return { status: "saved", ...payload() };
			},
			[`${API}.reset_layout`]: () => {
				delete rows[user];
				return { status: "reset", ...payload() };
			},
		} as Record<string, unknown>,
	};
}

function boot(
	server: ReturnType<typeof layoutServer>,
	options: {
		theme?: "dark";
		viewport?: [number, number];
		skipCustomer?: boolean;
		profile?: Record<string, unknown>;
		extraRoutes?: Record<string, unknown>;
	} = {},
) {
	const [w, h] = options.viewport || [1440, 900];
	cy.viewport(w, h);
	cy.bootPos({
		routes: {
			...server.routes,
			"xpos.api.shifts.check_open_shift": {
				...OPEN_SHIFT,
				pos_profile: { ...POS_PROFILE_DOC, allow_coupon_entry: 1, ...(options.profile || {}) },
			},
			...(options.extraRoutes || {}),
		},
		readyItem: ITEM_A.item_name,
		skipCustomer: options.skipCustomer,
		beforeLoad: (win) => {
			if (options.theme) win.localStorage.setItem("xpos-theme", options.theme);
		},
	});
}

function shot(name: string) {
	cy.wait(400);
	cy.screenshot(`${SET}/${name}`, { capture: "viewport", overwrite: true });
}

const openCustomize = () => cy.get("[data-testid='customize-open']:visible").click();
const panel = () => cy.get("[data-testid='customize-panel']");
const saveCalls = () => callsTo(`${API}.save_layout`);

describe("POS view customizer", () => {
	it("previews live, saves only what changed, and keeps it after a reload", () => {
		const server = layoutServer();
		boot(server);
		cy.get("#pos-products [data-testid='item-add']").first().should("be.visible");

		openCustomize();
		panel().should("be.visible");
		cy.get("[data-testid='view-list']").click();
		cy.get("[data-testid='density-compact']").click();
		// preview: the list header appears before anything is saved
		cy.get("#pos-products").contains("Stock").should("be.visible");
		cy.then(() => expect(saveCalls()).to.have.length(0));
		shot("customize-mode-preview");

		cy.get("[data-testid='customize-save']").click();
		panel().should("not.exist");
		cy.then(() => {
			expect(saveCalls()).to.have.length(1);
			const sent = JSON.parse(String(saveCalls()[0].args.layout));
			expect(sent.shared).to.deep.equal({ view: "list" });
			expect(sent.device).to.deep.equal({ desktop: { density: "compact" } });
			expect(saveCalls()[0].args.base_revision).to.equal(0);
		});

		cy.reload();
		cy.get("#pos-products").contains("Stock").should("be.visible");
	});

	it("Cancel throws the draft away and nothing is written", () => {
		const server = layoutServer();
		boot(server);
		cy.get("#pos-products [data-testid='item-add']").first().should("be.visible");
		openCustomize();
		cy.get("[data-testid='view-list']").click();
		cy.get("[data-testid='customize-cancel']").click();
		panel().should("not.exist");
		cy.get("#pos-products").contains("Stock").should("not.exist");
		cy.then(() => expect(saveCalls()).to.have.length(0));
	});

	it("Reset returns to the profile defaults", () => {
		const server = layoutServer({
			"cashier@example.com": {
				personal: { version: 1, shared: { view: "list" }, device: {} },
				revision: 1,
			},
		});
		boot(server);
		cy.get("#pos-products").contains("Stock").should("be.visible");
		openCustomize();
		cy.get("[data-testid='customize-reset']").click();
		cy.get("[data-testid='customize-reset-confirm']").click();
		cy.get("#pos-products").contains("Stock").should("not.exist");
		cy.then(() => expect(server.rows["cashier@example.com"]).to.equal(undefined));
	});

	it("shows five cart buttons and puts the rest in More, as icons only", () => {
		const server = layoutServer();
		boot(server);
		cy.get("#pos-products [data-testid='item-add']").first().should("be.visible");
		cy.get("[data-testid='cart-actions'] > *").should("have.length", 6); // 5 + More
		cy.get("[data-testid='cart-actions']").should("not.contain.text", "Hold");
		cy.get("[data-testid='hold-order']").should("have.attr", "aria-label", "Hold sale");
		cy.get("[data-testid='cart-more']:visible").click();
		cy.get("[role='menu']").should("be.visible").and("contain", "Clear cart");
		shot("cart-buttons-more-menu");
		cy.get("[role='menu'] [role='menuitem']").contains("Restore draft").click();
		cy.get("[role='menu']").should("not.exist");
	});

	it("customer edit and loyalty are visible in front, not in a menu", () => {
		const server = layoutServer();
		boot(server, { extraRoutes: {} });
		cy.contains("button", /^\s*(Select|Change)\s*$/).should("be.visible");
		cy.selectCustomer("Walk-in Customer");
		cy.get("[data-testid='customer-edit']").should("be.visible");
		cy.get("[data-testid='customer-loyalty']").should("be.visible");
	});

	it("reorders cart buttons from the keyboard and saves the new order", () => {
		const server = layoutServer();
		boot(server);
		cy.get("#pos-products [data-testid='item-add']").first().should("be.visible");
		openCustomize();
		cy.get("[data-testid='cz-actions'] [data-testid='reorder-row']")
			.first()
			.focus()
			.type("{alt}{downArrow}");
		cy.get("[data-testid='cz-actions'] [data-testid='reorder-row']")
			.first()
			.should("have.attr", "data-id", "discount");
		cy.get("[data-testid='customize-save']").click();
		cy.then(() => {
			const sent = JSON.parse(String(saveCalls()[0].args.layout));
			expect(sent.shared.quickActions.footer.slice(0, 2)).to.deep.equal(["discount", "hold"]);
		});
		cy.get("[data-testid='cart-actions'] > *").first().should("have.attr", "aria-label", "Discount");
	});

	it("moves a button into the More menu and another onto the cart", () => {
		const server = layoutServer();
		boot(server);
		cy.get("#pos-products [data-testid='item-add']").first().should("be.visible");
		openCustomize();
		cy.get("[data-testid='cz-actions'] [data-id='coupon'] [data-testid='move-across']").click();
		cy.get("[data-testid='cz-actions'] [data-testid='reorder-row']")
			.last()
			.should("have.attr", "data-id", "coupon");
		cy.get("[data-testid='customize-save']").click();
		cy.get("[data-testid='cart-actions'] [aria-label='Coupon']").should("not.exist");
		cy.get("[data-testid='cart-more']:visible").click();
		cy.get("[role='menu']").contains("Coupon").should("be.visible");
	});

	it("pins items and favorites categories without per-scan layout writes", () => {
		const server = layoutServer({
			"cashier@example.com": {
				personal: {
					version: 1,
					shared: { pinnedItems: ["ITEM-B"], favoriteCategories: ["Supplies", "Beverages"] },
					device: {},
				},
				revision: 1,
			},
		});
		boot(server);
		cy.get("[data-testid='pinned-item']").should("have.length", 1).and("contain", "Filter Papers");
		cy.get("[data-testid='favorite-category']").then(($chips) => {
			expect([...$chips].map((chip) => chip.textContent?.trim())).to.deep.equal([
				"Supplies",
				"Beverages",
			]);
		});
		cy.selectCustomer("Walk-in Customer");
		const before = callsTo(`${API}.get_layout`).length;
		cy.get("[data-testid='pinned-item']").click();
		cy.cartRow("Filter Papers").should("exist");
		cy.addItemToCart("Espresso Beans");
		cy.then(() => {
			expect(saveCalls()).to.have.length(0);
			expect(callsTo(`${API}.get_layout`).length).to.equal(before);
		});
		shot("pinned-and-favorites");
	});

	it("a removed product silently drops out of the pinned strip", () => {
		const server = layoutServer({
			"cashier@example.com": {
				personal: { version: 1, shared: { pinnedItems: ["ITEM-B", "GONE-1"] }, device: {} },
				revision: 1,
			},
		});
		boot(server);
		cy.get("[data-testid='pinned-item']").should("have.length", 1);
	});

	it("a pinned item that is out of stock cannot be added", () => {
		const out = { ...ITEM_B, actual_qty: 0 };
		const server = layoutServer({
			"cashier@example.com": {
				personal: { version: 1, shared: { pinnedItems: ["ITEM-B"] }, device: {} },
				revision: 1,
			},
		});
		server.routes[`${API}.get_pinned_items`] = () => [out];
		boot(server, {
			extraRoutes: {
				"xpos.api.shifts.check_open_shift": {
					...OPEN_SHIFT,
					pos_profile: POS_PROFILE_DOC,
					stock_settings: { allow_negative_stock: false },
				},
			},
		});
		cy.get("[data-testid='pinned-item']").should("be.disabled");
	});

	it("two users on one terminal each get their own layout", () => {
		const server = layoutServer({
			"cashier@example.com": {
				personal: { version: 1, shared: { view: "list" }, device: {} },
				revision: 1,
			},
		});
		boot(server);
		cy.get("#pos-products").contains("Stock").should("be.visible");
		cy.then(() => server.as("other@example.com"));
		stub("frappe.auth.get_logged_user", "other@example.com");
		cy.reload();
		cy.get("#pos-products [data-testid='item-add']").first().should("be.visible");
		cy.get("#pos-products").contains("Stock").should("not.exist");
	});

	it("one user gets a different layout per device class", () => {
		const server = layoutServer({
			"cashier@example.com": {
				personal: {
					version: 1,
					shared: {},
					device: {
						desktop: { cartSide: "left" },
						tablet: { cartSide: "right", density: "touch" },
					},
				},
				revision: 1,
			},
		});
		boot(server);
		cy.get("#pos-products [data-testid='item-add']").first().should("be.visible");
		cy.get("[data-cart-side]").should("have.attr", "data-cart-side", "left");
		shot("desktop-cart-left");
		cy.viewport(820, 1100);
		cy.get("[data-cart-side]").should("have.attr", "data-cart-side", "right");
		cy.get("[data-density]").should("have.attr", "data-density", "touch");
		shot("tablet-touch");
	});

	it("an edit made offline is kept and sent when the connection returns", () => {
		const server = layoutServer();
		boot(server);
		cy.get("#pos-products [data-testid='item-add']").first().should("be.visible");
		cy.goOffline();
		openCustomize();
		cy.get("[data-testid='view-list']").click();
		cy.get("[data-testid='customize-save']").click();
		cy.get("#pos-products").contains("Stock").should("be.visible");
		cy.then(() => expect(server.rows["cashier@example.com"]).to.equal(undefined));
		cy.goOnline();
		cy.then(() => expect(server.rows["cashier@example.com"]?.personal.shared.view).to.equal("list"));
	});

	it("a save that lost the race asks keep mine / use theirs", () => {
		const server = layoutServer();
		boot(server);
		cy.get("#pos-products [data-testid='item-add']").first().should("be.visible");
		openCustomize();
		cy.get("[data-testid='view-list']").click();
		cy.then(() => {
			server.rows["cashier@example.com"] = {
				personal: { version: 1, shared: { favoriteCategories: ["Supplies"] }, device: {} },
				revision: 1,
			};
		});
		cy.get("[data-testid='customize-save']").click();
		cy.get("[data-testid='layout-conflict']").should("be.visible");
		shot("conflict-prompt");
		cy.get("[data-testid='conflict-keep-mine']").click();
		cy.then(() => {
			const row = server.rows["cashier@example.com"];
			expect(row.revision).to.equal(2);
			expect(row.personal.shared.view).to.equal("list");
		});
	});

	it("search keeps the keyboard and scanner after customizing", () => {
		const server = layoutServer();
		boot(server);
		cy.get("#pos-products [data-testid='item-add']").first().should("be.visible");
		openCustomize();
		cy.get("[data-testid='customize-cancel']").click();
		cy.focused().should("have.attr", "data-testid", "barcode-input");
		cy.get("body").type("Esp");
		cy.get("[data-testid='barcode-input']").should("have.value", "Esp");
	});

	it("the cart is protected from an accidental reload", () => {
		const server = layoutServer();
		boot(server);
		cy.selectCustomer("Walk-in Customer");
		cy.addItemToCart("Espresso Beans");
		cy.window().then((win) => {
			const event = new win.Event("beforeunload", { cancelable: true });
			win.dispatchEvent(event);
			expect(event.defaultPrevented).to.equal(true);
		});
	});

	it("captures themes, densities and views", () => {
		const server = layoutServer();
		boot(server, { theme: "dark" });
		cy.get("#pos-products [data-testid='item-add']").first().should("be.visible");
		shot("1440-dark-default");
		openCustomize();
		shot("1440-dark-customize");
		cy.get("[data-testid='view-list']").click();
		cy.get("[data-testid='density-compact']").click();
		shot("1440-dark-list-compact");
		cy.get("[data-testid='view-grid']").click();
		cy.get("[data-testid='density-touch']").click();
		shot("1440-dark-grid-touch");
		cy.get("[data-testid='customize-cancel']").click();
	});

	it("phone layout still shows customize mode and the cart actions", () => {
		const server = layoutServer();
		boot(server, { viewport: [390, 844], skipCustomer: true });
		cy.get("#pos-products [data-testid='item-add']").first().should("be.visible");
		shot("390-default");
	});
});

describe("POS view customizer on phones", () => {
	for (const [width, height] of [
		[320, 640],
		[390, 844],
	] as const) {
		it(`opens, previews, saves and returns to the search at ${width}px`, () => {
			const server = layoutServer();
			boot(server, { viewport: [width, height], skipCustomer: true });
			cy.get("#pos-products [data-testid='item-add']").first().should("be.visible");

			cy.get("[data-testid='customize-open']").should("be.visible").click();
			panel().should("be.visible");
			panel().then(($panel) => {
				const box = $panel[0].getBoundingClientRect();
				expect(box.left, "left edge").to.be.at.least(0);
				expect(box.right, "right edge").to.be.at.most(width);
			});
			cy.get("[data-testid='customize-save']").scrollIntoView().should("be.visible");
			cy.get("[data-testid='customize-cancel']").scrollIntoView().should("be.visible");
			cy.get("[data-testid='view-list']").click();
			cy.get("[data-testid='customize-save']").click();
			panel().should("not.exist");
			cy.focused().should("have.attr", "data-testid", "barcode-input");
			cy.then(() => expect(saveCalls()).to.have.length(1));
		});
	}

	it("cancels and resets from the phone panel", () => {
		const server = layoutServer();
		boot(server, { viewport: [390, 844], skipCustomer: true });
		cy.get("[data-testid='customize-open']").click();
		cy.get("[data-testid='view-list']").click();
		cy.get("[data-testid='customize-cancel']").click();
		panel().should("not.exist");
		cy.then(() => expect(saveCalls()).to.have.length(0));
		cy.get("[data-testid='customize-open']").click();
		cy.get("[data-testid='customize-reset']").scrollIntoView().click();
		cy.get("[data-testid='customize-reset-confirm']").click();
		cy.then(() => expect(callsTo(`${API}.reset_layout`)).to.have.length(1));
	});

	it("is reachable from the cart tab and in RTL dark", () => {
		const server = layoutServer();
		boot(server, { viewport: [390, 844], theme: "dark", skipCustomer: true });
		cy.document().then((doc) => doc.documentElement.setAttribute("dir", "rtl"));
		cy.get("#pos-tab-cart").click();
		cy.get("#pos-tab-items").click();
		cy.get("[data-testid='customize-open']").click();
		panel().should("be.visible");
		panel().then(($panel) => {
			const box = $panel[0].getBoundingClientRect();
			expect(box.left).to.be.at.least(0);
			expect(box.right).to.be.at.most(390);
		});
	});
});
