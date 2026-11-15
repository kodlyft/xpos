<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
	AlertTriangle,
	ArrowLeft,
	BarChart3,
	Clock,
	Copy,
	Download,
	Lock,
	Printer,
	RefreshCw,
	Search,
	Share2,
	Star,
} from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { PageHeader } from "@/components/ui/page";
import { Popover, PopoverContentStyled, PopoverMenuItem, PopoverTrigger } from "@/components/ui/popover";
import ReportFilterBar from "@/components/reports/ReportFilterBar.vue";
import ReportTable from "@/components/reports/ReportTable.vue";
import ReportSummaryStrip from "@/components/reports/ReportSummaryStrip.vue";
import ReportChart from "@/components/reports/ReportChart.vue";
import ReportColumnsMenu from "@/components/reports/ReportColumnsMenu.vue";
import ReportViewsMenu from "@/components/reports/ReportViewsMenu.vue";
import __ from "@/lib/translate";
import { showError, showInfo, showSuccess } from "@/services/api";
import { useAuthStore } from "@/stores/authStore";
import { usePosStore } from "@/stores/posStore";
import { extractErrorMessage, isOnline } from "@/utils";
import {
	buildInitialReportFilters,
	columnCurrency,
	fetchReportCatalog,
	fetchReportData,
	fetchReportMeta,
	findReportDefinition,
	getReportPreparedState,
	getVisibleReportColumns,
	hydrateReportFiltersFromQuery,
	isReportRunnable,
	isReportTotalRow,
	missingRequiredReportFilters,
	normalizeReportFilters,
	normalizeReportRows,
	REPORT_EXPORT_ROW_LIMIT,
	serializeReportFiltersToQuery,
	splitShiftBoundFilters,
	validateReportFilters,
	type ReportColumn,
	type ReportDefinition,
	type ReportFilterDefinition,
	type ReportPreparedState,
	type ReportQueryResult,
	type ReportSummaryItem,
} from "@/services/reports";
import {
	applyLayout,
	computeFilteredTotals,
	emptyLayout,
	hasMixedCurrency,
	isTreeReport,
	reconcileLayout,
	rowHasChildren,
	selectReportRows,
	type ReportLayout,
	type ReportSort,
} from "@/services/reportGrid";
import { buildReportExport, CSV_BOM, reportFileName, ReportExportLimitError } from "@/services/reportExport";
import {
	openReportPrintWindow,
	pickPrintFormat,
	writeReportPrintWindow,
	type ReportPrintOptions,
} from "@/services/reportPrint";
import { createRunGuard } from "@/services/reportRunGuard";
import { createReportViewStore, reportStorageKey, type ReportView } from "@/services/reportViews";
import { openDocument, type DrillTarget } from "@/services/reportDrill";

type ViewerStatus = "idle" | "loading" | "ready" | "error";

interface LoadedResult {
	columns: ReportColumn[];
	rows: Record<string, unknown>[];
	summary: ReportSummaryItem[];
	chart: unknown;
	prepared: ReportPreparedState;
	preparedStatus: string;
	message: string;
}

const route = useRoute();
const router = useRouter();
const posStore = usePosStore();
const authStore = useAuthStore();

const reportCurrency = computed(() => posStore.invoiceCurrency || posStore.currency || "");
const guard = createRunGuard();
let autoRunTimer: ReturnType<typeof setTimeout> | undefined;
const catalog = ref<ReportDefinition[]>([]);
const catalogLoaded = ref(false);
const activeReport = computed(() => findReportDefinition(catalog.value, route.params.reportSlug));
const isReportAllowed = computed(() => (activeReport.value ? isReportRunnable(activeReport.value) : false));

const filters = ref<ReportFilterDefinition[]>([]);
const filterState = reactive<Record<string, unknown>>({});
const validationErrors = ref<string[]>([]);

const status = ref<ViewerStatus>("idle");
const errorMessage = ref("");
const result = ref<LoadedResult | null>(null);
const lastRunPayload = ref<Record<string, unknown> | null>(null);
const lastRefreshedAt = ref<Date | null>(null);

const searchTerm = ref("");
const sortState = ref<ReportSort | null>(null);
const layout = ref<ReportLayout>(emptyLayout());
const collapsed = ref<ReadonlySet<number>>(new Set());

const viewStore = computed(() =>
	createReportViewStore(reportStorageKey(window.location.host, authStore.userName)),
);
const favorites = ref<string[]>([]);
const savedViews = ref<ReportView[]>([]);

