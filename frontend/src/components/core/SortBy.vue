<template>
	<div class="flex items-center rounded-md border border-input bg-background h-8">
		<button
			class="flex items-center justify-center w-7 h-full border-e border-input text-muted-foreground hover:text-foreground hover:bg-accent transition-colors rounded-s-md px-1.5"
			:title="
				dir === 'desc'
					? __('Descending - click to sort ascending')
					: __('Ascending - click to sort descending')
			"
			@click="toggleDir"
		>
			<ArrowDown v-if="dir === 'desc'" class="h-3.5 w-3.5" />
			<ArrowUp v-else class="h-3.5 w-3.5" />
		</button>

		<button
			ref="fieldBtnRef"
			class="flex items-center gap-1 px-2 h-full text-xs font-medium text-foreground hover:bg-accent transition-colors rounded-e-md"
			@click="toggleDropdown"
		>
			{{ currentFieldLabel }}
			<ChevronDown class="h-3 w-3 text-muted-foreground" />
		</button>

		<Teleport to="body">
			<div v-if="showDropdown" class="fixed inset-0 z-998" @click="closeDropdown" />
			<div
				v-if="showDropdown"
				class="fixed z-999 bg-popover border border-border rounded-lg shadow-lg min-w-50 max-h-72 flex flex-col overflow-hidden"
				:style="dropdownStyle"
			>
				<div class="px-2 py-1.5 border-b border-border shrink-0">
					<input
						ref="searchInputRef"
						v-model="fieldSearch"
						type="text"
						:placeholder="__('Search fields...')"
						class="w-full text-xs px-2 py-1 rounded border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
						@click.stop
						@keydown="onSearchKeydown"
					/>
				</div>

				<div ref="fieldListRef" class="overflow-y-auto py-1">
					<button
						v-for="(field, idx) in filteredFields"
						:key="field.fieldname"
						:data-sortby-index="idx"
						class="flex items-center w-full px-3 py-1.5 text-sm gap-2 text-start transition-colors"
						:class="
							idx === highlightedIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-accent'
						"
						@click="selectField(field.fieldname)"
						@mouseenter="highlightedIndex = idx"
					>
						<Check
							v-if="field.fieldname === currentField"
							class="h-3.5 w-3.5 shrink-0 text-primary"
						/>
						<span v-else class="inline-block h-3.5 w-3.5 shrink-0" />
						{{ field.label || field.fieldname }}
					</button>
					<div v-if="filteredFields.length === 0" class="px-3 py-2 text-sm text-muted-foreground">
						{{ __("No fields found") }}
					</div>
				</div>
			</div>
		</Teleport>
	</div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, watch } from "vue";
import { ArrowUp, ArrowDown, ChevronDown, Check } from "lucide-vue-next";
import type { DocField } from "@/services/doctypeMeta";
import __ from "@/lib/translate";

const NON_SORTABLE = new Set([
	"Text",
	"Long Text",
	"Small Text",
	"Code",
	"HTML Editor",
	"Markdown Editor",
	"JSON",
	"Attach",
	"Attach Image",
	"Password",
	"Table",
	"Table MultiSelect",
	"Section Break",
	"Column Break",
	"Tab Break",
	"HTML",
	"Button",
	"Fold",
	"Heading",
	"Image",
	"Signature",
	"Connection",
]);

const SYSTEM_FIELDS: DocField[] = [
	{ fieldname: "owner", fieldtype: "Data", label: "Created By" },
	{ fieldname: "modified_by", fieldtype: "Data", label: "Modified By" },
	{ fieldname: "modified", fieldtype: "Datetime", label: "Modified On" },
	{ fieldname: "creation", fieldtype: "Datetime", label: "Created On" },
	{ fieldname: "name", fieldtype: "Data", label: "ID" },
];

const props = defineProps<{
	modelValue: string;
	fields: DocField[];
}>();

const emit = defineEmits<{
	(e: "update:modelValue", value: string): void;
}>();

function parseField(orderBy: string): string {
	return (orderBy || "").split(/[\s,]/)[0] || "modified";
}

