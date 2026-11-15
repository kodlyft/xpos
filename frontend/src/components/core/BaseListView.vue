<template>
	<div class="flex h-full flex-col overflow-hidden bg-background p-3 lg:pt-3">
		<div
			class="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border bg-card/70 shadow-raised"
		>
			<div class="shrink-0 border-b border-border p-3 sm:p-4">
				<div class="mb-3 flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
					<h1 class="text-xl font-bold text-foreground">{{ title }}</h1>
					<slot name="header-actions" />
				</div>
				<div class="flex flex-wrap items-end gap-2">
					<div :class="hideStandardFiltersOnMobile ? 'hidden sm:contents' : 'contents'">
						<ListFilterBar
							:fields="resolvedStandardFilterFields"
							:model-filters="standardFilters"
							@update:model-filters="emit('update:standardFilters', $event)"
						/>
					</div>
					<SortBy
						:model-value="orderBy"
						:fields="fields"
						@update:model-value="emit('update:orderBy', $event)"
					/>
					<div class="flex-1"></div>
					<QueryFilterPanel
						:fields="fields"
						:model-query-filters="queryFilters"
						@update:model-query-filters="emit('update:queryFilters', $event)"
					/>
					<Button
						variant="outline"
						size="icon"
						:aria-label="__('Refresh')"
						:title="__('Refresh')"
						@click="emit('refresh')"
					>
						<RefreshCw class="h-4 w-4" />
					</Button>
					<Button
						v-if="hasActiveFilters"
						variant="ghost"
						class="text-muted-foreground hover:text-foreground"
						@click="emit('clearFilters')"
					>
						<X class="h-4 w-4" />
						{{ __("Clear") }}
					</Button>
				</div>
			</div>

			<div class="flex min-h-0 flex-1 overflow-hidden">
				<slot name="aside" />
				<div class="flex min-h-0 flex-1 flex-col overflow-hidden">
					<div :class="scrollAreaClasses">
						<div v-if="isLoading && items.length === 0" class="grid gap-3">
							<div
								v-for="index in loadingSkeletonCount"
								:key="index"
								class="skeleton h-20 w-full rounded-xl"
							></div>
						</div>
						<ErrorState
							v-else-if="error && items.length === 0"
							:title="__('Could not load records')"
							:description="error"
							retryable
							:retrying="isLoading"
							@retry="emit('retry')"
						/>
						<EmptyState
							v-else-if="items.length === 0"
							class="h-64"
							:title="emptyTitle"
							:description="emptyDescription"
							:icon="emptyIcon"
						/>

						<div v-else :class="[listClass, { 'opacity-50': isLoading }]">
							<template v-for="(item, index) in items" :key="resolveItemKey(item, index)">
								<slot name="item" :item="item" :index="index" />
							</template>
						</div>
					</div>

					<Pagination
						v-if="total > 0"
						:total="total"
						:page-size="pageSize"
						:current-page="currentPage"
						@update:current-page="emit('update:currentPage', $event)"
						@update:page-size="emit('update:pageSize', $event)"
					/>
				</div>
			</div>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed, type Component } from "vue";
import { Button } from "@/components/ui/button";
import ListFilterBar from "@/components/core/ListFilterBar.vue";
import QueryFilterPanel from "@/components/core/QueryFilterPanel.vue";
import SortBy from "@/components/core/SortBy.vue";
import { EmptyState, ErrorState } from "@/components/ui/state";
import Pagination from "@/components/orders/Pagination.vue";
import type { DocField } from "@/services/doctypeMeta";
import __ from "@/lib/translate";
import { RefreshCw, X } from "lucide-vue-next";

type QueryFilterModel = { field: string; operator: string; value: string };
type ItemKeyResolver = string | ((item: any, index: number) => string | number);

const props = withDefaults(
	defineProps<{
		title: string;
		fields: DocField[];
		standardFilterFields?: DocField[];
		standardFilters: Record<string, unknown>;
		queryFilters?: QueryFilterModel[];
		orderBy: string;
		isLoading: boolean;
		error?: string | null;
		items: any[];
		total: number;
		pageSize: number;
		currentPage: number;
		emptyTitle: string;
		emptyDescription?: string;
		emptyIcon?: Component;
		hideStandardFiltersOnMobile?: boolean;
		scrollClass?: string;
		listClass?: string;
		itemKey?: ItemKeyResolver;
		loadingSkeletonCount?: number;
	}>(),
	{
		error: null,
		queryFilters: () => [],
		emptyDescription: "",
		hideStandardFiltersOnMobile: false,
		scrollClass: "p-3 sm:p-4 xpos-scrollbar",
		listClass: "space-y-2",
		loadingSkeletonCount: 5,
	},
);

const emit = defineEmits<{
	(e: "update:standardFilters", filters: Record<string, unknown>): void;
	(e: "update:queryFilters", filters: QueryFilterModel[]): void;
	(e: "update:orderBy", value: string): void;
	(e: "refresh"): void;
	(e: "retry"): void;
	(e: "clearFilters"): void;
	(e: "update:currentPage", page: number): void;
	(e: "update:pageSize", size: number): void;
}>();

const resolvedStandardFilterFields = computed(() => {
	if (props.standardFilterFields && props.standardFilterFields.length > 0) {
		return props.standardFilterFields;
	}
	return props.fields.filter((field) => field.in_standard_filter === 1);
});

const hasActiveFilters = computed(() => {
	return Object.keys(props.standardFilters).length > 0 || props.queryFilters.length > 0;
});

const scrollAreaClasses = computed(() => ["flex-1 overflow-y-auto", props.scrollClass]);

function resolveItemKey(item: any, index: number) {
	if (typeof props.itemKey === "function") {
		return props.itemKey(item, index);
	}

	if (typeof props.itemKey === "string" && item && typeof item === "object") {
		const value = (item as Record<string, unknown>)[props.itemKey];
		if (typeof value === "string" || typeof value === "number") {
			return value;
		}
	}

	if (item && typeof item === "object") {
		const name = (item as Record<string, unknown>).name;
		if (typeof name === "string" || typeof name === "number") {
			return name;
		}
	}

	return index;
}
</script>