const contextDefaults = computed(() => ({
	company: posStore.companyName || "",
	warehouse: posStore.warehouse || "",
}));
const shiftContext = computed(() => ({
	company: posStore.companyName || "",
	warehouse: posStore.warehouse || "",
	pos_profile: posStore.profileName || "",
}));
const filterSplit = computed(() => splitShiftBoundFilters(filters.value, shiftContext.value));
const shownFilters = computed(() => filterSplit.value.visible);

const isLoading = computed(() => status.value === "loading");
const currentPayload = computed(() => normalizeReportFilters(filters.value, filterState));
const isStale = computed(
	() =>
		lastRunPayload.value !== null &&
		JSON.stringify(lastRunPayload.value) !== JSON.stringify(currentPayload.value),
);

const baseColumns = computed(() => getVisibleReportColumns(result.value?.columns ?? []));
const allColumnsOrdered = computed(() => applyLayout(baseColumns.value, { ...layout.value, hidden: [] }));
const displayColumns = computed(() => applyLayout(baseColumns.value, layout.value));
const dataRows = computed(() => (result.value?.rows ?? []).filter((row) => !isReportTotalRow(row)));
const totalRowsList = computed(() => (result.value?.rows ?? []).filter((row) => isReportTotalRow(row)));
const treeMode = computed(() => isTreeReport(dataRows.value));
const parents = computed(() => {
	const set = new Set<number>();
	dataRows.value.forEach((_, index) => {
		if (rowHasChildren(dataRows.value, index)) set.add(index);
	});
	return set;
});
const searchActive = computed(() => searchTerm.value.trim().length > 0);

const selection = computed(() =>
	selectReportRows(dataRows.value, {
		columns: displayColumns.value,
		search: searchTerm.value,
		sort: sortState.value,
		currency: reportCurrency.value,
		collapsed: collapsed.value,
	}),
);
const mixedCurrency = computed(() =>
	hasMixedCurrency(displayColumns.value, dataRows.value, reportCurrency.value, columnCurrency),
);
const filteredTotals = computed(() =>
	searchActive.value
		? computeFilteredTotals(
				displayColumns.value,
				selection.value.rows,
				totalRowsList.value[0],
				reportCurrency.value,
				columnCurrency,
			)
		: null,
);

const isFavorite = computed(() =>
	activeReport.value ? favorites.value.includes(activeReport.value.id) : false,
);
const preparedState = computed(() => result.value?.prepared ?? "none");
const isEmptyResult = computed(
	() => status.value === "ready" && preparedState.value === "none" && dataRows.value.length === 0,
);
const hasData = computed(
	() => status.value === "ready" && preparedState.value === "none" && dataRows.value.length > 0,
);
const exportScope = computed(() => (searchActive.value ? "filtered" : "complete"));

/** Why export and print are unavailable right now, or empty when they are. */
const actionBlock = computed(() => {
	if (isLoading.value) return __("Wait for the report to finish loading.");
	if (status.value === "error") return __("The last run failed. Run the report again first.");
	if (preparedState.value !== "none") return __("The report is still being prepared.");
	if (isStale.value) return __("Filters changed. Run the report before exporting or printing.");
	if (!hasData.value) return __("There are no rows to export.");
	if (dataRows.value.length > REPORT_EXPORT_ROW_LIMIT) {
		return __("Too many rows to export ({0}). The limit is {1}. Narrow the filters.", [
			String(dataRows.value.length),
			String(REPORT_EXPORT_ROW_LIMIT),
		]);
	}
	return "";
});
const canExport = computed(() => !actionBlock.value && Boolean(activeReport.value?.export.allowed));
const canPrint = computed(() => !actionBlock.value && Boolean(activeReport.value?.print.allowed));

watch(
	() => route.params.reportSlug,
	() => {
		void loadReport();
	},
	{ immediate: true },
);

watch([searchTerm, sortState], () => {
	collapsed.value = new Set();
});

onBeforeUnmount(() => {
	clearTimeout(autoRunTimer);
	guard.cancel();
});

function resetState() {
	for (const key of Object.keys(filterState)) delete filterState[key];
	filters.value = [];
	result.value = null;
	lastRunPayload.value = null;
	lastRefreshedAt.value = null;
	validationErrors.value = [];
	errorMessage.value = "";
	status.value = "idle";
	searchTerm.value = "";
	sortState.value = null;
	layout.value = emptyLayout();
	collapsed.value = new Set();
}

