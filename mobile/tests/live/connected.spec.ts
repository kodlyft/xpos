/**
 * Connected run: the app's own sale code talking to a real ERPNext 16 site over HTTP, then reading the invoices back.
 * Skipped unless XPOS_LIVE_URL is set. Needs a site built with `xpos.api.tests.mobile_fixtures.build_live_site`
 * (see the README, "Connected verification"). It creates real invoices on that site, so use a disposable one.
 *
 *   XPOS_LIVE_URL=http://localhost:8001 XPOS_LIVE_SITE=xpos-mt.localhost yarn test tests/live
 */
import { describe, expect, it } from "vitest";
import { FrappeHttpTransport, ServerError } from "../../src/adapters/frappeHttp";
import { FrappeOnlineLogin, LoginError } from "../../src/adapters/onlineLogin";
import {
	captureSale,
	drainPending,
	giftCardQuote,
	quoteCart,
	QuoteError,
	sendSale,
	type Quote,
} from "../../src/app/checkout";
import { checkGiftCard, takeIssuedCards } from "../../src/app/giftCards";
import { createCustomer, searchCustomers } from "../../src/app/customers";
import { asScanned, lookupRemoteBarcode } from "../../src/app/scan";
import type { BootstrapInfo, CatalogItem } from "../../src/ports";
import { newSaleId, type TenderEvidence } from "../../src/domain/sale";
import { HostSqlite } from "../support/hostSqlite";

const URL_ = process.env.XPOS_LIVE_URL;
const SITE = process.env.XPOS_LIVE_SITE ?? "";
const PASSWORD = process.env.XPOS_LIVE_PASSWORD ?? "mp-pass-123";
const CASHIER = "mp-cashier@example.com";
const MANAGER = "mp-manager@example.com";
const RESTRICTED = "mp-restricted@example.com";
const STRANGER = "mp-stranger@example.com";
const PROFILE = "MP Profile";

