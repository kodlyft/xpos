<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { useVirtualizer } from "@tanstack/vue-virtual";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, ChevronsUpDown, Table2 } from "lucide-vue-next";
import __ from "@/lib/translate";
import {
	columnCurrency,
	formatReportCell,
	isReportNumericColumn,
	type ReportColumn,
} from "@/services/reports";
import {
	clampWidth,
	defaultColumnWidth,
	treeIndent,
	type ReportSort,
	type TotalCell,
} from "@/services/reportGrid";
import { drillTarget, type DrillTarget } from "@/services/reportDrill";

export type ReportSortState = ReportSort;

const ROW_HEIGHT = 36;
const INDENT_PX = 16;

const props = withDefaults(
	defineProps<{
		columns: ReportColumn[];
		rows: Record<string, unknown>[];
		/** Index of each row in the complete result, for tree state. */
		sourceIndex?: number[];
		/** Server totals for the complete result. */
		totals?: Record<string, unknown>[];
		/** When set, shown instead of `totals`: a filtered view must not show complete-report totals. */
		filteredTotals?: Record<string, TotalCell> | null;
		currency: string;
		sortState: ReportSort | null;
		widths?: Record<string, number>;
		frozen?: number;
		sortable?: boolean;
		parents?: ReadonlySet<number>;
		collapsed?: ReadonlySet<number>;
		mixedCurrency?: boolean;
		emptyTitle?: string;
		emptyDescription?: string;
		label?: string;
	}>(),
	{
		sourceIndex: () => [],
		totals: () => [],
		filteredTotals: null,
		widths: () => ({}),
		frozen: 0,
		sortable: true,
		parents: () => new Set<number>(),
		collapsed: () => new Set<number>(),
		mixedCurrency: false,
		emptyTitle: "",
		emptyDescription: "",
		label: "",
	},
);

const emit = defineEmits<{
	(e: "sort-change", fieldname: string): void;
	(e: "resize", fieldname: string, width: number): void;
	(e: "toggle", sourceIndex: number): void;
	(e: "drill", target: DrillTarget): void;
}>();

const scroller = ref<HTMLElement | null>(null);
const active = ref({ row: 0, col: 0 });
const isRtl = () => document.documentElement.dir === "rtl";

const sizes = computed(() =>
	props.columns.map((column, index) =>
		clampWidth(props.widths[column.fieldname] ?? defaultColumnWidth(column, index)),
	),
);
const totalWidth = computed(() => sizes.value.reduce((sum, width) => sum + width, 0));
const offsets = computed(() => {
	let running = 0;
	return sizes.value.map((width) => {
		const start = running;
		running += width;
		return start;
	});
});
const treeColumn = computed(() =>
	props.parents.size > 0 || props.rows.some((r) => treeIndent(r) > 0) ? 0 : -1,
);

const virtualizer = useVirtualizer(
	computed(() => ({
		count: props.rows.length,
		getScrollElement: () => scroller.value,
		estimateSize: () => ROW_HEIGHT,
		overscan: 12,
	})),
);
const virtualRows = computed(() => virtualizer.value.getVirtualItems());
const totalHeight = computed(() => virtualizer.value.getTotalSize());

const footerRows = computed(() => {
	if (props.filteredTotals) {
		const cells: Record<string, unknown> = {};
		return Object.keys(props.filteredTotals).length > 0 ? [cells] : [];
	}
	return props.totals;
});

function frozenStyle(index: number): Record<string, string> {
	if (index >= props.frozen) return {};
	return { position: "sticky", insetInlineStart: `${offsets.value[index]}px`, zIndex: "5" };
}

function cellStyle(index: number): Record<string, string> {
	return { width: `${sizes.value[index]}px`, flex: "none", ...frozenStyle(index) };
}

function sortAria(column: ReportColumn): "ascending" | "descending" | "none" {
	if (!props.sortState || props.sortState.fieldname !== column.fieldname) return "none";
	return props.sortState.direction === "asc" ? "ascending" : "descending";
}

function text(column: ReportColumn, row: Record<string, unknown>): string {
	return formatReportCell(column, row[column.fieldname], props.currency, row);
}

function footerText(column: ReportColumn, row: Record<string, unknown>): string {
	if (props.filteredTotals) {
		const total = props.filteredTotals[column.fieldname];
		if (!total) return "";
		if (total.mixed || total.value === null) return __("Mixed");
		return formatReportCell(column, total.value, total.currency || props.currency, {});
	}
	const value = row[column.fieldname];
	if (value === null || value === undefined || value === "") return "";
	if (props.mixedCurrency && column.fieldtype === "Currency") return __("Mixed");
	return formatReportCell(column, value, props.currency, row);
}

function ariaCurrency(column: ReportColumn, row: Record<string, unknown>): string | undefined {
	return column.fieldtype === "Currency"
		? columnCurrency(column, row, props.currency) || undefined
		: undefined;
}

