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
import { setSessionScope } from "@/services/sessionScope";

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
	findPendingInvoiceByLocalId: vi.fn(),
	recoverStaleClaims: vi.fn(async () => 0),
	exportPendingInvoices: vi.fn(),
	claimPendingInvoice: vi.fn(async (id: number) => {
		const row = db.rows.find((r) => r.id === id);
		if (!row) return null;
		row.status = "syncing";
		return { ...row };
	}),
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
	setSessionScope({
		user: "cashier",
		profile: "Main",
		company: "TC",
		warehouse: "Stores",
		priceList: "Std",
	});
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
		db.rows[0].next_attempt_at = null;

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

import { claimPendingInvoice, deletePendingInvoice } from "@/services/dbBridge";

const rejection = (message: string, excType = "ValidationError", status = 417) =>
	Object.assign(new Error(message), { excType, status });

describe("retries and rejections", () => {
	it("keeps retrying a sale through repeated network failures and never parks it", async () => {
		call.mockRejectedValue(new Error("__offline__"));
		const store = useOfflineStore();
		for (let attempt = 1; attempt <= 12; attempt++) {
			db.rows[0].next_attempt_at = null;
			await store.syncPendingInvoices();
			expect(db.rows[0].status).toBe("failed");
			expect(db.rows[0].attempts).toBe(attempt);
		}
		expect(deletePendingInvoice).not.toHaveBeenCalled();
		expect(db.rows[0].rejection).toBeUndefined();
	});

	it("waits out the backoff instead of resending straight away", async () => {
		call.mockRejectedValue(new Error("__offline__"));
		const store = useOfflineStore();
		await store.syncPendingInvoices();
		expect(call).toHaveBeenCalledTimes(1);
		expect(Date.parse(db.rows[0].next_attempt_at as string)).toBeGreaterThan(Date.now());

		await store.syncPendingInvoices();
		expect(call).toHaveBeenCalledTimes(1);
	});

	it("treats a server error as transient", async () => {
		call.mockRejectedValue(Object.assign(new Error("Bad gateway"), { status: 502 }));
		await useOfflineStore().syncPendingInvoices();
		expect(db.rows[0].status).toBe("failed");
		expect(db.rows[0].rejection).toBeUndefined();
	});

	it("keeps a refused sale for review with the server's reason, and leaves it alone afterwards", async () => {
		call.mockRejectedValue(rejection("Discount above the allowed limit"));
		const store = useOfflineStore();
		await store.syncPendingInvoices();

		expect(db.rows).toHaveLength(1);
		expect(db.rows[0].status).toBe("dead_letter");
		expect(db.rows[0].rejection).toMatchObject({
			code: "ValidationError",
			message: "Discount above the allowed limit",
		});

		call.mockClear();
		for (let pass = 0; pass < 3; pass++) await store.syncPendingInvoices();
		expect(call).not.toHaveBeenCalled();
		expect(db.rows).toHaveLength(1);
	});

	it("deletes a queued sale only when the server confirms it", async () => {
		const store = useOfflineStore();
		call.mockRejectedValueOnce(new Error("__offline__")).mockRejectedValueOnce(rejection("No"));
		await store.syncPendingInvoices();
		db.rows[0].next_attempt_at = null;
		await store.syncPendingInvoices();
		expect(deletePendingInvoice).not.toHaveBeenCalled();

		call.mockResolvedValue({ name: "ACC-SINV-9", status: "Paid" });
		await store.retrySingle(1);
		expect(deletePendingInvoice).toHaveBeenCalledTimes(1);
	});

	it("resolves a replay after a lost response to the same invoice, exactly once", async () => {
		const server = new Map<string, string>();
		call.mockImplementation(async (_method: string, args: { local_id: string }) => {
			const duplicate = server.has(args.local_id);
			if (!duplicate) server.set(args.local_id, "ACC-SINV-5");
			if (!duplicate && server.size === 1 && call.mock.calls.length === 1)
				throw new Error("__offline__");
			return {
				name: server.get(args.local_id),
				status: "Paid",
				...(duplicate ? { duplicate: true } : {}),
			};
		});
		const store = useOfflineStore();
		await store.syncPendingInvoices();
		expect(db.rows).toHaveLength(1);

		db.rows[0].next_attempt_at = null;
		await store.syncPendingInvoices();
		expect(db.rows).toHaveLength(0);
		expect(server.size).toBe(1);
	});

	it("two counters selling the last unit: one posts, the other is kept for review", async () => {
		db.rows = [
			{ ...queued(), id: 1, local_id: "inv_counter_a" },
			{ ...queued(), id: 2, local_id: "inv_counter_b" },
		];
		call.mockResolvedValueOnce({ name: "ACC-SINV-1", status: "Paid" }).mockRejectedValueOnce(
			rejection("Insufficient stock for ITEM-A", "XPosInsufficientStockError"),
		);
		await useOfflineStore().syncPendingInvoices();

		expect(db.rows.map((r) => [r.local_id, r.status])).toEqual([["inv_counter_b", "dead_letter"]]);
		expect(db.rows[0].rejection?.code).toBe("XPosInsufficientStockError");
	});

	it("stops a pass after repeated transient failures instead of hammering the server", async () => {
		db.rows = [1, 2, 3, 4, 5].map((id) => ({ ...queued(), id, local_id: `inv_${id}` }));
		call.mockRejectedValue(new Error("__offline__"));
		await useOfflineStore().syncPendingInvoices();
		expect(call).toHaveBeenCalledTimes(3);
	});
});

describe("who may send a sale", () => {
	it("sends only the signed-in user's sales, and sales saved before owners were recorded", async () => {
		db.rows = [
			{
				...queued(),
				id: 1,
				local_id: "inv_mine",
				owner: { user: "cashier", profile: "Main", company: "TC" },
			},
			{
				...queued(),
				id: 2,
				local_id: "inv_theirs",
				owner: { user: "other", profile: "Main", company: "TC" },
			},
			{ ...queued(), id: 3, local_id: "inv_legacy", owner: null },
		];
		call.mockResolvedValue({ name: "ACC-SINV-1", status: "Paid" });
		await useOfflineStore().syncPendingInvoices();
		expect(db.rows.map((r) => r.local_id)).toEqual(["inv_theirs"]);
	});

	it("leaves a held sale to the cashier until they ask for it to be sent", async () => {
		db.rows[0].hold = "offline_blocked";
		call.mockResolvedValue({ name: "ACC-SINV-1", status: "Paid" });
		const store = useOfflineStore();
		await store.syncPendingInvoices();
		expect(call).not.toHaveBeenCalled();

		await store.retrySingle(1);
		expect(call).toHaveBeenCalledTimes(1);
		expect(db.rows).toHaveLength(0);
	});

	it("does not send a sale that another tab is already sending", async () => {
		vi.mocked(claimPendingInvoice).mockResolvedValueOnce(null);
		call.mockResolvedValue({ name: "ACC-SINV-1", status: "Paid" });
		await useOfflineStore().syncPendingInvoices();
		expect(call).not.toHaveBeenCalled();
		expect(db.rows).toHaveLength(1);
	});
});