async function loadReport() {
	const token = guard.next();
	clearTimeout(autoRunTimer);
	resetState();
	if (!catalogLoaded.value) {
		try {
			const rows = await fetchReportCatalog();
			if (!guard.isCurrent(token)) return;
			catalog.value = rows;
		} catch (error) {
			if (!guard.isCurrent(token)) return;
			errorMessage.value = extractErrorMessage(error);
			status.value = "error";
			showError(errorMessage.value);
			return;
		}
		catalogLoaded.value = true;
	}
	const report = activeReport.value;

	if (!report) {
		document.title = `${__("Reports")} | X POS`;
		return;
	}

	document.title = `${report.title} | X POS`;
	if (route.params.reportSlug !== report.slug) {
		await router.replace({ path: `/reports/${report.slug}`, query: route.query });
		return;
	}
	if (!isReportRunnable(report)) {
		errorMessage.value = __("This report cannot be run from the POS yet.");
		return;
	}

	favorites.value = viewStore.value.favorites();
	savedViews.value = viewStore.value.views(report.id);
	viewStore.value.touchRecent(report.id);

	let definitions: ReportFilterDefinition[];
	try {
		definitions = await fetchReportMeta(report.id);
	} catch (error) {
		if (!guard.isCurrent(token)) return;
		errorMessage.value = extractErrorMessage(error);
		status.value = "error";
		showError(errorMessage.value);
		return;
	}
	if (!guard.isCurrent(token)) return;
	filters.value = definitions;

	const query = route.query as Record<string, string | string[] | null | undefined>;
	const defaults = buildInitialReportFilters(definitions, contextDefaults.value);
	const fromUrl = hydrateReportFiltersFromQuery(definitions, query);
	Object.assign(filterState, defaults, fromUrl);
	Object.assign(filterState, splitShiftBoundFilters(definitions, shiftContext.value).bound);

	const defaultView = savedViews.value.find((view) => view.isDefault);
	if (defaultView?.filters && Object.keys(fromUrl).length === 0) {
		Object.assign(filterState, defaultView.filters, filterSplit.value.bound);
	}
	pendingDefaultView = defaultView ?? null;

	await runReport();
}

let pendingDefaultView: ReportView | null = null;

function setFilterValue(fieldname: string, value: unknown) {
	filterState[fieldname] = value;
	clearTimeout(autoRunTimer);
	autoRunTimer = setTimeout(() => void runReport(), 400);
}

async function runReport() {
	clearTimeout(autoRunTimer);
	const report = activeReport.value;
	if (!report) return;

	if (!isReportRunnable(report)) {
		errorMessage.value = __("This report cannot be run from the POS yet.");
		showError(errorMessage.value);
		return;
	}

	Object.assign(filterState, filterSplit.value.bound);
	validationErrors.value = validateReportFilters(filters.value, filterState);
	if (validationErrors.value.length > 0) return;
	// Empty required filters are marked in the bar; the run just waits for them.
	if (missingRequiredReportFilters(filters.value, filterState).length > 0) return;

	const token = guard.next();
	await execute(normalizeReportFilters(filters.value, filterState), token, true);
}

/** Re-fetch exactly the filters of the displayed result. */
async function refresh() {
	if (!lastRunPayload.value) return runReport();
	await execute(lastRunPayload.value, guard.next(), false);
}

function normalizeResponse(response: ReportQueryResult): LoadedResult {
	const columns = Array.isArray(response.columns) ? response.columns : [];
	return {
		columns,
		rows: normalizeReportRows(columns, Array.isArray(response.result) ? response.result : [], {
			addTotalRow: response.add_total_row,
			skipTotalRow: response.skip_total_row,
		}),
		summary: Array.isArray(response.report_summary) ? response.report_summary : [],
		chart: response.chart ?? null,
		prepared: getReportPreparedState(response),
		preparedStatus: String(response.status ?? ""),
		message: response.message ? String(response.message) : "",
	};
}

