/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
const queue = vi.hoisted(() => ({ add: vi.fn(), remove: vi.fn() }));
vi.mock("@/services/dbBridge", () => ({ addPendingInvoice: queue.add, deletePendingInvoice: queue.remove }));
vi.mock("@/utils", () => ({ isNetworkError: (e: Error) => e.message === "lost response" }));
import { newInvoiceId, submitDurableInvoice } from "@/services/invoiceSubmission";
import type { InvoiceData, ReceiptSnapshot } from "@/types/pos.types";
const receipt = { grand_total: 36 } as ReceiptSnapshot;
beforeEach(() => {
	vi.resetAllMocks();
	queue.add.mockResolvedValue({ id: 7 });
});
describe("a cashier's durable sale", () => {
	it("journals before the first request and retries a lost response with the same identity", async () => {
		const data = { local_id: newInvoiceId(), customer: "Madison" } as InvoiceData;
		const server = new Map<string, string>();
		const send = vi.fn(async () => {
			expect(queue.add).toHaveBeenCalledWith(expect.objectContaining({ data }));
			server.set(data.local_id!, server.get(data.local_id!) || "INV-1");
			if (send.mock.calls.length === 1) throw new Error("lost response");
			return server.get(data.local_id!);
		});
		await expect(submitDurableInvoice(data, receipt, send)).rejects.toThrow("lost response");
		expect(queue.remove).not.toHaveBeenCalled();
		// The persisted payload survives a page reload; recovery uses its original identity.
		const recovered = JSON.parse(JSON.stringify(queue.add.mock.calls[0][0].data));
		expect(await submitDurableInvoice(recovered, receipt, send)).toBe("INV-1");
		expect(server.size).toBe(1);
		expect(queue.remove).toHaveBeenCalledWith(7);
	});
	it("does not send if durable storage fails", async () => {
		queue.add.mockRejectedValue(new Error("storage full"));
		const send = vi.fn();
		await expect(submitDurableInvoice({} as InvoiceData, receipt, send)).rejects.toThrow("storage full");
		expect(send).not.toHaveBeenCalled();
	});
	it("removes a definitively rejected sale instead of silently queueing it", async () => {
		await expect(
			submitDurableInvoice({} as InvoiceData, receipt, async () => {
				throw Object.assign(new Error("invalid payment"), { excType: "ValidationError" });
			}),
		).rejects.toThrow("invalid payment");
		expect(queue.remove).toHaveBeenCalledWith(7);
	});
	it("keeps a confirmed sale successful if queue cleanup fails", async () => {
		queue.remove.mockRejectedValue(new Error("disk"));
		expect(await submitDurableInvoice({} as InvoiceData, receipt, async () => "INV-1")).toBe("INV-1");
	});
	it("uses independent identities for separate sales", () => {
		expect(newInvoiceId()).not.toBe(newInvoiceId());
	});
});
