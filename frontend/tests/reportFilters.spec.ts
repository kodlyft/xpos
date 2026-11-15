import { describe, expect, it } from "vitest";
import {
	buildInitialReportFilters,
	hydrateReportFiltersFromQuery,
	serializeReportFiltersToQuery,
	missingRequiredReportFilters,
	validateReportContext,
	validateReportFilters,
	type ReportFilterDefinition,
} from "@/services/reports";

const f = (over: Partial<ReportFilterDefinition>): ReportFilterDefinition => ({
	fieldname: "x",
	label: "X",
	type: "text",
	...over,
});

const filters = [
	f({ fieldname: "company", label: "Company", type: "link", required: true }),
	f({ fieldname: "warehouse", label: "Warehouse", type: "link" }),
	f({ fieldname: "from_date", label: "From", type: "date" }),
	f({ fieldname: "to_date", label: "To", type: "date" }),
	f({
		fieldname: "mode",
		label: "Mode",
		type: "select",
		options: [{ label: "A", value: "a" }],
	}),
	f({ fieldname: "items", label: "Items", type: "multi-link" }),
];

describe("URL hydration", () => {
	it("returns only the fields the URL supplies, so defaults survive", () => {
		const defaults = buildInitialReportFilters(filters, { company: "Acme", warehouse: "Main - A" });
		const hydrated = hydrateReportFiltersFromQuery(filters, { from_date: "2026-01-02" });
		expect(hydrated).toEqual({ from_date: "2026-01-02" });
		expect({ ...defaults, ...hydrated }.company).toBe("Acme");
	});

	it("treats a key present with an empty value as an explicit clear", () => {
		expect(hydrateReportFiltersFromQuery(filters, { warehouse: "" })).toEqual({ warehouse: "" });
		expect(hydrateReportFiltersFromQuery(filters, { items: "" })).toEqual({ items: [] });
	});

	it("rejects invalid dates and unknown select options", () => {
		expect(hydrateReportFiltersFromQuery(filters, { from_date: "yesterday", mode: "zzz" })).toEqual({});
		expect(hydrateReportFiltersFromQuery(filters, { mode: "a" })).toEqual({ mode: "a" });
	});

	it("round-trips a cleared default through the URL", () => {
		const defaults = { company: "Acme", warehouse: "Main - A" };
		const query = serializeReportFiltersToQuery(filters, { company: "Acme", warehouse: "" }, defaults);
		expect(query).toEqual({ company: "Acme", warehouse: "" });
		const back = hydrateReportFiltersFromQuery(filters, query);
		expect({ ...defaults, ...back }.warehouse).toBe("");
	});

	it("does not write empty values that have no default", () => {
		expect(serializeReportFiltersToQuery(filters, { company: "Acme" }, {})).toEqual({ company: "Acme" });
	});
});

describe("filter validation", () => {
	it("flags missing required, bad ranges and warehouse without company", () => {
		expect(validateReportFilters(filters, { company: "" })).toHaveLength(0);
		expect(missingRequiredReportFilters(filters, { company: "" }).map((x) => x.fieldname)).toEqual([
			"company",
		]);
		const range = validateReportFilters(filters, {
			company: "A",
			from_date: "2026-02-02",
			to_date: "2026-01-01",
		});
		expect(range).toHaveLength(1);
		expect(validateReportFilters(filters.slice(1), { warehouse: "W" })).toHaveLength(0);
		const noCompany = [f({ fieldname: "company", label: "Company", type: "link" }), ...filters.slice(1)];
		expect(validateReportFilters(noCompany, { warehouse: "W" })).toHaveLength(1);
	});

	it("checks warehouse and profile belong to the company", async () => {
		const defs = [...filters, f({ fieldname: "pos_profile", label: "Profile", type: "link" })];
		const errors = await validateReportContext(
			defs,
			{ company: "Acme", warehouse: "W1", pos_profile: "P1" },
			async (doctype) => (doctype === "Warehouse" ? "Other Co" : "Acme"),
		);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("W1");
	});
});
