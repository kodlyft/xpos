<script setup lang="ts">
import { AlertTriangle } from "lucide-vue-next";
import __ from "@/lib/translate";
import { TooltipWrapper } from "@/components/ui/tooltip";
import ReportFilterField from "@/components/reports/ReportFilterField.vue";
import type { ReportFilterDefinition } from "@/services/reports";

defineProps<{
	filters: ReportFilterDefinition[];
	values: Record<string, unknown>;
	errors?: string[];
}>();

const emit = defineEmits<{
	(e: "set", fieldname: string, value: unknown): void;
	(e: "apply"): void;
}>();
</script>

<template>
	<form
		v-if="filters.length > 0"
		class="flex flex-wrap items-start gap-2"
		role="search"
		@submit.prevent="emit('apply')"
	>
		<TooltipWrapper
			v-for="filter in filters"
			:key="filter.fieldname"
			:content="filter.label"
			side="bottom"
		>
			<div class="relative w-44 min-w-0 flex-none">
				<span
					v-if="filter.required"
					class="pointer-events-none absolute -top-1 -inset-e-0.5 z-10 text-base font-bold leading-none text-destructive"
					aria-hidden="true"
					>*</span
				>
				<ReportFilterField
					:filter="filter"
					:filters="filters"
					:values="values"
					@set="(name, value) => emit('set', name, value)"
				/>
			</div>
		</TooltipWrapper>
		<button type="submit" class="sr-only">{{ __("Run") }}</button>
		<ul
			v-if="errors && errors.length > 0"
			class="basis-full space-y-0.5 text-xs text-destructive"
			role="alert"
		>
			<li v-for="message in errors" :key="message" class="flex items-center gap-1.5">
				<AlertTriangle class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />{{ message }}
			</li>
		</ul>
	</form>
</template>
