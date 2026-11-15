/**
 * The reports workspace: catalog, filters, the read-only grid, and the export / print paths.
 * Backend calls are stubbed; the specs cover what the UI does with each kind of result.
 */
import { callsTo, delayMethod, clearDelay, stubError } from "../support/frappeStub";
import { CATALOG, EMPTY, FILTERS, LARGE, MIXED, PREPARED, SMALL, TREE } from "../fixtures/reports";

const RESULTS: Record<string, unknown> = {
	"Shift Report": SMALL,
	"Stock Balance": LARGE,
	"Chart of Accounts": TREE,
	"Multi Currency Sales": MIXED,
	"Prepared Sales": PREPARED,
	"Empty Report": EMPTY,
};

function boot(path = "/xpos/reports", extra: Record<string, unknown> = {}, theme?: "dark", dir?: "rtl") {
	cy.viewport(1440, 900);
	cy.bootPos({
		path,
		skipCustomer: true,
		skipReadyWait: true,
		routes: {
			"xpos.api.reports.get_report_catalog": CATALOG,
			"xpos.api.reports.get_report_meta": { filters: FILTERS },
			"xpos.api.reports.run_report": (args: Record<string, unknown>) =>
				RESULTS[String(args.report)] ?? EMPTY,
			"frappe.client.has_permission": { has_permission: true },
			"frappe.client.get_value": { company: "Test Co" },
			...extra,
		},
		currencies: [
			{ name: "USD", symbol: "$", number_format: "#,###.##" },
			{ name: "EUR", symbol: "€", number_format: "#,###.##" },
		],
		beforeLoad: (win) => {
			if (theme) win.localStorage.setItem("xpos-theme", theme);
			// Direction is read when the app mounts, so it has to be in place before load.
			if (dir) win.document.documentElement.setAttribute("dir", dir);
		},
	});
}

const grid = () => cy.get("[role='grid']");

describe("reports catalog", () => {
	it("searches, favorites and remembers recent reports", () => {
		boot();
		cy.contains("button", "Stock Balance").should("be.visible");
		cy.get("input[type='search']").type("ledger");
		cy.contains("No reports match your search").should("be.visible");
		cy.get("input[type='search']").clear().type("stock");
		cy.contains("button", "Shift Report").should("not.exist");
		cy.get("[aria-label='Add Stock Balance to favorites']").click();
		cy.get("section[aria-label='Favorites']").should("contain", "Stock Balance");
		cy.get("input[type='search']").clear();
		cy.contains("button", "Shift Report").click();
		cy.location("pathname").should("eq", "/xpos/reports/shift-report");
		grid().should("be.visible");
		cy.go("back");
		cy.get("section[aria-label='Recent']").should("contain", "Shift Report");
	});
});

