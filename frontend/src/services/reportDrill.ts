import { call } from "@/services/api";
import type { ReportColumn } from "@/services/reports";

export interface DrillTarget {
	doctype: string;
	name: string;
}

/** The document a cell points at: a Link column's options, or the doctype in a Dynamic Link's sibling column. */
export function drillTarget(column: ReportColumn, row: Record<string, unknown>): DrillTarget | null {
	const value = row[column.fieldname];
	if (value === null || value === undefined || value === "") return null;
	const options = String(column.options || "").trim();
	if (!options) return null;
	let doctype = "";
	if (column.fieldtype === "Link") doctype = options;
	else if (column.fieldtype === "Dynamic Link") doctype = String(row[options] ?? "");
	if (!doctype) return null;
	return { doctype, name: String(value) };
}

export function documentPath(target: DrillTarget): string {
	const slug = target.doctype.toLowerCase().replace(/\s+/g, "-");
	return `/desk/${encodeURIComponent(slug)}/${encodeURIComponent(target.name)}`;
}

const permitted = new Map<string, Promise<boolean>>();

/** Server-side read check, remembered per document so repeated clicks stay cheap. */
export function canOpenDocument(target: DrillTarget): Promise<boolean> {
	const key = `${target.doctype}\u0000${target.name}`;
	let result = permitted.get(key);
	if (!result) {
		result = call<{ has_permission?: boolean } | boolean>("frappe.client.has_permission", {
			doctype: target.doctype,
			docname: target.name,
			perm_type: "read",
		})
			.then((response) =>
				typeof response === "object" && response !== null
					? Boolean(response.has_permission)
					: Boolean(response),
			)
			.catch(() => {
				permitted.delete(key);
				return false;
			});
		permitted.set(key, result);
	}
	return result;
}

/** Open the document in a new tab, only when the server says this user may read it. */
export async function openDocument(target: DrillTarget): Promise<boolean> {
	if (!(await canOpenDocument(target))) return false;
	window.open(documentPath(target), "_blank", "noopener,noreferrer");
	return true;
}
