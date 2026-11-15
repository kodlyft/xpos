<script setup lang="ts">
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Autocomplete } from "@/components/ui/autocomplete";
import { DateTimePicker } from "@/components/ui/datetime-picker";
import MultiLinkInput from "@/components/reports/MultiLinkInput.vue";
import __ from "@/lib/translate";
import { resolveReportLinkFilters, type ReportFilterDefinition } from "@/services/reports";

const props = defineProps<{
	filter: ReportFilterDefinition;
	filters: ReportFilterDefinition[];
	values: Record<string, unknown>;
}>();

const emit = defineEmits<{ (e: "set", fieldname: string, value: unknown): void }>();

function emptyValueFor(fieldname: string): unknown {
	const def = props.filters.find((filter) => filter.fieldname === fieldname);
	return def?.type === "multi-link" ? [] : "";
}

function setValue(value: unknown) {
	emit("set", props.filter.fieldname, value);
	for (const dependent of props.filter.clears ?? []) {
		emit("set", dependent, emptyValueFor(dependent));
	}
}

function stringValue(): string {
	const value = props.values[props.filter.fieldname];
	if (value === null || value === undefined) return "";
	if (Array.isArray(value)) return value.map((item) => String(item)).join(", ");
	return String(value);
}

function multiValue(): string[] {
	const value = props.values[props.filter.fieldname];
	return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function placeholder(): string {
	const { filter } = props;
	if (filter.placeholder) return filter.placeholder;
	return filter.label;
}
</script>

<template>
	<Autocomplete
		v-if="filter.type === 'link'"
		:model-value="stringValue()"
		:doctype="filter.doctype || 'DocType'"
		:filters="resolveReportLinkFilters(filter, values)"
		:placeholder="placeholder()"
		:aria-label="filter.label"
		:open-on-focus="true"
		:clearable="true"
		class="w-full"
		@update:model-value="setValue"
	/>

	<MultiLinkInput
		v-else-if="filter.type === 'multi-link'"
		:model-value="multiValue()"
		:doctype="filter.doctype || 'DocType'"
		:filters="resolveReportLinkFilters(filter, values)"
		:placeholder="placeholder()"
		:label="filter.label"
		class="w-full"
		@update:model-value="setValue"
	/>

	<DateTimePicker
		v-else-if="filter.type === 'date'"
		:model-value="stringValue()"
		mode="date"
		:show-today="true"
		:clearable="true"
		:placeholder="placeholder()"
		class="w-full"
		@change="setValue"
	/>

	<Select
		v-else-if="filter.type === 'select'"
		:model-value="stringValue()"
		:placeholder="placeholder()"
		:items="filter.options || []"
		@update:model-value="setValue"
	/>

	<Input
		v-else
		:id="`rf-${filter.fieldname}`"
		:aria-label="filter.label"
		:model-value="stringValue()"
		:type="filter.type === 'text' ? 'text' : 'number'"
		:step="filter.type === 'float' ? '0.01' : '1'"
		:placeholder="placeholder()"
		class="w-full"
		@update:model-value="setValue"
	/>
</template>
