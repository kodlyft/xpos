<script setup lang="ts">
import { ref, computed, nextTick, watch } from "vue";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Autocomplete } from "@/components/ui/autocomplete";
import type { AutocompleteOption } from "@/components/ui/autocomplete";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip";
import { Select } from "@/components/ui/select";
import {
	Trash2,
	Plus,
	Package,
	Settings,
	Copy,
	GripVertical,
	ChevronUp,
	ChevronDown,
	X,
	Check,
	Pencil,
} from "lucide-vue-next";
import __ from "@/lib/translate";
import type { TableColumn as ChildTableColumn, TableRow as ChildTableRow, SelectOption } from "./types";
import { formatNumber } from "@/utils/numberFormat";
import Checkbox from "../checkbox/Checkbox.vue";
import { EmptyState } from "../state";

const props = withDefaults(
	defineProps<{
		rows: ChildTableRow[];
		columns: ChildTableColumn[];
		label?: string;
		flush?: boolean;
		minWidth?: string;
		showRowNumbers?: boolean;
		showCheckboxes?: boolean;
		showDeleteButton?: boolean;
		showAddRow?: boolean;
		keyboardNavigation?: boolean;
		allowReorder?: boolean;
		allowDuplicate?: boolean;
		emptyMessage?: string;
		emptyDescription?: string;
		showColumnSettings?: boolean;
		highlightNewRows?: boolean;
		showEditRow?: boolean;
		tabToAddRow?: boolean;
	}>(),
	{
		label: "Items",
		minWidth: "1200px",
		showRowNumbers: true,
		showCheckboxes: true,
		showDeleteButton: true,
		showAddRow: true,
		keyboardNavigation: true,
		allowReorder: true,
		allowDuplicate: true,
		emptyMessage: "No rows added",
		emptyDescription: "Add items to get started",
		showColumnSettings: true,
		highlightNewRows: true,
		showEditRow: false,
		tabToAddRow: false,
	},
);

const emit = defineEmits<{
	(e: "update:rows", rows: ChildTableRow[]): void;
	(e: "add-row"): void;
	(e: "cell-change", payload: { rowIndex: number; fieldname: string; value: any }): void;
	(e: "link-select", payload: { rowIndex: number; fieldname: string; option: AutocompleteOption }): void;
}>();

const tableContainerRef = ref<HTMLElement | null>(null);
const isTouchDevice = ref("ontouchstart" in window || navigator.maxTouchPoints > 0);

type FocusTarget = {
	focus: () => void;
	select?: () => void;
};

const inputRefs = ref<Map<string, FocusTarget>>(new Map());
const selectedIndices = ref<Set<number>>(new Set());
const showColumnSettingsModal = ref(false);
const hiddenColumns = ref<Set<string>>(new Set());
const draggingRowIndex = ref<number | null>(null);
const dragOverRowIndex = ref<number | null>(null);
const dragInsertPosition = ref<"before" | "after" | null>(null);

const editorOpen = ref(false);
const editorRowIndex = ref(-1);
const editorRowData = ref<ChildTableRow>({});
const editorMoveToIndex = ref(1);

const visibleColumns = computed(() => {
	return props.columns.filter((col) => col.visible !== false && !hiddenColumns.value.has(col.fieldname));
});

const editableColumnNames = computed(() => {
	return visibleColumns.value
		.filter((col) => col.editable !== false && col.type !== "readonly" && col.type !== "component")
		.map((col) => col.fieldname);
});

function parseTwWidth(tw?: string): number {
	if (!tw) return 0;
	const m = tw.match(/\[(\d+)px\]/);
	return m ? parseInt(m[1], 10) : 0;
}

const frozenStyles = computed(() => {
	const map = new Map<string, Record<string, string>>();
	let left = 0;

	if (props.showCheckboxes) {
		map.set("__checkbox", { position: "sticky", left: `${left}px`, zIndex: "11" });
		left += 32; // w-8
	}
	if (props.showRowNumbers) {
		map.set("__rownumber", { position: "sticky", left: `${left}px`, zIndex: "11" });
		left += 40; // w-10
	}
	for (const col of visibleColumns.value) {
		if (col.frozen === "left") {
			map.set(col.fieldname, { position: "sticky", left: `${left}px`, zIndex: "11" });
			left += col.frozenWidth || parseTwWidth(col.width) || 150;
		}
	}
	return map;
});

const lastFrozenFieldname = computed(() => {
	let last = "";
	if (props.showCheckboxes) last = "__checkbox";
	if (props.showRowNumbers) last = "__rownumber";
	for (const col of visibleColumns.value) {
		if (col.frozen === "left") last = col.fieldname;
	}
	return last;
});

const editorColumns = computed(() => {
	return props.columns.filter((col) => {
		if (col.showInEditor === false) return false;
		if (col.type === "component") return false;
		return true;
	});
});

const isAllRowsSelected = computed((): boolean | "indeterminate" => {
	if (isPartialSelect.value) return "indeterminate";
	return props.rows.length > 0 && selectedIndices.value.size === props.rows.length;
});

const isPartialSelect = computed(() => {
	return selectedIndices.value.size > 0 && selectedIndices.value.size < props.rows.length;
});

const totalColSpan = computed(() => {
	let count = visibleColumns.value.length;
	if (props.showRowNumbers) count++;
	if (props.showCheckboxes) count++;
	if (hasActions.value) count++;
	return count;
});

const showRowDragHandle = computed(() => props.allowReorder && props.showRowNumbers);

const showInlineReorderActions = computed(() => props.allowReorder && !props.showRowNumbers);

