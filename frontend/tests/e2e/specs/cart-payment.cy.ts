/**
 * Cart, line editing and payment.
 *
 * The screenshot pass captures the cart and payment layouts for review (`CYPRESS_shotSet=before|after`
 * names the set). The behaviour pass pins down what checkout must keep doing: payloads, gating,
 * returns, split tenders, permissions and interrupted submissions.
 */
import { CUSTOMER_IN_GROUP, ITEM_A, ITEM_B, PERMISSIONS } from "../fixtures/pos";
import { BATCH_ITEM, SERIAL_ITEM, UOM_ITEM, cartRoutes } from "../fixtures/cartPayment";
import { callsTo, lastCallTo, stubError, stubNetworkError } from "../support/frappeStub";
import { realPress } from "../support/realKeys";

const SET = String(Cypress.env("shotSet") || "after");
const VIEWPORTS: Array<[number, number]> = [
	[1440, 900],
	[1024, 768],
	[768, 1024],
	[390, 844],
];

const RETURN_INVOICE = "ACC-SINV-2026-00500";

interface BootCartOptions {
	theme?: "dark";
	profile?: Record<string, unknown>;
	shift?: Record<string, unknown>;
	permissions?: Record<string, unknown>;
	routes?: Record<string, unknown>;
}

function bootCart(options: BootCartOptions = {}) {
	cy.viewport(1440, 900);
	cy.bootPos({
		routes: {
			...cartRoutes(options.profile, options.shift),
			...(options.permissions ? { "xpos.api.auth.get_my_pos_permissions": options.permissions } : {}),
			...(options.routes || {}),
		},
		beforeLoad: (win) => {
			if (options.theme) win.localStorage.setItem("xpos-theme", options.theme);
		},
	});
}

function shot(name: string) {
	cy.wait(400);
	cy.screenshot(`cart-payment/${SET}/${name}`, { capture: "viewport", overwrite: true });
}

function openTab(label: RegExp) {
	cy.get("body").then(($body) => {
		const tab = $body.find("[role='tab']:visible").filter((_, el) => label.test(el.textContent || ""));
		if (tab.length) cy.wrap(tab.first()).click();
	});
}

function addFromGrid(name: string) {
	openTab(/Products/);
	cy.contains("[data-item-index]", name).click();
}

function fillRepresentativeCart() {
	addFromGrid(ITEM_A.item_name);
	addFromGrid(ITEM_A.item_name);
	addFromGrid(ITEM_B.item_name);
	addFromGrid(UOM_ITEM.item_name);
	addFromGrid(SERIAL_ITEM.item_name);
	addFromGrid(BATCH_ITEM.item_name);
	openTab(/Current sale/);
}

/** Complete the serial-tracked line through its own "Choose serial" action. */
function chooseSerial(serials: string[]) {
	cy.get("[data-pending='serial'] [data-testid='cart-pending-resolve']:visible").first().click();
	cy.get("[data-testid='resolve-line-note']").should("be.visible");
	for (const serial of serials) cy.contains("[role='dialog'] button", serial).click();
	cy.get("[data-testid='resolve-line-apply']").click();
	cy.get("[role='dialog']").should("not.exist");
}

function pay() {
	openTab(/Current sale/);
	cy.get("[data-testid='pay-button']:visible").click();
	cy.get("[role='dialog']").should("be.visible");
}

function startReturn() {
	cy.window().then((win) => win.dispatchEvent(new CustomEvent("xpos:show-return-dialog")));
	cy.get("[role='dialog'] input").first().type("ACC");
	cy.contains("[role='dialog'] button", RETURN_INVOICE).click();
	cy.contains("[role='dialog'] button", "Process Return").click();
	cy.get("[role='dialog']").should("not.exist");
}

const RETURN_ROUTES = {
	"xpos.api.invoices.search_invoices_for_return": {
		invoices: [
			{
				name: RETURN_INVOICE,
				customer: CUSTOMER_IN_GROUP.name,
				customer_name: CUSTOMER_IN_GROUP.customer_name,
				posting_date: "2026-10-12",
				grand_total: 220,
				status: "Paid",
			},
		],
		has_more: false,
	},
	"xpos.api.invoices.get_invoice_for_return": {
		name: RETURN_INVOICE,
		customer: CUSTOMER_IN_GROUP.name,
		customer_name: CUSTOMER_IN_GROUP.customer_name,
		items: [
			{
				item_code: ITEM_A.item_code,
				item_name: ITEM_A.item_name,
				qty: 2,
				rate: 100,
				amount: 200,
				uom: "Nos",
				remaining_returnable_qty: 2,
				already_returned_qty: 0,
			},
		],
	},
};