async function execute(payload: Record<string, unknown>, token: number, syncUrl: boolean) {
	const report = activeReport.value;
	if (!report) return;

	if (!isOnline()) {
		errorMessage.value = __("You are offline. Connect to the server and try again.");
		status.value = result.value ? "ready" : "error";
		showError(errorMessage.value);
		return;
	}

	status.value = "loading";
	errorMessage.value = "";

	try {
		const response = await fetchReportData(report.id, payload);
		if (!guard.isCurrent(token)) return;
		const loaded = normalizeResponse(response);
		result.value = loaded;
		lastRunPayload.value = { ...payload };
		lastRefreshedAt.value = new Date();
		collapsed.value = new Set();
		layout.value = reconcileLayout(layout.value, getVisibleReportColumns(loaded.columns));
		if (pendingDefaultView) {
			layout.value = reconcileLayout(
				pendingDefaultView.layout,
				getVisibleReportColumns(loaded.columns),
			);
			sortState.value = pendingDefaultView.sort;
			pendingDefaultView = null;
		}
		status.value = "ready";
		if (syncUrl && route.params.reportSlug === report.slug) {
			await router.replace({
				path: route.path,
				query: serializeReportFiltersToQuery(
					shownFilters.value,
					filterState,
					buildInitialReportFilters(filters.value, contextDefaults.value),
				),
			});
		}
		if (loaded.message && guard.isCurrent(token)) showSuccess(loaded.message);
	} catch (error) {
		if (!guard.isCurrent(token)) return;
		errorMessage.value = extractErrorMessage(error);
		status.value = "error";
		showError(errorMessage.value);
	}
}

function toggleSort(fieldname: string) {
	if (!sortState.value || sortState.value.fieldname !== fieldname) {
		sortState.value = { fieldname, direction: "asc" };
	} else if (sortState.value.direction === "asc") {
		sortState.value = { fieldname, direction: "desc" };
	} else {
		sortState.value = null;
	}
}

function toggleGroup(sourceIndex: number) {
	const next = new Set(collapsed.value);
	if (!next.delete(sourceIndex)) next.add(sourceIndex);
	collapsed.value = next;
}

function onResize(fieldname: string, width: number) {
	layout.value = { ...layout.value, widths: { ...layout.value.widths, [fieldname]: width } };
}

function toggleFavorite() {
	const report = activeReport.value;
	if (!report) return;
	viewStore.value.toggleFavorite(report.id);
	favorites.value = viewStore.value.favorites();
	if (!viewStore.value.durable()) warnSessionOnly();
}

function saveView(name: string, withFilters: boolean) {
	const report = activeReport.value;
	if (!report) return;
	savedViews.value = viewStore.value.saveView(report.id, {
		name,
		layout: { ...layout.value, order: allColumnsOrdered.value.map((column) => column.fieldname) },
		sort: sortState.value,
		filters: withFilters
			? Object.fromEntries(
					Object.entries(currentPayload.value).filter(([key]) => !(key in filterSplit.value.bound)),
				)
			: undefined,
	});
	if (viewStore.value.durable()) showSuccess(__("View saved."));
	else warnSessionOnly();
}

function warnSessionOnly() {
	showInfo(__("This browser would not store it, so it lasts only until you close or reload this page."));
}

function applyView(view: ReportView) {
	layout.value = reconcileLayout(view.layout, baseColumns.value);
	sortState.value = view.sort;
	if (view.filters) {
		Object.assign(
			filterState,
			buildInitialReportFilters(filters.value, contextDefaults.value),
			view.filters,
			filterSplit.value.bound,
		);
		void runReport();
	}
}

function deleteView(view: ReportView) {
	if (!activeReport.value) return;
	savedViews.value = viewStore.value.deleteView(activeReport.value.id, view.id);
}

function setDefaultView(view: ReportView) {
	if (!activeReport.value) return;
	savedViews.value = viewStore.value.setDefault(activeReport.value.id, view.isDefault ? null : view.id);
}

async function drill(target: DrillTarget) {
	const opened = await openDocument(target);
	if (!opened) showError(__("You do not have permission to open {0} {1}.", [target.doctype, target.name]));
}

interface FreshData {
	columns: ReportColumn[];
	rows: Record<string, unknown>[];
	totals: Record<string, unknown>[];
	summary: ReportSummaryItem[];
}

/**
 * Re-run the displayed filters under the export/print purpose and hand back that response.
 * Output is always built from this authorized response, never from the rows already on screen,
 * and is dropped if the user has moved on in the meantime.
 */
