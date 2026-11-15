<script setup lang="ts">
import { computed, onActivated, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { ArrowRight, BarChart3, FolderOpen, Lock, Search, Star } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page";
import { ScrollArea } from "@/components/ui/scroll-area";
import __ from "@/lib/translate";
import { showError } from "@/services/api";
import { useAuthStore } from "@/stores/authStore";
import { extractErrorMessage } from "@/utils";
import { fetchReportCatalog, isReportRunnable, type ReportDefinition } from "@/services/reports";
import { createReportViewStore, reportStorageKey } from "@/services/reportViews";

const router = useRouter();
const authStore = useAuthStore();
const searchTerm = ref("");
const reports = ref<ReportDefinition[]>([]);
const loading = ref(true);
const favorites = ref<string[]>([]);
const recents = ref<string[]>([]);

const store = computed(() =>
	createReportViewStore(reportStorageKey(window.location.host, authStore.userName)),
);

function loadLocalState() {
	favorites.value = store.value.favorites();
	recents.value = store.value.recents();
}

// The signed-in user decides which device-local state applies; it can arrive after first paint.
watch(() => authStore.userName, loadLocalState);
onActivated(loadLocalState);

onMounted(async () => {
	loadLocalState();
	try {
		reports.value = await fetchReportCatalog(true);
	} catch (error) {
		showError(extractErrorMessage(error));
	} finally {
		loading.value = false;
	}
});

const query = computed(() => searchTerm.value.trim().toLowerCase());

const matches = computed(() => {
	if (!query.value) return reports.value;
	return reports.value.filter((report) =>
		[report.title, report.id, report.description, report.category, report.slug, ...report.aliases]
			.join(" ")
			.toLowerCase()
			.includes(query.value),
	);
});

const byId = computed(() => new Map(matches.value.map((report) => [report.id, report])));
const favoriteReports = computed(() =>
	favorites.value
		.map((id) => byId.value.get(id))
		.filter((report): report is ReportDefinition => Boolean(report)),
);
const recentReports = computed(() =>
	recents.value
		.map((id) => byId.value.get(id))
		.filter((report): report is ReportDefinition => Boolean(report)),
);

const sections = computed(() => {
	const categories = Array.from(new Set(matches.value.map((report) => report.category)));
	return categories.map((category) => ({
		category,
		reports: matches.value.filter((report) => report.category === category),
	}));
});

function open(report: ReportDefinition) {
	if (isReportRunnable(report)) router.push(`/reports/${report.slug}`);
}

function toggleFavorite(report: ReportDefinition) {
	store.value.toggleFavorite(report.id);
	favorites.value = store.value.favorites();
}

function isFavorite(report: ReportDefinition): boolean {
	return favorites.value.includes(report.id);
}
</script>

<template>
	<div class="flex h-full flex-col overflow-hidden bg-background">
		<PageHeader
			:title="__('Reports')"
			:subtitle="__('Open a report, filter it, then export or print the result.')"
			class="mx-3 mt-3 rounded-2xl border shadow-raised"
		>
			<div class="relative w-full sm:w-80">
				<Search
					class="pointer-events-none absolute inset-s-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
					aria-hidden="true"
				/>
				<Input
					v-model="searchTerm"
					type="search"
					:aria-label="__('Search reports')"
					:placeholder="__('Search reports or categories...')"
					class="h-9 ps-9"
				/>
			</div>
		</PageHeader>

		<ScrollArea class="flex-1">
			<div class="space-y-4 p-3">
				<div v-if="loading" class="space-y-2" aria-busy="true">
					<div v-for="i in 5" :key="i" class="skeleton h-14 w-full rounded-xl"></div>
				</div>

				<div
					v-else-if="matches.length === 0"
					class="flex flex-col items-center justify-center py-20 text-center"
					role="status"
				>
					<FolderOpen class="mb-4 h-12 w-12 text-muted-foreground/40" />
					<p class="text-lg font-semibold text-foreground">
						{{
							reports.length === 0
								? __("No reports available")
								: __("No reports match your search")
						}}
					</p>
					<p class="mt-1 max-w-md text-sm text-muted-foreground">
						{{
							reports.length === 0
								? __("Ask an administrator to enable reports for your role.")
								: __("Try a different keyword or clear the search field.")
						}}
					</p>
				</div>

				<template v-else>
					<section
						v-for="group in [
							{ key: 'fav', title: __('Favorites'), items: favoriteReports },
							{ key: 'recent', title: __('Recent'), items: recentReports },
						]"
						v-show="group.items.length > 0"
						:key="group.key"
						:aria-label="group.title"
					>
						<h2 class="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
							{{ group.title }}
						</h2>
						<ul class="flex flex-wrap gap-2">
							<li v-for="report in group.items" :key="report.id">
								<Button
									variant="outline"
									size="sm"
									class="h-9 gap-1.5"
									:disabled="!isReportRunnable(report)"
									@click="open(report)"
								>
									<BarChart3 class="h-4 w-4 text-muted-foreground" aria-hidden="true" />
									{{ report.title }}
								</Button>
							</li>
						</ul>
					</section>

					<section
						v-for="section in sections"
						:key="section.category"
						:aria-label="section.category"
					>
						<h2 class="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
							{{ section.category }}
							<span class="ms-1 font-normal">({{ section.reports.length }})</span>
						</h2>
						<ul
							class="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card/50 shadow-raised"
						>
							<li
								v-for="report in section.reports"
								:key="report.id"
								class="flex items-center gap-2 px-3 py-2 hover:bg-surface-hover"
							>
								<Button
									variant="ghost"
									size="icon-sm"
									:aria-pressed="isFavorite(report)"
									:aria-label="
										isFavorite(report)
											? __('Remove {0} from favorites', [report.title])
											: __('Add {0} to favorites', [report.title])
									"
									@click="toggleFavorite(report)"
								>
									<Star
										class="h-4 w-4"
										:class="isFavorite(report) ? 'fill-warning text-warning' : ''"
									/>
								</Button>
								<button
									type="button"
									class="flex min-w-0 flex-1 items-center gap-3 rounded-lg py-1 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-60"
									:disabled="!isReportRunnable(report)"
									@click="open(report)"
								>
									<span class="min-w-0 flex-1">
										<span class="block truncate text-sm font-medium text-foreground">{{
											report.title
										}}</span>
										<span class="block truncate text-xs text-muted-foreground">{{
											report.description
										}}</span>
									</span>
									<Badge
										v-if="!isReportRunnable(report)"
										variant="destructive"
										class="gap-1"
									>
										<Lock class="h-3 w-3" aria-hidden="true" />{{ __("Needs adapter") }}
									</Badge>
									<ArrowRight
										class="h-4 w-4 shrink-0 text-muted-foreground rtl:rotate-180"
										aria-hidden="true"
									/>
								</button>
							</li>
						</ul>
					</section>
				</template>
			</div>
		</ScrollArea>
	</div>
</template>
