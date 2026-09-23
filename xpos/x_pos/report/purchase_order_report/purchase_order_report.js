// Copyright (c) 2025, Kodlyft and contributors
// For license information, please see license.txt

frappe.query_reports["Purchase Order Report"] = {
	filters: [
		{
			fieldname: "company",
			label: __("Company"),
			fieldtype: "Link",
			options: "Company",
			default: frappe.defaults.get_user_default("Company"),
			reqd: 1,
		},
		{
			fieldname: "supplier",
			label: __("Supplier"),
			fieldtype: "Link",
			options: "Supplier",
			reqd: 1,
		},
		{
			fieldname: "from_date",
			label: __("From Date"),
			fieldtype: "Date",
			reqd: 1,
		},
		{
			fieldname: "to_date",
			label: __("To Date"),
			fieldtype: "Date",
			reqd: 1,
		},
		{
			fieldname: "type",
			label: __("Type"),
			fieldtype: "Select",
			options: ["All", "Based on ReOrder Level", "Based on Sales"],
			default: "All",
			reqd: 1,
		},
	],
	onload: function (report) {
		report.page
			.add_inner_button(__("Create Purchase Order"), function () {
				const report_data = report.data;
				const filters = report.get_values();
				if (!report_data || !report_data.length) {
					frappe.msgprint(__("No items found to create Purchase Order"));
					return;
				}
				frappe.call({
					method: "xpos.x_pos.report.purchase_order_report.purchase_order_report.create_purchase_order",
					args: {
						report_data: report_data,
						filters: filters,
					},
					callback: function (r) {
						if (!r.exc) {
							if (r.message && r.message.name) {
								frappe.msgprint({
									title: __("Success"),
									indicator: "green",
									message: __(
										'Purchase Order <a href="/app/purchase-order/{0}">{0}</a> created successfully',
									).replace("{0}", r.message.name),
								});

								// Refresh the report after creation
								report.refresh();

								// Optional: Open the new PO
								frappe.set_route("Form", "Purchase Order", r.message.name);
							}
						} else {
							frappe.msgprint({
								title: __("Error"),
								indicator: "red",
								message: __("Failed to create Purchase Order: {0}", [r.exc]),
							});
						}
					},
					freeze: true,
					freeze_message: __("Creating Purchase Order..."),
				});
			})
			.addClass("btn-primary");
	},
};
