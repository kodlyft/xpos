<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
	AlertTriangle,
	ArrowLeft,
	ArrowUpDown,
	BarChart3,
	Copy,
	Download,
	Lock,
	Printer,
	RefreshCw,
	Search,
} from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select } from "@/components/ui/select";
import Pagination from "@/components/orders/Pagination.vue";
import ReportFilterBar from "@/components/reports/ReportFilterBar.vue";
import ReportTable, { type ReportSortState } from "@/components/reports/ReportTable.vue";
import __ from "@/lib/translate";
import { showError, showSuccess } from "@/services/api";
import { usePosStore } from "@/stores/posStore";
import { extractErrorMessage, formatQty, isOnline } from "@/utils";
import { printThermalReport } from "@/services/reportPrint";
import {
	buildInitialReportFilters,
	buildReportDelimitedRows,
	compareReportRows,
	fetchReportData,
	fetchReportMeta,
	formatReportCell,
	getReportDefinition,
	getVisibleReportColumns,
	hydrateReportFiltersFromQuery,
	isReportAccessible,
	isReportTotalRow,
	normalizeReportFilters,
	normalizeReportRows,
	serializeReportFiltersToQuery,
	type ReportColumn,
	type ReportFilterDefinition,
	type ReportSummaryItem,
} from "@/services/reports";

const route = useRoute();
const router = useRouter();
const posStore = usePosStore();

const reportCurrency = computed(() => posStore.invoiceCurrency || posStore.currency || "");

const activeReport = computed(() => getReportDefinition(route.params.reportSlug));
const isReportVisible = computed(() => Boolean(activeReport.value));
const isReportAllowed = computed(() => (activeReport.value ? isReportAccessible(activeReport.value) : false));

const filters = ref<ReportFilterDefinition[]>([]);
const filterState = reactive<Record<string, unknown>>({});
const reportColumns = ref<ReportColumn[]>([]);
const reportRows = ref<Record<string, unknown>[]>([]);
const reportSummary = ref<ReportSummaryItem[]>([]);
const isLoading = ref(false);
const errorMessage = ref("");
const lastRefreshedAt = ref<string | null>(null);
const searchTerm = ref("");
const sortState = ref<ReportSortState | null>(null);
const currentPage = ref(1);
const pageSize = ref(20);

const contextDefaults = computed(() => ({
	company: posStore.companyName || "",
	warehouse: posStore.warehouse || "",
}));

const visibleColumns = computed(() => getVisibleReportColumns(reportColumns.value));
const summaryItems = computed(() => reportSummary.value || []);
const dataRows = computed(() => reportRows.value.filter((row) => !isReportTotalRow(row)));
const totalRowsList = computed(() => reportRows.value.filter((row) => isReportTotalRow(row)));
const isInitialLoading = computed(() => isLoading.value && reportRows.value.length === 0);
const sortFieldOptions = computed(() =>
	visibleColumns.value.map((column) => ({ label: column.label, value: column.fieldname })),
);

const missingRequiredFilters = computed(() =>
	filters.value
		.filter((filter) => filter.required && !isValidFilterValue(filterState[filter.fieldname]))
		.map((filter) => filter.label),
);

const filteredRows = computed(() => {
	const query = searchTerm.value.trim().toLowerCase();
	const rows = dataRows.value.filter((row) => {
		if (!query) return true;
		return visibleColumns.value.some((column) =>
			formatReportCell(column, row[column.fieldname], reportCurrency.value)
				.toLowerCase()
				.includes(query),
		);
	});

	if (!sortState.value) return rows;
	const column = visibleColumns.value.find((item) => item.fieldname === sortState.value?.fieldname);
	if (!column) return rows;

	return [...rows]
		.map((row, index) => ({ row, index }))
		.sort((left, right) => {
			const comparison = compareReportRows(left.row, right.row, column);
			if (comparison !== 0) return sortState.value?.direction === "desc" ? -comparison : comparison;
			return left.index - right.index;
		})
		.map((entry) => entry.row);
});

const totalRows = computed(() => filteredRows.value.length);
const pagedRows = computed(() => {
	const start = (currentPage.value - 1) * pageSize.value;
	return filteredRows.value.slice(start, start + pageSize.value);
});

watch(
	() => route.params.reportSlug,
	() => {
		void loadReport();
	},
	{ immediate: true },
);