describe("report viewer", () => {
	it("renders a small result read-only, hides hidden columns and keeps summary, chart and totals", () => {
		boot("/xpos/reports/shift-report");
		grid().should("be.visible");
		grid().should("not.contain", "SECRET-NOTE");
		grid().should("not.contain", "Internal");
		grid().contains("[role='gridcell']", "1.500 Kg").should("exist");
		grid().contains("[role='gridcell']", "$100.50").should("exist");
		cy.contains("dt", "Net sales").should("be.visible");
		cy.get("figure").should("be.visible");
		grid().contains("[role='gridcell']", "$150.00").should("exist");
		// read-only: no editor affordances anywhere in the grid
		grid().find("input, textarea, [data-testid*='delete'], [data-testid*='add-row']").should("not.exist");
		// markup in data is text, not HTML
		grid().find("img").should("not.exist");
	});

	it("lets every cell react to row hover, so no opaque cell hides the highlight", () => {
		boot("/xpos/reports/shift-report");
		grid().should("be.visible");
		cy.get("[data-r='0']").each(($cell) => expect($cell).to.have.class("group-hover:bg-surface-hover"));
		cy.get("[data-r='0'][data-c='0']")
			.parent()
			.should("have.class", "group")
			.and("not.have.class", "hover:bg-surface-hover");
	});

	it("separates filtered totals from the complete report's totals", () => {
		boot("/xpos/reports/shift-report");
		grid().contains("$150.00");
		cy.get("input[aria-label='Search rows']").type("INV-1");
		cy.contains("1 of 2 rows").should("be.visible");
		grid().contains("Filtered total").should("exist");
		grid().should("not.contain", "$150.00");
	});

	it("opens a linked document only after a permission check", () => {
		boot("/xpos/reports/shift-report");
		cy.window().then((win) => cy.stub(win, "open").as("open"));
		grid().contains("button", "INV-1").click();
		cy.get("@open").should("have.been.calledWithMatch", "/desk/pos-invoice/INV-1");
		cy.then(() => expect(callsTo("frappe.client.has_permission")).to.have.length.greaterThan(0));
	});

	it("denies drill-down when the server says no", () => {
		boot("/xpos/reports/shift-report", { "frappe.client.has_permission": { has_permission: false } });
		cy.window().then((win) => cy.stub(win, "open").as("open"));
		grid().contains("button", "INV-1").click();
		cy.get("@open").should("not.have.been.called");
		cy.contains("You do not have permission to open").should("be.visible");
	});

	it("virtualizes a 10,000 row result and navigates it from the keyboard", () => {
		boot("/xpos/reports/stock-balance");
		cy.contains("10000 rows").should("be.visible");
		grid().find("[role='row']").its("length").should("be.lessThan", 100);
		grid().find("[data-r='0'][data-c='0']").focus().type("{ctrl}{end}");
		grid().contains("[role='gridcell']", "Row 09999").should("exist");
		grid().find("[role='row']").its("length").should("be.lessThan", 100);
	});

	it("shows a grouped result with collapsible groups", () => {
		boot("/xpos/reports/chart-of-accounts");
		grid().contains("Bank").should("exist");
		cy.get("[aria-label='Collapse group']").first().click();
		grid().should("not.contain", "Bank");
		grid().contains("Liabilities").should("exist");
		cy.get("[aria-label='Expand group']").first().click();
		grid().contains("Bank").should("exist");
	});

	it("shows an empty result as empty", () => {
		boot("/xpos/reports/empty-report");
		cy.contains("No rows found").should("be.visible");
	});

	it("shows a failure with a retry, not an empty table", () => {
		boot("/xpos/reports/broken-report", {
			"xpos.api.reports.run_report": {
				__xposStubError: true,
				message: "Boom",
				excType: "ValidationError",
			},
		});
		cy.get("[role='alert']").should("contain", "Boom");
		cy.contains("button", "Try Again").should("be.visible");
		cy.contains("No rows found").should("not.exist");
	});

	it("flags mixed currencies and refuses to add them", () => {
		boot("/xpos/reports/multi-currency-sales");
		cy.contains("This report mixes currencies").should("be.visible");
		grid().contains("[role='gridcell']", "Mixed").should("exist");
		grid().contains("[role='gridcell']", "€20.00").should("exist");
	});

	it("treats a prepared report as pending, never as empty", () => {
		boot("/xpos/reports/prepared-sales");
		cy.get("[data-testid='prepared-state']").should("contain", "being prepared");
		cy.contains("No rows found").should("not.exist");
		cy.get("[data-testid='share-menu']").click();
		cy.get("[data-testid='export-csv']").should("be.disabled");
	});

	it("does not offer company or warehouse: the open shift decides them", () => {
		boot("/xpos/reports/shift-report");
		grid().should("be.visible");
		cy.contains("label", "Company").should("not.exist");
		cy.contains("label", "Warehouse").should("not.exist");
		cy.then(() => {
			const filters = JSON.parse(String(callsTo("xpos.api.reports.run_report")[0].args.filters));
			expect(filters.company).to.eq("Test Co");
			expect(filters.warehouse).to.eq("Stores - TC");
		});
	});

	it("ignores a company or warehouse smuggled in through the URL", () => {
		boot("/xpos/reports/shift-report?company=Other%20Co&warehouse=Elsewhere");
		grid().should("be.visible");
		cy.then(() => {
			const filters = JSON.parse(String(callsTo("xpos.api.reports.run_report")[0].args.filters));
			expect(filters.company).to.eq("Test Co");
			expect(filters.warehouse).to.eq("Stores - TC");
		});
	});

	it("keeps URL-supplied fields only and leaves the other defaults alone", () => {
		boot("/xpos/reports/shift-report?from_date=2026-01-02");
		grid().should("be.visible");
		cy.then(() => {
			const filters = JSON.parse(String(callsTo("xpos.api.reports.run_report")[0].args.filters));
			expect(filters.company).to.eq("Test Co");
			expect(filters.from_date).to.eq("2026-01-02");
		});
	});

	it("blocks a run with an inverted date range", () => {
		boot("/xpos/reports/shift-report?from_date=2026-02-02&to_date=2026-01-01");
		cy.get("[role='alert']").should("contain", "start date");
	});

	it("shows only the report's own filters, inline, with labels as placeholders", () => {
		boot("/xpos/reports/shift-report");
		grid().should("be.visible");
		cy.get("form[role='search'] label").should("not.exist");
		cy.get("form[role='search'] button[type='submit']")
			.should("have.length", 1)
			.and("have.class", "sr-only");
		cy.contains("More filters").should("not.exist");
		cy.get("input[placeholder='From Date']").should("be.visible");
		cy.get("input[placeholder='To Date']").should("be.visible");
	});

	it("marks an empty required filter with a red asterisk, shows no message and does not run", () => {
		boot("/xpos/reports/shift-report", {
			"xpos.api.reports.get_report_meta": {
				filters: [
					{
						fieldname: "brand",
						label: "Brand",
						type: "multi-link",
						doctype: "Brand",
						required: true,
					},
				],
			},
		});
		cy.get("form[role='search'] span.text-destructive").should("have.text", "*");
		cy.contains("Please fill").should("not.exist");
		cy.get("form[role='search'] [role='alert']").should("not.exist");
		cy.get("form[role='search']").contains("Clear").should("not.exist");
		cy.get("form[role='search']").invoke("outerHeight").should("be.lessThan", 60);
		cy.wait(600);
		cy.then(() => expect(callsTo("xpos.api.reports.run_report")).to.have.length(0));
	});

	it("shows the filter's name in a tooltip on hover", () => {
		boot("/xpos/reports/shift-report");
		grid().should("be.visible");
		cy.get("input[placeholder='From Date']").parents("div.relative").first().as("field");
		cy.get("@field").trigger("pointerenter", { pointerType: "mouse" });
		cy.get("@field").trigger("pointermove", { pointerType: "mouse" });
		cy.get("[role='tooltip']").should("contain", "From Date");
	});

	it("reruns on change and blocks export and print while the new results load", () => {
		boot("/xpos/reports/shift-report");
		grid().should("be.visible");
		cy.then(() => delayMethod("xpos.api.reports.run_report", 1500));
		cy.get("input[placeholder='From Date']").type("03/04/2026").blur();
		cy.get("[data-testid='share-menu']").click();
		cy.get("[data-testid='export-csv']").should("be.disabled");
		cy.get("[data-testid='print-report']").should("be.disabled");
		cy.contains("Wait for the report to finish loading").should("be.visible");
		cy.then(() => clearDelay("xpos.api.reports.run_report"));
		cy.then(() => expect(callsTo("xpos.api.reports.run_report").length).to.be.greaterThan(1));
	});
});