function parseDir(orderBy: string): "asc" | "desc" {
	const lower = (orderBy || "").toLowerCase();
	return lower.includes("asc") && !lower.includes("desc") ? "asc" : "desc";
}

const currentField = computed(() => parseField(props.modelValue));
const dir = computed(() => parseDir(props.modelValue));

const sortableFields = computed<DocField[]>(() => {
	const systemNames = new Set(SYSTEM_FIELDS.map((f) => f.fieldname));

	const relevant = props.fields.filter(
		(f) =>
			!systemNames.has(f.fieldname) &&
			!NON_SORTABLE.has(f.fieldtype) &&
			!f.hidden &&
			!f.fieldname.includes(".") &&
			(f.bold || f.in_list_view || f.reqd || f.in_standard_filter || f.in_global_search),
	);

	const all = [...SYSTEM_FIELDS, ...relevant];

	all.sort((a, b) => {
		const la = (a.label || a.fieldname).toLowerCase();
		const lb = (b.label || b.fieldname).toLowerCase();
		return la.localeCompare(lb);
	});

	return all;
});

const fieldSearch = ref("");

const filteredFields = computed<DocField[]>(() => {
	const q = fieldSearch.value.trim().toLowerCase();
	if (!q) return sortableFields.value;
	return sortableFields.value.filter(
		(f) => (f.label || f.fieldname).toLowerCase().includes(q) || f.fieldname.toLowerCase().includes(q),
	);
});

const currentFieldLabel = computed(() => {
	const found = sortableFields.value.find((f) => f.fieldname === currentField.value);
	return found?.label || currentField.value;
});

const showDropdown = ref(false);
const fieldBtnRef = ref<HTMLButtonElement | null>(null);
const searchInputRef = ref<HTMLInputElement | null>(null);
const fieldListRef = ref<HTMLDivElement | null>(null);
const dropdownStyle = ref<Record<string, string>>({});
const highlightedIndex = ref(-1);

watch(fieldSearch, () => {
	highlightedIndex.value = -1;
});

async function toggleDropdown() {
	if (!showDropdown.value && fieldBtnRef.value) {
		const rect = fieldBtnRef.value.getBoundingClientRect();
		const minWidth = 200;
		let left = rect.left;
		if (left + minWidth > window.innerWidth - 8) {
			left = window.innerWidth - minWidth - 8;
		}
		dropdownStyle.value = {
			top: `${rect.bottom + 4}px`,
			left: `${left}px`,
		};
		fieldSearch.value = "";
		highlightedIndex.value = -1;
		showDropdown.value = true;
		await nextTick();
		searchInputRef.value?.focus();
	} else {
		closeDropdown();
	}
}

function closeDropdown() {
	showDropdown.value = false;
	fieldSearch.value = "";
	highlightedIndex.value = -1;
}

function onSearchKeydown(e: KeyboardEvent) {
	const fields = filteredFields.value;
	switch (e.key) {
		case "ArrowDown":
			e.preventDefault();
			highlightedIndex.value = Math.min(highlightedIndex.value + 1, fields.length - 1);
			scrollToHighlighted();
			break;
		case "ArrowUp":
			e.preventDefault();
			highlightedIndex.value = Math.max(highlightedIndex.value - 1, 0);
			scrollToHighlighted();
			break;
		case "Enter":
			e.preventDefault();
			if (highlightedIndex.value >= 0 && highlightedIndex.value < fields.length) {
				selectField(fields[highlightedIndex.value].fieldname);
			}
			break;
		case "Escape":
			closeDropdown();
			break;
	}
}

function scrollToHighlighted() {
	nextTick(() => {
		const el = fieldListRef.value?.querySelector(
			`[data-sortby-index="${highlightedIndex.value}"]`,
		) as HTMLElement | null;
		el?.scrollIntoView({ block: "nearest" });
	});
}

function toggleDir() {
	const newDir = dir.value === "desc" ? "asc" : "desc";
	emit("update:modelValue", `${currentField.value} ${newDir}`);
}

function selectField(fieldname: string) {
	closeDropdown();
	emit("update:modelValue", `${fieldname} ${dir.value}`);
}
</script>
