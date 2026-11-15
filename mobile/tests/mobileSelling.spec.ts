import { beforeEach, describe, expect, it } from "vitest";
import {
	acceptReprice,
	captureSale,
	giftCardQuote,
	quoteCart,
	sendSale,
	settleTenders,
	type Quote,
} from "../src/app/checkout";
import { checkGiftCard, holdIssuedCards, takeIssuedCards, withoutCodes } from "../src/app/giftCards";
import { asScanned, lookupRemoteBarcode } from "../src/app/scan";
import { createCustomer, customerForSale, searchCustomers } from "../src/app/customers";
import { buildInvoiceBody, type PricedLine, type TenderEvidence } from "../src/domain/sale";
import type { ApiTransport, CatalogItem } from "../src/ports";
import { lineKey, resetPricingChoices, useCart } from "../src/composables/useCart";
import { saleCustomer } from "../src/composables/saleCustomer";
import { useCustomer } from "../src/composables/useCustomer";
import { quoteKey } from "../src/composables/useQuote";
import { HostSqlite } from "./support/hostSqlite";

type Handler = (args: Record<string, unknown>) => unknown;
function api(
	handlers: Record<string, Handler>,
	log: { method: string; args: Record<string, unknown> }[] = [],
): ApiTransport {
	return {
		kind: "native",
		async call<T>(method: string, args: Record<string, unknown> = {}) {
			const name = method.split(".").pop()!;
			log.push({ method: `${method}`, args });
			const h = handlers[name];
			if (!h) throw new Error("unexpected " + name);
			return (await h(args)) as T;
		},
	};
}

const ctx = { profile: "Main", customer: "Wholesale", shift: "SHIFT-1", minorDigits: 2 };
const cartLine = { itemCode: "A", name: "Apple", uom: "Nos", priceMinor: 1000, qtyMilli: 3000 };
const reply = (over: Record<string, unknown> = {}) => ({
	quote_id: "q1",
	customer: "Wholesale",
	unsupported: [],
	refusals: [],
	notices: [],
	lines: [
		{
			row_id: "0",
			item_code: "A",
			uom: "Nos",
			rate: 9,
			price_list_rate: 10,
			send_rate: 9,
			send_discount_percentage: 0,
			amount: 27,
			discount_pct: 10,
			pricing_rules: '["PRLE-1"]',
			item_tax_template: null,
		},
	],
	net_total: 27,
	grand_total: 25.65,
	total_taxes_and_charges: 0,
	discount_amount: 1.35,
	payable: 25.65,
	...over,
});

describe("the server quote is the price", () => {
	it("carries promotions, the customer's discount and what each line must send", async () => {
		const log: { method: string; args: Record<string, unknown> }[] = [];
		const q = await quoteCart(
			api({ quote_sale: () => reply({ coupons_detail: [{ coupon_code: "C1" }] }) }, log),
			ctx,
			[cartLine],
			{
				coupons: ["C1"],
				loyaltyPoints: 0,
				extraDiscountPct: 0,
			},
		);
		expect(log[0].method).toBe("xpos.api.mobile_quote.quote_sale");
		expect(log[0].args).toMatchObject({
			customer: "Wholesale",
			coupons: ["C1"],
			items: [{ item_code: "A", qty: 3, uom: "Nos" }],
		});
		expect(q).toMatchObject({
			quoteId: "q1",
			customer: "Wholesale",
			payableMinor: 2565,
			discountMinor: 135,
			couponCodes: ["C1"],
			lines: [
				{
					rate: 9,
					priceListRate: 10,
					sendRate: 9,
					discountPct: 10,
					rules: '["PRLE-1"]',
					amountMinor: 2700,
				},
			],
		});
		expect(q.extras.discountAmount).toBe(1.35);
	});

	it("sends line overrides and manual discounts only when the cashier set them", async () => {
		const log: { method: string; args: Record<string, unknown> }[] = [];
		await quoteCart(api({ quote_sale: () => reply() }, log), ctx, [
			{ ...cartLine, discountPct: 5, rateOverride: 8 },
		]);
		expect(log[0].args.items).toEqual([
			{ row_id: "0", item_code: "A", qty: 3, uom: "Nos", discount_percentage: 5, rate_override: 8 },
		]);
		const log2: { method: string; args: Record<string, unknown> }[] = [];
		await quoteCart(api({ quote_sale: () => reply() }, log2), ctx, [cartLine]);
		expect(log2[0].args.items).toEqual([{ row_id: "0", item_code: "A", qty: 3, uom: "Nos" }]);
	});

	it("never charges what the server could not price: unsupported lines and refused overrides stop the sale", async () => {
		await expect(
			quoteCart(
				api({
					quote_sale: () =>
						reply({ unsupported: [{ row_id: "0", reason: "Serial items are not supported." }] }),
				}),
				ctx,
				[cartLine],
			),
		).rejects.toMatchObject({ code: "unsupported", message: expect.stringContaining("Serial items") });
		await expect(
			quoteCart(
				api({
					quote_sale: () =>
						reply({
							refusals: [{ row_id: "0", reason: "You are not permitted to discount item A." }],
						}),
				}),
				ctx,
				[cartLine],
			),
		).rejects.toMatchObject({ code: "refused", message: "You are not permitted to discount item A." });
	});
});