/** A fetch with a cookie jar, standing in for the Android cookie store. */
function jarFetch(): typeof fetch {
	const jar = new Map<string, string>();
	return async (input, init) => {
		const headers = new Headers(init?.headers);
		headers.set("X-Frappe-Site-Name", SITE);
		if (jar.size) headers.set("Cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
		const res = await fetch(String(input), { ...init, headers, credentials: undefined });
		for (const c of res.headers.getSetCookie()) {
			const [pair] = c.split(";");
			const i = pair.indexOf("=");
			const name = pair.slice(0, i);
			const value = pair.slice(i + 1);
			if (value === "" || /expires=Thu, 01 Jan 1970/i.test(c)) jar.delete(name);
			else jar.set(name, value);
		}
		return res;
	};
}

interface Session {
	t: FrappeHttpTransport;
	info: BootstrapInfo;
	ctx: { profile: string; customer: string; shift: string | null; minorDigits: number };
}

async function signIn(user: string, password = PASSWORD): Promise<Session> {
	const f = jarFetch();
	let t!: FrappeHttpTransport;
	const info = await new FrappeOnlineLogin((origin) => (t = new FrappeHttpTransport(origin, f))).login(
		URL_!,
		user,
		password,
	);
	await t.call("xpos.api.shifts.open_shift", {
		pos_profile: info.profile,
		company: info.company,
		balance_details: JSON.stringify([{ mode_of_payment: "Cash", opening_amount: 0 }]),
	});
	const shift = (
		await t.call<{ pos_opening_shift?: { name: string } } | null>("xpos.api.shifts.check_open_shift", {
			user,
		})
	)?.pos_opening_shift?.name;
	return {
		t,
		info,
		ctx: {
			profile: info.profile,
			customer: info.customer ?? "",
			shift: shift ?? null,
			minorDigits: info.minorDigits,
		},
	};
}

const widget = (qty = 1) => ({
	itemCode: "MP-WIDGET",
	name: "MP-WIDGET",
	uom: "Nos",
	priceMinor: 10000,
	qtyMilli: qty * 1000,
});
const gadget = (qty = 1) => ({
	itemCode: "MP-GADGET",
	name: "MP-GADGET",
	uom: "Nos",
	priceMinor: 20000,
	qtyMilli: qty * 1000,
});
const cash = (amountMinor: number): TenderEvidence => ({ mode: "Cash", type: "Cash", amountMinor });
const major = (minor: number, digits: number) => minor / 10 ** digits;

interface Invoice {
	name: string;
	customer: string;
	grand_total: number;
	rounded_total: number;
	discount_amount: number;
	selling_price_list: string;
	docstatus: number;
	items: {
		item_code: string;
		qty: number;
		uom: string;
		rate: number;
		price_list_rate: number;
		discount_percentage: number;
		amount: number;
	}[];
	payments: { mode_of_payment: string; amount: number }[];
}
async function invoice(s: Session, name: string): Promise<Invoice> {
	return s.t.call<Invoice>("frappe.client.get", { doctype: "Sales Invoice", name });
}

/** Pays a quote in cash, stores it on the "device", sends it, and reads the invoice back. */
async function sell(
	s: Session,
	store: HostSqlite,
	quote: Quote,
	customerName: string,
	tenders?: TenderEvidence[],
) {
	const txnId = newSaleId();
	const scopeId = `real:${s.info.user}|${s.info.profile}`;
	const sale = await captureSale(store, {
		txnId,
		scopeId,
		ctx: { ...s.ctx, customer: quote.customer },
		customerName,
		currency: s.info.currency,
		quote,
		tenders: tenders ?? [cash(quote.payableMinor)],
	});
	const posted = await sendSale(store, s.t, sale.txnId);
	return { sale: posted, evidence: JSON.parse(posted.evidenceJson) };
}

describe.skipIf(!URL_)("the app against a real server", () => {
	it("prices two customers differently, and the invoice and receipt match the quote", async () => {
		const s = await signIn(CASHIER);
		const store = new HostSqlite();
		const found = await searchCustomers(await Promise.resolve(s.t), s.info.profile, "MP");
		const names = found.map((c) => c.name);
		expect(names).toEqual(expect.arrayContaining(["MP Retail Cust", "MP Wholesale Cust", "MP Walk-in"]));
		const wholesale = found.find((c) => c.name === "MP Wholesale Cust")!;
		expect(wholesale).toMatchObject({ priceList: "MP Wholesale", discountPct: 5 });

		const lines = [widget(2), gadget(1)];
		const retail = await quoteCart(s.t, { ...s.ctx, customer: "MP Retail Cust" }, lines);
		const whole = await quoteCart(s.t, { ...s.ctx, customer: "MP Wholesale Cust" }, lines);
		expect(retail.lines.map((l) => l.rate)).toEqual([100, 200]);
		expect(whole.lines.map((l) => l.rate)).toEqual([80, 150]);
		expect(retail.payableMinor).toBe(40000);
		expect(whole.payableMinor).toBe(29400);
		expect(whole.discountMinor).toBe(1550);
		expect(whole.quoteId).not.toBe(retail.quoteId);

		for (const [quote, name] of [
			[retail, "MP Retail Cust"],
			[whole, "MP Wholesale Cust"],
		] as const) {
			const { sale, evidence } = await sell(s, store, quote, name);
			expect(sale.status).toBe("posted");
			const inv = await invoice(s, sale.invoice!);
			expect(inv.customer).toBe(name);
			expect(inv.docstatus).toBe(1);
			expect(inv.selling_price_list).toBe(quote.priceList);
			expect(inv.items.map((i) => i.rate)).toEqual(quote.lines.map((l) => l.rate));
			expect(inv.rounded_total || inv.grand_total).toBe(major(quote.payableMinor, 2));
			expect(inv.payments[0].amount).toBe(major(quote.payableMinor, 2));
			// the receipt the cashier saw is the invoice
			expect(evidence.quotedPayableMinor).toBe(quote.payableMinor);
			expect(evidence.customerName).toBe(name);
			expect(evidence.lines.map((l: { totalMinor: number }) => l.totalMinor)).toEqual(
				inv.items.map((i) => Math.round(i.amount * 100)),
			);
		}
	}, 120_000);

	it("applies quantity rules and promotions, and the saved invoice carries them", async () => {
		const s = await signIn(CASHIER);
		const store = new HostSqlite();
		const tier = await quoteCart(s.t, { ...s.ctx, customer: "MP Retail Cust" }, [widget(10)]);
		expect(tier.lines[0]).toMatchObject({ rate: 90 });
		expect(tier.payableMinor).toBe(90000);
		const few = await quoteCart(s.t, { ...s.ctx, customer: "MP Retail Cust" }, [gadget(2)]);
		expect(few.payableMinor).toBe(40000);
		const promo = await quoteCart(s.t, { ...s.ctx, customer: "MP Retail Cust" }, [gadget(3)]);
		expect(promo.lines[0]).toMatchObject({ priceListRate: 200, rate: 180, discountPct: 10 });
		expect(promo.lines[0].rules).toBeTruthy();
		const { sale } = await sell(s, store, promo, "MP Retail Cust");
		expect(sale.status).toBe("posted");
		const inv = await invoice(s, sale.invoice!);
		expect(inv.items[0]).toMatchObject({ rate: 180, price_list_rate: 200, qty: 3 });
		expect(inv.grand_total).toBe(540);
	}, 120_000);

	it("a customer change on a populated cart re-prices it; nothing of the old customer is kept", async () => {
		const s = await signIn(CASHIER);
		const lines = [widget(2)];
		const a = await quoteCart(s.t, { ...s.ctx, customer: "MP Retail Cust" }, lines, {
			coupons: [],
			loyaltyPoints: 0,
			extraDiscountPct: 0,
		});
		const b = await quoteCart(s.t, { ...s.ctx, customer: "MP Wholesale Cust" }, lines);
		expect([a.customer, b.customer]).toEqual(["MP Retail Cust", "MP Wholesale Cust"]);
		expect([a.payableMinor, b.payableMinor]).toEqual([20000, 15200]);
		const store = new HostSqlite();
		await expect(
			captureSale(store, {
				txnId: newSaleId(),
				scopeId: "x",
				ctx: { ...s.ctx, customer: "MP Wholesale Cust" },
				customerName: "MP Wholesale Cust",
				currency: "INR",
				quote: a,
				tenders: [cash(a.payableMinor)],
			}),
		).rejects.toThrow(/different customer/);
	}, 60_000);

	it("a cashier cannot discount or reprice; a manager can within the limit; a forged discount is refused on the server", async () => {
		const c = await signIn(CASHIER);
		const ctx = { ...c.ctx, customer: "MP Retail Cust" };
		await expect(quoteCart(c.t, ctx, [{ ...widget(), discountPct: 5 }])).rejects.toMatchObject({
			code: "refused",
			message: expect.stringContaining("not permitted to discount"),
		});
		await expect(quoteCart(c.t, ctx, [{ ...widget(), rateOverride: 50 }])).rejects.toMatchObject({
			code: "refused",
			message: expect.stringContaining("not permitted to change the price"),
		});
		const plain = await quoteCart(c.t, ctx, [widget()]);
		const forged = {
			...plain,
			lines: plain.lines.map((l) => ({ ...l, sendDiscountPct: 10 })),
		};
		const store = new HostSqlite();
		const sale = await captureSale(store, {
			txnId: newSaleId(),
			scopeId: "c",
			ctx,
			customerName: "MP Retail Cust",
			currency: "INR",
			quote: { ...forged, payableMinor: 9000 },
			tenders: [cash(9000)],
		});
		const refused = await sendSale(store, c.t, sale.txnId);
		expect(refused.status).toBe("rejected");
		expect(refused.message).toMatch(/not permitted to discount/);

		const m = await signIn(MANAGER);
		const mctx = { ...m.ctx, customer: "MP Retail Cust" };
		const ok = await quoteCart(m.t, mctx, [{ ...widget(), discountPct: 5 }]);
		expect(ok.lines[0]).toMatchObject({ rate: 95, manualDiscountPct: 5 });
		const { sale: posted } = await sell(m, new HostSqlite(), ok, "MP Retail Cust");
		expect(posted.status).toBe("posted");
		const inv = await invoice(m, posted.invoice!);
		expect(inv.items[0]).toMatchObject({ rate: 95, price_list_rate: 100, discount_percentage: 5 });
		await expect(quoteCart(m.t, mctx, [{ ...widget(), discountPct: 15 }])).rejects.toMatchObject({
			code: "refused",
			message: expect.stringContaining("exceeds maximum allowed"),
		});
		const price = await quoteCart(m.t, mctx, [{ ...widget(), rateOverride: 70 }]);
		expect(price.payableMinor).toBe(7000);
	}, 120_000);

	it("sells a box by its barcode at the box price", async () => {
		const s = await signIn(CASHIER);
		const found = await lookupRemoteBarcode(s.t, s.info.profile, "MP-CASE-BOX", s.info.minorDigits);
		expect(found).toMatchObject({ kind: "found", itemCode: "MP-CASE", uom: "Box", priceMinor: 11500 });
		if (found.kind !== "found") return;
		const base: CatalogItem = {
			itemCode: "MP-CASE",
			variantOf: null,
			name: "MP-CASE",
			itemGroup: "x",
			uom: "Nos",
			priceMinor: 1000,
			priced: true,
			attrs: {},
			barcodes: [],
		};
		const item = asScanned(base, found);
		const quote = await quoteCart(s.t, { ...s.ctx, customer: "MP Retail Cust" }, [
			{
				itemCode: item.itemCode,
				name: item.name,
				uom: item.uom,
				priceMinor: item.priceMinor,
				qtyMilli: 2000,
			},
		]);
		expect(quote.lines[0]).toMatchObject({ uom: "Box", rate: 115 });
		expect(quote.payableMinor).toBe(23000);
		const { sale } = await sell(s, new HostSqlite(), quote, "MP Retail Cust");
		const inv = await invoice(s, sale.invoice!);
		expect(inv.items[0]).toMatchObject({ uom: "Box", qty: 2, rate: 115 });
	}, 60_000);

	it("issues a gift card once, spends it, and a repeated send changes nothing", async () => {
		const m = await signIn(MANAGER);
		const store = new HostSqlite();
		const gift = m.info.giftCards!;
		expect(gift).toBeTruthy();
		const quote = giftCardQuote(m.ctx.customer, gift.item, 10000, m.info.minorDigits);
		const { sale } = await sell(m, store, quote, "MP Walk-in");
		expect(sale.status).toBe("posted");
		const [card] = takeIssuedCards(sale.txnId);
		expect(card.amount).toBe(100);
		expect(takeIssuedCards(sale.txnId)).toEqual([]);
		expect(JSON.stringify(await store.getSale(sale.txnId))).not.toContain(card.code);

		// the same sale sent again is the same invoice
		const body = JSON.parse(sale.bodyJson);
		const again = await m.t.call<{ name: string; duplicate?: boolean }>(
			"xpos.api.invoices.create_invoice",
			{ data: body, local_id: sale.txnId },
		);
		expect(again).toMatchObject({ name: sale.invoice, duplicate: true });

		// spend part of it
		const check = await checkGiftCard(m.t, m.info.profile, card.code, 2);
		expect(check.balanceMinor).toBe(10000);
		const purchase = await quoteCart(m.t, { ...m.ctx, customer: "MP Retail Cust" }, [widget()]);
		const pay: TenderEvidence = {
			mode: gift.modeOfPayment,
			type: "Gift Card",
			amountMinor: 10000,
			giftCardAuth: check.auth,
			maskedCard: check.maskedCode,
		};
		const spent = await sell(m, store, purchase, "MP Retail Cust", [pay]);
		expect(spent.sale.status).toBe("posted");
		expect(JSON.parse(spent.sale.serverJson!).gift_cards[0]).toMatchObject({ balance_after: 0 });
		const after = await m.t
			.call<{
				balance: number;
			}>("xpos.api.gift_cards.check_gift_card", { code: card.code, pos_profile: m.info.profile })
			.catch((e) => e);
		expect(after).toBeInstanceOf(ServerError);

		// a cashier without the gift card permission can neither sell nor take a card
		const c = await signIn(CASHIER);
		await expect(checkGiftCard(c.t, c.info.profile, card.code, 2)).rejects.toThrow(/not permitted/);
	}, 120_000);

	it("keeps customers, profiles and sales inside their boundaries", async () => {
		const r = await signIn(RESTRICTED);
		const mine = (await searchCustomers(r.t, r.info.profile, "MP")).map((c) => c.name);
		expect(mine).toEqual(["MP Retail Cust"]);
		await expect(
			quoteCart(r.t, { ...r.ctx, customer: "MP Wholesale Cust" }, [widget()]),
		).rejects.toBeInstanceOf(QuoteError);
		await expect(signIn(STRANGER)).rejects.toBeInstanceOf(LoginError);
		await expect(signIn(CASHIER, "wrong-password")).rejects.toMatchObject({
			code: "invalid_credentials",
		});

		// creating a customer: the same request twice is one customer, another person on that number is refused
		const m = await signIn(MANAGER);
		const mobile = `0399${String(Date.now()).slice(-7)}`;
		const input = { customerName: "Live Created", mobileNo: mobile, emailId: "", customerGroup: "" };
		const made = await createCustomer(m.t, m.info.profile, input, 2);
		const twice = await createCustomer(m.t, m.info.profile, input, 2);
		expect(twice.name).toBe(made.name);
		await expect(
			createCustomer(m.t, m.info.profile, { ...input, customerName: "Someone Else" }, 2),
		).rejects.toThrow(/already exists/);
	}, 120_000);

	it("a sale waiting on the device is sent only by the user it belongs to", async () => {
		const c = await signIn(CASHIER);
		const store = new HostSqlite();
		const quote = await quoteCart(c.t, { ...c.ctx, customer: "MP Retail Cust" }, [widget()]);
		const scope = `real:${CASHIER}|${PROFILE}`;
		await captureSale(store, {
			txnId: newSaleId(),
			scopeId: scope,
			ctx: { ...c.ctx, customer: "MP Retail Cust" },
			customerName: "MP Retail Cust",
			currency: "INR",
			quote,
			tenders: [cash(quote.payableMinor)],
		});
		const m = await signIn(MANAGER);
		expect(await drainPending(store, m.t, `real:${MANAGER}|${PROFILE}`)).toEqual([]);
		const sent = await drainPending(store, c.t, scope);
		expect(sent).toHaveLength(1);
		expect(sent[0].status).toBe("posted");
	}, 120_000);
});