const hasActions = computed(() => {
	return (
		props.showDeleteButton || props.allowDuplicate || props.showEditRow || showInlineReorderActions.value
	);
});

const actionColumnWidthClass = computed(() => {
	if (!hasActions.value) return "";
	return showInlineReorderActions.value ? "w-[112px]" : "w-[84px]";
});

function toFocusTarget(value: unknown): FocusTarget | null {
	if (!value) return null;

	if (value instanceof HTMLElement) {
		return {
			focus: () => value.focus(),
			select:
				"select" in value && typeof (value as HTMLInputElement).select === "function"
					? () => (value as HTMLInputElement).select()
					: undefined,
		};
	}

	const component = value as {
		focus?: () => void;
		select?: () => void;
		getInputEl?: () => HTMLInputElement | null;
		getTriggerEl?: () => HTMLElement | null;
	};

	if (typeof component.focus === "function") {
		return {
			focus: () => component.focus!(),
			select: typeof component.select === "function" ? () => component.select!() : undefined,
		};
	}

	const el =
		(typeof component.getInputEl === "function" ? component.getInputEl() : null) ??
		(typeof component.getTriggerEl === "function" ? component.getTriggerEl() : null);

	if (el instanceof HTMLElement) {
		return {
			focus: () => el.focus(),
			select:
				"select" in el && typeof (el as HTMLInputElement).select === "function"
					? () => (el as HTMLInputElement).select()
					: undefined,
		};
	}

	return null;
}

function registerInput(rowIndex: number, fieldname: string, el: FocusTarget | null): void {
	const key = `${rowIndex}-${fieldname}`;
	if (el) {
		inputRefs.value.set(key, el);
	} else {
		inputRefs.value.delete(key);
	}
}

function focusCell(rowIndex: number, fieldname: string): void {
	const key = `${rowIndex}-${fieldname}`;
	nextTick(() => {
		requestAnimationFrame(() => {
			const input = inputRefs.value.get(key);
			if (input) {
				input.focus();
				input.select?.();
			}
		});
	});
}

function clampRowIndex(index: number): number {
	return Math.max(0, Math.min(props.rows.length - 1, index));
}

function shiftSelectionAfterDelete(index: number): void {
	const next = new Set<number>();
	for (const selectedIndex of selectedIndices.value) {
		if (selectedIndex === index) continue;
		next.add(selectedIndex > index ? selectedIndex - 1 : selectedIndex);
	}
	selectedIndices.value = next;
}

function shiftSelectionAfterMove(fromIndex: number, toIndex: number): void {
	if (fromIndex === toIndex) return;

	const next = new Set<number>();
	for (const selectedIndex of selectedIndices.value) {
		if (selectedIndex === fromIndex) {
			next.add(toIndex);
			continue;
		}

		if (fromIndex < toIndex && selectedIndex > fromIndex && selectedIndex <= toIndex) {
			next.add(selectedIndex - 1);
			continue;
		}

		if (toIndex < fromIndex && selectedIndex >= toIndex && selectedIndex < fromIndex) {
			next.add(selectedIndex + 1);
			continue;
		}

		next.add(selectedIndex);
	}

	selectedIndices.value = next;
}

function clearDragState(): void {
	draggingRowIndex.value = null;
	dragOverRowIndex.value = null;
	dragInsertPosition.value = null;
}

function notifyRowsUpdated(): void {
	emit("update:rows", props.rows.slice());
}

function reorderRows(fromIndex: number, toIndex: number): boolean {
	if (props.rows.length < 2) return false;
	if (fromIndex < 0 || fromIndex >= props.rows.length) return false;

	const clampedIndex = clampRowIndex(toIndex);
	if (fromIndex === clampedIndex) return false;

	const [row] = props.rows.splice(fromIndex, 1);
	if (!row) return false;
	props.rows.splice(clampedIndex, 0, row);
	shiftSelectionAfterMove(fromIndex, clampedIndex);
	notifyRowsUpdated();
	return true;
}

function onHandleDragStart(event: DragEvent, index: number): void {
	if (!props.allowReorder || props.rows.length < 2) return;

	draggingRowIndex.value = index;
	dragOverRowIndex.value = index;
	dragInsertPosition.value = "before";
	selectedIndices.value = new Set([index]);

	if (event.dataTransfer) {
		event.dataTransfer.effectAllowed = "move";
		event.dataTransfer.setData("text/plain", String(index));
	}
}

function onHandleDragEnd(): void {
	clearDragState();
}

function syncEditorRowData(): void {
	if (!editorOpen.value || editorRowIndex.value < 0) return;
	const sourceRow = props.rows[editorRowIndex.value];
	if (!sourceRow) return;
	editorRowData.value = { ...sourceRow };
}

function onRowDragOver(event: DragEvent, index: number): void {
	if (!props.allowReorder || draggingRowIndex.value === null) return;

	event.preventDefault();
	const rowEl = event.currentTarget as HTMLElement | null;
	if (!rowEl) return;

	const rect = rowEl.getBoundingClientRect();
	const offset = event.clientY - rect.top;
	dragOverRowIndex.value = index;
	dragInsertPosition.value = offset < rect.height / 2 ? "before" : "after";

	if (event.dataTransfer) {
		event.dataTransfer.dropEffect = "move";
	}
}

function onRowDrop(event: DragEvent, index: number): void {
	if (!props.allowReorder || draggingRowIndex.value === null) return;

	event.preventDefault();
	const fromIndex = draggingRowIndex.value;
	const position = dragInsertPosition.value ?? "after";
	let insertionIndex = index + (position === "after" ? 1 : 0);
	if (insertionIndex > fromIndex) {
		insertionIndex -= 1;
	}

	reorderRows(fromIndex, insertionIndex);
	clearDragState();
}

