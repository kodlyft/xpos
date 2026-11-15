/**
 * @vitest-environment jsdom
 *
 * Receiving rows are checked before anything is sent, a scan counts into the matching row, and one
 * receipt keeps one request id until the server says it made nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const api = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("@/services/api", () => ({ call: api.call }));
vi.mock("@/stores/posStore", () => ({ usePosStore: () => ({ profileName: "P1" }) }));
vi.mock("@/stores/authStore", () => ({ useAuthStore: () => ({ userName: "u@example.com" }) }));
vi.mock("@/services/toast", () => ({
	toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

import { useReceivingStore } from "@/stores/receivingStore";
import { lineIssues, receiptIssues } from "@/services/receivingRules";
import type { IncomingTransfer, ReceivingLine } from "@/types/receiving.types";

const setup = {
	pos_profile: "P1",
	company: "C",
	warehouse: "W1",
	can_draft: true,
	can_submit: true,
	can_see_rates: false,
};

const row = (extra: Partial<IncomingTransfer["items"][number]> = {}) => ({
	ste_detail: "d1",
	item_code: "A",
	item_name: "A",
	uom: "Nos",
	stock_uom: "Nos",
	conversion_factor: 1,
	sent_qty: 10,
	received_qty: 4,
	pending_qty: 6,
	s_warehouse: "S",
	transit_warehouse: "T",
	destination: null,
	has_batch_no: 0,
	has_serial_no: 0,
	...extra,
});

const transfer = (items = [row()]): IncomingTransfer => ({
	name: "MAT-1",
	posting_date: "2026-10-30",
	from_warehouse: "S",
	destination: "W1",
	per_transferred: 40,
	remarks: "",
	items,
});

function line(extra: Partial<ReceivingLine> = {}): ReceivingLine {
	return { ...row(), rate: null, qty: 0, return_qty: 0, ...extra };
}

describe("row rules", () => {
	it("refuses more than is in transit", () => {
		expect(lineIssues(line({ qty: 7 })).map((i) => i.field)).toContain("qty");
		expect(lineIssues(line({ qty: 6 }))).toEqual([]);
	});

	it("counts received and returned quantity together", () => {
		expect(lineIssues(line({ qty: 4, return_qty: 3 })).map((i) => i.field)).toContain("return");
		expect(lineIssues(line({ qty: 4, return_qty: 2 }))).toEqual([]);
	});

	it("refuses negative quantities", () => {
		expect(lineIssues(line({ qty: -1 })).length).toBeGreaterThan(0);
	});

	it("needs a quantity on at least one row", () => {
		expect(receiptIssues([line()])).toHaveLength(1);
		expect(receiptIssues([line({ qty: 1 })])).toEqual([]);
	});
});

describe("receiving store", () => {
	beforeEach(() => {
		setActivePinia(createPinia());
		api.call.mockReset();
		localStorage.clear();
	});

	async function opened(rows = [row()]) {
		const store = useReceivingStore();
		store.setup = setup;
		api.call.mockResolvedValueOnce(transfer(rows));
		await store.openTransfer("MAT-1");
		return store;
	}

	it("opens a transfer with everything in transit ready to receive", async () => {
		const store = await opened();
		expect(store.lines).toHaveLength(1);
		expect(store.lines[0].qty).toBe(6);
		expect(store.lines[0].return_qty).toBe(0);
		expect(store.dirty).toBe(false);
	});

	it("counts a scan into the matching row and stops at what is in transit", async () => {
		const store = await opened();
		store.lines[0].qty = 4;
		expect(store.countScan("A")).toBe("added");
		expect(store.countScan("A")).toBe("added");
		expect(store.lines[0].qty).toBe(6);
		expect(store.countScan("A")).toBe("full");
		expect(store.countScan("Z")).toBe("missing");
	});

	it("keeps the request id across a lost answer and reuses an existing receipt", async () => {
		const store = await opened();
		const id = store.requestId;
		api.call.mockRejectedValueOnce(new Error("__offline__"));
		expect(await store.save("submit")).toBeNull();
		expect(store.uncertain).toBe(true);
		expect(store.requestId).toBe(id);

		api.call.mockImplementation(async (method: string) =>
			method.endsWith("get_receipt_status")
				? {
						found: true,
						name: "MAT-2",
						doctype: "Stock Entry",
						docstatus: 1,
						stock_posted: true,
						created: false,
					}
				: Promise.reject(new Error("must not save again")),
		);
		const result = await store.save("submit");
		expect(result?.name).toBe("MAT-2");
		expect(api.call.mock.calls.filter(([m]) => String(m).endsWith("save_receipt"))).toHaveLength(1);
		expect(store.transfer).toBeNull();
		expect(store.requestId).not.toBe(id);
	});

	it("retries with the same id when the server made nothing, and a draft is not posted stock", async () => {
		const store = await opened();
		const id = store.requestId;
		api.call.mockRejectedValueOnce(new Error("__offline__"));
		await store.save("draft");
		api.call.mockImplementation(async (method: string, args: Record<string, unknown>) => {
			if (method.endsWith("get_receipt_status")) return { found: false };
			expect(args.request_id).toBe(id);
			return {
				name: "MAT-3",
				doctype: "Stock Entry",
				docstatus: 0,
				stock_posted: false,
				created: true,
			};
		});
		const result = await store.save("draft");
		expect(result?.stock_posted).toBe(false);
		expect(store.draftDoc?.name).toBe("MAT-3");
		expect(store.transfer).not.toBeNull();
	});

	it("does not call the server while offline", async () => {
		const store = await opened();
		api.call.mockClear();
		store.setOnline(false);
		expect(await store.save("submit")).toBeNull();
		expect(api.call).not.toHaveBeenCalled();
	});

	it("sends only the rows being received, with no rate", async () => {
		const store = await opened([row(), row({ ste_detail: "d2", item_code: "B" })]);
		store.lines[1].qty = 0;
		api.call.mockResolvedValue({
			name: "MAT-4",
			doctype: "Stock Entry",
			docstatus: 0,
			stock_posted: false,
			created: true,
		});
		await store.save("draft");
		const sent = JSON.parse(api.call.mock.calls.at(-1)![1].data);
		expect(sent.items).toEqual([{ ste_detail: "d1", qty: 6 }]);
		expect(sent.stock_entry).toBe("MAT-1");
		expect(sent.warehouse).toBeUndefined();
	});

	it("keeps unsaved work for a reload and restores it", async () => {
		const store = await opened();
		store.lines[0].qty = 2;
		store.touch();
		await Promise.resolve();
		setActivePinia(createPinia());
		const again = useReceivingStore();
		again.setup = setup;
		expect(again.restore()).toBe(true);
		expect(again.lines[0].qty).toBe(2);
		expect(again.transfer?.name).toBe("MAT-1");
	});
});
