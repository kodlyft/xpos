/**
 * @vitest-environment jsdom
 *
 * Exercises the real tender arithmetic in `services/tenderLegs`, using the client's own receipt as
 * the canonical fixture: invoice 5,892,300 LBP settled with $100 at 90,000, change $30 plus
 * 407,700 LBP.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { resetCurrencyCache } from "@/composables/useCurrency";
import {
	buildChangeLeg,
	buildTenderLeg,
	changeBaseTotal,
	changeRemaining,
	groupTenderByCurrency,
	isChangeAllocationValid,
	mergeTenderLeg,
	negateForReturn,
	remainingIn,
	resetLegIds,
	tenderBaseTotal,
	toInvoicePayments,
	type TenderContext,
	type TenderModeInfo,
} from "@/services/tenderLegs";
import type { InvoiceChangeLeg, TenderLeg } from "@/types/pos.types";

const GRAND_TOTAL = 5892300;
const USD_RATE = 90000;

/** Two cash modes deliberately share the "Cash" prefix; only the currency separates them. */
const MODES: Record<string, TenderModeInfo> = {
	"Cash USD": {
		mode_of_payment: "Cash USD",
		pos_tender_currency: "USD",
		exchange_rate: USD_RATE,
		type: "Cash",
	},
	"Cash LBP": { mode_of_payment: "Cash LBP", pos_tender_currency: "LBP", exchange_rate: 1, type: "Cash" },
	Card: { mode_of_payment: "Card", pos_tender_currency: "LBP", exchange_rate: 1, type: "Bank" },
};

const ctx: TenderContext = {
	invoiceCurrency: "LBP",
	modeInfo: (mode) => MODES[mode],
};

beforeEach(() => {
	(window as any).xpos = {
		boot: {
			currencies: [
				{ name: "LBP", symbol: "L£", number_format: "#,###" },
				{ name: "USD", symbol: "$", number_format: "#,###.##" },
			],
		},
	};
	resetCurrencyCache();
	resetLegIds();
});

describe("tender leg construction", () => {
	it("converts a foreign leg into the invoice currency and keeps the native figure", () => {
		const leg = buildTenderLeg("Cash USD", 100, ctx);

		expect(leg.currency).toBe("USD");
		expect(leg.native_amount).toBe(100);
		expect(leg.exchange_rate).toBe(USD_RATE);
		expect(leg.base_amount).toBe(9000000);
	});

	it("leaves an invoice-currency leg at a rate of one", () => {
		const leg = buildTenderLeg("Cash LBP", 500000, ctx);

		expect(leg.currency).toBe("LBP");
		expect(leg.base_amount).toBe(500000);
		expect(leg.exchange_rate).toBe(1);
	});

	it("rounds the native amount at its own currency's precision", () => {
		// USD keeps cents even though the invoice currency has none.
		expect(buildTenderLeg("Cash USD", 34.5349, ctx).native_amount).toBe(34.53);
		// LBP has no cents to keep.
		expect(buildTenderLeg("Cash LBP", 407700.6, ctx).native_amount).toBe(407701);
	});

	it("rounds away float noise in the converted amount", () => {
		// 34.53 * 90000 is 3107700.0000000005 in IEEE754.
		expect(buildTenderLeg("Cash USD", 34.53, ctx).base_amount).toBe(3107700);
	});

	it("falls back to the invoice currency for an unknown mode", () => {
		const leg = buildTenderLeg("Voucher", 100, ctx);

		expect(leg.currency).toBe("LBP");
		expect(leg.base_amount).toBe(100);
	});

	it("gives every leg a distinct id", () => {
		const first = buildTenderLeg("Cash USD", 10, ctx);
		const second = buildTenderLeg("Cash USD", 10, ctx);

		expect(first.id).not.toBe(second.id);
	});
});

describe("leg consolidation", () => {
	it("does not merge two currencies that share a mode name", () => {
		// The regression this whole refactor exists for: keying on mode_of_payment alone collapsed
		// a USD leg into an LBP leg.
		const legs: TenderLeg[] = [];
		mergeTenderLeg(legs, buildTenderLeg("Cash USD", 100, ctx), ctx);
		mergeTenderLeg(legs, buildTenderLeg("Cash LBP", 500000, ctx), ctx);

		expect(legs).toHaveLength(2);
		expect(legs.map((l) => l.currency)).toEqual(["USD", "LBP"]);
	});

	it("merges repeat taps of the same mode at the same rate", () => {
		const legs: TenderLeg[] = [];
		mergeTenderLeg(legs, buildTenderLeg("Cash USD", 60, ctx), ctx);
		mergeTenderLeg(legs, buildTenderLeg("Cash USD", 40, ctx), ctx);

		expect(legs).toHaveLength(1);
		expect(legs[0].native_amount).toBe(100);
		expect(legs[0].base_amount).toBe(9000000);
	});

	it("keeps legs apart when the same mode was taken at different rates", () => {
		const legs: TenderLeg[] = [];
		mergeTenderLeg(legs, buildTenderLeg("Cash USD", 50, ctx), ctx);
		mergeTenderLeg(legs, { ...buildTenderLeg("Cash USD", 50, ctx), exchange_rate: 89000 }, ctx);

		expect(legs).toHaveLength(2);
	});
});