function handleKeyDown(event: KeyboardEvent, rowIndex: number, fieldname: string): void {
	if (event.defaultPrevented || !props.keyboardNavigation) return;

	const cols = editableColumnNames.value;
	const colIndex = cols.indexOf(fieldname);
	if (colIndex === -1) return;
	const totalRows = props.rows.length;

	let newRowIndex = rowIndex;
	let newColIndex = colIndex;

	switch (event.key) {
		case "ArrowUp":
			event.preventDefault();
			newRowIndex = Math.max(0, rowIndex - 1);
			break;
		case "ArrowDown":
			event.preventDefault();
			newRowIndex = Math.min(totalRows - 1, rowIndex + 1);
			break;
		case "ArrowLeft":
			if ((event.target as HTMLInputElement)?.selectionStart === 0) {
				event.preventDefault();
				newColIndex = Math.max(0, colIndex - 1);
			} else {
				return;
			}
			break;
		case "ArrowRight": {
			const input = event.target as HTMLInputElement;
			if (input?.selectionStart === input?.value?.length) {
				event.preventDefault();
				newColIndex = Math.min(cols.length - 1, colIndex + 1);
			} else {
				return;
			}
			break;
		}
		case "Enter":
			event.preventDefault();
			if (rowIndex < totalRows - 1) {
				newRowIndex = rowIndex + 1;
			}
			break;
		case "Tab":
			if (event.shiftKey) {
				const isFirstCol = colIndex === 0;
				const isFirstRow = rowIndex === 0;
				if (isFirstCol && isFirstRow) return;

				event.preventDefault();
				if (isFirstCol) {
					focusCell(rowIndex - 1, cols[cols.length - 1]);
				} else {
					focusCell(rowIndex, cols[colIndex - 1]);
				}
				return;
			}

			const isLastCol = colIndex === cols.length - 1;
			const isLastRow = rowIndex === totalRows - 1;
			if (isLastCol && isLastRow) {
				if (props.tabToAddRow) {
					event.preventDefault();
					emit("add-row");
				}
				return;
			}

			event.preventDefault();
			if (isLastCol) {
				focusCell(rowIndex + 1, cols[0]);
			} else {
				focusCell(rowIndex, cols[colIndex + 1]);
			}
			return;
		default:
			return;
	}

	if (newRowIndex !== rowIndex || newColIndex !== colIndex) {
		const newField = cols[newColIndex];
		focusCell(newRowIndex, newField);
	}
}

watch(
	() => props.rows.length,
	(newLen, oldLen) => {
		if (!props.highlightNewRows || newLen <= oldLen) return;
		nextTick(() => {
			const lastIndex = newLen - 1;
			if (editableColumnNames.value.length > 0) {
				focusCell(lastIndex, editableColumnNames.value[0]);
			}
			const rows = tableContainerRef.value?.querySelectorAll(".ct-row");
			const lastRow = rows?.[lastIndex] as HTMLElement | null;
			if (lastRow) {
				lastRow.scrollIntoView({ block: "nearest", behavior: "smooth" });
				lastRow.classList.add("ring-2", "ring-primary/50");
				setTimeout(() => {
					lastRow.classList.remove("ring-2", "ring-primary/50");
				}, 800);
			}
		});
	},
);

watch(
	() => props.rows.length,
	(newLen) => {
		if (!editorOpen.value) return;
		if (newLen === 0 || editorRowIndex.value >= newLen) {
			closeRowEditor();
			return;
		}

		editorMoveToIndex.value = Math.min(editorMoveToIndex.value, newLen);
	},
);

watch(
	() => (editorOpen.value && editorRowIndex.value >= 0 ? props.rows[editorRowIndex.value] : undefined),
	() => {
		syncEditorRowData();
	},
	{ deep: true },
);

function toggleSelectAll(): void {
	if (isAllRowsSelected.value === true) {
		selectedIndices.value.clear();
	} else {
		selectedIndices.value = new Set(props.rows.map((_, i) => i));
	}
}

function toggleRowSelect(index: number): void {
	if (selectedIndices.value.has(index)) {
		selectedIndices.value.delete(index);
	} else {
		selectedIndices.value.add(index);
	}
}

function addRow(): void {
	emit("add-row");
}

function deleteRow(index: number): void {
	if (index < 0 || index >= props.rows.length) return;

	shiftSelectionAfterDelete(index);
	props.rows.splice(index, 1);
	notifyRowsUpdated();
}

function deleteSelected(): void {
	const indices = Array.from(selectedIndices.value).sort((a, b) => b - a);
	for (const index of indices) {
		props.rows.splice(index, 1);
	}
	notifyRowsUpdated();
	selectedIndices.value.clear();
}

function duplicateRow(index: number): void {
	const row = props.rows[index];
	if (!row) return;

	props.rows.splice(index + 1, 0, { ...row });
	notifyRowsUpdated();
}

function moveRow(index: number, direction: -1 | 1): void {
	reorderRows(index, index + direction);
}

function onCellChange(rowIndex: number, fieldname: string, value: any): void {
	emit("cell-change", { rowIndex, fieldname, value });
}