watch([searchTerm, sortState], () => {
	currentPage.value = 1;
});

function resetState() {
	for (const key of Object.keys(filterState)) delete filterState[key];
	filters.value = [];
	reportColumns.value = [];
	reportRows.value = [];
	reportSummary.value = [];
	errorMessage.value = "";
	searchTerm.value = "";
	sortState.value = null;
	currentPage.value = 1;
	lastRefreshedAt.value = null;
}

async function loadReport() {
	const report = activeReport.value;
	resetState();

	if (!report) {
		document.title = `${__("Reports")} | X POS`;
		return;
	}

	document.title = `${report.title} | X POS`;
	if (!isReportAccessible(report)) {
		errorMessage.value = __("You do not have access to this report.");
		return;
	}

	try {
		filters.value = await fetchReportMeta(report.reportName);
	} catch (error) {
		errorMessage.value = extractErrorMessage(error);
		showError(errorMessage.value);
		return;
	}

	Object.assign(filterState, buildInitialReportFilters(filters.value, contextDefaults.value));
	Object.assign(
		filterState,
		hydrateReportFiltersFromQuery(
			filters.value,
			route.query as Record<string, string | string[] | null | undefined>,
		),
	);
	await runReport();
}

function setFilterValue(fieldname: string, value: unknown) {
	filterState[fieldname] = value;
}

function isValidFilterValue(value: unknown): boolean {
	if (Array.isArray(value)) return value.length > 0;
	if (value === null || value === undefined) return false;
	if (typeof value === "string") return value.trim().length > 0;
	return true;
}

async function runReport() {
	const report = activeReport.value;
	if (!report) return;

	if (!isReportAccessible(report)) {
		errorMessage.value = __("You do not have access to this report.");
		showError(errorMessage.value);
		return;
	}

	if (!isOnline()) {
		errorMessage.value = __("You are offline. Connect to the server and try again.");
		showError(errorMessage.value);
		return;
	}

	if (missingRequiredFilters.value.length > 0) {
		errorMessage.value = __("Please fill the required filters: {0}", [
			missingRequiredFilters.value.join(", "),
		]);
		showError(errorMessage.value);
		return;
	}

	isLoading.value = true;
	errorMessage.value = "";

	try {
		const payload = normalizeReportFilters(filters.value, filterState);
		const response = await fetchReportData(report.reportName, payload);
		reportColumns.value = response.columns || [];
		reportRows.value = normalizeReportRows(
			reportColumns.value,
			Array.isArray(response.result) ? response.result : [],
			{
				addTotalRow: response.add_total_row,
				skipTotalRow: response.skip_total_row,
			},
		);
		reportSummary.value = Array.isArray(response.report_summary) ? response.report_summary : [];
		lastRefreshedAt.value = new Date().toLocaleString();
		currentPage.value = 1;
		await router.replace({
			path: route.path,
			query: serializeReportFiltersToQuery(filters.value, filterState),
		});
		if (response.message) showSuccess(response.message);
	} catch (error) {
		errorMessage.value = extractErrorMessage(error);
		showError(errorMessage.value);
	} finally {
		isLoading.value = false;
	}
}

function resetFilters() {
	Object.assign(filterState, buildInitialReportFilters(filters.value, contextDefaults.value));
	searchTerm.value = "";
	sortState.value = null;
	currentPage.value = 1;
	void runReport();
}

function toggleSort(fieldname: string) {
	if (!sortState.value || sortState.value.fieldname !== fieldname) {
		sortState.value = { fieldname, direction: "asc" };
		return;
	}
	if (sortState.value.direction === "asc") {
		sortState.value = { fieldname, direction: "desc" };
		return;
	}
	sortState.value = null;
}

function setSortField(fieldname: string | undefined) {
	if (!fieldname) {
		sortState.value = null;
		return;
	}
	if (!sortState.value || sortState.value.fieldname !== fieldname) {
		sortState.value = { fieldname, direction: "asc" };
	}
}

function toggleSortDirection() {
	if (!sortState.value) return;
	sortState.value = {
		fieldname: sortState.value.fieldname,
		direction: sortState.value.direction === "asc" ? "desc" : "asc",
	};
}

