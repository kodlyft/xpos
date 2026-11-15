<script setup lang="ts">
import { computed } from "vue";
import __ from "@/lib/translate";
import { formatFloat } from "@/utils/numberFormat";

const props = defineProps<{ chart: unknown }>();

const MAX_POINTS = 40;
const SERIES = ["var(--primary)", "var(--info)", "var(--success)", "var(--warning)"];

const SUPPORTED = ["bar", "line"] as const;
const DASH = ["", "6 3", "2 3", "8 3 2 3"];

interface Parsed {
	type: (typeof SUPPORTED)[number];
	totalSeries: number;
	labels: string[];
	total: number;
	series: { name: string; values: number[] }[];
	max: number;
	min: number;
}

type ChartInput = { type?: string; data?: { labels?: unknown[]; datasets?: unknown[] } } | null;

const unsupportedType = computed<string | null>(() => {
	const chart = props.chart as ChartInput;
	if (!chart || typeof chart !== "object") return null;
	const type = typeof chart.type === "string" && chart.type ? chart.type : "bar";
	return (SUPPORTED as readonly string[]).includes(type) ? null : type;
});

const parsed = computed<Parsed | null>(() => {
	const chart = props.chart as ChartInput;
	if (unsupportedType.value) return null;
	const labels = chart?.data?.labels;
	const datasets = chart?.data?.datasets;
	if (!Array.isArray(labels) || !Array.isArray(datasets) || labels.length === 0) return null;
	const series = datasets
		.map((set) => {
			const entry = set as { name?: unknown; values?: unknown[] };
			return {
				name: String(entry.name ?? ""),
				values: (Array.isArray(entry.values) ? entry.values : [])
					.slice(0, MAX_POINTS)
					.map((value) => (Number.isFinite(Number(value)) ? Number(value) : 0)),
			};
		})
		.filter((set) => set.values.length > 0)
		.slice(0, SERIES.length);
	if (series.length === 0) return null;
	const all = series.flatMap((set) => set.values);
	return {
		type: chart?.type === "line" ? "line" : "bar",
		totalSeries: datasets.length,
		labels: labels.slice(0, MAX_POINTS).map((label) => String(label)),
		total: labels.length,
		series,
		max: Math.max(0, ...all),
		min: Math.min(0, ...all),
	};
});

const W = 640;
const MAX_BAR = 44;
const H = 180;
const PAD = 8;

function y(value: number, chart: Parsed): number {
	const span = chart.max - chart.min || 1;
	return PAD + (1 - (value - chart.min) / span) * (H - PAD * 2);
}

function x(index: number, chart: Parsed): number {
	return PAD + ((index + 0.5) / chart.labels.length) * (W - PAD * 2);
}

function barWidth(chart: Parsed): number {
	return Math.min(MAX_BAR, ((W / chart.labels.length) * 0.7) / chart.series.length);
}

function barX(index: number, series: number, chart: Parsed): number {
	const width = barWidth(chart);
	return x(index, chart) - (width * chart.series.length) / 2 + series * width;
}

const summary = computed(() =>
	parsed.value
		? __("{0} chart with {1} points and {2} series.", [
				parsed.value.type === "line" ? __("Line") : __("Bar"),
				String(parsed.value.labels.length),
				String(parsed.value.series.length),
			])
		: "",
);
</script>

<template>
	<p
		v-if="unsupportedType"
		class="rounded-2xl border border-border bg-card/50 p-3 text-sm text-muted-foreground"
		data-testid="chart-unsupported"
		role="note"
	>
		{{
			__("This report's {0} chart cannot be shown here. Its figures are in the table.", [
				unsupportedType,
			])
		}}
	</p>
	<figure v-else-if="parsed" class="rounded-2xl border border-border bg-card/50 p-3 shadow-raised">
		<svg
			:viewBox="`0 0 ${W} ${H}`"
			class="h-44 w-full"
			role="img"
			:aria-label="summary"
			preserveAspectRatio="xMidYMid meet"
		>
			<line :x1="PAD" :x2="W - PAD" :y1="y(0, parsed)" :y2="y(0, parsed)" stroke="hsl(var(--border))" />
			<text :x="PAD" :y="PAD + 8" font-size="11" fill="hsl(var(--muted-foreground))">
				{{ formatFloat(parsed.max) }}
			</text>
			<text
				v-if="parsed.min < 0"
				:x="PAD"
				:y="H - PAD"
				font-size="11"
				fill="hsl(var(--muted-foreground))"
			>
				{{ formatFloat(parsed.min) }}
			</text>
			<template v-for="(set, s) in parsed.series" :key="set.name || s">
				<template v-if="parsed.type === 'bar'">
					<rect
						v-for="(value, i) in set.values"
						:key="i"
						:x="barX(i, s, parsed)"
						:y="Math.min(y(value, parsed), y(0, parsed))"
						:width="barWidth(parsed)"
						:height="Math.max(1, Math.abs(y(value, parsed) - y(0, parsed)))"
						:fill="`hsl(${SERIES[s]})`"
					/>
				</template>
				<template v-else>
					<polyline
						fill="none"
						stroke-width="2"
						:stroke="`hsl(${SERIES[s]})`"
						:stroke-dasharray="DASH[s]"
						:points="
							set.values.map((value, i) => `${x(i, parsed!)},${y(value, parsed!)}`).join(' ')
						"
					/>
					<circle
						v-for="(value, i) in set.values"
						:key="i"
						:cx="x(i, parsed)"
						:cy="y(value, parsed)"
						r="3"
						:fill="`hsl(${SERIES[s]})`"
					/>
				</template>
			</template>
		</svg>
		<figcaption class="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
			<span v-for="(set, s) in parsed.series" :key="s" class="inline-flex items-center gap-1">
				<span
					class="h-2 w-2 rounded-full"
					:style="{ background: `hsl(${SERIES[s]})` }"
					aria-hidden="true"
				/>
				{{ set.name || __("Series {0}", [String(s + 1)]) }}
			</span>
			<span v-if="parsed.totalSeries > parsed.series.length">
				{{
					__("Showing the first {0} of {1} series.", [
						String(parsed.series.length),
						String(parsed.totalSeries),
					])
				}}
			</span>
			<span v-if="parsed.total > parsed.labels.length">
				{{
					__("Showing the first {0} of {1} points.", [
						String(parsed.labels.length),
						String(parsed.total),
					])
				}}
			</span>
		</figcaption>
		<details class="mt-2 text-xs" data-testid="chart-values">
			<summary class="cursor-pointer text-muted-foreground">{{ __("Show values") }}</summary>
			<table class="mt-1 w-full text-start">
				<caption class="sr-only">
					{{
						summary
					}}
				</caption>
				<thead>
					<tr>
						<th scope="col">{{ __("Label") }}</th>
						<th v-for="(set, s) in parsed.series" :key="s" scope="col">{{ set.name }}</th>
					</tr>
				</thead>
				<tbody>
					<tr v-for="(label, i) in parsed.labels" :key="i">
						<th scope="row">{{ label }}</th>
						<td v-for="(set, s) in parsed.series" :key="s">
							{{ formatFloat(set.values[i] ?? 0) }}
						</td>
					</tr>
				</tbody>
			</table>
		</details>
	</figure>
</template>
