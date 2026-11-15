import { describe, expect, it } from "vitest";
import {
	acceptReprice,
	giftCardQuote,
	type Quote,
	captureSale,
	drainPending,
	quoteCart,
	QuoteError,
	repriceOf,
	sendSale,
	fiscalPendingMessage,
	fiscalPendingSale,
	settleTenders,
} from "../src/app/checkout";
import { OfflineError, ServerError, SessionExpiredError } from "../src/adapters/frappeHttp";
import { SaleConflictError, type TenderEvidence } from "../src/domain/sale";
import type { ApiTransport } from "../src/ports";
import { HostSqlite } from "./support/hostSqlite";

const ctx = { profile: "Main", customer: "Walk-in", shift: "SHIFT-1", minorDigits: 2 };
const lines = [{ itemCode: "A", name: "Apple", uom: "Nos", priceMinor: 1000, qtyMilli: 2000 }];
const priced = (qtyMilli = 2000) => ({
	rowId: "0",
	itemCode: "A",
	name: "Apple",
	uom: "Nos",
	qtyMilli,
	rate: 10,
	priceListRate: 10,
	sendRate: 10,
	sendDiscountPct: 0,
	sendDiscountAmount: 0,
	amountMinor: (10 * 100 * qtyMilli) / 1000,
	discountPct: 0,
	rules: null,
	itemTaxTemplate: "VAT 5",
	manualDiscountPct: 0,
	rateOverridden: false,
});
const quote: Quote = {
	quoteId: "q1",
	customer: "Walk-in",
	payableMinor: 2100,
	netMinor: 2000,
	taxMinor: 100,
	grandMinor: 2100,
	discountMinor: 0,
	loyaltyMinor: 0,
	priceList: "Std",
	couponCodes: [],
	notices: [],
	extras: { discountAmount: 0, coupons: [], offers: [], loyaltyPoints: 0, freeLines: [] },
	lines: [priced()],
};
const reply = (over: Record<string, unknown> = {}) => ({
	quote_id: "q1",
	customer: "Walk-in",
	unsupported: [],
	refusals: [],
	notices: [],
	lines: [],
	...over,
});
const cash = (amountMinor: number): TenderEvidence => ({ mode: "Cash", type: "Cash", amountMinor });
const card = (amountMinor: number, ok = true): TenderEvidence => ({
	mode: "Card",
	type: "Bank",
	amountMinor,
	reference: "T123",
	terminalConfirmed: ok,
});

type Handler = (args: Record<string, unknown>) => unknown;
function api(
	handlers: Record<string, Handler>,
	log: { method: string; args: Record<string, unknown> }[] = [],
): ApiTransport {
	return {
		kind: "native",
		async call<T>(method: string, args: Record<string, unknown> = {}) {
			const name = method.split(".").pop()!;
			log.push({ method: name, args });
			const h = handlers[name];
			if (!h) throw new Error("unexpected " + name);
			return (await h(args)) as T;
		},
	};
}
const input = (store: HostSqlite, txnId = "mob-1", tenders = [cash(2100)]) =>
	captureSale(store, {
		txnId,
		scopeId: "s",
		ctx,
		customerName: "Walk-in",
		currency: "KWD",
		quote,
		tenders,
	});

describe("tender rules", () => {
	it("needs full cover, only cash may be over, and card needs the cashier's terminal confirmation", () => {
		expect(settleTenders(2100, [cash(2000)])).toMatchObject({ ok: false });
		expect(settleTenders(2100, [cash(2500)])).toEqual({ ok: true, changeMinor: 400 });
		expect(settleTenders(2100, [card(2500)])).toMatchObject({ ok: false });
		expect(settleTenders(2100, [card(2100, false)])).toMatchObject({ ok: false });
		expect(settleTenders(2100, [card(2100)])).toEqual({ ok: true, changeMinor: 0 });
		expect(settleTenders(2100, [card(1100), cash(1500)])).toEqual({ ok: true, changeMinor: 500 });
	});

	it("asks for a reference only where the company requires one, and calls the card check cashier-confirmed", () => {
		const need = { ...card(2100), requiresReference: true };
		expect(settleTenders(2100, [need])).toEqual({ ok: true, changeMinor: 0 });
		expect(settleTenders(2100, [{ ...need, reference: "  " }])).toMatchObject({
			ok: false,
			reason: "Card needs the terminal or transfer reference.",
		});
		expect(settleTenders(2100, [{ ...card(2100), reference: undefined }])).toEqual({
			ok: true,
			changeMinor: 0,
		});
		expect(settleTenders(2100, [card(2100, false)])).toMatchObject({
			ok: false,
			reason: expect.stringContaining("you saw Card approved"),
		});
	});
});