async function fetchAuthorized(purpose: "export" | "print"): Promise<FreshData | null> {
	const report = activeReport.value;
	const payload = lastRunPayload.value;
	if (!report || !payload) return null;
	const token = guard.current();
	try {
		const response = await fetchReportData(report.id, payload, purpose);
		if (!guard.isCurrent(token)) return null;
		const loaded = normalizeResponse(response);
		if (loaded.prepared !== "none") {
			showError(__("The report is still being prepared."));
			return null;
		}
		const columns = applyLayout(getVisibleReportColumns(loaded.columns), layout.value);
		return {
			columns,
			rows: loaded.rows.filter((row) => !isReportTotalRow(row)),
			totals: loaded.rows.filter((row) => isReportTotalRow(row)),
			summary: loaded.summary,
		};
	} catch (error) {
		if (guard.isCurrent(token)) showError(extractErrorMessage(error));
		return null;
	}
}

function scoped(data: FreshData) {
	const picked = selectReportRows(data.rows, {
		columns: data.columns,
		search: searchActive.value ? searchTerm.value : "",
		sort: treeMode.value ? null : sortState.value,
		currency: reportCurrency.value,
	});
	return {
		rows: picked.rows,
		filtered: searchActive.value,
		filteredTotals: searchActive.value
			? computeFilteredTotals(
					data.columns,
					picked.rows,
					data.totals[0],
					reportCurrency.value,
					columnCurrency,
				)
			: undefined,
	};
}