describe("the sale body", () => {
	const line: PricedLine = {
		rowId: "0",
		itemCode: "A",
		name: "Apple",
		uom: "Box",
		qtyMilli: 2000,
		rate: 9,
		priceListRate: 10,
		sendRate: 10,
		sendDiscountPct: 10,
		sendDiscountAmount: 0,
		amountMinor: 1800,
		discountPct: 10,
		rules: null,
		itemTaxTemplate: "VAT",
	};
	it("carries the unit, the manual discount, invoice discount, coupons, loyalty, free items and gift card tender", () => {
		const body = buildInvoiceBody(
			ctx,
			"mob-1",
			[line],
			[
				{
					mode: "Gift",
					type: "Gift Card",
					amountMinor: 1000,
					giftCardAuth: "tok",
					maskedCard: "••••-1234",
				},
				{ mode: "Cash", type: "Cash", amountMinor: 500 },
			],
			0,
			{
				discountAmount: 1.5,
				coupons: [{ coupon_code: "C1" }],
				offers: [{ offer_name: "O1" }],
				loyaltyPoints: 40,
				freeLines: [{ item_code: "F", qty: 1, uom: "Nos", pricing_rules: "PR" }],
			},
		) as Record<string, any>;
		expect(body.items[0]).toMatchObject({
			item_code: "A",
			uom: "Box",
			rate: 10,
			discount_percentage: 10,
			item_tax_template: "VAT",
		});
		expect(body.items[1]).toMatchObject({ item_code: "F", is_free_item: 1, pricing_rules: "PR" });
		expect(body).toMatchObject({
			discount_amount: 1.5,
			apply_discount_on: "Grand Total",
			coupons_detail: [{ coupon_code: "C1" }],
			offers_detail: [{ offer_name: "O1" }],
			redeem_loyalty_points: 1,
			loyalty_points: 40,
		});
		expect(body.payments).toEqual([
			{ mode_of_payment: "Gift", amount: 10, gift_card_auth: "tok" },
			{ mode_of_payment: "Cash", amount: 5 },
		]);
	});

	it("is quiet when nothing special applies", () => {
		const body = buildInvoiceBody(
			ctx,
			"mob-1",
			[{ ...line, sendDiscountPct: 0, itemTaxTemplate: null }],
			[],
			0,
		) as Record<string, any>;
		expect(Object.keys(body)).not.toContain("discount_amount");
		expect(Object.keys(body)).not.toContain("coupons_detail");
		expect(Object.keys(body)).not.toContain("redeem_loyalty_points");
		expect(body.items[0].discount_percentage).toBeUndefined();
	});
});

