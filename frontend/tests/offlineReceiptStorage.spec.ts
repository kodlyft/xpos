/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { InvoiceData, ReceiptSnapshot } from "@/types/pos.types";

const { bridge, call, online } = vi.hoisted(() => ({
	bridge: {
		addPendingInvoice: vi.fn(),
		getAllPendingInvoices: vi.fn(),
		updatePendingInvoice: vi.fn(),
		deletePendingInvoice: vi.fn(),
		countPendingInvoices: vi.fn(),
		countDeadLetters: vi.fn(),
		retryDeadLetter: vi.fn(),
		adjustCachedStock: vi.fn(),
		cachePOSData: vi.fn(),
		getCachedPOSData: vi.fn(),
		cacheReceiptContext: vi.fn(),
	},
	call: vi.fn(),
	online: { value: true },
}));

vi.mock("@/services/dbBridge", () => bridge);
vi.mock("@/services/api", () => ({
	call,
	showSuccess: vi.fn(),
	showError: vi.fn(),
	showInfo: vi.fn(),
}));
vi.mock("@/services/electronBridge", () => ({ isElectron: () => false }));
vi.mock("@/utils", () => ({
	isOnline: () => online.value,
	isNetworkError: () => false,
}));
vi.mock("@/stores/settingsStore", () => ({
	useSettingsStore: () => ({ fetchSettings: vi.fn().mockResolvedValue(undefined), reset: vi.fn() }),
}));
vi.mock("@/stores/itemStore", () => ({
	useItemStore: () => ({ cacheAllItems: vi.fn().mockResolvedValue(undefined) }),
}));
vi.mock("@/stores/customerStore", () => ({
	useCustomerStore: () => ({ cacheAllCustomers: vi.fn().mockResolvedValue(undefined) }),
}));

import { useOfflineStore } from "@/stores/offlineStore";
import { usePosStore } from "@/stores/posStore";

const invoiceData = { customer: "Walk-in Customer", items: [] } as unknown as InvoiceData;
const receipt = { name: "", grand_total: 10, items: [] } as unknown as ReceiptSnapshot;
const receiptContext = { company_name: "Acme Store", css: "" };

/** Wait for the fire-and-forget work openShift/checkShift start. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function mockServer(profile: Record<string, unknown>) {
	call.mockImplementation(async (method: string) => {
		switch (method) {
			case "xpos.api.shifts.open_shift":
			case "xpos.api.shifts.check_open_shift":
				return {
					pos_opening_shift: { name: "POS-OPE-0001" },
					pos_profile: { name: "Shop Floor", ...profile },
					company: "Acme",
					print_settings: { print_format: "XPOS Thermal Receipt" },
				};
			case "xpos.api.print_formats.get_receipt_context":
				return receiptContext;
			default:
				return [];
		}
	});
}

beforeEach(() => {
	setActivePinia(createPinia());
	vi.clearAllMocks();
	online.value = true;
	globalThis.__ = ((text: string) => text) as any;
	bridge.addPendingInvoice.mockResolvedValue({ id: 7, local_id: "inv_7" });
	bridge.getAllPendingInvoices.mockResolvedValue([]);
	bridge.countPendingInvoices.mockResolvedValue(0);
	bridge.countDeadLetters.mockResolvedValue(0);
});

describe("offline invoice queue", () => {
	it("stores the receipt with the queued invoice", async () => {
		const store = useOfflineStore();

		const result = await store.saveOffline(invoiceData, "Walk-in Customer", 10, [], receipt);

		expect(result).toEqual({ success: true, localId: 7 });
		expect(bridge.addPendingInvoice).toHaveBeenCalledWith({
			data: invoiceData,
			customer_name: "Walk-in Customer",
			grand_total: 10,
			receipt,
		});
	});

	it("sends only the invoice to the server when it syncs, never the receipt", async () => {
		bridge.getAllPendingInvoices.mockResolvedValue([
			{ id: 7, local_id: "inv_7", data: invoiceData, receipt, status: "pending", retry_count: 0 },
		]);
		call.mockResolvedValue({ name: "ACC-SINV-0001" });
		const store = useOfflineStore();
		store.isOnline = true as any;

		await store.syncPendingInvoices();

		const syncCall = call.mock.calls.find(([method]) => method === "xpos.api.invoices.create_invoice");
		expect(syncCall).toBeDefined();
		expect(syncCall![1]).toEqual({ data: JSON.stringify(invoiceData), local_id: "inv_7" });
		expect(syncCall![1].data).not.toContain("receipt");
		expect(bridge.deletePendingInvoice).toHaveBeenCalledWith(7);
	});
});

describe("receipt layout cache (browser)", () => {
	it("is filled when a shift opens on an offline-mode profile", async () => {
		mockServer({ use_offline_mode: 1 });
		const posStore = usePosStore();

		await posStore.openShift("Shop Floor", "Acme", []);
		await settle();

		expect(call).toHaveBeenCalledWith("xpos.api.print_formats.get_receipt_context", {
			pos_profile: "Shop Floor",
			print_format: expect.any(String),
		});
		expect(bridge.cacheReceiptContext).toHaveBeenCalledWith("Shop Floor", receiptContext);
	});

	it("is filled when an already-open shift is resumed on an offline-mode profile", async () => {
		mockServer({ use_offline_mode: 1 });
		const posStore = usePosStore();

		await posStore.checkExistingShift();
		await settle();

		expect(bridge.cacheReceiptContext).toHaveBeenCalledWith("Shop Floor", receiptContext);
	});

	it("is left alone when the profile does not use offline mode", async () => {
		mockServer({ use_offline_mode: 0 });
		const posStore = usePosStore();

		await posStore.openShift("Shop Floor", "Acme", []);
		await settle();

		expect(call).not.toHaveBeenCalledWith(
			"xpos.api.print_formats.get_receipt_context",
			expect.anything(),
		);
		expect(bridge.cacheReceiptContext).not.toHaveBeenCalled();
	});

	it("is not refreshed while offline", async () => {
		mockServer({ use_offline_mode: 1 });
		const posStore = usePosStore();
		await posStore.openShift("Shop Floor", "Acme", []);
		await settle();
		vi.clearAllMocks();

		online.value = false;
		posStore.posProfile = { name: "Shop Floor", use_offline_mode: 1 } as any;
		await posStore.openShift("Shop Floor", "Acme", []).catch(() => {});
		await settle();

		expect(bridge.cacheReceiptContext).not.toHaveBeenCalled();
	});
});
