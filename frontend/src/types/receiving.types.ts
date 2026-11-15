export interface ReceivingSetup {
	pos_profile: string;
	company: string;
	warehouse: string | null;
	can_draft: boolean;
	can_submit: boolean;
	can_see_rates: boolean;
}

export interface TransferSummary {
	name: string;
	posting_date: string;
	from_warehouse: string;
	destination: string;
	per_transferred: number;
	open_rows: number;
	pending_qty: number;
}

export interface ReceiptDraft {
	name: string;
	outgoing_stock_entry: string;
	posting_date: string;
	modified: string;
}

export interface TransferRow {
	ste_detail: string;
	item_code: string;
	item_name: string;
	uom: string;
	stock_uom: string;
	conversion_factor: number;
	sent_qty: number;
	received_qty: number;
	pending_qty: number;
	s_warehouse: string;
	transit_warehouse: string;
	destination: string | null;
	has_batch_no: number;
	has_serial_no: number;
	variant_of?: string | null;
	basic_rate?: number;
}

export interface IncomingTransfer {
	name: string;
	posting_date: string;
	from_warehouse: string;
	destination: string;
	per_transferred: number;
	remarks: string;
	items: TransferRow[];
}

export interface ReceivingLine {
	ste_detail: string;
	item_code: string;
	item_name: string;
	uom: string;
	stock_uom: string;
	conversion_factor: number;
	sent_qty: number;
	received_qty: number;
	pending_qty: number;
	has_batch_no: number;
	has_serial_no: number;
	variant_of?: string | null;
	rate: number | null;
	qty: number;
	return_qty: number;
}

export interface SaveResult {
	name: string;
	doctype: string;
	docstatus: number;
	stock_posted: boolean;
	created: boolean;
}

export interface ReceiptStatus extends Partial<SaveResult> {
	found: boolean;
}