describe("cart + payment screenshots", () => {
	it("captures the cart at each viewport", () => {
		bootCart();
		fillRepresentativeCart();
		for (const [w, h] of VIEWPORTS) {
			cy.viewport(w, h);
			openTab(/Current sale/);
			shot(`${w}-cart`);
		}
	});

	it("captures the payment dialog", () => {
		bootCart();
		addFromGrid(ITEM_A.item_name);
		addFromGrid(ITEM_B.item_name);
		for (const [w, h] of VIEWPORTS) {
			cy.viewport(w, h);
			pay();
			shot(`${w}-payment`);
			cy.get("body").type("{esc}");
			cy.get("[role='dialog']").should("not.exist");
		}
	});

	it("captures a split tender", () => {
		bootCart();
		addFromGrid(ITEM_A.item_name);
		addFromGrid(ITEM_B.item_name);
		pay();
		cy.contains("button", "Split Payment").click();
		cy.get("[data-testid='payment-method'][data-mode='Cash']").click();
		cy.get("[role='dialog'] input[inputmode], [role='dialog'] input[type='text']")
			.first()
			.clear()
			.type("100{enter}");
		cy.get("[data-testid='payment-method'][data-mode='Card']").click();
		cy.get("[data-testid='payment-reference'] input").type("AUTH-7781");
		shot("1440-payment-split");
	});

	it("captures return mode", () => {
		bootCart({ profile: { allow_return: 1 }, routes: RETURN_ROUTES });
		startReturn();
		shot("1440-return-cart");
		pay();
		shot("1440-return-payment");
	});

	it("captures dark mode and offline", () => {
		bootCart({ theme: "dark" });
		fillRepresentativeCart();
		shot("1440-dark-cart");
		chooseSerial(["SN-0002"]);
		pay();
		shot("1440-dark-payment");
		cy.get("body").type("{esc}");
		cy.goOffline();
		shot("1440-dark-offline-cart");
	});

	it("captures a profile without price/discount rights", () => {
		bootCart({
			permissions: {
				...PERMISSIONS,
				allow_change_price: false,
				show_edit_discount_field: false,
				apply_additional_discount: false,
			},
		});
		addFromGrid(ITEM_A.item_name);
		addFromGrid(SERIAL_ITEM.item_name);
		shot("1440-restricted-cart");
	});
});

const CREATE = "xpos.api.invoices.create_invoice";

/** Wait for the stubbed server to receive the sale. */
function waitForInvoice(count = 1) {
	cy.wrap(null).should(() => {
		expect(callsTo(CREATE), "create_invoice calls").to.have.length(count);
	});
}

function sentInvoice(): Record<string, any> {
	const call = lastCallTo(CREATE);
	expect(call, "create_invoice was called").to.not.equal(undefined);
	return JSON.parse(String(call!.args.data));
}

function amountInput() {
	return cy.get("[role='dialog'] input[inputmode='decimal']").first();
}

function tender(mode: string, amount: number) {
	cy.get(`[data-testid='payment-method'][data-mode='${mode}']`).click();
	amountInput().clear().type(String(amount));
}

/** Pending invoices the till holds for retry (IndexedDB, as the web till stores them). */
function pendingInvoices(): Cypress.Chainable<Array<Record<string, any>>> {
	return cy.window().then(
		(win) =>
			new Cypress.Promise<Array<Record<string, any>>>((resolve, reject) => {
				const open = win.indexedDB.open("xpos_offline_v3");
				open.onerror = () => reject(open.error);
				open.onsuccess = () => {
					const db = open.result;
					if (!db.objectStoreNames.contains("pendingInvoices")) return resolve([]);
					const req = db.transaction("pendingInvoices").objectStore("pendingInvoices").getAll();
					req.onsuccess = () => resolve(req.result as Array<Record<string, any>>);
					req.onerror = () => reject(req.error);
				};
			}),
	);
}

