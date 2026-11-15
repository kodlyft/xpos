/**
 * @vitest-environment jsdom
 *
 * ReportChart draws only the chart types it can show faithfully and says so for the rest.
 */
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import ReportChart from "@/components/reports/ReportChart.vue";

const data = (extra: Record<string, unknown> = {}, sets = 1, points = 3) => ({
	data: {
		labels: Array.from({ length: points }, (_, i) => `L${i + 1}`),
		datasets: Array.from({ length: sets }, (_, s) => ({
			name: `S${s + 1}`,
			values: Array.from({ length: points }, (_, i) => (i + 1) * (s + 1) * 1000),
		})),
	},
	...extra,
});

describe("ReportChart", () => {
	it("draws bar and line charts", () => {
		expect(mount(ReportChart, { props: { chart: data({ type: "bar" }) } }).findAll("rect")).toHaveLength(
			3,
		);
		const line = mount(ReportChart, { props: { chart: data({ type: "line" }) } });
		expect(line.find("polyline").exists()).toBe(true);
		expect(line.findAll("circle")).toHaveLength(3);
	});

	it.each(["pie", "donut", "percentage", "heatmap", "axis-mixed"])(
		"does not pass a %s chart off as a bar chart",
		(type) => {
			const wrapper = mount(ReportChart, { props: { chart: data({ type }) } });
			expect(wrapper.find("svg").exists()).toBe(false);
			expect(wrapper.get("[data-testid=chart-unsupported]").text()).toContain(type);
		},
	);

	it("tells the user when series or points were cut", () => {
		const wrapper = mount(ReportChart, { props: { chart: data({ type: "bar" }, 6, 60) } });
		expect(wrapper.text()).toContain("Showing the first 4 of 6 series.");
		expect(wrapper.text()).toContain("Showing the first 40 of 60 points.");
	});

	it("labels the scale and lists the readable values", () => {
		const wrapper = mount(ReportChart, { props: { chart: data({ type: "bar" }) } });
		expect(wrapper.find("svg text").text()).toContain("3");
		const values = wrapper.get("[data-testid=chart-values]");
		expect(values.text()).toContain("L2");
		expect(values.text()).toContain("S1");
		expect(wrapper.find("table").classes()).not.toContain("sr-only");
	});

	it("renders nothing for a chart with no data", () => {
		const wrapper = mount(ReportChart, {
			props: { chart: { type: "bar", data: { labels: [], datasets: [] } } },
		});
		expect(wrapper.find("figure").exists()).toBe(false);
		expect(wrapper.find("[data-testid=chart-unsupported]").exists()).toBe(false);
	});
});
