describe("clear cart confirmation", () => {
	it("disables the button when the cart is empty", () => {
		cy.bootPos();
		cy.get("[data-testid='clear-cart']:visible").should("be.disabled");
	});

	it("keeps the cart when the confirmation is cancelled", () => {
		cy.bootPos();
		cy.addItemToCart("Espresso Beans");
		cy.cartRows().should("have.length", 1);

		cy.get("[data-testid='clear-cart']:visible").click();
		cy.contains("[role='dialog']", "Clear cart?").should("be.visible");

		cy.get("[role='dialog']").contains("button", "Cancel").click();
		cy.get("[role='dialog']").should("not.exist");
		cy.cartRows().should("have.length", 1);
	});

	it("clears the cart once the confirmation is accepted", () => {
		cy.bootPos();
		cy.addItemToCart("Espresso Beans");
		cy.cartRows().should("have.length", 1);

		cy.get("[data-testid='clear-cart']:visible").click();
		cy.get("[role='dialog']").contains("button", "Clear Cart").click();

		cy.get("[role='dialog']").should("not.exist");
		cy.cartRows().should("have.length", 0);
	});
});