async function focusCell(row: number, col: number) {
	active.value = { row, col };
	virtualizer.value.scrollToIndex(row);
	await nextTick();
	await new Promise((resolve) => requestAnimationFrame(resolve));
	scroller.value?.querySelector<HTMLElement>(`[data-r="${row}"][data-c="${col}"]`)?.focus();
}

function onKeydown(event: KeyboardEvent) {
	const target = event.target as HTMLElement;
	if (!target.matches?.("[data-r]")) return;
	const lastRow = props.rows.length - 1;
	const lastCol = props.columns.length - 1;
	const { row, col } = active.value;
	const forward = isRtl() ? "ArrowLeft" : "ArrowRight";
	const back = isRtl() ? "ArrowRight" : "ArrowLeft";
	const page = Math.max(1, Math.floor((scroller.value?.clientHeight ?? 360) / ROW_HEIGHT) - 2);
	let next: [number, number] | null = null;
	switch (event.key) {
		case "ArrowDown":
			next = [Math.min(lastRow, row + 1), col];
			break;
		case "ArrowUp":
			next = [Math.max(0, row - 1), col];
			break;
		case forward:
			next = [row, Math.min(lastCol, col + 1)];
			break;
		case back:
			next = [row, Math.max(0, col - 1)];
			break;
		case "PageDown":
			next = [Math.min(lastRow, row + page), col];
			break;
		case "PageUp":
			next = [Math.max(0, row - page), col];
			break;
		case "Home":
			next = event.ctrlKey ? [0, 0] : [row, 0];
			break;
		case "End":
			next = event.ctrlKey ? [lastRow, lastCol] : [row, lastCol];
			break;
		case " ": {
			const source = props.sourceIndex[row];
			if (source !== undefined && props.parents.has(source) && col === treeColumn.value) {
				emit("toggle", source);
				event.preventDefault();
			}
			return;
		}
		default:
			return;
	}
	event.preventDefault();
	void focusCell(next[0], next[1]);
}

function drill(column: ReportColumn, row: Record<string, unknown>) {
	const targetDoc = drillTarget(column, row);
	if (targetDoc) emit("drill", targetDoc);
}

let drag: { fieldname: string; startX: number; startWidth: number } | null = null;