describe("capture refuses a quote made for someone else", () => {
	it("does not save a sale whose prices belong to a different customer", async () => {
		const store = new HostSqlite();
		const q = await quoteCart(
			api({ quote_sale: () => reply({ customer: "Retail" }) }),
			{ ...ctx, customer: "Retail" },
			[cartLine],
		);
		await expect(
			captureSale(store, {
				txnId: "mob-1",
				scopeId: "s",
				ctx,
				customerName: "Wholesale",
				currency: "KWD",
				quote: q,
				tenders: [{ mode: "Cash", type: "Cash", amountMinor: 2565 }],
			}),
		).rejects.toThrow(/different customer/);
		expect(await store.getSale("mob-1")).toBeNull();
	});

	it("a re-price accepted by the cashier drops the line discount so it is never taken twice", async () => {
		const store = new HostSqlite();
		const q = await quoteCart(api({ quote_sale: () => reply() }), ctx, [{ ...cartLine, discountPct: 5 }]);
		q.lines[0].sendRate = 10;
		q.lines[0].sendDiscountPct = 5;
		await captureSale(store, {
			txnId: "mob-1",
			scopeId: "s",
			ctx,
			customerName: "Wholesale",
			currency: "KWD",
			quote: q,
			tenders: [{ mode: "Cash", type: "Cash", amountMinor: 2565 }],
		});
		expect(JSON.parse((await store.getSale("mob-1"))!.bodyJson).items[0].discount_percentage).toBe(5);
		const repriced = await sendSale(
			store,
			api({
				create_invoice: () => ({
					status: "reprice_required",
					grand_total: 24,
					rounded_total: 24,
					lines: [{ row_id: "0", quoted_rate: 9.5, rate: 8 }],
				}),
			}),
			"mob-1",
		);
		const ready = await acceptReprice(
			store,
			repriced,
			[{ mode: "Cash", type: "Cash", amountMinor: 2400 }],
			2,
		);
		const item = JSON.parse(ready.bodyJson).items[0];
		expect(item.rate).toBe(8);
		expect(item.discount_percentage).toBeUndefined();
	});
});

describe("gift cards", () => {
	const gift = (amountMinor: number): TenderEvidence => ({
		mode: "Gift",
		type: "Gift Card",
		amountMinor,
		giftCardAuth: "tok",
		maskedCard: "••••-9",
	});

	it("a card needs no terminal confirmation, may not pay more than is due, and change only comes from cash", () => {
		expect(settleTenders(2000, [gift(2000)])).toEqual({ ok: true, changeMinor: 0 });
		expect(settleTenders(2000, [gift(2500)])).toMatchObject({ ok: false });
		expect(settleTenders(2000, [gift(1500), { mode: "Cash", type: "Cash", amountMinor: 1000 }])).toEqual({
			ok: true,
			changeMinor: 500,
		});
	});

	it("checks the balance live and keeps only the masked card", async () => {
		const log: { method: string; args: Record<string, unknown> }[] = [];
		const c = await checkGiftCard(
			api(
				{
					check_gift_card: () => ({
						masked_code: "••••-1234",
						balance: 12.5,
						mode_of_payment: "Gift",
						auth: "tok",
						valid_upto: null,
					}),
				},
				log,
			),
			"Main",
			" abcd-efgh ",
			2,
		);
		expect(c).toMatchObject({ maskedCode: "••••-1234", balanceMinor: 1250, auth: "tok" });
		expect(log[0].args).toEqual({ code: "abcd-efgh", pos_profile: "Main" });
	});

	it("sells a card as one line of the card's value with no tax or discount", () => {
		const q: Quote = giftCardQuote("Walk-in", "GIFT-ITEM", 5000, 2);
		const body = buildInvoiceBody(
			{ ...ctx, customer: "Walk-in" },
			"mob-1",
			q.lines,
			[{ mode: "Cash", type: "Cash", amountMinor: 5000 }],
			0,
			q.extras,
		) as Record<string, any>;
		expect(body.items).toHaveLength(1);
		expect(body.items[0]).toMatchObject({ item_code: "GIFT-ITEM", qty: 1, rate: 50, gift_card_issue: 1 });
		expect(body.items[0].discount_percentage).toBeUndefined();
		expect(body.discount_amount).toBeUndefined();
		expect(q.payableMinor).toBe(5000);
	});

	it("never writes a card code to the device: the stored reply loses it, and it can be taken only once", async () => {
		const store = new HostSqlite();
		const q = giftCardQuote("Walk-in", "GIFT-ITEM", 5000, 2);
		await captureSale(store, {
			txnId: "mob-g",
			scopeId: "s",
			ctx: { ...ctx, customer: "Walk-in" },
			customerName: "Walk-in",
			currency: "KWD",
			quote: q,
			tenders: [{ mode: "Cash", type: "Cash", amountMinor: 5000 }],
		});
		const secret = "ABCD-EFGH-JKMN-PQRS";
		const posted = await sendSale(
			store,
			api({
				create_invoice: () => ({
					name: "SINV-1",
					issued_gift_cards: [
						{ code: secret, masked_code: "••••-PQRS", amount: 50, valid_upto: null },
					],
				}),
			}),
			"mob-g",
		);
		expect(posted.status).toBe("posted");
		expect(posted.serverJson).not.toContain(secret);
		expect(JSON.stringify(await store.getSale("mob-g"))).not.toContain(secret);
		const cards = takeIssuedCards("mob-g");
		expect(cards).toEqual([{ code: secret, maskedCode: "••••-PQRS", amount: 50, validUpto: null }]);
		expect(takeIssuedCards("mob-g")).toEqual([]);
		expect(withoutCodes({ name: "X", issued_gift_cards: [{ code: "Z" }] })).toEqual({
			name: "X",
			issued_gift_cards_count: 1,
		});
		holdIssuedCards("none", { name: "X" });
		expect(takeIssuedCards("none")).toEqual([]);
	});

	it("a retried send for the same sale id asks the server again with that id, so one card is ever issued", async () => {
		const store = new HostSqlite();
		await captureSale(store, {
			txnId: "mob-g2",
			scopeId: "s",
			ctx: { ...ctx, customer: "Walk-in" },
			customerName: "Walk-in",
			currency: "KWD",
			quote: giftCardQuote("Walk-in", "GIFT-ITEM", 5000, 2),
			tenders: [{ mode: "Cash", type: "Cash", amountMinor: 5000 }],
		});
		const ids: unknown[] = [];
		let n = 0;
		const flaky = api({
			create_invoice: (a) => {
				ids.push(a.local_id);
				if (n++ === 0) throw new (class extends Error {})("lost");
				return { name: "SINV-7", duplicate: true };
			},
		});
		await expect(sendSale(store, flaky, "mob-g2")).rejects.toThrow();
		expect((await store.getSale("mob-g2"))!.status).toBe("posting");
		expect(await sendSale(store, flaky, "mob-g2")).toMatchObject({ status: "posted", invoice: "SINV-7" });
		expect(ids).toEqual(["mob-g2", "mob-g2"]);
	});
});

