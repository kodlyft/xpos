import { describe, expect, it } from "vitest";
import { findReportDefinition, isReportRunnable, type ReportDefinition } from "@/services/reports";

const report = (overrides: Partial<ReportDefinition>): ReportDefinition => ({
	id: "POS Shift Reconciliation",
	slug: "pos-shift-reconciliation",
	aliases: ["shift-reconciliation"],
	title: "POS Shift Reconciliation",
	description: "",
	category: "Sales",
	ref_doctype: "POS Opening Shift",
	capability: { state: "supported", reasons: [] },
	export: { allowed: true },
	print: { allowed: true, thermal: true },
	...overrides,
});

describe("report catalog lookup", () => {
	const reports = [
		report({}),
		report({ id: "Gift Card Liability", slug: "gift-card-liability", aliases: [] }),
	];

	it("resolves a legacy slug, an alias and the canonical id to the same report", () => {
		expect(findReportDefinition(reports, "pos-shift-reconciliation")?.id).toBe(
			"POS Shift Reconciliation",
		);
		expect(findReportDefinition(reports, "shift-reconciliation")?.id).toBe("POS Shift Reconciliation");
		expect(findReportDefinition(reports, "POS Shift Reconciliation")?.slug).toBe(
			"pos-shift-reconciliation",
		);
	});

	it("does not resolve reports the server did not list", () => {
		expect(findReportDefinition(reports, "stock-ledger")).toBeUndefined();
		expect(findReportDefinition(reports, undefined)).toBeUndefined();
	});

	it("only runs reports the server marks supported", () => {
		expect(isReportRunnable(report({}))).toBe(true);
		expect(
			isReportRunnable(
				report({ capability: { state: "adapter_required", reasons: ["js_only_filters"] } }),
			),
		).toBe(false);
	});
});
