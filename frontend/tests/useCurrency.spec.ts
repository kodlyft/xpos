import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	convertToBase,
	currencyMeta,
	DEFAULT_CURRENCY_PRECISION,
	displayPrecisionFor,
	formatFor,
	formatWithSymbol,
	minorUnitFor,
	numberFormatFor,
	precisionFor,
	precisionFromNumberFormat,
	resetCurrencyCache,
	roundFor,
	symbolFor,
} from "@/composables/useCurrency";
import { resetNumberFormatSettings, setNumberFormatSettings } from "@/utils/numberFormat";

vi.mock("@/services/dbBridge", () => ({
	getCachedCurrencyMeta: vi.fn().mockResolvedValue([]),
}));

/** LBP is quoted in whole units, USD in cents. Every assertion here rests on that asymmetry. */
function seedBoot() {
	(window as any).xpos = {
		boot: {
			currencies: [
				{ name: "LBP", symbol: "L£", number_format: "#,###" },
				{ name: "USD", symbol: "$", number_format: "#,###.##" },
				{ name: "KWD", symbol: "KD", number_format: "#,###.###" },
				{ name: "SEK", symbol: "kr", number_format: "# ###,##", symbol_on_right: 1 },
			],
		},
	};
	resetCurrencyCache();
}

beforeEach(() => {
	seedBoot();
	resetNumberFormatSettings();
});

describe("precisionFromNumberFormat", () => {
	// Every entry in frappe's NUMBER_FORMAT_MAP, so the parser cannot drift from the source.
	const cases: Array<[string, number]> = [
		["#,###.##", 2],
		["#.###,##", 2],
		["# ###.##", 2],
		["# ###,##", 2],
		["#'###.##", 2],
		["#, ###.##", 2],
		["#,##,###.##", 2],
		["#,###.###", 3],
		["#.###", 0],
		["#,###", 0],
		["#.########", 8],
	];

	it.each(cases)("reads %s as %i decimals", (format, expected) => {
		expect(precisionFromNumberFormat(format)).toBe(expected);
	});

	it("tells the zero-decimal #,### from the three-decimal #,###.###", () => {
		// The trap: both end in a group of three digits. Only the separator count separates them.
		expect(precisionFromNumberFormat("#,###")).toBe(0);
		expect(precisionFromNumberFormat("#,###.###")).toBe(3);
	});

	it("falls back to two decimals for a missing or unrecognised format", () => {
		expect(precisionFromNumberFormat(undefined)).toBe(DEFAULT_CURRENCY_PRECISION);
		expect(precisionFromNumberFormat("")).toBe(DEFAULT_CURRENCY_PRECISION);
		expect(precisionFromNumberFormat(null)).toBe(DEFAULT_CURRENCY_PRECISION);
	});

	it("treats a format with no separator as zero decimals", () => {
		expect(precisionFromNumberFormat("###")).toBe(0);
	});
});

describe("currency metadata", () => {
	it("derives precision per currency from the boot payload", () => {
		expect(precisionFor("LBP")).toBe(0);
		expect(precisionFor("USD")).toBe(2);
		expect(precisionFor("KWD")).toBe(3);
	});

	it("falls back to two decimals for an unknown currency", () => {
		expect(precisionFor("XYZ")).toBe(DEFAULT_CURRENCY_PRECISION);
		expect(symbolFor("XYZ")).toBe("XYZ");
	});

	it("uses the currency code as the symbol when none is configured", () => {
		(window as any).xpos = { boot: { currencies: [{ name: "LBP" }] } };
		resetCurrencyCache();

		expect(symbolFor("LBP")).toBe("LBP");
	});

	it("survives a missing boot payload", () => {
		(window as any).xpos = undefined;
		resetCurrencyCache();

		expect(currencyMeta("USD").precision).toBe(DEFAULT_CURRENCY_PRECISION);
	});
});

describe("minorUnitFor", () => {
	it("is one whole unit for a zero-decimal currency", () => {
		expect(minorUnitFor("LBP")).toBe(1);
	});

	it("is one cent for a two-decimal currency", () => {
		expect(minorUnitFor("USD")).toBeCloseTo(0.01, 10);
	});
});

describe("roundFor", () => {
	it("rounds an LBP amount to whole units", () => {
		expect(roundFor("LBP", 3107700.0000000005)).toBe(3107700);
		expect(roundFor("LBP", 5892300.4)).toBe(5892300);
		expect(roundFor("LBP", 5892300.6)).toBe(5892301);
	});

	it("keeps cents on a USD amount", () => {
		expect(roundFor("USD", 34.5349)).toBe(34.53);
	});

	it("rounds a half-way cent up despite binary representation error", () => {
		// 34.535 * 100 is 3453.4999999999995, so a naive Math.round gives 34.53.
		expect(roundFor("USD", 34.535)).toBe(34.54);
		expect(roundFor("USD", 1.005)).toBe(1.01);
	});

	it("rounds negatives away from zero, symmetrically", () => {
		expect(roundFor("USD", -34.535)).toBe(-34.54);
		expect(roundFor("LBP", -5892300.6)).toBe(-5892301);
	});

	it("returns zero for a non-finite value", () => {
		expect(roundFor("USD", Number.NaN)).toBe(0);
		expect(roundFor("USD", Number.POSITIVE_INFINITY)).toBe(0);
	});
});

