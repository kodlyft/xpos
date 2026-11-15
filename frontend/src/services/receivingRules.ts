import type { ReceivingLine } from "@/types/receiving.types";
import __ from "@/lib/translate";

export interface LineIssue {
	field: "qty" | "return";
	message: string;
}

export function lineIssues(line: ReceivingLine): LineIssue[] {
	const issues: LineIssue[] = [];
	if (line.qty < 0) issues.push({ field: "qty", message: __("Quantity cannot be negative.") });
	if (line.return_qty < 0) issues.push({ field: "return", message: __("Quantity cannot be negative.") });
	if (line.qty > line.pending_qty + 1e-9) {
		issues.push({
			field: "qty",
			message: __("Only {0} is still in transit.").replace("{0}", String(line.pending_qty)),
		});
	}
	if (line.qty + line.return_qty > line.pending_qty + 1e-9) {
		issues.push({ field: "return", message: __("Received plus returned is more than is in transit.") });
	}
	return issues;
}

export function receiptIssues(lines: ReceivingLine[]): string[] {
	const out: string[] = [];
	if (!lines.some((l) => l.qty > 0)) out.push(__("Enter a quantity for at least one row."));
	for (const line of lines) {
		for (const issue of lineIssues(line)) out.push(`${line.item_code}: ${issue.message}`);
	}
	return out;
}