async function copyText(text: string) {
	if (navigator.clipboard?.writeText) {
		await navigator.clipboard.writeText(text);
		return;
	}
	const textarea = document.createElement("textarea");
	textarea.value = text;
	document.body.appendChild(textarea);
	textarea.select();
	document.execCommand("copy");
	document.body.removeChild(textarea);
}

async function copyReport() {
	if (filteredRows.value.length === 0) {
		showError(__("No rows to copy."));
		return;
	}
	const rows = [...filteredRows.value, ...totalRowsList.value];
	await copyText(buildReportDelimitedRows(visibleColumns.value, rows, reportCurrency.value, "\t"));
	showSuccess(__("Copied {0} rows to clipboard.", [String(filteredRows.value.length)]));
}

function slugify(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function exportCsv() {
	if (filteredRows.value.length === 0) {
		showError(__("No rows available to export."));
		return;
	}
	const rows = [...filteredRows.value, ...totalRowsList.value];
	const csv = buildReportDelimitedRows(visibleColumns.value, rows, reportCurrency.value, ",");
	const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
	const downloadUrl = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = downloadUrl;
	anchor.download = `${slugify(activeReport.value?.title || "report")}-${new Date().toISOString().slice(0, 10)}.csv`;
	anchor.style.display = "none";
	document.body.appendChild(anchor);
	anchor.click();
	document.body.removeChild(anchor);
	URL.revokeObjectURL(downloadUrl);
	showSuccess(__("Report exported as CSV."));
}

function printThermal() {
	if (filteredRows.value.length === 0) {
		showError(__("No data to print."));
		return;
	}
	const ok = printThermalReport({
		title: activeReport.value?.title || __("Report"),
		filters: filters.value,
		values: filterState,
		columns: visibleColumns.value,
		rows: filteredRows.value,
	});
	if (!ok) showError(__("Print window blocked. Please allow popups and try again."));
}

function formatSummaryValue(value: unknown): string {
	if (value === null || value === undefined || value === "") return "-";
	if (Array.isArray(value)) return value.map((item) => String(item)).join(", ");
	if (typeof value === "number") return formatQty(value);
	return String(value);
}

function goBack() {
	router.push("/reports");
}
</script>

<template>
	<div class="flex h-full flex-col overflow-hidden bg-background">
		<div
			v-if="!isReportVisible || !activeReport"
			class="flex h-full items-center justify-center p-6 text-center"
		>
			<Card class="w-full max-w-xl border-border/70 bg-card p-8">
				<div class="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-muted">
					<BarChart3 class="h-7 w-7 text-muted-foreground" />
				</div>
				<h1 class="text-xl font-semibold text-foreground">{{ __("Report not found") }}</h1>
				<p class="mt-2 text-sm text-muted-foreground">
					{{ __("The report route does not match any configured report.") }}
				</p>
				<div class="mt-6 flex justify-center">
					<Button @click="goBack">
						<ArrowLeft class="h-4 w-4" />
						{{ __("Back to Reports") }}
					</Button>
				</div>
			</Card>
		</div>

		<div v-else-if="!isReportAllowed" class="flex h-full items-center justify-center p-6 text-center">
			<Card class="w-full max-w-xl border-border/70 bg-card p-8">
				<div
					class="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-destructive/10 text-destructive"
				>
					<Lock class="h-7 w-7" />
				</div>
				<h1 class="text-xl font-semibold text-foreground">{{ __("Access restricted") }}</h1>
				<p class="mt-2 text-sm text-muted-foreground">
					{{ __("You do not have permission to open this report from the app.") }}
				</p>
				<div class="mt-6 flex justify-center">
					<Button variant="outline" @click="goBack">
						<ArrowLeft class="h-4 w-4" />
						{{ __("Back to Reports") }}
					</Button>
				</div>
			</Card>
		</div>

		<ScrollArea v-else class="flex-1">
			<div class="space-y-4 p-3 pb-4 sm:p-4">
				<div class="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
					<div class="min-w-0 space-y-1">
						<div class="flex flex-wrap items-center gap-2">
							<Button variant="ghost" size="icon-sm" @click="goBack">
								<ArrowLeft class="h-4 w-4" />
							</Button>
							<h1 class="truncate text-xl font-bold tracking-tight text-foreground sm:text-2xl">
								{{ activeReport.title }}
							</h1>
							<Badge variant="outline">{{ activeReport.category }}</Badge>
						</div>
						<p class="text-sm text-muted-foreground">{{ activeReport.description }}</p>
					</div>

					<div class="flex flex-wrap items-center gap-2">
						<Button
							variant="outline"
							size="sm"
							class="h-9"
							:disabled="isLoading"
							@click="runReport"
						>
							<RefreshCw class="h-4 w-4" :class="{ 'animate-spin': isLoading }" />
							{{ __("Refresh") }}
						</Button>
						<Button variant="outline" size="sm" class="h-9" @click="copyReport">
							<Copy class="h-4 w-4" />
							{{ __("Copy") }}
						</Button>
						<Button variant="outline" size="sm" class="h-9" @click="exportCsv">
							<Download class="h-4 w-4" />
							{{ __("Export CSV") }}
						</Button>
						<Button
							v-if="activeReport.thermalPrint"
							variant="outline"
							size="sm"
							class="h-9"
							:disabled="reportRows.length === 0"
							@click="printThermal"
						>
							<Printer class="h-4 w-4" />
							{{ __("Print") }}
						</Button>
					</div>
				</div>

				<ReportFilterBar
					:filters="filters"
					:values="filterState"
					:loading="isLoading"
					:missing-required="missingRequiredFilters"
					@set="setFilterValue"
					@apply="runReport"
					@reset="resetFilters"
				/>

				<div v-if="summaryItems.length > 0" class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
					<Card
						v-for="item in summaryItems"
						:key="item.key || item.label || String(item.value)"
						class="border-border/70 bg-card p-4"
					>
						<p class="text-xs uppercase tracking-[0.18em] text-muted-foreground">
							{{ item.label || __("Summary") }}
						</p>
						<p class="mt-1 wrap-break-word text-lg font-semibold text-foreground">
							{{ formatSummaryValue(item.value) }}
						</p>
					</Card>
				</div>

				<Card class="border-border/70 bg-card p-4 sm:p-5">
					<div class="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
						<div class="flex w-full items-center gap-2 lg:max-w-xl">
							<div class="relative flex-1">
								<Search
									class="pointer-events-none absolute inset-s-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
								/>
								<Input
									v-model="searchTerm"
									:placeholder="__('Search rows...')"
									class="h-10 ps-9"
								/>
							</div>
							<Select
								:items="sortFieldOptions"
								:placeholder="__('Sort by')"
								:model-value="sortState?.fieldname || ''"
								@update:model-value="setSortField"
							/>
							<Button
								variant="outline"
								size="icon-sm"
								:disabled="!sortState"
								@click="toggleSortDirection"
							>
								<ArrowUpDown class="h-4 w-4" />
							</Button>
						</div>
						<div class="flex items-center gap-2 text-sm text-muted-foreground">
							<Badge variant="secondary">{{ totalRows }} {{ __("rows") }}</Badge>
							<span v-if="lastRefreshedAt" class="text-xs">{{ lastRefreshedAt }}</span>
						</div>
					</div>

					<div
						v-if="errorMessage"
						class="mb-4 rounded-xl border border-destructive/20 bg-destructive/5 p-4"
					>
						<div class="flex items-start gap-3">
							<AlertTriangle class="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
							<div class="min-w-0 flex-1 space-y-3">
								<p class="text-sm font-medium text-foreground">{{ errorMessage }}</p>
								<Button size="sm" @click="runReport">
									<RefreshCw class="h-4 w-4" />
									{{ __("Try Again") }}
								</Button>
							</div>
						</div>
					</div>

					<div v-if="isInitialLoading" class="space-y-2">
						<div v-for="i in 6" :key="i" class="skeleton h-10 w-full rounded-lg"></div>
					</div>

					<div v-else>
						<ReportTable
							:columns="visibleColumns"
							:rows="pagedRows"
							:totals="totalRowsList"
							:currency="reportCurrency"
							:sort-state="sortState"
							:empty-title="__('No rows found')"
							:empty-description="__('Try adjusting the filters, search term, or sort order.')"
							@sort-change="toggleSort"
						/>

						<Pagination
							v-if="totalRows > 0"
							class="mt-4"
							:total="totalRows"
							:page-size="pageSize"
							:current-page="currentPage"
							@update:current-page="currentPage = $event"
							@update:page-size="pageSize = $event"
						/>
					</div>
				</Card>
			</div>
		</ScrollArea>
	</div>
</template>
