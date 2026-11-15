/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { reactive } from "vue";

const offline = reactive({
	dbState: "ready",
	storageHealth: null as unknown,
	offlineModeEnabled: true,
	storagePersisted: false as boolean | null,
	pendingInvoices: [] as { id: string; status: string }[],
});

vi.mock("@/stores/offlineStore", () => ({ useOfflineStore: () => offline }));
vi.mock("@/stores/cartStore", () => ({
	useCartStore: () => ({ isEmpty: true, showPaymentDialog: false }),
}));
vi.mock("@/services/appUpdate", async () => {
	const { ref } = await import("vue");
	return {
		applyUpdate: vi.fn(),
		reloadForUpdate: vi.fn(),
		reloadNeeded: ref(false),
		updateWaiting: ref(false),
		updateBlockers: () => [],
	};
});
vi.mock("@/lib/translate", () => ({
	default: (text: string) => text,
}));

import AppStatusBanner from "@/components/offline/AppStatusBanner.vue";

const BANNER = '[data-testid="app-status-banner"]';

describe("AppStatusBanner persistence notice", () => {
	beforeEach(() => {
		localStorage.clear();
		offline.pendingInvoices = [];
		offline.storagePersisted = false;
	});

	it("stays hidden when nothing is queued offline", () => {
		expect(mount(AppStatusBanner).find(BANNER).exists()).toBe(false);
	});

	it("shows when queued sales exist and can be dismissed for good", async () => {
		offline.pendingInvoices = [{ id: "a", status: "pending" }];
		const wrapper = mount(AppStatusBanner);
		expect(wrapper.text()).toContain("may clear offline data");

		await wrapper.find("button").trigger("click");
		expect(wrapper.find(BANNER).exists()).toBe(false);

		expect(mount(AppStatusBanner).find(BANNER).exists()).toBe(false);
	});

	it("is an in-flow block that does not cover the header", () => {
		offline.pendingInvoices = [{ id: "a", status: "pending" }];
		const classes = mount(AppStatusBanner).find(BANNER).classes();
		expect(classes).not.toContain("fixed");
		expect(classes).toContain("shrink-0");
	});
});