describe("barcodes in another unit", () => {
	const item: CatalogItem = {
		itemCode: "A",
		variantOf: null,
		name: "Apple",
		itemGroup: "G",
		uom: "Nos",
		priceMinor: 1000,
		priced: true,
		attrs: {},
		barcodes: [],
	};
	it("resolves a box barcode on the server and sells the line in that unit", async () => {
		const log: { method: string; args: Record<string, unknown> }[] = [];
		const found = await lookupRemoteBarcode(
			api(
				{ search_barcode: () => ({ item_code: "A", uom: "Box", rate: 115, conversion_factor: 12 }) },
				log,
			),
			"Main",
			"BOX-1",
			2,
		);
		expect(found).toEqual({ kind: "found", itemCode: "A", uom: "Box", priceMinor: 11500 });
		expect(log[0].args).toEqual({ barcode: "BOX-1", pos_profile: "Main" });
		if (found.kind !== "found") throw new Error("expected a match");
		expect(asScanned(item, found)).toMatchObject({ uom: "Box", priceMinor: 11500 });
		expect(asScanned(item, { ...found, uom: "Nos" })).toBe(item);
	});
	it("says so when the barcode is unknown or a weighed-item code", async () => {
		expect(await lookupRemoteBarcode(api({ search_barcode: () => null }), "Main", "X", 2)).toEqual({
			kind: "none",
		});
		expect(
			await lookupRemoteBarcode(
				api({ search_barcode: () => ({ item_code: "A", is_scale_barcode: 1 }) }),
				"Main",
				"X",
				2,
			),
		).toMatchObject({ kind: "unsupported" });
	});
});