function startResize(event: PointerEvent, column: ReportColumn, index: number) {
	event.preventDefault();
	drag = { fieldname: column.fieldname, startX: event.clientX, startWidth: sizes.value[index] };
	(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}

function moveResize(event: PointerEvent) {
	if (!drag) return;
	const delta = (event.clientX - drag.startX) * (isRtl() ? -1 : 1);
	emit("resize", drag.fieldname, clampWidth(drag.startWidth + delta));
}

function endResize() {
	drag = null;
}

function keyResize(event: KeyboardEvent, column: ReportColumn, index: number) {
	const step = event.shiftKey ? 40 : 12;
	const grow = isRtl() ? "ArrowLeft" : "ArrowRight";
	const shrink = isRtl() ? "ArrowRight" : "ArrowLeft";
	if (event.key !== grow && event.key !== shrink) return;
	event.preventDefault();
	emit("resize", column.fieldname, clampWidth(sizes.value[index] + (event.key === grow ? step : -step)));
}
</script>

<template>
	<div
		v-if="rows.length === 0"
		class="flex flex-col items-center justify-center py-16 text-center"
		role="status"
	>
		<div class="mb-4 rounded-full bg-muted p-4">
			<Table2 class="h-6 w-6 text-muted-foreground" aria-hidden="true" />
		</div>
		<p class="text-base font-semibold text-foreground">{{ emptyTitle || __("No rows found") }}</p>
		<p class="mt-1 max-w-md text-sm text-muted-foreground">
			{{ emptyDescription || __("Try adjusting the filters or the search.") }}
		</p>
	</div>

	<div
		v-else
		ref="scroller"
		class="relative max-h-[68vh] min-h-48 overflow-auto rounded-xl border border-border bg-card text-sm shadow-inset"
		role="grid"
		:aria-label="label || __('Report results')"
		:aria-rowcount="rows.length + 1"
		:aria-colcount="columns.length"
		@keydown="onKeydown"
	>
		<div :style="{ width: `${totalWidth}px`, minWidth: '100%' }">
			<div role="row" class="sticky top-0 z-20 flex border-b border-border bg-muted">
				<div
					v-for="(column, index) in columns"
					:key="column.fieldname"
					role="columnheader"
					:aria-sort="sortAria(column)"
					:aria-colindex="index + 1"
					class="relative flex items-center bg-muted px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
					:class="isReportNumericColumn(column) ? 'justify-end' : 'justify-start'"
					:style="cellStyle(index)"
				>
					<button
						v-if="sortable"
						type="button"
						class="inline-flex min-w-0 items-center gap-1.5 rounded transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
						@click="emit('sort-change', column.fieldname)"
					>
						<span class="truncate" :title="column.label">{{ column.label }}</span>
						<ArrowUp
							v-if="sortAria(column) === 'ascending'"
							class="h-3.5 w-3.5 shrink-0 text-primary"
						/>
						<ArrowDown
							v-else-if="sortAria(column) === 'descending'"
							class="h-3.5 w-3.5 shrink-0 text-primary"
						/>
						<ChevronsUpDown v-else class="h-3.5 w-3.5 shrink-0 opacity-60" />
					</button>
					<span v-else class="truncate" :title="column.label">{{ column.label }}</span>
					<div
						role="separator"
						aria-orientation="vertical"
						tabindex="0"
						:aria-label="__('Resize column {0}', [column.label])"
						:aria-valuenow="sizes[index]"
						class="absolute inset-y-0 inset-e-0 w-2 cursor-col-resize touch-none hover:bg-primary/30 focus-visible:bg-primary/40 focus-visible:outline-none"
						@pointerdown="startResize($event, column, index)"
						@pointermove="moveResize"
						@pointerup="endResize"
						@pointercancel="endResize"
						@keydown="keyResize($event, column, index)"
					/>
				</div>
			</div>

			<div role="rowgroup" class="relative" :style="{ height: `${totalHeight}px` }">
				<div
					v-for="item in virtualRows"
					:key="String(item.key)"
					role="row"
					:aria-rowindex="item.index + 2"
					class="group absolute inset-s-0 top-0 flex border-b border-border/60"
					:style="{
						height: `${ROW_HEIGHT}px`,
						transform: `translateY(${item.start}px)`,
						width: '100%',
					}"
				>
					<div
						v-for="(column, index) in columns"
						:key="column.fieldname"
						role="gridcell"
						:aria-colindex="index + 1"
						:data-r="item.index"
						:data-c="index"
						:tabindex="active.row === item.index && active.col === index ? 0 : -1"
						class="flex items-center bg-card px-3 outline-none transition-colors duration-fast group-hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
						:class="isReportNumericColumn(column) ? 'justify-end tabular-nums' : 'justify-start'"
						:style="cellStyle(index)"
						:data-currency="ariaCurrency(column, rows[item.index])"
						@focus="active = { row: item.index, col: index }"
					>
						<div
							class="flex min-w-0 items-center gap-1"
							:style="
								index === treeColumn
									? { paddingInlineStart: `${treeIndent(rows[item.index]) * INDENT_PX}px` }
									: undefined
							"
						>
							<button
								v-if="
									index === treeColumn &&
									sourceIndex[item.index] !== undefined &&
									parents.has(sourceIndex[item.index])
								"
								type="button"
								tabindex="-1"
								class="shrink-0 rounded text-muted-foreground hover:text-foreground"
								:aria-expanded="!collapsed.has(sourceIndex[item.index])"
								:aria-label="
									collapsed.has(sourceIndex[item.index])
										? __('Expand group')
										: __('Collapse group')
								"
								@click="emit('toggle', sourceIndex[item.index])"
							>
								<ChevronRight
									v-if="collapsed.has(sourceIndex[item.index])"
									class="h-4 w-4 rtl:rotate-180"
								/>
								<ChevronDown v-else class="h-4 w-4" />
							</button>
							<button
								v-if="drillTarget(column, rows[item.index]) && text(column, rows[item.index])"
								type="button"
								class="truncate rounded text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
								:title="__('Open {0}', [text(column, rows[item.index])])"
								@click="drill(column, rows[item.index])"
							>
								{{ text(column, rows[item.index]) }}
							</button>
							<span
								v-else
								class="truncate"
								:class="{
									'font-semibold':
										index === treeColumn && parents.has(sourceIndex[item.index]),
								}"
								:title="text(column, rows[item.index])"
								>{{ text(column, rows[item.index]) }}</span
							>
						</div>
					</div>
				</div>
			</div>

			<div
				v-for="(total, totalIndex) in footerRows"
				:key="`total-${totalIndex}`"
				role="row"
				class="sticky bottom-0 z-20 flex border-t-2 border-border bg-muted font-semibold"
			>
				<div
					v-for="(column, index) in columns"
					:key="column.fieldname"
					role="gridcell"
					class="flex items-center bg-muted px-3 py-2"
					:class="isReportNumericColumn(column) ? 'justify-end tabular-nums' : 'justify-start'"
					:style="cellStyle(index)"
				>
					<span v-if="index === 0 && filteredTotals" class="truncate text-muted-foreground">
						{{ __("Filtered total") }}
					</span>
					<span v-else class="truncate">{{ footerText(column, total) }}</span>
				</div>
			</div>
		</div>
	</div>
</template>
