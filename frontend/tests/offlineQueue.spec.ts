/**
 * @vitest-environment jsdom
 *
 * Syncing queued sales: only a finished invoice clears the queue entry. A sale the
 * server repriced is held for review (nothing was posted), never silently dropped.
 * A sale waiting for FBR keeps its draft and is never fiscalised twice.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import type { PendingInvoice } from "@/services/idbService";

const { db, call } = vi.hoisted(() => ({
	db: { rows: [] as PendingInvoice[] },
	call: vi.fn(),
}));

vi.mock("@/services/api", () => ({
	call,
	showError: vi.fn(),
	showSuccess: vi.fn(),
	showInfo: vi.fn(),
}));
vi.mock("@/stores/posStore", () => ({ usePosStore: () => ({ useOfflineMode: true }) }));
vi.mock("@/services/dbBridge", () => ({
	addPendingInvoice: vi.fn(),
	getAllPendingInvoices: vi.fn(async () => db.rows.map((r) => ({ ...r }))),
	updatePendingInvoice: vi.fn(async (id: number, updates: Record<string, unknown>) => {
		const row = db.rows.find((r) => r.id === id);
		if (row) Object.assign(row, updates);
		return true;
	}),
	deletePendingInvoice: vi.fn(async (id: number) => {
		db.rows = db.rows.filter((r) => r.id !== id);
	}),
	countPendingInvoices: vi.fn(async () => db.rows.length),
	countDeadLetters: vi.fn(async () => 0),
	retryDeadLetter: vi.fn(),
	adjustCachedStock: vi.fn(),
}));

import { useOfflineStore } from "@/stores/offlineStore";

function queued(): PendingInvoice {
	return {
		id: 1,
		local_id: "inv_queued",
		status: "pending",
		retry_count: 0,
		created_at: "2026-10-17",
		customer_name: "Walk-in",
		data: {
			customer: "Walk-in",
			items: [{ row_id: "r1", item_code: "ITEM-A", item_name: "A", qty: 1, rate: 90 }],
			payments: [{ mode_of_payment: "Cash", amount: 90 }],
		},
	};
}

const reprice = {
	status: "reprice_required",
	lines: [
		{
			row_id: "r1",
			index: 0,
			item_code: "ITEM-A",
			quoted_rate: 90,
			rate: 100,
			price_list_rate: 100,
			discount_percentage: 0,
			discount_amount: 0,
		},
	],
	additional_discount_percentage: 0,
	discount_amount: 0,
	discount_changed: false,
	grand_total: 100,
	rounded_total: 100,
	message: "Prices changed",
};

const EVIDENCE = "IRIS POS invoice list, sale date";
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

function localAnswer(body: Record<string, unknown>) {
	return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

const localRequired = {
	name: "ACC-SINV-3",
	doctype: "Sales Invoice",
	status: "fbr_local_required",
	fbr_payload: { USIN: "inv_queued" },
	fbr_local_service_url: "http://localhost:8524",
};
const uncertain = {
	name: "ACC-SINV-3",
	doctype: "Sales Invoice",
	status: "fbr_uncertain",
	message: "Check FBR",
};

beforeEach(() => {
	setActivePinia(createPinia());
	vi.clearAllMocks();
	call.mockReset();
	fetchMock.mockReset();
	localStorage.clear();
	db.rows = [queued()];
});

describe("offline queue sync", () => {
	it("removes the entry only for a finished invoice", async () => {
		call.mockResolvedValue({ name: "ACC-SINV-1", status: "Paid" });
		await useOfflineStore().syncPendingInvoices();
		expect(db.rows).toHaveLength(0);
	});

	it("holds a repriced sale for review instead of dropping it", async () => {
		call.mockResolvedValue(reprice);
		const store = useOfflineStore();
		await store.syncPendingInvoices();
		expect(db.rows).toHaveLength(1);
		expect(db.rows[0].status).toBe("needs_review");
		expect(db.rows[0].review?.lines[0].rate).toBe(100);

		// The next sync leaves it alone until someone reviews it.
		call.mockClear();
		await store.syncPendingInvoices();
		expect(call).not.toHaveBeenCalled();
	});

	it("posts a reviewed sale at the revised price with the same local id", async () => {
		call.mockResolvedValueOnce(reprice).mockResolvedValueOnce({ name: "ACC-SINV-2", status: "Paid" });
		const store = useOfflineStore();
		await store.syncPendingInvoices();
		await store.loadPendingInvoices();

		expect(await store.resolveReview(1, false)).toBe(true);
		const [, args] = call.mock.calls[1] as [string, { data: string; local_id: string }];
		expect(args.local_id).toBe("inv_queued");
		expect(JSON.parse(args.data).items[0].rate).toBe(100);
		expect(db.rows).toHaveLength(0);
	});

	it("finishes a queued sale through the local FBR service", async () => {
		fetchMock.mockResolvedValue(localAnswer({ InvoiceNumber: "FBR-1", Code: "100" }));
		call.mockResolvedValueOnce(localRequired).mockResolvedValueOnce({
			name: "ACC-SINV-3",
			status: "Paid",
		});
		await useOfflineStore().syncPendingInvoices();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(call.mock.calls[1]).toEqual([
			"xpos.api.invoices.finalize_fiscal_invoice",
			{ name: "ACC-SINV-3", fbr_invoice_number: "FBR-1", doctype: "Sales Invoice" },
		]);
		expect(db.rows).toHaveLength(0);
	});

	it("never asks the local service twice when the finalize answer was lost", async () => {
		fetchMock.mockResolvedValue(localAnswer({ InvoiceNumber: "FBR-2", Code: "100" }));
		call.mockResolvedValueOnce(localRequired)
			.mockRejectedValueOnce(new TypeError("Failed to fetch"))
			.mockResolvedValueOnce({ ...localRequired, duplicate: true })
			.mockResolvedValueOnce({ name: "ACC-SINV-3", status: "Paid" });
		const store = useOfflineStore();
		await store.syncPendingInvoices();
		expect(db.rows[0].status).toBe("failed");

		await store.syncPendingInvoices();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(call.mock.calls[3][1]).toMatchObject({ fbr_invoice_number: "FBR-2" });
		expect(db.rows).toHaveLength(0);
	});

	it("holds the sale for an FBR check when the local service does not answer", async () => {
		fetchMock.mockRejectedValue(new DOMException("aborted", "AbortError"));
		call.mockResolvedValueOnce(localRequired).mockResolvedValueOnce({ status: "fbr_uncertain" });
		const store = useOfflineStore();
		await store.syncPendingInvoices();
		expect(call.mock.calls[1][0]).toBe("xpos.api.invoices.mark_fiscalization_uncertain");
		expect(db.rows[0].status).toBe("fiscal_uncertain");
		expect(db.rows[0].fiscal).toMatchObject({
			name: "ACC-SINV-3",
			doctype: "Sales Invoice",
			usin: "inv_queued",
		});

		// Nothing is retried on its own.
		call.mockClear();
		fetchMock.mockClear();
		await store.syncPendingInvoices();
		expect(call).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("retries after a refusal from the local service, which proves nothing was fiscalised", async () => {
		fetchMock.mockResolvedValue(localAnswer({ Code: "401", Response: "Bad payload" }));
		call.mockResolvedValue(localRequired);
		await useOfflineStore().syncPendingInvoices();
		expect(call).toHaveBeenCalledTimes(1);
		expect(db.rows[0].status).toBe("failed");
		expect(db.rows[0].error).toContain("Bad payload");
	});

	it("records the number found in FBR's records, then sends the same sale to finish it", async () => {
		call.mockResolvedValueOnce(uncertain)
			.mockResolvedValueOnce({ resolution: "Recorded" })
			.mockResolvedValueOnce({ name: "ACC-SINV-3", status: "Paid" });
		const store = useOfflineStore();
		await store.syncPendingInvoices();
		await store.loadPendingInvoices();
		expect(db.rows[0].status).toBe("fiscal_uncertain");

		expect(await store.resolveFiscalCheck(1, "FBR-9", EVIDENCE)).toBe(true);
		expect(call.mock.calls[1]).toEqual([
			"xpos.api.invoices.resolve_fiscal_check",
			{
				usin: "inv_queued",
				pos_profile: undefined,
				resolution: "Recorded",
				fbr_invoice_number: "FBR-9",
				evidence: EVIDENCE,
			},
		]);
		expect(call.mock.calls[2][0]).toBe("xpos.api.invoices.create_invoice");
		expect(call.mock.calls[2][1]).toMatchObject({ local_id: "inv_queued" });
		expect(db.rows).toHaveLength(0);
	});

	it("records 'not in FBR records' and keeps the sale held while FBR still has no answer", async () => {
		call.mockResolvedValueOnce(uncertain)
			.mockResolvedValueOnce({ resolution: "Not Recorded" })
			.mockResolvedValueOnce(uncertain);
		const store = useOfflineStore();
		await store.syncPendingInvoices();
		await store.loadPendingInvoices();

		expect(await store.resolveFiscalCheck(1, null, EVIDENCE)).toBe(false);
		expect(call.mock.calls[1][1]).toMatchObject({
			resolution: "Not Recorded",
			fbr_invoice_number: undefined,
		});
		expect(db.rows[0].status).toBe("fiscal_uncertain");
	});

	it("sends nothing again when recording the check is refused", async () => {
		call.mockResolvedValueOnce(uncertain).mockRejectedValueOnce(new Error("not permitted"));
		const store = useOfflineStore();
		await store.syncPendingInvoices();
		await store.loadPendingInvoices();

		expect(await store.resolveFiscalCheck(1, "FBR-9", EVIDENCE)).toBe(false);
		expect(call).toHaveBeenCalledTimes(2);
		expect(db.rows[0].status).toBe("fiscal_uncertain");
	});

	it("holds a customer-credit sale that has no draft by its sale id, and finishes it on a recheck", async () => {
		call.mockResolvedValueOnce({
			name: null,
			usin: "inv_queued",
			pos_profile: "Till 1",
			status: "fbr_uncertain",
		}).mockResolvedValueOnce({ name: "ACC-SINV-4", status: "Paid" });
		const store = useOfflineStore();
		await store.syncPendingInvoices();
		await store.loadPendingInvoices();
		expect(db.rows[0].fiscal).toMatchObject({ name: null, usin: "inv_queued", pos_profile: "Till 1" });

		expect(await store.recheckFiscalSale(1)).toBe(true);
		expect(db.rows).toHaveLength(0);
	});

	it("keeps the entry when the server answers without an invoice", async () => {
		call.mockResolvedValue({});
		await useOfflineStore().syncPendingInvoices();
		expect(db.rows).toHaveLength(1);
		expect(db.rows[0].status).toBe("failed");
	});
});
