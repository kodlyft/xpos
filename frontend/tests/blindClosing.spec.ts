/**
 * @vitest-environment jsdom
 *
 * hide_expected_amount: the closing dialog renders what the server sends. On a
 * blind profile that is no expected figure at all, and nothing may be pre-filled.
 */
import { describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";

vi.mock("@/services/api", () => ({ call: vi.fn(), showError: vi.fn(), showSuccess: vi.fn() }));
vi.mock("@/services/userRights", () => ({ hasPermission: () => true }));

const summary = { value: {} as Record<string, unknown> };
vi.mock("@/stores/posStore", () => ({
	usePosStore: () => ({
		showClosingDialog: true,
		cashModeOfPayment: "Cash",
		invoiceCurrency: "USD",
		giftCardMode: "",
		fetchClosingData: async () => summary.value,
		closeShift: vi.fn(),
	}),
}));

import ClosingDialog from "@/components/dialogs/ClosingDialog.vue";

async function render(data: Record<string, unknown>) {
	summary.value = data;
	document.body.innerHTML = "";
	mount(ClosingDialog, { attachTo: document.body });
	await flushPromises();
	return document.body;
}

function countedInput(body: HTMLElement): HTMLInputElement | null {
	return body.querySelector("[data-testid=closing-input] input, input[data-testid=closing-input]");
}

describe("ClosingDialog", () => {
	it("shows expected and pre-fills the count for a supervisor", async () => {
		const body = await render({
			total_invoices: 2,
			grand_total: 100,
			expected_amounts: { Cash: { amount: 600, currency: "USD" } },
			opening_balances: { Cash: { amount: 500, currency: "USD" } },
		});
		expect(body.querySelector("[data-testid=closing-expected]")?.textContent).toContain("600");
		expect(body.querySelector("[data-testid=blind-closing-note]")).toBeNull();
		expect(countedInput(body)?.value).toContain("600");
	});

	it("is blind: no expected, no difference, nothing pre-filled", async () => {
		const body = await render({
			blind_closing: true,
			total_invoices: 2,
			payment_modes: { Cash: { currency: "USD" } },
		});
		expect(body.querySelector("[data-testid=blind-closing-note]")).not.toBeNull();
		expect(body.querySelector("[data-testid=closing-expected]")).toBeNull();
		expect(body.querySelector("[data-testid=closing-difference]")).toBeNull();
		expect(body.querySelectorAll("[data-testid=closing-row]")).toHaveLength(1);
		const input = countedInput(body);
		expect(input).not.toBeNull();
		expect(Number(input!.value || 0)).toBe(0);
	});
});
