<template>
	<BaseListView
		:title="title"
		:fields="listView.allFilterableFields.value"
		:standard-filter-fields="listView.standardFilterFields.value"
		:standard-filters="standardFilterModel"
		:query-filters="queryFilterModel"
		:order-by="listView.orderBy.value"
		:is-loading="listView.isLoading.value"
		:error="listView.error.value"
		:items="items"
		:total="listView.total.value"
		:page-size="listView.pageSize.value"
		:current-page="listView.currentPage.value"
		:empty-title="emptyTitle"
		:empty-description="emptyDescription"
		:empty-icon="emptyIcon"
		:hide-standard-filters-on-mobile="hideStandardFiltersOnMobile"
		:scroll-class="scrollClass"
		:list-class="listClass"
		:item-key="itemKey"
		@update:standard-filters="onStandardFilterUpdate"
		@update:query-filters="onQueryFilterUpdate"
		@update:order-by="listView.setOrderBy"
		@refresh="listView.refresh()"
		@retry="listView.retry()"
		@clear-filters="listView.clearFilters()"
		@update:current-page="listView.setPage"
		@update:page-size="listView.setPageSize"
	>
		<template #header-actions>
			<slot name="header-actions" :list-view="listView" />
		</template>

		<template #aside>
			<slot name="aside" :list-view="listView" />
		</template>

		<template #item="{ item, index }">
			<slot name="item" :item="item" :index="index" :list-view="listView" />
		</template>
	</BaseListView>
</template>

<script setup lang="ts">
import { computed, type Component } from "vue";
import BaseListView from "@/components/core/BaseListView.vue";
import { useListView, type QueryFilter } from "@/composables/useListView";

type ItemKeyResolver = string | ((item: unknown, index: number) => string | number);

const props = withDefaults(
	defineProps<{
		title: string;
		doctype: string;
		fields?: string[];
		baseFilters?: Record<string, unknown>;
		defaultOrderBy?: string;
		defaultPageSize?: number;
		emptyTitle: string;
		emptyDescription?: string;
		emptyIcon?: Component;
		hideStandardFiltersOnMobile?: boolean;
		scrollClass?: string;
		listClass?: string;
		itemKey?: ItemKeyResolver;
	}>(),
	{
		fields: () => [],
		defaultOrderBy: "modified desc",
		defaultPageSize: 20,
		emptyDescription: "",
		hideStandardFiltersOnMobile: false,
		scrollClass: "px-3 sm:px-4 py-1 xpos-scrollbar",
		listClass: "space-y-2",
	},
);

const doctypeRef = computed(() => props.doctype);
const baseFiltersRef = computed(() => props.baseFilters);

const listView = useListView({
	doctype: doctypeRef,
	fields: props.fields,
	baseFilters: baseFiltersRef,
	defaultOrderBy: props.defaultOrderBy,
	defaultPageSize: props.defaultPageSize,
});

const items = computed(() => listView.data.value as unknown[]);

const standardFilterModel = computed(() => {
	const model: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(listView.filters)) {
		if (value !== undefined && value !== null && value !== "") {
			model[key] = value;
		}
	}
	return model;
});

const queryFilterModel = computed(() =>
	listView.queryFilters.value.map((filter) => ({
		field: filter.field,
		operator: filter.operator,
		value: filter.value,
	})),
);

function onStandardFilterUpdate(updated: Record<string, unknown>) {
	for (const key of Object.keys(listView.filters)) {
		if (!(key in updated)) {
			listView.removeFilter(key);
		}
	}

	for (const [key, value] of Object.entries(updated)) {
		listView.setFilter(key, value);
	}
}

function onQueryFilterUpdate(filters: { field: string; operator: string; value: string }[]) {
	listView.setQueryFilters(
		filters.map((filter) => ({
			field: filter.field,
			operator: filter.operator as QueryFilter["operator"],
			value: filter.value,
		})),
	);
}
</script>