function onLinkSelect(rowIndex: number, col: ChildTableColumn, option: AutocompleteOption): void {
	emit("cell-change", { rowIndex, fieldname: col.fieldname, value: option.value });
	emit("link-select", { rowIndex, fieldname: col.fieldname, option });

	if (col.link?.onSelect) {
		const row = props.rows[rowIndex];
		const partial = col.link.onSelect(
			option.value,
			{ value: option.value, description: option.description },
			row,
			rowIndex,
		);
		if (partial && typeof partial === "object") {
			for (const [key, val] of Object.entries(partial)) {
				emit("cell-change", { rowIndex, fieldname: key, value: val });
			}
		}
	}
}

function getLinkFilters(col: ChildTableColumn, row: ChildTableRow, index: number): Record<string, unknown> {
	if (!col.link?.filters) return {};
	if (typeof col.link.filters === "function") return col.link.filters(row, index);
	return col.link.filters;
}

function openRowEditor(index: number): void {
	if (!props.rows[index]) return;

	editorRowIndex.value = index;
	editorMoveToIndex.value = index + 1;
	editorOpen.value = true;
	syncEditorRowData();
}

function closeRowEditor(): void {
	editorOpen.value = false;
	editorRowIndex.value = -1;
	editorMoveToIndex.value = 1;
	editorRowData.value = {};
}

function onEditorFieldChange(fieldname: string, value: any): void {
	editorRowData.value[fieldname] = value;
	if (editorRowIndex.value < 0) return;
	emit("cell-change", { rowIndex: editorRowIndex.value, fieldname, value });
}

function onEditorLinkSelect(col: ChildTableColumn, option: AutocompleteOption): void {
	if (editorRowIndex.value < 0) return;

	editorRowData.value[col.fieldname] = option.value;
	emit("cell-change", {
		rowIndex: editorRowIndex.value,
		fieldname: col.fieldname,
		value: option.value,
	});
	emit("link-select", {
		rowIndex: editorRowIndex.value,
		fieldname: col.fieldname,
		option,
	});

	if (col.link?.onSelect) {
		const partial = col.link.onSelect(
			option.value,
			{ value: option.value, description: option.description },
			editorRowData.value,
			editorRowIndex.value,
		);
		if (partial && typeof partial === "object") {
			for (const [key, val] of Object.entries(partial)) {
				editorRowData.value[key] = val;
				emit("cell-change", { rowIndex: editorRowIndex.value, fieldname: key, value: val });
			}
		}
	}
}

function saveRowEditor(): void {
	if (editorRowIndex.value < 0) return;
	closeRowEditor();
}

function moveEditorRow(direction: -1 | 1): void {
	const idx = editorRowIndex.value;
	if (idx < 0) return;

	const targetIndex = idx + direction;
	if (targetIndex < 0 || targetIndex >= props.rows.length) return;

	if (reorderRows(idx, targetIndex)) {
		editorRowIndex.value = targetIndex;
		editorMoveToIndex.value = targetIndex + 1;
		syncEditorRowData();
	}
}

function moveEditorRowToIndex(): void {
	const idx = editorRowIndex.value;
	if (idx < 0) return;

	const targetIndex = clampRowIndex(Math.round(editorMoveToIndex.value || idx + 1) - 1);
	if (reorderRows(idx, targetIndex)) {
		editorRowIndex.value = targetIndex;
		editorMoveToIndex.value = targetIndex + 1;
		syncEditorRowData();
	} else {
		editorMoveToIndex.value = idx + 1;
	}
}

function deleteEditorRow(): void {
	const idx = editorRowIndex.value;
	if (idx < 0) return;

	deleteRow(idx);
	closeRowEditor();
}

function toggleColumnVisibility(fieldname: string): void {
	if (hiddenColumns.value.has(fieldname)) {
		hiddenColumns.value.delete(fieldname);
	} else {
		hiddenColumns.value.add(fieldname);
	}
}

function resetColumns(): void {
	hiddenColumns.value.clear();
}

function getAlignClass(align?: string): string {
	switch (align) {
		case "right":
			return "text-end";
		case "center":
			return "text-center";
		default:
			return "text-start";
	}
}

function getCellClass(col: ChildTableColumn, value: any, row: ChildTableRow, index: number): string {
	if (!col.cellClass) return "";
	if (typeof col.cellClass === "function") return col.cellClass(value, row, index);
	return col.cellClass;
}

function getSelectOptions(col: ChildTableColumn, row: ChildTableRow, index: number): SelectOption[] {
	if (!col.options) return [];
	if (typeof col.options === "function") return col.options(row, index);
	return col.options;
}

function formatValue(col: ChildTableColumn, value: any, row: ChildTableRow, index: number): string {
	if (col.format) return col.format(value, row, index);
	if (value === null || value === undefined) return "-";
	if (col.type === "number" && value !== "") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return formatNumber(parsed, null, col.precision ?? null);
	}
	return String(value);
}

