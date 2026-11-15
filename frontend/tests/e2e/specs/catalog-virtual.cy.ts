/**
 * A long catalogue is windowed: only the rows near the viewport are in the DOM, yet keyboard
 * navigation, highlight, paging and the keyboard add flow behave as with the full list.
 */
import { ITEM_A, ITEM_GROUPS } from "../fixtures/pos";

const TOTAL = 3000;
const ALL = Array.from({ length: TOTAL }, (_, i) => ({
	...ITEM_A,
	item_code: `V-${String(i).padStart(5, "0")}`,
	item_name: `Widget ${String(i).padStart(5, "0")}`,
	rate: 10,
}));

function page(args: Record<string, unknown>) {
	const term = String(args.search_term || "").toLowerCase();
	const rows = term ? ALL.filter((i) => i.item_name.toLowerCase().includes(term)) : ALL;
	const start = Number(args.start || 0);
	return rows.slice(start, start + Number(args.page_length || 40));
}

const cards = () => cy.get("#pos-products [data-item-index]:visible");

function boot(viewMode: "Grid" | "List" = "Grid") {
	cy.viewport(1440, 900);
	cy.bootPos({
		routes: {
			"xpos.api.items.get_pos_items": page,
			"xpos.api.items.get_items_count": TOTAL,
			"xpos.api.items.get_item_groups": { groups: ITEM_GROUPS, parent_groups: [] },
			"xpos.api.items.get_stock_availability": ALL.map((i) => ({
				item_code: i.item_code,
				actual_qty: 5,
			})),
		},
		readyItem: "Widget 00000",
		skipCustomer: false,
	});
	if (viewMode === "List")
		cy.window().then((win) => win.dispatchEvent(new CustomEvent("xpos:toggle-view")));
}

describe("catalogue virtualization", () => {
	it("keeps the DOM small while scrolling through hundreds of loaded items", () => {
		boot();
		for (let i = 0; i < 6; i++) {
			cy.get("#pos-products .xpos-scrollbar").scrollTo("bottom", { duration: 0 });
			cy.wait(150);
		}
		cards().its("length").should("be.lessThan", 120);
		cy.get("#pos-products .xpos-scrollbar").then(($s) => {
			expect($s[0].scrollHeight).to.be.greaterThan(2000);
		});
		cy.get("#pos-products [data-item-index='0']").should("not.exist");
	});

	it("scrolls the highlighted tile into view as the arrow keys move past the first screen", () => {
		boot();
		cy.get("[data-testid='barcode-input']").focus();
		for (let i = 0; i < 24; i++) cy.get("[data-testid='barcode-input']").type("{downarrow}");
		cy.get("#pos-products [data-item-index='23']")
			.should("have.class", "ring-2")
			.then(($tile) => {
				const scroller = Cypress.$("#pos-products .xpos-scrollbar")[0].getBoundingClientRect();
				const rect = $tile[0].getBoundingClientRect();
				expect(rect.bottom).to.be.at.most(scroller.bottom + 1);
				expect(rect.top).to.be.at.least(scroller.top - 1);
			});
	});

	it("opens the highlighted item with Enter and returns focus to search", () => {
		boot("List");
		cy.get("[data-testid='barcode-input']").focus();
		for (let i = 0; i < 15; i++) cy.get("[data-testid='barcode-input']").type("{downarrow}");
		cy.get("[data-testid='barcode-input']").type("{enter}");
		cy.get("[role='dialog']").should("be.visible").and("contain", "Widget 00014");
		cy.get("body").type("{esc}");
		cy.get("[role='dialog']").should("not.exist");
		cy.get("[data-testid='barcode-input']").should("have.focus");
	});

	it("tells assistive technology the size of the list and each tile's place in it", () => {
		boot("List");
		cy.get("#pos-products [data-item-index='3']")
			.should("have.attr", "aria-posinset", "4")
			.and("have.attr", "aria-setsize");
	});

	it("a new search replaces the window and starts from the top", () => {
		boot();
		cy.get("#pos-products .xpos-scrollbar").scrollTo("bottom", { duration: 0 });
		cy.get("[data-testid='barcode-input']").type("Widget 0123");
		cy.get("#pos-products [data-item-index='0']").should("contain", "Widget 01230");
		cy.get("#pos-products .xpos-scrollbar").then(($s) => expect($s[0].scrollTop).to.equal(0));
	});
});
