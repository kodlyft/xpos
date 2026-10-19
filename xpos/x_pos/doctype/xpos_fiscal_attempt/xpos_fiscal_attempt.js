// Copyright (c) 2026, Ali Raza and contributors
// For license information, please see license.txt

frappe.ui.form.on("XPOS Fiscal Attempt", {
	refresh(frm) {
		const open = ["Sent", "Uncertain"].includes(frm.doc.status) && !frm.doc.resolution;
		if (!open || !frm.doc.pos_profile) return;
		frm.add_custom_button(__("Record FBR Check"), () => {
			const dialog = new frappe.ui.Dialog({
				title: __("Record what FBR's records show for sale {0}", [frm.doc.usin]),
				fields: [
					{
						fieldname: "resolution",
						fieldtype: "Select",
						label: __("Resolution"),
						options: ["Recorded", "Not Recorded"],
						reqd: 1,
					},
					{
						fieldname: "fbr_invoice_number",
						fieldtype: "Data",
						label: __("FBR Invoice Number"),
						depends_on: "eval:doc.resolution == 'Recorded'",
						mandatory_depends_on: "eval:doc.resolution == 'Recorded'",
					},
					{
						fieldname: "evidence",
						fieldtype: "Small Text",
						label: __("Where you checked and what you found"),
						reqd: 1,
					},
				],
				primary_action_label: __("Record"),
				primary_action(values) {
					frappe
						.call("xpos.api.invoices.resolve_fiscal_check", {
							usin: frm.doc.usin,
							pos_profile: frm.doc.pos_profile,
							...values,
						})
						.then(() => {
							dialog.hide();
							frappe.show_alert({
								message: __("Recorded. Send the sale again from the till to finish it."),
								indicator: "green",
							});
							frm.reload_doc();
						});
				},
			});
			dialog.show();
		});
	},
});