function buildDelimited(data: FreshData, delimiter: "," | "\t"): string {
	const scope = scoped(data);
	return buildReportExport({
		columns: data.columns,
		rows: scope.rows,
		completeTotals: data.totals,
		filteredTotals: scope.filteredTotals,
		filtered: scope.filtered,
		currency: reportCurrency.value,
		delimiter,
	});
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

const busyAction = ref<"copy" | "export" | "print" | null>(null);

async function copyReport() {
	if (!canExport.value || busyAction.value) return;
	busyAction.value = "copy";
	try {
		const data = await fetchAuthorized("export");
		if (!data) return;
		await copyText(buildDelimited(data, "\t"));
		showSuccess(__("Copied {0} rows to the clipboard.", [String(scoped(data).rows.length)]));
	} catch (error) {
		showError(error instanceof ReportExportLimitError ? error.message : extractErrorMessage(error));
	} finally {
		busyAction.value = null;
	}
}

async function exportCsv() {
	if (!canExport.value || busyAction.value) return;
	busyAction.value = "export";
	try {
		const data = await fetchAuthorized("export");
		if (!data) return;
		const csv = CSV_BOM + buildDelimited(data, ",");
		const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = reportFileName(activeReport.value?.title || "report");
		anchor.style.display = "none";
		document.body.appendChild(anchor);
		anchor.click();
		document.body.removeChild(anchor);
		URL.revokeObjectURL(url);
		showSuccess(__("Report exported as CSV."));
	} catch (error) {
		showError(error instanceof ReportExportLimitError ? error.message : extractErrorMessage(error));
	} finally {
		busyAction.value = null;
	}
}

async function printReport() {
	if (!canPrint.value || busyAction.value) return;
	// Opened synchronously: after an await the click's user gesture is gone and popup blockers bite.
	const win = openReportPrintWindow();
	if (!win) {
		showError(__("Print window blocked. Please allow popups and try again."));
		return;
	}
	busyAction.value = "print";
	try {
		const data = await fetchAuthorized("print");
		if (!data) {
			win.close();
			return;
		}
		if (data.rows.length > REPORT_EXPORT_ROW_LIMIT) {
			win.close();
			showError(new ReportExportLimitError(data.rows.length, REPORT_EXPORT_ROW_LIMIT).message);
			return;
		}
		const scope = scoped(data);
		const options: ReportPrintOptions = {
			title: activeReport.value?.title || __("Report"),
			filters: filters.value,
			values: lastRunPayload.value ?? {},
			columns: data.columns,
			rows: scope.rows,
			completeTotals: data.totals,
			filteredTotals: scope.filteredTotals,
			summary: data.summary,
			currency: reportCurrency.value,
			filteredBy: scope.filtered ? searchTerm.value.trim() : undefined,
			format: pickPrintFormat(activeReport.value, data.columns),
		};
		writeReportPrintWindow(win, options);
	} catch (error) {
		win.close();
		showError(extractErrorMessage(error));
	} finally {
		busyAction.value = null;
	}
}

function goBack() {
	router.push("/reports");
}

const updatedAt = computed(() => (lastRefreshedAt.value ? lastRefreshedAt.value.toLocaleTimeString() : ""));
</script>

<template>
	<div class="flex h-full flex-col overflow-hidden bg-background">
		<div
			v-if="catalogLoaded && !activeReport"
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
						<ArrowLeft class="h-4 w-4 rtl:rotate-180" />
						{{ __("Back to Reports") }}
					</Button>
				</div>
			</Card>
		</div>

		<div
			v-else-if="activeReport && !isReportAllowed"
			class="flex h-full items-center justify-center p-6 text-center"
		>
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
						<ArrowLeft class="h-4 w-4 rtl:rotate-180" />
						{{ __("Back to Reports") }}
					</Button>
				</div>
			</Card>
		</div>

		<template v-else-if="activeReport">
			<PageHeader
				:title="activeReport.title"
				:subtitle="activeReport.description"
				class="mx-3 mt-3 rounded-2xl border shadow-raised"
			>
				<template #leading>
					<Button
						variant="ghost"
						size="icon-sm"
						:aria-label="__('Back to Reports')"
						@click="goBack"
					>
						<ArrowLeft class="h-4 w-4 rtl:rotate-180" />
					</Button>
				</template>
				<template #meta>
					<Badge variant="outline">{{ activeReport.category }}</Badge>
					<Badge v-if="isLoading" variant="secondary" role="status">{{ __("Loading") }}</Badge>
					<Badge v-else-if="isStale" variant="warning" role="status">{{
						__("Filters changed")
					}}</Badge>
					<span
						v-else-if="updatedAt"
						class="inline-flex items-center gap-1 text-xs text-muted-foreground"
					>
						<Clock class="h-3 w-3" aria-hidden="true" />{{ __("Updated {0}", [updatedAt]) }}
					</span>
				</template>
				<Button
					variant="ghost"
					size="icon-sm"
					:aria-pressed="isFavorite"
					:aria-label="isFavorite ? __('Remove from favorites') : __('Add to favorites')"
					@click="toggleFavorite"
				>
					<Star class="h-4 w-4" :class="isFavorite ? 'fill-warning text-warning' : ''" />
				</Button>
				<Button
					variant="outline"
					size="sm"
					class="h-9 gap-1.5"
					:disabled="isLoading"
					:title="__('Reload the results shown, using the same filters')"
					@click="refresh"
				>
					<RefreshCw class="h-4 w-4" :class="{ 'animate-spin': isLoading }" />
					{{ __("Refresh") }}
				</Button>
				<Popover>
					<PopoverTrigger as-child>
						<Button
							variant="outline"
							size="sm"
							class="h-9 gap-1.5"
							:disabled="Boolean(busyAction)"
							data-testid="share-menu"
						>
							<Share2 class="h-4 w-4" aria-hidden="true" />
							{{ __("Export") }}
						</Button>
					</PopoverTrigger>
					<PopoverContentStyled align="end" class="w-72">
						<p class="px-1 pb-1 text-xs text-muted-foreground" role="status">
							{{
								actionBlock ||
								(exportScope === "filtered"
									? __(
											"Exports the filtered view: rows matching “{0}”, with filtered totals.",
											[searchTerm.trim()],
										)
									: __("Exports the complete report with its totals."))
							}}
						</p>
						<PopoverMenuItem :disabled="!canExport" data-testid="copy-report" @click="copyReport">
							<template #icon><Copy /></template>
							{{ __("Copy") }}
						</PopoverMenuItem>
						<PopoverMenuItem :disabled="!canExport" data-testid="export-csv" @click="exportCsv">
							<template #icon><Download /></template>
							{{ __("Export CSV") }}
						</PopoverMenuItem>
						<PopoverMenuItem
							:disabled="!canPrint"
							data-testid="print-report"
							@click="printReport"
						>
							<template #icon><Printer /></template>
							{{ __("Print") }}
						</PopoverMenuItem>
					</PopoverContentStyled>
				</Popover>
			</PageHeader>

			<ScrollArea class="flex-1">
				<div class="space-y-3 p-3">
					<ReportFilterBar
						:filters="shownFilters"
						:values="filterState"
						:errors="validationErrors"
						@set="setFilterValue"
						@apply="runReport"
					/>

					<ReportSummaryStrip
						v-if="hasData && result"
						:items="result.summary"
						:currency="reportCurrency"
					/>
					<ReportChart v-if="hasData && result?.chart" :chart="result.chart" />

					<Card class="rounded-2xl border-border bg-card/50 p-3 shadow-raised">
						<div class="mb-3 flex flex-wrap items-center gap-2">
							<div class="relative min-w-48 flex-1 sm:max-w-sm">
								<Search
									class="pointer-events-none absolute inset-s-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
									aria-hidden="true"
								/>
								<Input
									v-model="searchTerm"
									type="search"
									:aria-label="__('Search rows')"
									:placeholder="__('Search rows...')"
									class="h-9 ps-9"
									:disabled="!hasData"
								/>
							</div>
							<ReportColumnsMenu
								v-if="hasData"
								:columns="allColumnsOrdered"
								:layout="layout"
								@change="layout = $event"
								@reset="layout = emptyLayout()"
							/>
							<ReportViewsMenu
								v-if="hasData"
								:views="savedViews"
								@apply="applyView"
								@save="saveView"
								@delete="deleteView"
								@default="setDefaultView"
							/>
							<span v-if="hasData" class="ms-auto text-sm text-muted-foreground" role="status">
								<template v-if="searchActive">
									{{
										__("{0} of {1} rows", [
											String(selection.rows.length),
											String(dataRows.length),
										])
									}}
								</template>
								<template v-else>{{ __("{0} rows", [String(dataRows.length)]) }}</template>
							</span>
						</div>

						<div
							v-if="errorMessage"
							class="mb-3 rounded-xl border border-destructive/30 bg-destructive/5 p-3"
							role="alert"
						>
							<div class="flex items-start gap-3">
								<AlertTriangle class="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
								<div class="min-w-0 flex-1 space-y-2">
									<p class="text-sm font-medium text-foreground">{{ errorMessage }}</p>
									<Button size="sm" @click="runReport">
										<RefreshCw class="h-4 w-4" />
										{{ __("Try Again") }}
									</Button>
								</div>
							</div>
						</div>

						<div
							v-if="preparedState !== 'none'"
							class="mb-3 rounded-xl border border-border bg-muted p-4"
							role="status"
							data-testid="prepared-state"
						>
							<p class="text-sm font-semibold text-foreground">
								{{
									preparedState === "failed"
										? __("The prepared report failed to build.")
										: __("This report is being prepared.")
								}}
							</p>
							<p class="mt-1 text-sm text-muted-foreground">
								{{
									preparedState === "failed"
										? __(
												"No results are available. Run it again, or contact an administrator if it keeps failing.",
											)
										: __(
												"It is built in the background and has no results yet{0}. This is not an empty report.",
												[result?.preparedStatus ? ` (${result.preparedStatus})` : ""],
											)
								}}
							</p>
							<Button size="sm" class="mt-2" variant="outline" @click="refresh">
								<RefreshCw class="h-4 w-4" />
								{{ preparedState === "failed" ? __("Run again") : __("Check again") }}
							</Button>
						</div>

						<div v-if="isLoading && !result" class="space-y-2" aria-busy="true">
							<div v-for="i in 6" :key="i" class="skeleton h-9 w-full rounded-lg"></div>
						</div>

						<div
							v-else-if="
								preparedState === 'none' &&
								status !== 'idle' &&
								!(status === 'error' && !result)
							"
						>
							<div :class="{ 'opacity-60': isLoading || isStale }" :aria-busy="isLoading">
								<ReportTable
									:columns="displayColumns"
									:rows="selection.rows"
									:source-index="selection.sourceIndex"
									:totals="totalRowsList"
									:filtered-totals="filteredTotals"
									:currency="reportCurrency"
									:sort-state="sortState"
									:widths="layout.widths"
									:frozen="layout.frozen"
									:sortable="!treeMode"
									:parents="parents"
									:collapsed="collapsed"
									:mixed-currency="mixedCurrency"
									:label="activeReport.title"
									:empty-title="
										isEmptyResult ? __('No rows found') : __('No matching rows')
									"
									:empty-description="
										isEmptyResult
											? __('This report returned no data for these filters.')
											: __('No rows match the search.')
									"
									@sort-change="toggleSort"
									@resize="onResize"
									@toggle="toggleGroup"
									@drill="drill"
								/>
							</div>
							<p v-if="mixedCurrency" class="mt-2 text-xs text-muted-foreground">
								{{
									__(
										"This report mixes currencies. Totals are not added across currencies.",
									)
								}}
							</p>
						</div>
					</Card>
				</div>
			</ScrollArea>
		</template>
	</div>
</template>