describe("cart + payment behaviour", () => {
	it("sells with qty, UOM and change, and sends one stable invoice", () => {
		bootCart();
		addFromGrid(ITEM_A.item_name);
		cy.cartRow(ITEM_A.item_name).find("[data-testid='cart-qty-increase']").click();
		addFromGrid(UOM_ITEM.item_name);
		cy.cartRow(UOM_ITEM.item_name).contains("button", "Nos").click();
		cy.cartRow(UOM_ITEM.item_name).find("[data-uom='Sleeve']").click();
		// 2 x 100 + 1 Sleeve (50 x 2.00) = 300, VAT 10% = 330
		cy.get("[data-testid='cart-grand-total']:visible").should("contain", "330.00");
		pay();
		tender("Cash", 400);
		cy.get("[data-testid='payment-remaining']").should("contain", "Change").and("contain", "70.00");
		cy.get("[data-testid='save-payment']").click();
		cy.get("[role='dialog']").should("not.exist");
		cy.then(() => {
			const invoice = sentInvoice();
			expect(invoice.local_id, "stable transaction identity").to.match(/^inv_[0-9a-f]{32}$/);
			expect(invoice.items.map((i: any) => [i.item_code, i.qty, i.uom])).to.deep.equal([
				[ITEM_A.item_code, 2, "Nos"],
				[UOM_ITEM.item_code, 1, "Sleeve"],
			]);
			expect(invoice.items[1].rate).to.equal(100);
			expect(invoice.payments).to.deep.equal([{ mode_of_payment: "Cash", amount: 400 }]);
			expect(invoice.change_amount).to.equal(70);
			expect(callsTo(CREATE)).to.have.length(1);
		});
		pendingInvoices().should("have.length", 0);
		cy.get("[data-cart-index]:visible").should("not.exist");
	});

	it("splits cash and card with a required reference", () => {
		bootCart();
		addFromGrid(ITEM_A.item_name);
		addFromGrid(ITEM_B.item_name);
		pay();
		cy.get("[data-testid='split-payment']").click();
		tender("Cash", 100);
		amountInput().type("{enter}");
		cy.get("[data-testid='payment-method'][data-mode='Card']").click();
		// 154 due, 100 cash: the card leg is pre-filled with the 54 still owed
		amountInput().should("have.value", "54.00");
		cy.get("[data-testid='add-tender-leg']").should("be.disabled");
		cy.get("[data-testid='payment-reference'] input").type("AUTH-7781");
		cy.get("[data-testid='add-tender-leg']").click();
		cy.get("[data-testid='tender-leg']").should("have.length", 2);
		cy.get("[data-testid='payment-remaining']").should("contain", "0.00");
		cy.get("[data-testid='save-payment']").click();
		waitForInvoice();
		cy.then(() => {
			expect(sentInvoice().payments).to.deep.equal([
				{ mode_of_payment: "Cash", amount: 100 },
				{ mode_of_payment: "Card", amount: 54, reference_no: "AUTH-7781" },
			]);
		});
	});

	it("processes a return as a negative refund", () => {
		bootCart({ profile: { allow_return: 1 }, routes: RETURN_ROUTES });
		startReturn();
		cy.get("[data-testid='return-banner']").should("contain", RETURN_INVOICE);
		cy.get("[data-testid='customer-change']").should("not.exist");
		pay();
		cy.contains("[role='dialog']", "Refund Amount").should("contain", "220.00");
		cy.get("[data-testid='save-payment']").click();
		waitForInvoice();
		cy.then(() => {
			const invoice = sentInvoice();
			expect(invoice.is_return).to.equal(true);
			expect(invoice.return_against).to.equal(RETURN_INVOICE);
			expect(invoice.items[0].qty).to.equal(-2);
			expect(invoice.payments[0].amount).to.equal(-220);
		});
	});

	it("blocks payment until the serial is chosen; a missing batch only warns", () => {
		bootCart();
		addFromGrid(SERIAL_ITEM.item_name);
		addFromGrid(SERIAL_ITEM.item_name);
		addFromGrid(BATCH_ITEM.item_name);
		cy.get("[data-testid='checkout-requirements']").should("have.attr", "role", "alert");
		cy.get("[data-testid='pay-button']:visible")
			.should("be.disabled")
			.and("contain", "Choose serial for 1 line");
		focusBody();
		realPress("F4");
		cy.get("[role='dialog']").should("not.exist");
		cy.contains("choose a serial number").should("be.visible");

		// two units on one line need two serials, and become two lines
		chooseSerial(["SN-0001", "SN-0003"]);
		cy.get("[data-testid='cart-serial']:visible").should("have.length", 2);
		cy.get("[data-pending='serial']").should("not.exist");
		cy.get("[data-pending='batch']").should("have.length", 1);
		cy.get("[data-testid='pay-button']:visible").should("not.be.disabled");

		cy.get("[data-pending='batch'] [data-testid='cart-pending-resolve']").click();
		cy.contains("[role='dialog'] button", "CB-2026-10").click();
		cy.get("[data-testid='resolve-line-apply']").click();
		cy.get("[data-testid='cart-batch']:visible").should("contain", "CB-2026-10");
		cy.get("[data-testid='checkout-requirements']").should("not.exist");

		pay();
		cy.get("[data-testid='save-payment']").click();
		waitForInvoice();
		cy.then(() => {
			const items = sentInvoice().items;
			expect(items.map((i: any) => [i.serial_no || "", i.batch_no || "", i.qty])).to.deep.equal([
				["SN-0001", "", 1],
				["SN-0003", "", 1],
				["", "CB-2026-10", 1],
			]);
			expect(items[0].rate).to.equal(250);
			expect(items[1].rate).to.equal(250);
		});
	});

	it("hides price and discount controls without the rights", () => {
		bootCart({
			permissions: {
				...PERMISSIONS,
				allow_change_price: false,
				show_edit_discount_field: false,
				apply_additional_discount: false,
			},
		});
		addFromGrid(ITEM_A.item_name);
		cy.cartRow(ITEM_A.item_name).find("input[aria-label='Rate']").should("not.exist");
		cy.cartRow(ITEM_A.item_name).find("[data-testid='row-action-item_discount']").should("not.exist");
		cy.get("[data-testid='cart-discount']").should("not.exist");
	});

	it("keeps the sale when the server refuses it", () => {
		bootCart();
		cy.then(() => stubError(CREATE, "You are not permitted to submit Sales Invoice", "PermissionError"));
		addFromGrid(ITEM_A.item_name);
		pay();
		cy.get("[data-testid='save-payment']").click();
		cy.get("[data-testid='payment-status']")
			.should("have.attr", "data-state", "failed")
			.and("contain", "not permitted");
		cy.get("[role='dialog']").should("be.visible");
		// a structured rejection proves rollback, so nothing is left queued to retry
		pendingInvoices().should("have.length", 0);
		cy.get("body").type("{esc}");
		cy.cartRow(ITEM_A.item_name).should("exist");
	});

	it("keeps the sale and its identity when the connection drops mid-submit and offline checkout is not set up", () => {
		bootCart();
		cy.then(() => stubNetworkError(CREATE));
		addFromGrid(ITEM_A.item_name);
		pay();
		cy.get("[data-testid='save-payment']").click();
		cy.get("[data-testid='payment-status']")
			.should("have.attr", "data-state", "failed")
			.and("contain", "held in Pending Invoices");
		cy.get("[role='dialog']").should("be.visible");
		cy.contains(/saved successfully/).should("not.exist");
		pendingInvoices().then((rows) => {
			expect(rows, "one queued sale, not a duplicate").to.have.length(1);
			expect(rows[0].hold, "not sent again unseen").to.equal("offline_blocked");
			const ids = new Set(callsTo(CREATE).map((c) => JSON.parse(String(c.args.data)).local_id));
			expect([...ids]).to.deep.equal([rows[0].data.local_id]);
		});
	});

	it("echoes typed digits on the numpad", () => {
		bootCart();
		addFromGrid(ITEM_A.item_name);
		pay();
		amountInput().focus();
		realPress("6");
		cy.get("[data-testid='numpad-key'][data-key='6']").should("have.attr", "data-pressed", "true");
		cy.get("[data-testid='numpad-key'][data-key='6']").should("not.have.attr", "data-pressed");
	});

	it("shows tooltips on hover only, not on keyboard focus", () => {
		bootCart();
		addFromGrid(ITEM_A.item_name);
		cy.get("[data-testid='hold-order']:visible").focus();
		cy.wait(500);
		cy.get("[role='tooltip']").should("not.exist");
		cy.get("[data-testid='hold-order']:visible").trigger("pointerenter", { pointerType: "mouse" });
		cy.get("[data-testid='hold-order']:visible").trigger("pointermove", { pointerType: "mouse" });
		cy.get("[role='tooltip']", { timeout: 3000 }).should("contain", "Hold sale");
	});
});

