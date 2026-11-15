<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { X } from "lucide-vue-next";
import __ from "@/lib/translate";
import { Badge } from "@/components/ui/badge";
import { Autocomplete, AutocompleteOption } from "@/components/ui/autocomplete";

const props = withDefaults(
	defineProps<{
		modelValue: string[];
		doctype: string;
		placeholder?: string;
		disabled?: boolean;
		filters?: Record<string, unknown>;
		label?: string;
	}>(),
	{
		placeholder: "",
		disabled: false,
		filters: () => ({}),
	},
);

const emit = defineEmits<{
	(e: "update:modelValue", value: string[]): void;
}>();

const selectedItems = ref<Array<{ value: string; label: string }>>([]);
const activeValue = ref("");

watch(
	() => props.modelValue,
	(values) => {
		const nextValues = Array.isArray(values) ? values : [];
		selectedItems.value = nextValues.map((value) => {
			const existing = selectedItems.value.find((item) => item.value === value);
			return existing ?? { value, label: value };
		});
	},
	{ immediate: true },
);

function syncValues() {
	emit(
		"update:modelValue",
		selectedItems.value.map((item) => item.value),
	);
}

function addSelectedOption(option: AutocompleteOption) {
	if (!option.value) return;
	if (selectedItems.value.some((item) => item.value === option.value)) {
		activeValue.value = "";
		return;
	}

	selectedItems.value = [
		...selectedItems.value,
		{ value: option.value, label: option.description ?? option.value },
	];
	syncValues();
	activeValue.value = "";
	void nextTick(() => {
		activeValue.value = "";
	});
}

function removeItem(value: string) {
	selectedItems.value = selectedItems.value.filter((item) => item.value !== value);
	syncValues();
}

function clearAll() {
	selectedItems.value = [];
	activeValue.value = "";
	syncValues();
}
</script>

<template>
	<div class="space-y-1">
		<div v-if="selectedItems.length > 0" class="flex flex-wrap gap-1">
			<Badge
				v-for="item in selectedItems"
				:key="item.value"
				variant="secondary"
				class="gap-1 ps-2 pe-1"
			>
				<span class="max-w-28 truncate">{{ item.label || item.value }}</span>
				<button
					type="button"
					class="rounded-full p-0.5 text-muted-foreground transition-colors hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
					:aria-label="__('Remove {0}', [item.label || item.value])"
					@click="removeItem(item.value)"
				>
					<X class="h-3 w-3" />
				</button>
			</Badge>
			<button
				v-if="selectedItems.length > 1"
				type="button"
				class="rounded-full px-1.5 text-xs text-muted-foreground hover:text-foreground"
				@click="clearAll"
			>
				{{ __("Clear") }}
			</button>
		</div>
		<Autocomplete
			v-model="activeValue"
			:doctype="doctype"
			:filters="filters"
			:disabled="disabled"
			:clearable="false"
			:open-on-focus="true"
			:min-chars="0"
			:placeholder="placeholder"
			:aria-label="label"
			class="w-full"
			@select="addSelectedOption"
		/>
	</div>
</template>
