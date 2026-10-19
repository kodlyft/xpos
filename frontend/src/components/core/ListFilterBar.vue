<template>
	<div class="flex flex-wrap items-center gap-2">
		<template v-for="field in resolvedFields" :key="field.fieldname">
			<Autocomplete
				v-if="field.fieldtype === 'Link'"
				:model-value="(modelFilters[field.fieldname] as string) || ''"
				:options="linkOptions[field.fieldname] || []"
				:placeholder="field.label || field.fieldname"
				:remote-search="true"
				:show-search-icon="false"
				:open-on-focus="true"
				:clearable="true"
				:max-visible="20"
				:empty-text="__('No results')"
				class="w-40"
				@search="(q: string) => onLinkSearch(field, q)"
				@update:model-value="(val: string | undefined) => onFilterChange(field.fieldname, val || '')"
			/>

			<Select
				v-else-if="field.fieldtype === 'Select'"
				class="w-40"
				:model-value="(modelFilters[field.fieldname] as string) || '__all__'"
				@update:model-value="(val: string | undefined) => onFilterChange(field.fieldname, val || '')"
				:items="[
					{ label: __('All'), value: '__all__' },
					...getSelectOptions(field).map((opt) => ({ label: __(opt), value: opt })),
				]"
			/>

			<Select
				v-else-if="field.fieldtype === 'Check'"
				class="w-40"
				:model-value="(modelFilters[field.fieldname] as string) || '__all__'"
				@update:model-value="(val: string | undefined) => onFilterChange(field.fieldname, val || '')"
				:items="[
					{ label: __('All'), value: '__all__' },
					{ label: __('Yes'), value: '1' },
					{ label: __('No'), value: '0' },
				]"
			/>
			<Input
				v-else
				:model-value="(modelFilters[field.fieldname] as string) || ''"
				:placeholder="field.label || field.fieldname"
				class="h-8 w-35 text-sm"
				@change="
					(e: Event) => onTextFilterChange(field.fieldname, (e.target as HTMLInputElement).value)
				"
				@keydown.enter="
					(e: Event) => onTextFilterChange(field.fieldname, (e.target as HTMLInputElement).value)
				"
			/>
		</template>
	</div>
</template>

<script setup lang="ts">
import { reactive, computed } from "vue";
import { Autocomplete } from "@/components/ui/autocomplete";
import type { AutocompleteOption } from "@/components/ui/autocomplete";
import { Input } from "@/components/ui/input";
import type { DocField } from "@/services/doctypeMeta";
import { parseSelectOptions } from "@/services/doctypeMeta";
import { searchLink } from "@/services/api";
import __ from "@/lib/translate";
import { Select } from "../ui/select";

const ID_FIELD: DocField = {
	fieldname: "name",
	fieldtype: "Data",
	label: "ID",
	in_standard_filter: 1,
};

const props = defineProps<{
	fields: DocField[];
	modelFilters: Record<string, unknown>;
}>();

const emit = defineEmits<{
	(e: "update:modelFilters", filters: Record<string, unknown>): void;
}>();

const resolvedFields = computed<DocField[]>(() => {
	const hasName = props.fields.some((f) => f.fieldname === "name");
	return hasName ? props.fields : [ID_FIELD, ...props.fields];
});

const linkOptions = reactive<Record<string, AutocompleteOption[]>>({});

function getSelectOptions(field: DocField): string[] {
	return parseSelectOptions(field.options);
}

async function onLinkSearch(field: DocField, txt: string) {
	if (!field.options) {
		linkOptions[field.fieldname] = [];
		return;
	}
	try {
		const results = await searchLink(field.options, txt);
		linkOptions[field.fieldname] = results.map((r) => ({
			label: r.description ? `${r.value} - ${r.description}` : r.value,
			value: r.value,
			description: r.description,
		}));
	} catch {
		linkOptions[field.fieldname] = [];
	}
}

function onFilterChange(fieldname: string, value: string) {
	const updated = { ...props.modelFilters };
	if (!value || value === "__all__") {
		delete updated[fieldname];
	} else {
		updated[fieldname] = value;
	}
	emit("update:modelFilters", updated);
}

function onTextFilterChange(fieldname: string, value: string) {
	const updated = { ...props.modelFilters };
	if (!value.trim()) {
		delete updated[fieldname];
	} else {
		updated[fieldname] = value.trim();
	}
	emit("update:modelFilters", updated);
}
</script>
