/** Report catalog + result fixtures for the reports workspace specs. */
export const entry = (over: Record<string, unknown>) => ({
	id: "Shift Report",
	slug: "shift-report",
	aliases: [],
	title: "Shift Report",
	description: "Payments taken per shift",
	category: "Sales",
	report_type: "Script Report",
	ref_doctype: "POS Invoice",
	capability: { state: "supported", reasons: [] },
	permissions: { pos_permission: null },
	scope: { mode: "Company" },
	execution: { prepared: "none", summary: "runtime", chart: "runtime" },
	export: { allowed: true },
	print: { allowed: true, thermal: true },
	...over,
});

export const CATALOG = [
	entry({}),
	entry({
		id: "Stock Balance",
		slug: "stock-balance",
		title: "Stock Balance",
		category: "Inventory",
		description: "Qty on hand",
	}),
	entry({
		id: "Chart of Accounts",
		slug: "chart-of-accounts",
		title: "Chart of Accounts",
		category: "Accounting",
	}),
	entry({ id: "Multi Currency Sales", slug: "multi-currency-sales", title: "Multi Currency Sales" }),
	entry({ id: "Prepared Sales", slug: "prepared-sales", title: "Prepared Sales" }),
	entry({ id: "Empty Report", slug: "empty-report", title: "Empty Report" }),
	entry({ id: "Broken Report", slug: "broken-report", title: "Broken Report" }),
	entry({ id: "Slow Report", slug: "slow-report", title: "Slow Report" }),
];

export const FILTERS = [
	{
		fieldname: "company",
		label: "Company",
		type: "link",
		doctype: "Company",
		required: true,
		defaultValue: "Test Co",
	},
	{ fieldname: "warehouse", label: "Warehouse", type: "link", doctype: "Warehouse" },
	{ fieldname: "from_date", label: "From Date", type: "date" },
	{ fieldname: "to_date", label: "To Date", type: "date" },
	{ fieldname: "customer", label: "Customer", type: "link", doctype: "Customer" },
];

const text = (fieldname: string, label: string, extra = {}) => ({
	fieldname,
	label,
	fieldtype: "Data",
	...extra,
});
const money = (fieldname: string, label: string, extra = {}) => ({
	fieldname,
	label,
	fieldtype: "Currency",
	options: "currency",
	...extra,
});

export const SMALL = {
	columns: [
		text("customer", "Customer"),
		{ fieldname: "invoice", label: "Invoice", fieldtype: "Link", options: "POS Invoice" },
		money("amount", "Amount"),
		text("internal_note", "Internal", { hidden: 1 }),
		{ fieldname: "qty", label: "Qty", fieldtype: "Float", precision: 3, options: "uom" },
		text("uom", "UOM"),
	],
	result: [
		{
			customer: "=cmd|' /C calc'!A0",
			invoice: "INV-1",
			amount: 100.5,
			currency: "USD",
			internal_note: "SECRET-NOTE",
			qty: 1.5,
			uom: "Kg",
		},
		{
			customer: "<img src=x onerror=alert(1)>",
			invoice: "INV-2",
			amount: 49.5,
			currency: "USD",
			internal_note: "SECRET-NOTE",
			qty: 2,
			uom: "Kg",
		},
		{ customer: "Total", amount: 150, currency: "USD", is_total_row: 1 },
	],
	report_summary: [
		{ label: "Net sales", value: 150, datatype: "Currency", currency: "USD" },
		{ label: "Invoices", value: 2, datatype: "Int" },
	],
	chart: {
		type: "bar",
		data: { labels: ["INV-1", "INV-2"], datasets: [{ name: "Amount", values: [100.5, 49.5] }] },
	},
};

export const LARGE = {
	columns: [text("name", "Name"), money("amount", "Amount")],
	result: Array.from({ length: 10_000 }, (_, i) => ({
		name: `Row ${String(i).padStart(5, "0")}`,
		amount: i,
		currency: "USD",
	})),
};

export const TREE = {
	columns: [text("account", "Account"), money("balance", "Balance")],
	result: [
		{ account: "Assets", balance: 300, currency: "USD", indent: 0 },
		{ account: "Cash", balance: 100, currency: "USD", indent: 1 },
		{ account: "Bank", balance: 200, currency: "USD", indent: 1 },
		{ account: "Liabilities", balance: 50, currency: "USD", indent: 0 },
	],
};

export const MIXED = {
	columns: [text("customer", "Customer"), money("amount", "Amount")],
	result: [
		{ customer: "A", amount: 10, currency: "USD" },
		{ customer: "B", amount: 20, currency: "EUR" },
		{ customer: "Total", amount: 30, currency: "USD", is_total_row: 1 },
	],
};

export const PREPARED = { columns: [], result: [], prepared_report: true, status: "Queued" };
export const EMPTY = { columns: [text("customer", "Customer")], result: [] };
