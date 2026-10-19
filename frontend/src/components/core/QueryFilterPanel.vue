<template>
	<div class="relative">
		<Button
			ref="filterBtnRef"
			variant="outline"
			size="sm"
			class="h-8 gap-1"
			:class="{
				'bg-primary text-primary-foreground hover:bg-primary/90': modelQueryFilters.length > 0,
			}"
			@click="togglePanel"
		>
			<Filter class="h-3.5 w-3.5" />
			{{ __("Filters") }}
			<Badge
				v-if="modelQueryFilters.length > 0"
				:variant="'secondary'"
				class="ms-1 h-5 min-w-5 px-1.5 bg-background text-foreground"
			>
				{{ modelQueryFilters.length }}
			</Badge>
		</Button>

		<Teleport to="body">
			<div v-if="showPanel" class="fixed inset-0 z-[998]" @click="showPanel = false" />
			<div
				v-if="showPanel"
				class="fixed z-[999] w-[min(500px,calc(100vw-1rem))] bg-popover border border-border rounded-lg shadow-lg"
				:style="panelStyle"
			>
				<div class="p-3 border-b border-border">
					<div class="flex items-center justify-between">
						<span class="text-sm font-semibold text-foreground">{{ __("Query Filters") }}</span>
						<Button variant="outline" size="sm" class="h-7 text-xs" @click="addFilter">
							<Plus class="h-3 w-3" />
							{{ __("Add Filter") }}
						</Button>
					</div>
				</div>

				<div class="p-3 space-y-2 max-h-[300px] overflow-y-auto">
					<div v-for="(filter, index) in localFilters" :key="index" class="flex items-center gap-2">
						<Autocomplete
							v-model="filter.field"
							:options="fieldOptions"
							:placeholder="__('Field...')"
							:show-search-icon="false"
							:clearable="false"
							:max-visible="10"
							:empty-text="__('No fields')"
							class="w-[150px]"
							@update:model-value="onFilterFieldChange(index)"
						/>

						<Select
							v-model="filter.operator"
							class="w-[130px] shrink-0"
							@update:model-value="emitFilters"
							:items="
								getOperatorsForFilter(filter).map((op) => ({
									label: __(op.label),
									value: op.value,
								}))
							"
						/>

						<Autocomplete
							v-if="
								getFieldType(filter.field) === 'Link' &&
								!['is', 'is not'].includes(filter.operator)
							"
							v-model="filter.value"
							:options="linkOptions[filter.field] || []"
							:placeholder="__('Value')"
							:remote-search="true"
							:show-search-icon="false"
							:clearable="false"
							:max-visible="20"
							class="flex-1"
							@search="(q: string) => onLinkSearch(filter.field, q)"
							@update:model-value="emitFilters"
						/>

						<Select
							v-else-if="
								getFieldType(filter.field) === 'Select' &&
								!['is', 'is not'].includes(filter.operator)
							"
							v-model="filter.value"
							class="flex-1"
							@update:model-value="emitFilters"
							:items="
								getSelectOptionsForField(filter.field).map((opt) => ({
									label: __(opt),
									value: opt,
								}))
							"
						/>

						<Select
							v-else-if="['is', 'is not'].includes(filter.operator)"
							v-model="filter.value"
							class="flex-1"
							@update:model-value="emitFilters"
							:items="[
								{ label: __('Set (has value)'), value: 'set' },
								{ label: __('Not Set (empty)'), value: 'not set' },
							]"
						/>

						<Input
							v-else
							v-model="filter.value"
							type="text"
							:placeholder="__('Value')"
							class="h-8 flex-1"
							@change="emitFilters"
						/>

						<Button
							variant="ghost"
							size="icon-sm"
							class="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
							@click="removeFilter(index)"
						>
							<X class="h-3.5 w-3.5" />
						</Button>
					</div>

					<div
						v-if="localFilters.length === 0"
						class="text-sm text-muted-foreground py-4 text-center"
					>
						{{ __('No query filters. Click "Add Filter" to add one.') }}
					</div>
				</div>

				<div v-if="localFilters.length > 0" class="p-3 border-t border-border flex justify-end gap-2">
					<Button variant="ghost" size="sm" class="h-7" @click="clearAll">
						{{ __("Clear All") }}
					</Button>
					<Button size="sm" class="h-7" @click="showPanel = false">
						{{ __("Apply") }}
					</Button>
				</div>
			</div>
		</Teleport>
	</div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch } from "vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Autocomplete } from "@/components/ui/autocomplete";