describe("referenced transfers", () => {
	it("keeps each referenced transfer on its own row, and merges a repeat of the same one", () => {
		const legs: TenderLeg[] = [];
		mergeTenderLeg(legs, { ...buildTenderLeg("Cash LBP", 100000, ctx), reference_no: "TRF-1" }, ctx);
		mergeTenderLeg(legs, { ...buildTenderLeg("Cash LBP", 200000, ctx), reference_no: "TRF-2" }, ctx);
		mergeTenderLeg(legs, { ...buildTenderLeg("Cash LBP", 50000, ctx), reference_no: "TRF-1" }, ctx);

		expect(legs.map((leg) => [leg.reference_no, leg.native_amount])).toEqual([
			["TRF-1", 150000],
			["TRF-2", 200000],
		]);
	});

	it("carries the reference onto the payment row only when one was taken", () => {
		const rows = toInvoicePayments(
			[
				{ ...buildTenderLeg("Cash LBP", 100000, ctx), reference_no: "TRF-1" },
				buildTenderLeg("Cash LBP", 5000, ctx),
			],
			"LBP",
		);

		expect(rows[0].reference_no).toBe("TRF-1");
		expect(rows[1]).not.toHaveProperty("reference_no");
	});
});

describe("tender totals", () => {
	it("sums mixed-currency legs in the invoice currency (acceptance criterion 2)", () => {
		// $50 plus 500,000 LBP toward one invoice.
		const legs = [buildTenderLeg("Cash USD", 50, ctx), buildTenderLeg("Cash LBP", 500000, ctx)];

		expect(tenderBaseTotal(legs, "LBP")).toBe(5000000);
	});

	it("tracks the remaining amount correctly as each leg is added", () => {
		const legs: TenderLeg[] = [];
		expect(GRAND_TOTAL - tenderBaseTotal(legs, "LBP")).toBe(5892300);

		mergeTenderLeg(legs, buildTenderLeg("Cash USD", 50, ctx), ctx);
		expect(GRAND_TOTAL - tenderBaseTotal(legs, "LBP")).toBe(1392300);

		mergeTenderLeg(legs, buildTenderLeg("Cash LBP", 500000, ctx), ctx);
		expect(GRAND_TOTAL - tenderBaseTotal(legs, "LBP")).toBe(892300);
	});

	it("groups by currency for the per-currency breakdown", () => {
		const legs = [
			buildTenderLeg("Cash USD", 60, ctx),
			buildTenderLeg("Cash USD", 40, ctx),
			buildTenderLeg("Cash LBP", 407700, ctx),
		];

		const groups = groupTenderByCurrency(legs, "LBP");

		expect(groups).toHaveLength(2);
		expect(groups[0]).toMatchObject({ currency: "USD", native: 100, base: 9000000 });
		expect(groups[1]).toMatchObject({ currency: "LBP", native: 407700, base: 407700 });
	});

	it("reports insufficient tender against the converted total (acceptance criterion 3)", () => {
		const legs = [buildTenderLeg("Cash USD", 60, ctx)];
		const tendered = tenderBaseTotal(legs, "LBP");

		expect(tendered).toBe(5400000);
		expect(GRAND_TOTAL - tendered).toBe(492300);
	});
});