describe("convertToBase", () => {
	const RATE = 90000;

	it("converts the client's tender to the invoice currency", () => {
		expect(convertToBase("USD", "LBP", 100, RATE)).toBe(9000000);
		expect(convertToBase("USD", "LBP", 30, RATE)).toBe(2700000);
	});

	it("rounds away the float noise from a fractional amount", () => {
		// 34.53 * 90000 is 3107700.0000000005 in IEEE754.
		expect(convertToBase("USD", "LBP", 34.53, RATE)).toBe(3107700);
	});

	it("passes a same-currency amount through at the base precision", () => {
		expect(convertToBase("LBP", "LBP", 407700.4, RATE)).toBe(407700);
	});

	it("preserves a negative sign for return legs", () => {
		expect(convertToBase("USD", "LBP", -100, RATE)).toBe(-9000000);
	});

	it("yields zero when no rate is available", () => {
		expect(convertToBase("USD", "LBP", 100, 0)).toBe(0);
	});

	it("reconciles the client's receipt exactly", () => {
		// Invoice 5,892,300 LBP settled with $100; change $30 plus 407,700 LBP.
		const tendered = convertToBase("USD", "LBP", 100, RATE);
		const changeUsd = convertToBase("USD", "LBP", 30, RATE);
		const changeLbp = convertToBase("LBP", "LBP", 407700, RATE);

		expect(tendered - (changeUsd + changeLbp)).toBe(5892300);
	});
});

describe("formatting", () => {
	it("shows no decimals for LBP and two for USD", () => {
		expect(formatFor("LBP", 9000000)).toBe("9,000,000");
		expect(formatFor("USD", 100)).toBe("100.00");
	});

	it("puts the symbol on the correct side", () => {
		// Grouping and the decimal mark come from the System Settings mask, here left at its
		// default. SEK is present for symbol_on_right, not for its own comma decimal.
		expect(formatWithSymbol("USD", 100)).toBe("$ 100.00");
		expect(formatWithSymbol("SEK", 100)).toBe("100.00 kr");
		expect(formatWithSymbol("LBP", 9000000)).toBe("L£ 9,000,000");
	});

	it("renders a non-finite value as zero", () => {
		expect(formatFor("USD", Number.NaN)).toBe("0.00");
	});
});

describe("system number format", () => {
	it("prints an amount with the separators System Settings asks for", () => {
		setNumberFormatSettings({ number_format: "#.###,##" });

		expect(formatFor("USD", 1234567.89)).toBe("1.234.567,89");
		expect(formatFor("LBP", 9000000)).toBe("9.000.000");
	});

	it("uses the mask for grouping but the currency for how many decimals", () => {
		setNumberFormatSettings({ number_format: "# ###.##" });

		// The mask says two decimals; LBP is a whole-unit currency and wins on decimals.
		expect(formatFor("LBP", 9000000)).toBe("9 000 000");
		expect(formatFor("KWD", 1234.5)).toBe("1 234.500");
	});

	it("lets an explicit currency_precision override the currency's own decimals", () => {
		setNumberFormatSettings({ number_format: "#,###.##", currency_precision: "3" });

		expect(displayPrecisionFor("USD")).toBe(3);
		expect(formatFor("USD", 100)).toBe("100.000");
		// Money maths is untouched: LBP is still quoted in whole units.
		expect(precisionFor("LBP")).toBe(0);
		expect(roundFor("LBP", 5892300.6)).toBe(5892301);
	});

	it("ignores the currency's own mask unless System Settings asks for it", () => {
		setNumberFormatSettings({ number_format: "#,###.##" });
		expect(numberFormatFor("SEK")).toBe("#,###.##");
		expect(formatFor("SEK", 1234.5)).toBe("1,234.50");

		setNumberFormatSettings({ number_format: "#,###.##", use_number_format_from_currency: 1 });
		expect(numberFormatFor("SEK")).toBe("# ###,##");
		expect(formatFor("SEK", 1234.5)).toBe("1 234,50");
	});

	it("falls back to the system mask for a currency that declares none", () => {
		setNumberFormatSettings({ number_format: "#.###,##", use_number_format_from_currency: 1 });

		expect(numberFormatFor("XYZ")).toBe("#.###,##");
	});

	it("drops the symbol when the site hides currency symbols", () => {
		setNumberFormatSettings({ number_format: "#,###.##", hide_currency_symbol: "Yes" });

		expect(formatWithSymbol("USD", 100)).toBe("100.00");
	});
});
