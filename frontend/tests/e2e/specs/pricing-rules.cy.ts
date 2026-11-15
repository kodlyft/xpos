/**
 * Regression cover for the reported bug:
 *
 *   "When using the pricing rules, the discount is not reflected until I save
 *    the draft invoice and reload it."
 *
 * These run the real app in a browser against a stubbed Frappe backend, so they
 * exercise the actual cart components, stores and reactivity - which is where
 * the bug lived (the cart never asked for pricing rules at all).
 */
import { parseCartPayload, reconcileWith, ruleSnapshot } from "../fixtures/pricingRules";
import { callsTo, clearDelay, delayMethod, lastCallTo } from "../support/frappeStub";

const RECONCILE = "xpos.api.pricing_rules.reconcile_line_prices";
const SNAPSHOT = "xpos.api.pricing_rules.get_active_pricing_rules";

describe("pricing rules in the cart", () => {
	describe("the reported bug: discount applies without saving", () => {
		it("shows the discount as soon as the item is added", () => {
			cy.bootPos({
				routes: { [RECONCILE]: reconcileWith({ discountPercentage: 10, ruleName: "PR-GROUP" }) },
			});

			cy.addItemToCart("Espresso Beans");

			// Rate stays gross; the rule shows up as a discount on the line.
			cy.cartRow("Espresso Beans").within(() => {
				cy.get("input[type=number]").first().should("have.value", "100");
				cy.contains("-$10").should("be.visible");
				cy.contains("90").should("exist");
			});

			// ...and no draft was saved to get there.
			cy.then(() => {
				expect(callsTo("xpos.api.invoices.save_draft_invoice")).to.have.length(0);
			});
		});

		it("reflects the discount in the cart total", () => {
			cy.bootPos({
				routes: { [RECONCILE]: reconcileWith({ discountPercentage: 10 }) },
			});

			cy.addItemToCart("Espresso Beans");

			cy.contains("Subtotal").parent().should("contain", "90");
			cy.contains("Total").parent().should("contain", "90");
		});

		it("marks a rule discount as automatic so it is not mistaken for a manual one", () => {
			cy.bootPos({ routes: { [RECONCILE]: reconcileWith({ discountPercentage: 10 }) } });

			cy.addItemToCart("Espresso Beans");

			cy.cartRow("Espresso Beans").contains("Auto").should("be.visible");
		});

		it("re-prices once per change, not in a loop", () => {
			// Applying a result mutates the cart, which is also what triggers
			// re-pricing. Without care that feeds back on itself and hammers the
			// server for as long as the cart is open.
			cy.bootPos({
				routes: {
					[RECONCILE]: reconcileWith({
						discountPercentage: 10,
						freeItems: [{ item_code: "ITEM-GIFT", item_name: "Branded Mug" }],
					}),
				},
			});

			cy.addItemToCart("Espresso Beans");
			cy.cartRow("Espresso Beans").contains("Auto").should("be.visible");
			cy.cartRow("Branded Mug").should("exist");

			cy.wait(3000);
			cy.then(() => {
				expect(callsTo(RECONCILE).length, "reconcile calls for one item").to.be.lessThan(3);
			});
		});

		it("sends the gross rate as price_list_rate, with a row id per line", () => {
			cy.bootPos({ routes: { [RECONCILE]: reconcileWith({ discountPercentage: 10 }) } });

			cy.addItemToCart("Espresso Beans");
			cy.cartRow("Espresso Beans").contains("Auto");

			cy.then(() => {
				const call = lastCallTo(RECONCILE);
				expect(call, "reconcile was called").to.exist;
				const { context, lines } = parseCartPayload(call!.args);

				expect(lines).to.have.length(1);
				expect(lines[0].item_code).to.equal("ITEM-A");
				expect(lines[0].price_list_rate).to.equal(100);
				expect(lines[0].row_id).to.be.a("string").and.not.be.empty;
				expect(context.customer).to.equal("CUST-001");
				expect(context.pos_profile).to.equal("Main");
			});
		});
	});

	describe("reacting to cart changes", () => {
		it("applies the discount only once qty clears min_qty", () => {
			cy.bootPos({
				routes: { [RECONCILE]: reconcileWith({ discountPercentage: 10, minQty: 2 }) },
			});

			cy.addItemToCart("Espresso Beans");
			cy.cartRow("Espresso Beans").should("not.contain", "Auto");

			// Second click bumps qty to 2, crossing the threshold.
			cy.addItemToCart("Espresso Beans");
			cy.cartRow("Espresso Beans").contains("Auto").should("be.visible");
			cy.cartRow("Espresso Beans").should("contain", "-$20");
		});

		it("clears the discount again when qty drops back below min_qty", () => {
			cy.bootPos({
				routes: { [RECONCILE]: reconcileWith({ discountPercentage: 10, minQty: 2 }) },
			});

			cy.addItemToCart("Espresso Beans");
			cy.addItemToCart("Espresso Beans");
			cy.cartRow("Espresso Beans").contains("Auto");

			cy.cartRow("Espresso Beans").find("button").first().click(); // decrement
			cy.cartRow("Espresso Beans").should("not.contain", "Auto");
			cy.contains("Total").parent().should("contain", "100");
		});

		it("re-prices when the customer changes", () => {
			// Only the Retail customer's group qualifies.
			cy.bootPos({
				routes: {
					[RECONCILE]: (args: Record<string, unknown>) => {
						const { context } = parseCartPayload(args);
						return reconcileWith(
							context.customer === "CUST-001" ? { discountPercentage: 10 } : {},
						)(args);
					},
				},
			});

			cy.addItemToCart("Espresso Beans");
			cy.cartRow("Espresso Beans").contains("Auto").should("be.visible");

			cy.selectCustomer("Grace Hopper");

			cy.cartRow("Espresso Beans").should("not.contain", "Auto");
			cy.contains("Total").parent().should("contain", "100");
		});

		it("discards a slow reply that a newer one has already superseded", () => {
			let call = 0;
			cy.bootPos({
				routes: {
					[RECONCILE]: (args: Record<string, unknown>) => {
						call += 1;
						// The first (slow) reply claims a 50% discount; every later
						// one says 10%. Whatever order they land in, the cart must
						// end up showing the newest.
						return reconcileWith({ discountPercentage: call === 1 ? 50 : 10 })(args);
					},
				},
			});

			// Hold the first reply back long enough for a second to overtake it.
			cy.then(() => delayMethod(RECONCILE, 3000));
			cy.addItemToCart("Espresso Beans");

			// Let the first request go out, then release the rest.
			cy.wait(600);
			cy.then(() => clearDelay(RECONCILE));
			cy.addItemToCart("Espresso Beans");

			// The fast second reply lands first: 2 x 100 less 10%.
			cy.contains("Total").parent().should("contain", "180");

			// Now let the stale 50% reply arrive - it must be ignored.
			cy.wait(3500);
			cy.contains("Total").parent().should("contain", "180");
			cy.cartRow("Espresso Beans").should("contain", "-$20");
		});
	});

	describe("not stepping on the cashier", () => {
		it("leaves a manually entered discount alone when no rule matches", () => {
			cy.bootPos({ routes: { [RECONCILE]: reconcileWith({}) } });

			cy.addItemToCart("Espresso Beans");
			cy.cartRow("Espresso Beans").find("[data-testid='row-action-item_discount']").click();
			cy.cartRow("Espresso Beans").find("input[aria-label='Discount']").clear().type("25{enter}");

			cy.cartRow("Espresso Beans").should("contain", "-$25");
			cy.cartRow("Espresso Beans").should("not.contain", "Auto");
			// Still there after another reconcile round-trip.
			cy.addItemToCart("Filter Papers");
			cy.cartRow("Espresso Beans").should("contain", "-$25");
		});

		it("does not overwrite a rate the cashier typed in", () => {
			cy.bootPos({ routes: { [RECONCILE]: reconcileWith({ fixedRate: 70 }) } });

			cy.addItemToCart("Espresso Beans");
			cy.cartRow("Espresso Beans").find("input[type=number]").first().should("have.value", "70");

			cy.cartRow("Espresso Beans").find("input[type=number]").first().clear().type("85").blur();

			// A later reconcile must not push the rule's 70 back over it.
			cy.addItemToCart("Filter Papers");
			cy.cartRow("Espresso Beans").find("input[type=number]").first().should("have.value", "85");
		});
	});

	describe("transaction-level rules", () => {
		it("applies an invoice discount from an Apply On = Transaction rule", () => {
			cy.bootPos({
				routes: {
					[RECONCILE]: reconcileWith({
						transaction: { additional_discount_percentage: 15 },
					}),
				},
			});

			cy.addItemToCart("Espresso Beans");

			cy.contains("Additional Discount").should("be.visible");
			cy.contains("Additional Discount")
				.parent()
				.invoke("text")
				.should("match", /15(\.0+)?%/);
			// 100 less 15% = 85.
			cy.contains("Total").parent().should("contain", "85");
		});

		it("clears its own invoice discount when the rule stops matching", () => {
			let hasRule = true;
			cy.bootPos({
				routes: {
					[RECONCILE]: (args: Record<string, unknown>) =>
						reconcileWith(hasRule ? { transaction: { additional_discount_percentage: 15 } } : {})(
							args,
						),
				},
			});

			cy.addItemToCart("Espresso Beans");
			cy.contains("Additional Discount").should("be.visible");

			cy.then(() => {
				hasRule = false;
			});
			cy.addItemToCart("Filter Papers");

			cy.contains("Additional Discount").should("not.exist");
			cy.contains("Total").parent().should("contain", "140");
		});
	});

	describe("free items from a Product rule", () => {
		it("adds the free line to the cart, flagged and read-only", () => {
			cy.bootPos({
				routes: {
					[RECONCILE]: reconcileWith({
						freeItems: [{ item_code: "ITEM-GIFT", item_name: "Branded Mug", qty: 1 }],
						ruleName: "PR-FREE",
					}),
				},
			});

			cy.addItemToCart("Espresso Beans");

			cy.cartRow("Branded Mug").within(() => {
				cy.contains("Free").should("be.visible");
				cy.contains("Qty: 1").should("be.visible");
				// The rule owns qty and rate, so no editable inputs on this row.
				cy.get("input[type=number]").should("not.exist");
			});

			// A free line must not inflate the total.
			cy.contains("Total").parent().should("contain", "100");
		});

		it("removes the free line when the rule stops applying", () => {
			let hasRule = true;
			cy.bootPos({
				routes: {
					[RECONCILE]: (args: Record<string, unknown>) =>
						reconcileWith(
							hasRule
								? { freeItems: [{ item_code: "ITEM-GIFT", item_name: "Branded Mug" }] }
								: {},
						)(args),
				},
			});

			cy.addItemToCart("Espresso Beans");
			cy.cartRow("Branded Mug").should("exist");

			cy.then(() => {
				hasRule = false;
			});
			cy.addItemToCart("Filter Papers");

			cy.get("[data-cart-index]:visible").should("not.contain", "Branded Mug");
		});

		it("never sends the free line back as a priced line", () => {
			cy.bootPos({
				routes: {
					[RECONCILE]: reconcileWith({
						freeItems: [{ item_code: "ITEM-GIFT", item_name: "Branded Mug" }],
					}),
				},
			});

			cy.addItemToCart("Espresso Beans");
			cy.cartRow("Branded Mug").should("exist");
			cy.addItemToCart("Filter Papers");
			cy.cartRow("Filter Papers").should("exist");

			// Re-pricing is debounced, so retry until the request for both items
			// has actually gone out - cy.then() would read the previous one.
			cy.wrap(null).should(() => {
				const { lines } = parseCartPayload(lastCallTo(RECONCILE)!.args);
				expect(lines.map((l) => l.item_code)).to.deep.equal(["ITEM-A", "ITEM-B"]);
			});
		});
	});

	describe("offline", () => {
		it("keeps applying rules from the cached snapshot when the network drops", () => {
			cy.bootPos({
				routes: {
					[SNAPSHOT]: [ruleSnapshot({ discount_percentage: 10, item_codes: ["ITEM-A"] })],
					[RECONCILE]: reconcileWith({ discountPercentage: 10 }),
				},
			});

			// Prime the cache while still online.
			cy.addItemToCart("Espresso Beans");
			cy.cartRow("Espresso Beans").contains("Auto").should("be.visible");

			cy.goOffline();
			cy.addItemToCart("Espresso Beans");

			// Still discounted - now computed in the browser.
			cy.cartRow("Espresso Beans").contains("Auto").should("be.visible");
			cy.cartRow("Espresso Beans").should("contain", "-$20");
			cy.contains("Prices calculated offline").should("be.visible");
			cy.contains("Total").parent().should("contain", "180");
		});

		it("does not claim offline pricing while the connection is up", () => {
			cy.bootPos({
				routes: {
					[SNAPSHOT]: [ruleSnapshot()],
					[RECONCILE]: reconcileWith({ discountPercentage: 10 }),
				},
			});

			cy.addItemToCart("Espresso Beans");
			cy.cartRow("Espresso Beans").contains("Auto");

			cy.contains("Prices calculated offline").should("not.exist");
		});

		it("recovers server pricing when the connection returns", () => {
			cy.bootPos({
				routes: {
					[SNAPSHOT]: [ruleSnapshot({ discount_percentage: 10 })],
					[RECONCILE]: reconcileWith({ discountPercentage: 25 }),
				},
			});

			cy.addItemToCart("Espresso Beans");
			cy.goOffline();
			cy.addItemToCart("Espresso Beans");
			cy.contains("Prices calculated offline").should("be.visible");

			cy.goOnline();
			cy.addItemToCart("Espresso Beans");

			// The server's 25% wins again over the snapshot's 10%.
			cy.contains("Prices calculated offline").should("not.exist");
			cy.cartRow("Espresso Beans").should("contain", "-$75");
		});
	});

	describe("profile with ignore_pricing_rule", () => {
		it("leaves prices alone when the server reports no rules", () => {
			// The endpoint short-circuits server-side for such a profile.
			cy.bootPos({
				routes: {
					[RECONCILE]: { updates: [], free_lines: [], invoice_updates: {} },
				},
			});

			cy.addItemToCart("Espresso Beans");

			cy.cartRow("Espresso Beans").should("not.contain", "Auto");
			cy.contains("Total").parent().should("contain", "100");
		});
	});
});
