import { describe, expect, it } from "vitest";
import { formatMinor, lineTotalMinor, qtyToMilli, toMinor } from "../src/domain/money";

describe("minor-unit money", () => {
	it.each([
		["12.5", 2, 1250],
		["12", 0, 12],
		["0.075", 3, 75],
		["-3.10", 2, -310],
	])("parses %s at %i digits", (t, d, m) => expect(toMinor(t, d)).toBe(m));

	it("rejects excess precision and garbage", () => {
		expect(() => toMinor("1.005", 2)).toThrow();
		expect(() => toMinor("1.5", 0)).toThrow();
		expect(() => toMinor("abc", 2)).toThrow();
		expect(() => toMinor("1", 7)).toThrow();
	});

	it.each([
		[1250, 2, "12.50"],
		[12, 0, "12"],
		[75, 3, "0.075"],
		[-5, 2, "-0.05"],
	])("formats %i at %i digits", (m, d, s) => expect(formatMinor(m, d)).toBe(s));

	it("computes line totals with half-away-from-zero rounding and no float drift", () => {
		expect(lineTotalMinor(1999, 3000)).toBe(5997);
		expect(lineTotalMinor(1, 500)).toBe(1); // 0.5 rounds up
		expect(lineTotalMinor(-1, 500)).toBe(-1);
		expect(lineTotalMinor(333, 1500)).toBe(500); // 499.5 -> 500
		expect(qtyToMilli(1.25)).toBe(1250);
		expect(() => qtyToMilli(1.0005)).toThrow();
	});
});
