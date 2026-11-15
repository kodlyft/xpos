/**
 * @vitest-environment jsdom
 *
 * Order History filter bar: Posting Date uses the shared date picker and filters stay labelled.
 */
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import ListFilterBar from "@/components/core/ListFilterBar.vue";
import Pagination from "@/components/orders/Pagination.vue";
import type { DocField } from "@/services/doctypeMeta";

const fields: DocField[] = [
	{ fieldname: "posting_date", fieldtype: "Date", label: "Posting Date", in_standard_filter: 1 },
	{
		fieldname: "status",
		fieldtype: "Select",
		label: "Status",
		options: "Paid\nUnpaid",
		in_standard_filter: 1,
	},
];

function mountBar(modelFilters: Record<string, unknown> = {}) {
	return mount(ListFilterBar, { props: { fields, modelFilters } });
}

describe("ListFilterBar", () => {
	it("renders the date picker for Date fields and a label for every control", () => {
		const wrapper = mountBar();
		expect(wrapper.find("input[aria-label='Posting Date']").exists()).toBe(true);
		const labels = wrapper.findAll("label").map((l) => l.text());
		expect(labels).toEqual(expect.arrayContaining(["ID", "Posting Date", "Status"]));
		expect(wrapper.find("button[aria-label='Status']").exists()).toBe(true);
	});

	it("shows the stored YYYY-MM-DD value and emits an empty filter set when cleared", async () => {
		const wrapper = mountBar({ posting_date: "2026-10-25" });
		const input = wrapper.get("input[aria-label='Posting Date']");
		expect((input.element as HTMLInputElement).value).toBe("25/10/2026");

		await wrapper.vm.$nextTick();
		await wrapper.get("button[aria-label='Clear']").trigger("click");
		const emitted = wrapper.emitted("update:modelFilters");
		expect(emitted?.at(-1)?.[0]).toEqual({});
	});

	it("emits a date-only value when a date is typed", async () => {
		const wrapper = mountBar();
		const input = wrapper.get("input[aria-label='Posting Date']");
		(input.element as HTMLInputElement).value = "03/11/2026";
		await input.trigger("change");
		expect(wrapper.emitted("update:modelFilters")?.at(-1)?.[0]).toEqual({ posting_date: "2026-11-03" });
	});
});

describe("Pagination", () => {
	it("labels its controls and emits the requested page", async () => {
		const wrapper = mount(Pagination, { props: { total: 100, pageSize: 20, currentPage: 1 } });
		await wrapper.get("button[aria-label='Next page']").trigger("click");
		expect(wrapper.emitted("update:currentPage")?.[0]).toEqual([2]);
		expect(wrapper.get("button[aria-current='page']").text()).toBe("1");
	});
});