function focusBody() {
	cy.document().then((doc) => {
		(doc.activeElement as HTMLElement | null)?.blur?.();
	});
}

const PIXEL =
	"data:image/svg+xml;utf8," +
	encodeURIComponent(
		"<svg xmlns='http://www.w3.org/2000/svg' width='8' height='8'><rect width='8' height='8' fill='#2b6'/></svg>",
	);

describe("shell details", () => {
	it("shows the cashier's initials without a photo, and after a broken one", () => {
		cy.viewport(1440, 900);
		cy.bootPos({ routes: cartRoutes(), skipCustomer: true, userImage: "/files/missing-avatar.png" });
		cy.get("[data-testid='user-avatar']").should("contain", "TC").find("img:visible").should("not.exist");
		cy.screenshot(`cart-payment/${SET}/1440-avatar-broken-image`, {
			capture: "viewport",
			overwrite: true,
		});
	});

	it("shows the cashier's photo when there is one", () => {
		cy.viewport(1440, 900);
		cy.bootPos({ routes: cartRoutes(), skipCustomer: true, userImage: PIXEL });
		cy.get("[data-testid='user-avatar'] img").should("be.visible");
	});

	it("keeps the list header inside the rounded table", () => {
		bootCart();
		cy.window().then((win) => win.dispatchEvent(new CustomEvent("xpos:toggle-view")));
		cy.get("[role='list'][aria-label='Products']").should("be.visible");
		shot("1440-list-header");
		bootCart({ theme: "dark" });
		cy.window().then((win) => win.dispatchEvent(new CustomEvent("xpos:toggle-view")));
		shot("1440-dark-list-header");
	});
});