function handleTableKeyDown(event: KeyboardEvent): void {
	if ((event.ctrlKey || event.metaKey) && event.key === "d") {
		if (selectedIndices.value.size === 1) {
			event.preventDefault();
			const index = Array.from(selectedIndices.value)[0];
			duplicateRow(index);
		}
	}
	if (event.key === "Delete" && selectedIndices.value.size > 0) {
		const target = event.target as HTMLElement;
		if (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA")
			return;
		event.preventDefault();
		deleteSelected();
	}
}
</script>

<template>
	<div
		:class="[
			'child-table flex min-h-0 flex-col overflow-hidden bg-card',
			flush ? '' : 'rounded-lg border border-border shadow-raised',
		]"
		@keydown="handleTableKeyDown"
	>
		<div
			class="shrink-0 flex flex-col gap-2 px-3 py-2 bg-surface-sunken border-b border-border sm:flex-row sm:items-center sm:justify-between"
		>
			<div class="flex items-center gap-2">
				<span class="text-sm font-semibold text-foreground">
					{{ __(label) }}
				</span>
				<span
					class="text-xs font-medium text-muted-foreground bg-card border border-border px-1.5 py-0.5 rounded-full tabular-nums"
				>
					{{ rows.length }}
				</span>
			</div>
			<div class="flex w-full flex-wrap items-center gap-1.5 sm:w-auto sm:justify-end">
				<template v-if="selectedIndices.size > 0">
					<span class="text-xs font-semibold text-primary me-1">
						{{ selectedIndices.size }} {{ __("selected") }}
					</span>
					<TooltipWrapper :content="__('Delete selected')">
						<Button
							variant="ghost"
							size="icon"
							class="h-7 w-7 text-destructive hover:bg-destructive-soft"
							@click="deleteSelected"
						>
							<Trash2 class="w-3.5 h-3.5" />
						</Button>
					</TooltipWrapper>
					<TooltipWrapper :content="__('Deselect all')">
						<Button variant="ghost" size="icon" class="h-7 w-7" @click="selectedIndices.clear()">
							<X class="w-3.5 h-3.5" />
						</Button>
					</TooltipWrapper>
					<div class="w-px h-4 bg-border mx-0.5" />
				</template>

				<slot name="toolbar" />

				<Button v-if="showAddRow" variant="outline" size="sm" class="h-7 text-xs" @click="addRow">
					<Plus class="w-3.5 h-3.5 me-1" />
					{{ __("Add Row") }}
				</Button>

				<TooltipWrapper v-if="showColumnSettings" :content="__('Column settings')">
					<Button
						variant="ghost"
						size="icon"
						class="h-7 w-7"
						@click="showColumnSettingsModal = true"
					>
						<Settings class="w-3.5 h-3.5" />
					</Button>
				</TooltipWrapper>
			</div>
		</div>

		<div ref="tableContainerRef" class="ct-table-container flex-1 min-h-0 overflow-auto">
			<div v-if="rows.length === 0" class="flex h-full min-h-45 items-center justify-center">
				<EmptyState :icon="Package" :title="__(emptyMessage)" :description="__(emptyDescription)">
					<Button v-if="showAddRow" variant="outline" size="sm" @click="addRow">
						<Plus class="w-3.5 h-3.5 me-1" />
						{{ __("Add First Row") }}
					</Button>
				</EmptyState>
			</div>

			<table v-else class="w-full text-sm ct-table" :style="{ minWidth: minWidth }">
				<thead class="sticky top-0 z-20 bg-surface-sunken border-b border-border">
					<tr class="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
						<th
							v-if="showCheckboxes"
							class="w-8 px-2 py-2 bg-surface-sunken"
							:style="frozenStyles.get('__checkbox')"
							:class="{ 'ct-frozen-last': lastFrozenFieldname === '__checkbox' }"
						>
							<Checkbox
								:checked="isAllRowsSelected"
								:indeterminate="isPartialSelect"
								@update:checked="toggleSelectAll"
							/>
						</th>
						<th
							v-if="showRowNumbers"
							class="px-2 py-2 text-center w-10 bg-surface-sunken"
							:style="frozenStyles.get('__rownumber')"
							:class="{ 'ct-frozen-last': lastFrozenFieldname === '__rownumber' }"
						>
							#
						</th>
						<th
							v-for="col in visibleColumns"
							:key="col.fieldname"
							class="px-2 py-2 whitespace-nowrap"
							:class="[
								getAlignClass(col.align),
								col.width,
								col.frozen === 'left' ? 'bg-surface-sunken' : '',
								lastFrozenFieldname === col.fieldname ? 'ct-frozen-last' : '',
							]"
							:style="frozenStyles.get(col.fieldname)"
						>
							{{ __(col.label) }}
							<span v-if="col.required" class="text-destructive">*</span>
						</th>
						<th
							v-if="hasActions"
							class="px-2 py-2 text-center"
							:class="actionColumnWidthClass"
						></th>
					</tr>
				</thead>
				<tbody class="divide-y divide-border">
					<tr
						v-for="(row, rowIndex) in rows"
						:key="`row-${rowIndex}`"
						class="hover:bg-surface-hover/50 transition-colors ct-row group"
						:class="{
							'bg-surface-selected/60': selectedIndices.has(rowIndex),
							'ct-row-dragging': draggingRowIndex === rowIndex,
							'ct-row-drop-before':
								dragOverRowIndex === rowIndex && dragInsertPosition === 'before',
							'ct-row-drop-after':
								dragOverRowIndex === rowIndex && dragInsertPosition === 'after',
						}"
						@dragover="onRowDragOver($event, rowIndex)"
						@drop="onRowDrop($event, rowIndex)"
					>
						<td
							v-if="showCheckboxes"
							class="px-2 py-1 bg-card group-hover:bg-surface-hover/50"
							:style="frozenStyles.get('__checkbox')"
							:class="{ 'ct-frozen-last': lastFrozenFieldname === '__checkbox' }"
						>
							<Checkbox
								:checked="selectedIndices.has(rowIndex)"
								@update:checked="toggleRowSelect(rowIndex)"
							/>
						</td>

						<td
							v-if="showRowNumbers"
							class="px-2 py-1 text-center text-xs text-muted-foreground tabular-nums bg-card group-hover:bg-surface-hover/50"
							:style="frozenStyles.get('__rownumber')"
							:class="{ 'ct-frozen-last': lastFrozenFieldname === '__rownumber' }"
						>
							<button
								v-if="showRowDragHandle"
								type="button"
								class="ct-row-handle mx-auto flex h-7 min-w-7 items-center justify-center rounded-md px-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
								:class="{ 'ct-row-handle-dragging': draggingRowIndex === rowIndex }"
								:draggable="rows.length > 1"
								:title="__('Drag to reorder')"
								@click.stop
								@dragstart="onHandleDragStart($event, rowIndex)"
								@dragend="onHandleDragEnd"
							>
								<GripVertical class="h-3.5 w-3.5 me-0.5 opacity-60" />
								<span>{{ rowIndex + 1 }}</span>
							</button>
							<span v-else>{{ rowIndex + 1 }}</span>
						</td>

						<td
							v-for="col in visibleColumns"
							:key="`${rowIndex}-${col.fieldname}`"
							class="px-2 py-1"
							:class="[
								getAlignClass(col.align),
								col.frozen === 'left' ? 'bg-card group-hover:bg-surface-hover/50' : '',
								lastFrozenFieldname === col.fieldname ? 'ct-frozen-last' : '',
							]"
							:style="frozenStyles.get(col.fieldname)"
							@keydown="handleKeyDown($event, rowIndex, col.fieldname)"
						>
							<slot
								:name="`cell-${col.fieldname}`"
								:row="row"
								:index="rowIndex"
								:column="col"
								:value="row[col.fieldname]"
								:onChange="(val: any) => onCellChange(rowIndex, col.fieldname, val)"
								:registerInput="
									(el: unknown) => registerInput(rowIndex, col.fieldname, toFocusTarget(el))
								"
								:onKeyDown="(e: KeyboardEvent) => handleKeyDown(e, rowIndex, col.fieldname)"
							>
								<Autocomplete
									v-if="col.type === 'link' && col.link"
									:model-value="row[col.fieldname] || ''"
									@update:model-value="onCellChange(rowIndex, col.fieldname, $event)"
									@select="(opt: AutocompleteOption) => onLinkSelect(rowIndex, col, opt)"
									:doctype="col.link.doctype"
									:label-field="col.link.labelField || 'name'"
									:filters="getLinkFilters(col, row, rowIndex)"
									:placeholder="
										col.placeholder
											? __(col.placeholder)
											: `Search ${col.link.doctype}...`
									"
									:compact="true"
									:table-navigation="keyboardNavigation"
									:show-search-icon="false"
									:clearable="true"
									:ref="
										(el: unknown) =>
											registerInput(rowIndex, col.fieldname, toFocusTarget(el))
									"
								/>

								<Input
									v-else-if="col.type === 'text'"
									:model-value="row[col.fieldname] || ''"
									@update:model-value="onCellChange(rowIndex, col.fieldname, $event)"
									class="h-7 text-xs"
									:placeholder="col.placeholder ? __(col.placeholder) : ''"
									@keydown="handleKeyDown($event, rowIndex, col.fieldname)"
									:ref="
										(el: unknown) =>
											registerInput(rowIndex, col.fieldname, toFocusTarget(el))
									"
								/>

								<NumberInput
									v-else-if="col.type === 'number'"
									:model-value="row[col.fieldname] ?? 0"
									@update:model-value="onCellChange(rowIndex, col.fieldname, $event)"
									:min="col.min ?? 0"
									:disable-spinner="true"
									:max="col.max"
									:precision="col.precision ?? 2"
									class="h-7 text-xs w-full"
									:placeholder="col.placeholder"
									@keydown="handleKeyDown($event, rowIndex, col.fieldname)"
									:ref="
										(el: unknown) =>
											registerInput(rowIndex, col.fieldname, toFocusTarget(el))
									"
								/>

								<Input
									v-else-if="col.type === 'date'"
									type="date"
									:model-value="row[col.fieldname] || ''"
									@update:model-value="onCellChange(rowIndex, col.fieldname, $event)"
									class="h-7 text-xs"
									@keydown="handleKeyDown($event, rowIndex, col.fieldname)"
									:ref="
										(el: unknown) =>
											registerInput(rowIndex, col.fieldname, toFocusTarget(el))
									"
								/>

								<Select
									v-else-if="col.type === 'select'"
									:model-value="String(row[col.fieldname] || '')"
									@update:model-value="onCellChange(rowIndex, col.fieldname, $event)"
									:items="
										getSelectOptions(col, row, rowIndex).map((o) => ({
											label: o.label,
											value: String(o.value),
										}))
									"
									class="h-7 text-xs"
									:ref="
										(el: unknown) =>
											registerInput(rowIndex, col.fieldname, toFocusTarget(el))
									"
								/>

								<span
									v-else-if="col.type === 'readonly'"
									class="text-xs font-mono"
									:class="getCellClass(col, row[col.fieldname], row, rowIndex)"
								>
									{{ formatValue(col, row[col.fieldname], row, rowIndex) }}
								</span>

								<span v-else-if="col.type === 'component'" />
							</slot>
						</td>

						<td v-if="hasActions" class="px-1 py-1" :class="actionColumnWidthClass">
							<div
								class="flex items-center justify-center gap-0.5 transition-opacity"
								:class="isTouchDevice ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'"
							>
								<TooltipWrapper v-if="showEditRow" :content="__('Edit row')">
									<Button
										variant="ghost"
										size="icon"
										class="h-6 w-6"
										@click.stop="openRowEditor(rowIndex)"
									>
										<Pencil class="w-3 h-3" />
									</Button>
								</TooltipWrapper>
								<TooltipWrapper v-if="allowDuplicate" :content="__('Duplicate')">
									<Button
										variant="ghost"
										size="icon"
										class="h-6 w-6"
										@click.stop="duplicateRow(rowIndex)"
									>
										<Copy class="w-3 h-3" />
									</Button>
								</TooltipWrapper>
								<TooltipWrapper
									v-if="showInlineReorderActions && rowIndex > 0"
									:content="__('Move up')"
								>
									<Button
										variant="ghost"
										size="icon"
										class="h-6 w-6"
										@click.stop="moveRow(rowIndex, -1)"
									>
										<ChevronUp class="w-3 h-3" />
									</Button>
								</TooltipWrapper>
								<TooltipWrapper
									v-if="showInlineReorderActions && rowIndex < rows.length - 1"
									:content="__('Move down')"
								>
									<Button
										variant="ghost"
										size="icon"
										class="h-6 w-6"
										@click.stop="moveRow(rowIndex, 1)"
									>
										<ChevronDown class="w-3 h-3" />
									</Button>
								</TooltipWrapper>
								<TooltipWrapper v-if="showDeleteButton" :content="__('Delete')">
									<Button
										variant="ghost"
										size="icon"
										class="h-6 w-6 text-destructive hover:text-destructive hover:bg-destructive-soft"
										@click.stop="deleteRow(rowIndex)"
									>
										<Trash2 class="w-3 h-3" />
									</Button>
								</TooltipWrapper>
							</div>
						</td>
					</tr>
				</tbody>
			</table>
		</div>

		<div
			v-if="rows.length > 0 && keyboardNavigation"
			class="shrink-0 flex flex-col gap-2 px-3 py-1.5 border-t border-border bg-muted/30 sm:flex-row sm:items-center sm:justify-between"
		>
			<span class="text-xs text-muted-foreground">
				{{ __("Arrow keys to navigate") }} &middot; {{ __("Enter for next row") }} &middot;
				<template v-if="showRowDragHandle">{{ __("Drag row number to reorder") }} &middot; </template>
				{{ __("Ctrl+D to duplicate") }} &middot;
				{{ __("Del to delete selected") }}
				<template v-if="tabToAddRow"> &middot; {{ __("Tab on last cell adds row") }} </template>
			</span>
			<button
				v-if="showAddRow"
				type="button"
				class="self-start text-xs font-medium text-primary hover:underline"
				@click="addRow"
			>
				+ {{ __("Add Row") }}
			</button>
		</div>

		<Teleport to="body">
			<Transition name="ct-modal">
				<div
					v-if="showColumnSettingsModal"
					class="fixed inset-0 z-9999 flex items-center justify-center p-4"
					@click.self="showColumnSettingsModal = false"
				>
					<div class="absolute inset-0 bg-scrim/55" @click="showColumnSettingsModal = false" />
					<div
						class="relative bg-card border border-border rounded-lg shadow-overlay w-full max-w-sm max-h-[80vh] flex flex-col"
					>
						<div class="flex items-center justify-between px-4 py-3 border-b border-border">
							<h3 class="text-sm font-semibold text-foreground">
								{{ __("Column Settings") }}
							</h3>
							<Button
								variant="ghost"
								size="icon"
								class="h-7 w-7"
								@click="showColumnSettingsModal = false"
							>
								<X class="w-4 h-4" />
							</Button>
						</div>

						<div class="flex-1 overflow-auto px-4 py-3 space-y-1">
							<label
								v-for="col in columns"
								:key="col.fieldname"
								class="flex items-center gap-2.5 px-2 py-1.5 rounded hover:bg-muted cursor-pointer text-sm"
								:class="{ 'opacity-50 cursor-not-allowed': col.alwaysVisible }"
							>
								<Checkbox
									:checked="!hiddenColumns.has(col.fieldname)"
									:disabled="col.alwaysVisible"
									@update:checked="toggleColumnVisibility(col.fieldname)"
								/>
								<span>{{ __(col.label) }}</span>
								<span v-if="col.required" class="text-destructive text-xs">*</span>
							</label>
						</div>

						<div class="flex items-center justify-between px-4 py-3 border-t border-border">
							<Button variant="ghost" size="sm" @click="resetColumns">
								{{ __("Reset") }}
							</Button>
							<Button size="sm" @click="showColumnSettingsModal = false">
								<Check class="w-3.5 h-3.5 me-1" />
								{{ __("Done") }}
							</Button>
						</div>
					</div>
				</div>
			</Transition>
		</Teleport>

		<Teleport to="body">
			<Transition name="ct-modal">
				<div
					v-if="editorOpen"
					class="fixed inset-0 z-9999 flex items-center justify-center p-4"
					@click.self="closeRowEditor"
				>
					<div class="absolute inset-0 bg-scrim/55" @click="closeRowEditor" />
					<div
						class="relative bg-card border border-border rounded-xl shadow-overlay w-full max-w-lg max-h-[85vh] flex flex-col"
					>
						<div class="flex items-center justify-between px-5 py-3.5 border-b border-border">
							<h3 class="text-sm font-semibold text-foreground">
								{{ __("Edit Row") }} #{{ editorRowIndex + 1 }}
							</h3>
							<Button variant="ghost" size="icon" class="h-7 w-7" @click="closeRowEditor">
								<X class="w-4 h-4" />
							</Button>
						</div>

						<div class="border-b border-border bg-muted/30 px-5 py-3">
							<div class="flex flex-wrap items-center justify-between gap-3">
								<div class="flex items-center gap-2">
									<TooltipWrapper :content="__('Move up')">
										<Button
											variant="outline"
											size="icon-sm"
											class="h-8 w-8"
											:disabled="editorRowIndex <= 0"
											@click="moveEditorRow(-1)"
										>
											<ChevronUp class="w-3.5 h-3.5" />
										</Button>
									</TooltipWrapper>
									<TooltipWrapper :content="__('Move down')">
										<Button
											variant="outline"
											size="icon-sm"
											class="h-8 w-8"
											:disabled="editorRowIndex >= rows.length - 1"
											@click="moveEditorRow(1)"
										>
											<ChevronDown class="w-3.5 h-3.5" />
										</Button>
									</TooltipWrapper>
									<TooltipWrapper :content="__('Delete row')">
										<Button
											variant="ghost"
											size="icon-sm"
											class="h-8 w-8 text-destructive hover:bg-destructive-soft hover:text-destructive"
											@click="deleteEditorRow"
										>
											<Trash2 class="w-3.5 h-3.5" />
										</Button>
									</TooltipWrapper>
								</div>

								<div class="flex items-center gap-2 ms-auto">
									<span class="text-xs font-medium text-muted-foreground">{{
										__("Row")
									}}</span>
									<NumberInput
										v-model="editorMoveToIndex"
										:min="1"
										:max="rows.length"
										:step="1"
										:precision="0"
										:allow-decimal="false"
										:disable-spinner="true"
										class="h-8 w-16 text-center text-xs"
										@keydown.enter.prevent="moveEditorRowToIndex"
									/>
									<Button
										variant="outline"
										size="sm"
										class="h-8 shrink-0"
										@click="moveEditorRowToIndex"
									>
										{{ __("Move") }}
									</Button>
								</div>
							</div>
						</div>

						<div class="flex-1 overflow-auto px-5 py-4 space-y-4">
							<div v-for="col in editorColumns" :key="col.fieldname" class="space-y-1.5">
								<label class="text-sm font-medium text-foreground">
									{{ __(col.label) }}
									<span v-if="col.required" class="text-destructive">*</span>
								</label>

								<Autocomplete
									v-if="col.type === 'link' && col.link"
									:model-value="editorRowData[col.fieldname] || ''"
									@update:model-value="onEditorFieldChange(col.fieldname, $event)"
									@select="(opt: AutocompleteOption) => onEditorLinkSelect(col, opt)"
									:doctype="col.link.doctype"
									:label-field="col.link.labelField || 'name'"
									:filters="getLinkFilters(col, editorRowData, editorRowIndex)"
									:placeholder="`Search ${col.link.doctype}...`"
								/>

								<Input
									v-else-if="col.type === 'text'"
									:model-value="editorRowData[col.fieldname] || ''"
									@update:model-value="onEditorFieldChange(col.fieldname, $event)"
									:placeholder="col.placeholder ? __(col.placeholder) : ''"
								/>

								<NumberInput
									v-else-if="col.type === 'number'"
									:model-value="editorRowData[col.fieldname] ?? 0"
									@update:model-value="onEditorFieldChange(col.fieldname, $event)"
									:min="col.min ?? 0"
									:max="col.max"
									:precision="col.precision ?? 2"
								/>

								<Input
									v-else-if="col.type === 'date'"
									type="date"
									:model-value="editorRowData[col.fieldname] || ''"
									@update:model-value="onEditorFieldChange(col.fieldname, $event)"
								/>

								<Select
									v-else-if="col.type === 'select'"
									:model-value="String(editorRowData[col.fieldname] || '')"
									@update:model-value="onEditorFieldChange(col.fieldname, $event)"
									:items="
										getSelectOptions(col, editorRowData, editorRowIndex).map((o) => ({
											label: o.label,
											value: String(o.value),
										}))
									"
								/>

								<span
									v-else-if="col.type === 'readonly'"
									class="block text-sm text-muted-foreground font-mono py-1"
								>
									{{
										formatValue(
											col,
											editorRowData[col.fieldname],
											editorRowData,
											editorRowIndex,
										)
									}}
								</span>
							</div>
						</div>

						<div class="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-border">
							<Button variant="outline" size="sm" @click="closeRowEditor">
								{{ __("Cancel") }}
							</Button>
							<Button size="sm" @click="saveRowEditor">
								<Check class="w-3.5 h-3.5 me-1" />
								{{ __("Save") }}
							</Button>
						</div>
					</div>
				</div>
			</Transition>
		</Teleport>
	</div>
</template>

<style scoped>
.ct-table-container {
	position: relative;
}

.ct-table {
	border-collapse: separate;
	border-spacing: 0;
}

.ct-row {
	transition:
		background-color 0.15s ease,
		box-shadow 0.3s ease;
}

.ct-row-dragging {
	opacity: 0.6;
}

.ct-row-drop-before > td {
	box-shadow: inset 0 2px 0 hsl(var(--primary));
}

.ct-row-drop-after > td {
	box-shadow: inset 0 -2px 0 hsl(var(--primary));
}

.ct-row-handle {
	cursor: grab;
}

.ct-row-handle:active,
.ct-row-handle-dragging {
	cursor: grabbing;
}

.ct-frozen-last {
	box-shadow: 4px 0 6px -2px rgba(0, 0, 0, 0.12);
	clip-path: inset(0 -8px 0 0);
}

thead .ct-frozen-last,
thead [style*="sticky"] {
	z-index: 22 !important;
}

.ct-modal-enter-active,
.ct-modal-leave-active {
	transition: opacity 0.2s ease;
}

.ct-modal-enter-from,
.ct-modal-leave-to {
	opacity: 0;
}
</style>