describe("quote", () => {
	it("maps the server quote to exact minor units", async () => {
		const q = await quoteCart(
			api({
				quote_sale: () =>
					reply({
						payable: 21,
						grand_total: 21,
						net_total: 20,
						total_taxes_and_charges: 1,
						lines: [
							{
								row_id: "0",
								item_code: "A",
								uom: "Nos",
								rate: 10,
								amount: 20,
								item_tax_template: "VAT 5",
							},
						],
					}),
			}),
			ctx,
			lines,
		);
		expect(q).toMatchObject({
			payableMinor: 2100,
			taxMinor: 100,
			lines: [{ rate: 10, sendRate: 10, amountMinor: 2000, itemTaxTemplate: "VAT 5" }],
		});
	});
	it("refuses an unavailable price instead of selling for zero", async () => {
		await expect(
			quoteCart(api({ quote_sale: () => reply({ price_unavailable: ["A"] }) }), ctx, lines),
		).rejects.toMatchObject({ code: "price_unavailable" });
	});
	it("reports connection loss and session expiry distinctly", async () => {
		const mk = (e: Error) =>
			api({
				quote_sale: () => {
					throw e;
				},
			});
		await expect(quoteCart(mk(new OfflineError()), ctx, lines)).rejects.toMatchObject({
			code: "offline",
		});
		await expect(quoteCart(mk(new SessionExpiredError()), ctx, lines)).rejects.toBeInstanceOf(QuoteError);
	});
});