import type { AutocompleteOption } from "@/components/ui/autocomplete";
import { Badge } from "@/components/ui/badge";
import { Filter, Plus, X } from "lucide-vue-next";
import type { DocField } from "@/services/doctypeMeta";
import { getFieldOperators, parseSelectOptions } from "@/services/doctypeMeta";
import { searchLink } from "@/services/api";
import __ from "@/lib/translate";
import { Select } from "../ui/select";

const TEXT_FIELDTYPES = new Set(["Data", "Small Text", "Text", "Long Text"]);

interface LocalFilter {
	field: string;
	operator: string;
	value: string;
}

const props = defineProps<{
	fields: DocField[];
	modelQueryFilters: { field: string; operator: string; value: string }[];
}>();

const emit = defineEmits<{
	(e: "update:modelQueryFilters", filters: { field: string; operator: string; value: string }[]): void;
}>();

const showPanel = ref(false);
const filterBtnRef = ref<InstanceType<typeof Button> | null>(null);
const panelStyle = ref<Record<string, string>>({});

const localFilters = ref<LocalFilter[]>([]);
const linkOptions = reactive<Record<string, AutocompleteOption[]>>({});

const fieldMap = computed(() => {
	const map: Record<string, DocField> = {};
	for (const f of props.fields) {
		map[f.fieldname] = f;
	}
	return map;
});

const fieldOptions = computed<AutocompleteOption[]>(() =>
	props.fields.map((f) => ({
		label: f.label || f.fieldname,
		value: f.fieldname,
		description: f.fieldtype,
	})),
);

watch(
	() => props.modelQueryFilters,
	(incoming) => {
		localFilters.value = incoming.map((f) => ({ ...f }));
	},
	{ immediate: true, deep: true },
);

function togglePanel() {
	const el = (filterBtnRef.value as any)?.$el as HTMLElement | undefined;
	if (el) {
		const rect = el.getBoundingClientRect();
		const panelWidth = Math.min(500, window.innerWidth - 16);
		let left = rect.right - panelWidth;
		if (left < 8) left = 8;
		panelStyle.value = {
			top: rect.bottom + 4 + "px",
			left: left + "px",
			width: panelWidth + "px",
		};
	}
	showPanel.value = !showPanel.value;
}

function getFieldType(fieldname: string): string {
	return fieldMap.value[fieldname]?.fieldtype || "Data";
}

function getOperatorsForFilter(filter: LocalFilter) {
	return getFieldOperators(getFieldType(filter.field));
}

function getSelectOptionsForField(fieldname: string): string[] {
	return parseSelectOptions(fieldMap.value[fieldname]?.options);
}

async function onLinkSearch(fieldname: string, txt: string) {
	const doctype = fieldMap.value[fieldname]?.options;
	if (!doctype) {
		linkOptions[fieldname] = [];
		return;
	}
	try {
		const results = await searchLink(doctype, txt, undefined, 20);
		linkOptions[fieldname] = results.map((r) => ({
			label: r.description ? `${r.value} - ${r.description}` : r.value,
			value: r.value,
			description: r.description,
		}));
	} catch {
		linkOptions[fieldname] = [];
	}
}

function onFilterFieldChange(index: number) {
	const filter = localFilters.value[index];
	const fieldtype = getFieldType(filter.field);
	const operators = getFieldOperators(fieldtype);
	filter.operator = TEXT_FIELDTYPES.has(fieldtype) ? "like" : operators[0]?.value || "=";
	filter.value = "";
	emitFilters();
}

function addFilter() {
	const firstField = props.fields[0]?.fieldname || "name";
	const fieldtype = getFieldType(firstField);
	const operators = getFieldOperators(fieldtype);
	const defaultOp = TEXT_FIELDTYPES.has(fieldtype) ? "like" : operators[0]?.value || "=";
	localFilters.value.push({
		field: firstField,
		operator: defaultOp,
		value: "",
	});
}

function removeFilter(index: number) {
	localFilters.value.splice(index, 1);
	emitFilters();
}

function clearAll() {
	localFilters.value = [];
	emitFilters();
}

function emitFilters() {
	emit(
		"update:modelQueryFilters",
		localFilters.value.map((f) => ({ field: f.field, operator: f.operator, value: f.value })),
	);
}
</script>