describe("customers come from the server one search at a time", () => {
	it("maps search results, details, and creation", async () => {
		const log: { method: string; args: Record<string, unknown> }[] = [];
		const server = api(
			{
				search_customers_mobile: () => [
					{
						name: "C1",
						customer_name: "Ann",
						mobile_no: "0300",
						customer_group: "Retail",
						discount: 5,
						price_list: "Std",
					},
				],
				get_customer_for_sale: () => ({
					name: "C1",
					customer_name: "Ann",
					customer_group: "Retail",
					discount: 5,
					price_list: "Std",
					balance: 12.5,
					credit_limit: 100,
					loyalty_points: 40,
					loyalty_program: { name: "LP" },
				}),
				create_customer_mobile: () => ({ name: "C1" }),
			},
			log,
		);
		expect(await searchCustomers(server, "Main", " an ")).toEqual([
			{
				name: "C1",
				customerName: "Ann",
				mobileNo: "0300",
				customerGroup: "Retail",
				discountPct: 5,
				priceList: "Std",
			},
		]);
		expect(log[0].args).toEqual({ pos_profile: "Main", term: "an", limit: 20 });
		expect(await customerForSale(server, "Main", "C1", 2)).toMatchObject({
			balanceMinor: 1250,
			creditLimitMinor: 10000,
			loyaltyPoints: 40,
			loyaltyProgram: "LP",
		});
		const made = await createCustomer(
			server,
			"Main",
			{ customerName: "Ann", mobileNo: "0300", emailId: "", customerGroup: "" },
			2,
		);
		expect(made.name).toBe("C1");
		expect(log.find((l) => l.method.endsWith("create_customer_mobile"))!.args).toMatchObject({
			customer_group: null,
		});
	});
});

describe("changing the customer on a populated cart", () => {
	const item: CatalogItem = {
		itemCode: "A",
		variantOf: null,
		name: "Apple",
		itemGroup: "G",
		uom: "Nos",
		priceMinor: 1000,
		priced: true,
		attrs: {},
		barcodes: [],
	};
	const detail = (name: string) => ({
		name,
		customerName: name,
		mobileNo: null,
		customerGroup: "G",
		discountPct: 0,
		priceList: null,
		emailId: null,
		balanceMinor: 0,
		creditLimitMinor: 0,
		loyaltyPoints: 10,
		loyaltyProgram: "LP",
	});
	beforeEach(() => {
		useCart().clear();
		saleCustomer.customer = null;
	});

	it("drops the previous customer's coupons, points, discounts and set prices, and changes the quote key", async () => {
		const { cart, add } = useCart();
		add(item, 2);
		cart.coupons = ["C1"];
		cart.loyaltyPoints = 5;
		cart.extraDiscountPct = 3;
		cart.lines[0].discountPct = 4;
		cart.lines[0].rateOverride = 7;
		const before = quoteKey("A-customer");
		await useCustomer().choose(detail("B"));
		expect(saleCustomer.customer?.name).toBe("B");
		expect(cart.coupons).toEqual([]);
		expect(cart.loyaltyPoints).toBe(0);
		expect(cart.extraDiscountPct).toBe(0);
		expect(cart.lines[0]).not.toHaveProperty("discountPct");
		expect(cart.lines[0]).not.toHaveProperty("rateOverride");
		expect(cart.lines).toHaveLength(1);
		expect(quoteKey("B")).not.toBe(before);
	});

	it("choosing the customer already on the sale changes nothing; going back to the default clears too", async () => {
		const { cart, add } = useCart();
		add(item, 1);
		await useCustomer().choose(detail("B"));
		cart.coupons = ["KEEP"];
		await useCustomer().choose(detail("B"));
		expect(cart.coupons).toEqual(["KEEP"]);
		await useCustomer().useDefault();
		expect(saleCustomer.customer).toBeNull();
		expect(cart.coupons).toEqual([]);
	});

	it("keeps a box and a single of the same item as separate lines", () => {
		const { cart, add } = useCart();
		add(item, 1);
		add({ ...item, uom: "Box" }, 1);
		add(item, 1);
		expect(cart.lines.map((l) => [lineKey(l), l.qtyMilli])).toEqual([
			["A|Nos", 2000],
			["A|Box", 1000],
		]);
		expect(resetPricingChoices()).toBe(false);
	});
});