describe("capture and send", () => {
	it("writes the sale with tender and receipt evidence before anything is sent", async () => {
		const store = new HostSqlite();
		const s = await input(store);
		expect(s.status).toBe("captured");
		const body = JSON.parse(s.bodyJson);
		expect(body).toMatchObject({
			local_id: "mob-1",
			pos_profile: "Main",
			customer: "Walk-in",
			pos_opening_shift: "SHIFT-1",
		});
		expect(body.items[0]).toMatchObject({ item_code: "A", qty: 2, rate: 10, item_tax_template: "VAT 5" });
		expect(body.payments).toEqual([{ mode_of_payment: "Cash", amount: 21 }]);
		const ev = JSON.parse(s.evidenceJson);
		expect(ev.tenders[0].amountMinor).toBe(2100);
		expect(ev.lines[0].totalMinor).toBe(2000);
		expect(ev.customerName).toBe("Walk-in");
	});

	it("posts, records the invoice, and a repeated send never creates a second invoice request once posted", async () => {
		const store = new HostSqlite();
		await input(store);
		const log: { method: string; args: Record<string, unknown> }[] = [];
		const a = api({ create_invoice: () => ({ name: "SINV-1", grand_total: 21 }) }, log);
		const r = await sendSale(store, a, "mob-1");
		expect(r).toMatchObject({ status: "posted", invoice: "SINV-1", attempts: 1 });
		expect(log[0].args).toMatchObject({ local_id: "mob-1" });
		await sendSale(store, a, "mob-1");
		expect(log).toHaveLength(1);
	});

	it("timeout after the server may have committed -> uncertain; retry with the SAME id gets the existing invoice", async () => {
		const store = new HostSqlite();
		await input(store);
		const seen: unknown[] = [];
		const lost = api({
			create_invoice: (a) => {
				seen.push(a.local_id);
				throw new OfflineError();
			},
		});
		expect(await sendSale(store, lost, "mob-1")).toMatchObject({ status: "uncertain" });
		const ok = api({
			create_invoice: (a) => {
				seen.push(a.local_id);
				return { name: "SINV-9", duplicate: true };
			},
		});
		expect(await sendSale(store, ok, "mob-1")).toMatchObject({
			status: "posted",
			invoice: "SINV-9",
			attempts: 2,
		});
		expect(seen).toEqual(["mob-1", "mob-1"]);
	});

	it("session expiry holds the sale; a validation refusal rejects it and keeps it", async () => {
		const store = new HostSqlite();
		await input(store);
		expect(
			await sendSale(
				store,
				api({
					create_invoice: () => {
						throw new SessionExpiredError();
					},
				}),
				"mob-1",
			),
		).toMatchObject({ status: "held" });
		expect(
			await sendSale(
				store,
				api({
					create_invoice: () => {
						throw new ServerError(417, "Stock too low");
					},
				}),
				"mob-1",
			),
		).toMatchObject({ status: "rejected", message: "Stock too low" });
		expect(await store.getSale("mob-1")).not.toBeNull();
		// a rejected sale is not resent automatically
		const log: unknown[] = [];
		await sendSale(store, api({ create_invoice: () => log.push(1) }), "mob-1");
		expect(log).toHaveLength(0);
	});

	it("5xx is uncertain, fiscal states are surfaced and never shown as posted", async () => {
		const store = new HostSqlite();
		await input(store);
		expect(
			await sendSale(
				store,
				api({
					create_invoice: () => {
						throw new ServerError(502, "Bad gateway");
					},
				}),
				"mob-1",
			),
		).toMatchObject({ status: "uncertain" });
		const r = await sendSale(
			store,
			api({ create_invoice: () => ({ name: "SINV-2", status: "fbr_uncertain" }) }),
			"mob-1",
		);
		expect(r).toMatchObject({ status: "fiscal_pending", invoice: "SINV-2" });
	});

	it("a fiscal-pending sale survives and blocks any second sale or payment until it is finished", async () => {
		const store = new HostSqlite();
		await input(store);
		await sendSale(
			store,
			api({ create_invoice: () => ({ name: "SINV-9", status: "fbr_local_required" }) }),
			"mob-1",
		);
		const kept = await fiscalPendingSale(store, "s");
		expect(kept).toMatchObject({ txnId: "mob-1", invoice: "SINV-9", status: "fiscal_pending" });
		expect(fiscalPendingMessage(kept!)).toContain("SINV-9");
		await expect(input(store, "mob-2")).rejects.toThrow(/not fiscally complete/);
		expect(await store.getSale("mob-2")).toBeNull();
		// another cashier scope is not blocked
		expect(await fiscalPendingSale(store, "other")).toBeNull();
		// once the web POS finishes it and the sale is posted, selling resumes
		await store.updateSale("mob-1", { status: "posted", invoice: "SINV-9", message: "" });
		await expect(input(store, "mob-2")).resolves.toMatchObject({ status: "captured" });
	});

	it("server repricing: new prices wait for the cashier, then the same sale id is re-sent", async () => {
		const store = new HostSqlite();
		await input(store);
		const reprice = {
			status: "reprice_required",
			grand_total: 25,
			rounded_total: 25,
			message: "Prices changed",
			lines: [{ row_id: "0", quoted_rate: 10, rate: 12 }],
		};
		const s = await sendSale(store, api({ create_invoice: () => reprice }), "mob-1");
		expect(s.status).toBe("reprice");
		expect(repriceOf(s, 2)).toMatchObject({ payableMinor: 2500 });
		await expect(acceptReprice(store, s, [cash(2100)], 2)).rejects.toThrow(/cover/);
		const ready = await acceptReprice(store, s, [cash(2500)], 2);
		expect(ready.status).toBe("captured");
		expect(JSON.parse(ready.bodyJson).items[0].rate).toBe(12);
		expect(JSON.parse(ready.bodyJson).payments[0].amount).toBe(25);
		const done = await sendSale(
			store,
			api({
				create_invoice: (a) =>
					(a.data as { items: { rate: number }[] }).items[0].rate === 12
						? { name: "SINV-3" }
						: null,
			}),
			"mob-1",
		);
		expect(done).toMatchObject({ status: "posted", invoice: "SINV-3" });
	});

	it("the same sale id with different contents is refused; the same contents are a no-op", async () => {
		const store = new HostSqlite();
		await input(store);
		expect(
			(
				await store.saveSale({
					txnId: "mob-1",
					scopeId: "s",
					body: JSON.parse((await store.getSale("mob-1"))!.bodyJson),
					currency: "KWD",
					minorDigits: 2,
					payableMinor: 2100,
					evidence: JSON.parse((await store.getSale("mob-1"))!.evidenceJson),
				})
			).created,
		).toBe(false);
		await expect(
			captureSale(store, {
				txnId: "mob-1",
				scopeId: "s",
				ctx,
				customerName: "Walk-in",
				currency: "KWD",
				quote: { ...quote, lines: [priced(3000)] },
				tenders: [cash(2100)],
			}),
		).rejects.toBeInstanceOf(SaleConflictError);
	});

	it("drains only this cashier's waiting sales, oldest first, and stops at the first connectivity problem", async () => {
		let t = 1;
		const store = new HostSqlite({ now: () => t++ });
		await input(store, "mob-1");
		await input(store, "mob-2");
		await captureSale(store, {
			txnId: "other",
			scopeId: "someone-else",
			ctx,
			customerName: "Walk-in",
			currency: "KWD",
			quote,
			tenders: [cash(2100)],
		});
		const order: string[] = [];
		const a = api({
			create_invoice: (x) => {
				order.push(String(x.local_id));
				if (x.local_id === "mob-1") throw new OfflineError();
				return { name: "X" };
			},
		});
		const out = await drainPending(store, a, "s");
		expect(order).toEqual(["mob-1"]);
		expect(out[0].status).toBe("uncertain");
		expect((await store.getSale("mob-2"))!.status).toBe("captured");
		expect((await store.getSale("other"))!.status).toBe("captured");
	});

	it("a crash after capture loses nothing: the row is still there with its evidence", async () => {
		const store = new HostSqlite({
			fault: (s) => {
				if (s === "after-sale") throw new Error("power loss");
			},
		});
		await expect(input(store)).rejects.toThrow();
		expect(await store.getSale("mob-1")).toBeNull(); // not acknowledged, cart not released
	});
});