describe("change allocation", () => {
	const CHANGE_DUE = 3107700;

	it("splits the client's change across two currencies exactly", () => {
		const legs: InvoiceChangeLeg[] = [
			buildChangeLeg("Cash USD", 30, ctx),
			buildChangeLeg("Cash LBP", 407700, ctx),
		];

		expect(legs[0].base_amount).toBe(2700000);
		expect(legs[1].base_amount).toBe(407700);
		expect(changeBaseTotal(legs, "LBP")).toBe(CHANGE_DUE);
		expect(isChangeAllocationValid(CHANGE_DUE, legs, "LBP")).toBe(true);
	});

	it("stores change positive even when handed a negative amount", () => {
		expect(buildChangeLeg("Cash USD", -30, ctx).amount).toBe(30);
	});

	it("rejects an under-allocated split", () => {
		const legs = [buildChangeLeg("Cash USD", 30, ctx)];

		expect(changeRemaining(CHANGE_DUE, legs, "LBP")).toBe(407700);
		expect(isChangeAllocationValid(CHANGE_DUE, legs, "LBP")).toBe(false);
	});

	it("rejects an over-allocated split", () => {
		const legs = [buildChangeLeg("Cash USD", 40, ctx)];

		expect(changeRemaining(CHANGE_DUE, legs, "LBP")).toBe(-492300);
		expect(isChangeAllocationValid(CHANGE_DUE, legs, "LBP")).toBe(false);
	});

	it("tolerates one minor unit of rounding", () => {
		const legs = [buildChangeLeg("Cash LBP", CHANGE_DUE - 1, ctx)];

		expect(isChangeAllocationValid(CHANGE_DUE, legs, "LBP")).toBe(true);
	});

	it("treats a single invoice-currency leg as valid, which is the auto-seeded case", () => {
		const legs = [buildChangeLeg("Cash LBP", CHANGE_DUE, ctx)];

		expect(legs).toHaveLength(1);
		expect(legs[0].currency).toBe("LBP");
		expect(isChangeAllocationValid(CHANGE_DUE, legs, "LBP")).toBe(true);
	});

	it("needs no allocation when no change is due", () => {
		expect(isChangeAllocationValid(0, [], "LBP")).toBe(true);
	});

	it("converts the outstanding change into a tender currency so the cashier need not divide", () => {
		// 3,107,700 LBP is $34.53 at 90,000.
		expect(remainingIn(CHANGE_DUE, "USD", "LBP", USD_RATE)).toBe(34.53);
		expect(remainingIn(CHANGE_DUE, "LBP", "LBP", 1)).toBe(CHANGE_DUE);
	});

	it("yields zero rather than infinity when a rate is missing", () => {
		expect(remainingIn(CHANGE_DUE, "USD", "LBP", 0)).toBe(0);
	});
});

describe("invoice payment rows", () => {
	it("tags a foreign row and leaves an invoice-currency row untagged", () => {
		const rows = toInvoicePayments(
			[buildTenderLeg("Cash USD", 100, ctx), buildTenderLeg("Cash LBP", 407700, ctx)],
			"LBP",
		);

		expect(rows[0]).toEqual({
			mode_of_payment: "Cash USD",
			amount: 9000000,
			pos_tender_currency: "USD",
			pos_tender_amount: 100,
			pos_exchange_rate: USD_RATE,
		});
		// Single-currency stores must see exactly the row shape they saw before.
		expect(rows[1]).toEqual({ mode_of_payment: "Cash LBP", amount: 407700 });
	});

	it("drops zero-amount legs", () => {
		expect(toInvoicePayments([buildTenderLeg("Cash USD", 0, ctx)], "LBP")).toEqual([]);
	});

	it("negates both the converted and the native figure for a return", () => {
		const rows = negateForReturn(toInvoicePayments([buildTenderLeg("Cash USD", 100, ctx)], "LBP"));

		expect(rows[0].amount).toBe(-9000000);
		expect(rows[0].pos_tender_amount).toBe(-100);
	});
});

describe("acceptance criterion 1: the client's receipt", () => {
	it("submits with zero variance", () => {
		const tenderLegs = [buildTenderLeg("Cash USD", 100, ctx)];
		const tendered = tenderBaseTotal(tenderLegs, "LBP");
		const changeDue = tendered - GRAND_TOTAL;

		expect(tendered).toBe(9000000);
		expect(changeDue).toBe(3107700);
		// The cashier is offered $34.53 and chooses to hand back $30 plus the LBP residual.
		expect(remainingIn(changeDue, "USD", "LBP", USD_RATE)).toBe(34.53);

		const legs = [buildChangeLeg("Cash USD", 30, ctx), buildChangeLeg("Cash LBP", 407700, ctx)];

		expect(isChangeAllocationValid(changeDue, legs, "LBP")).toBe(true);
		expect(tendered - changeBaseTotal(legs, "LBP")).toBe(GRAND_TOTAL);
	});

	it("leaves the drawer at plus $70 and minus 407,700 LBP", () => {
		const tenderedUsd = 100;
		const legs = [buildChangeLeg("Cash USD", 30, ctx), buildChangeLeg("Cash LBP", 407700, ctx)];

		const netUsd = tenderedUsd - legs[0].amount;
		const netLbp = -legs[1].amount;

		expect(netUsd).toBe(70);
		expect(netUsd * USD_RATE + netLbp).toBe(GRAND_TOTAL);
	});
});