describe("date pickers", () => {
	it("opens an Air Datepicker, picks a day and writes it as an ISO date", () => {
		boot("/xpos/reports/shift-report");
		grid().should("be.visible");
		cy.get("input[placeholder='From Date']").click();
		cy.get(".air-datepicker").should("be.visible");
		cy.get(".air-datepicker-cell.-day-:not(.-other-month-)").contains(/^15$/).click();
		cy.get(".air-datepicker").should("not.exist");
		cy.get("input[placeholder='From Date']")
			.invoke("val")
			.should("match", /^15\/\d{2}\/\d{4}$/);
	});

	it("shows English month and day names and opens inside RTL", () => {
		boot("/xpos/reports/shift-report", {}, undefined, "rtl");
		grid().should("be.visible");
		cy.get("input[placeholder='From Date']").click();
		cy.get(".air-datepicker-nav--title")
			.invoke("text")
			.should("match", /^[A-Za-z]+,\s*\d{4}$/);
		cy.get(".air-datepicker-body--day-name").first().should("have.text", "Mo");
		cy.get(".air-datepicker").then(($el) => {
			const box = $el[0].getBoundingClientRect();
			expect(box.left).to.be.at.least(0);
			expect(box.right).to.be.at.most(Cypress.config("viewportWidth"));
		});
	});

	it("accepts a typed date and rejects an impossible one", () => {
		boot("/xpos/reports/shift-report");
		grid().should("be.visible");
		cy.get("input[placeholder='From Date']").type("03/04/2026{enter}");
		cy.get("input[placeholder='From Date']").should("have.value", "03/04/2026");
		cy.get("input[placeholder='From Date']").clear().type("31/02/2026{enter}");
		cy.get("input[placeholder='From Date']").should("have.attr", "aria-invalid", "true");
	});

	for (const theme of [undefined, "dark"] as const) {
		it(`is themed with the Pearl tokens in ${theme ?? "light"}`, () => {
			boot("/xpos/reports/shift-report", {}, theme);
			grid().should("be.visible");
			cy.get("input[placeholder='From Date']").click();
			cy.get(".air-datepicker").should("be.visible");
			cy.get(".air-datepicker").then(($el) => {
				const css = getComputedStyle($el[0]);
				expect(css.getPropertyValue("--adp-accent-color").trim()).to.match(/^hsl\(/);
			});
			cy.wait(300);
			cy.screenshot(`reports/datepicker-${theme ?? "light"}`, { capture: "viewport", overwrite: true });
		});
	}
});

describe("export and print", () => {
	it("exports the authorized response as safe CSV", () => {
		boot("/xpos/reports/shift-report");
		grid().should("be.visible");
		cy.window().then((win) => {
			cy.stub(win.URL, "createObjectURL").callsFake((blob: Blob) => {
				void blob.arrayBuffer().then((buffer) => {
					const bytes = new Uint8Array(buffer);
					(win as unknown as { __bom: boolean }).__bom =
						bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
					(win as unknown as { __csv: string }).__csv = new TextDecoder("utf-8", {
						ignoreBOM: true,
					}).decode(bytes);
				});
				return "blob:test";
			});
		});
		cy.get("[data-testid='share-menu']").click();
		cy.get("[data-testid='export-csv']").click();
		cy.window().its("__csv").should("be.a", "string");
		cy.window().then((win) => {
			const csv = (win as unknown as { __csv: string }).__csv;
			expect((win as unknown as { __bom: boolean }).__bom).to.eq(true);
			expect(csv).to.contain("'=cmd|");
			expect(csv).to.contain("Amount (USD)");
			expect(csv).to.contain("100.5");
			expect(csv).not.to.contain("SECRET-NOTE");
			expect(csv).not.to.contain("$");
		});
		cy.then(() => {
			const purposes = callsTo("xpos.api.reports.run_report").map((c) => c.args.purpose);
			expect(purposes).to.include("export");
		});
	});

	it("prints an escaped, financial-aware document from the print-purpose response", () => {
		boot("/xpos/reports/shift-report");
		grid().should("be.visible");
		cy.window().then((win) => {
			const written: string[] = [];
			const fake = {
				document: { open() {}, write: (html: string) => written.push(html), close() {} },
				focus() {},
				print() {},
				close() {},
				closed: false,
			};
			cy.stub(win, "open").returns(fake);
			(win as unknown as { __printed: string[] }).__printed = written;
		});
		cy.get("[data-testid='share-menu']").click();
		cy.get("[data-testid='print-report']").click();
		cy.window().should((win) => {
			const html = (win as unknown as { __printed: string[] }).__printed.at(-1) ?? "";
			expect(html).to.contain("&lt;img src=x onerror=alert(1)&gt;");
			expect(html).not.to.contain("<img src=x");
			expect(html).to.contain("$100.50");
			expect(html).to.contain("Total");
			expect(html).not.to.contain("SECRET-NOTE");
		});
		cy.then(() => {
			const purposes = callsTo("xpos.api.reports.run_report").map((c) => c.args.purpose);
			expect(purposes).to.include("print");
		});
	});
});

describe("navigation races", () => {
	it("never shows a slow report's rows under the report opened after it", () => {
		boot("/xpos/reports/slow-report", {
			"xpos.api.reports.run_report": (args: Record<string, unknown>) =>
				args.report === "Slow Report" ? SMALL : TREE,
		});
		delayMethod("xpos.api.reports.run_report", 1500);
		cy.visit("/xpos/reports/chart-of-accounts");
		clearDelay("xpos.api.reports.run_report");
		cy.contains("Liabilities").should("exist");
		cy.wait(2000);
		grid().should("not.contain", "INV-1");
	});
});

describe("themes and direction", () => {
	for (const theme of [undefined, "dark"] as const) {
		for (const dir of ["ltr", "rtl"] as const) {
			it(`renders the viewer in ${theme ?? "light"} / ${dir}`, () => {
				boot("/xpos/reports/shift-report", {}, theme, dir === "rtl" ? "rtl" : undefined);
				grid().should("be.visible");
				cy.get(".xpos-splash").should("not.exist");
				cy.wait(400);
				cy.screenshot(`reports/viewer-${theme ?? "light"}-${dir}`, {
					capture: "viewport",
					overwrite: true,
				});
			});
		}
	}

	it("captures the catalog in dark rtl", () => {
		boot("/xpos/reports", {}, "dark", "rtl");
		cy.contains("Shift Report").should("be.visible");
		cy.get(".xpos-splash").should("not.exist");
		cy.wait(400);
		cy.screenshot("reports/catalog-dark-rtl", { capture: "viewport", overwrite: true });
	});
});

void stubError;
