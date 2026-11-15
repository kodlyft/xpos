<template>
	<div class="flex min-w-0 items-center gap-2" data-testid="category-bar">
		<Popover v-model:open="browseOpen">
			<PopoverTrigger as-child>
				<Button
					variant="outline"
					size="sm"
					class="shrink-0 gap-1.5"
					:aria-label="__('Browse categories')"
					data-testid="category-browse"
				>
					<FolderTree />
					<span class="hidden sm:inline">{{ __("Categories") }}</span>
				</Button>
			</PopoverTrigger>
			<PopoverContentStyled
				align="start"
				class="w-80 p-2"
				@open-auto-focus.prevent
				@close-auto-focus="onCloseAutoFocus"
			>
				<Input
					ref="searchInputRef"
					v-model="query"
					size="compact"
					:placeholder="__('Search categories...')"
					:aria-label="__('Search categories')"
					class="mb-2"
					@keydown.down.prevent="focusResult(0)"
				/>
				<div ref="resultsRef" class="max-h-80 overflow-y-auto xpos-scrollbar" role="listbox">
					<button
						v-for="name in browseResults"
						:key="name"
						type="button"
						role="option"
						:aria-selected="selected === name"
						class="flex min-h-9 w-full flex-col items-start justify-center rounded-lg px-3 py-1.5 text-start text-sm transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none"
						:class="
							selected === name &&
							'bg-surface-selected font-semibold text-surface-selected-foreground'
						"
						@click="pick(name)"
						@keydown.down.prevent="moveResult($event, 1)"
						@keydown.up.prevent="moveResult($event, -1)"
					>
						<span class="w-full truncate">{{ label(name) }}</span>
						<span
							v-if="query && parentPath(name)"
							class="w-full truncate text-xs text-muted-foreground"
						>
							{{ parentPath(name) }}
						</span>
					</button>
					<p
						v-if="!browseResults.length"
						class="px-3 py-4 text-center text-sm text-muted-foreground"
					>
						{{ __("No categories found") }}
					</p>
					<p
						v-else-if="hiddenCount > 0"
						class="px-3 py-2 text-center text-xs text-muted-foreground"
					>
						{{ __("Type to search {0} more", [hiddenCount]) }}
					</p>
				</div>
			</PopoverContentStyled>
		</Popover>

		<div
			ref="rowRef"
			class="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto py-1 xpos-scrollbar-none"
			role="toolbar"
			:aria-label="__('Categories')"
			@keydown="onRowKeydown"
		>
			<nav class="flex shrink-0 items-center gap-0.5 text-sm" :aria-label="__('Category path')">
				<template v-for="(crumb, index) in crumbs" :key="crumb.value">
					<ChevronRight
						v-if="index > 0"
						class="size-3.5 shrink-0 text-muted-foreground rtl:rotate-180"
						aria-hidden="true"
					/>
					<button
						type="button"
						data-chip
						:tabindex="-1"
						:aria-current="crumb.value === selected ? 'location' : undefined"
						class="max-w-48 truncate rounded-md px-2 py-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
						:class="
							crumb.value === selected
								? 'font-semibold text-foreground'
								: 'text-muted-foreground hover:bg-surface-hover hover:text-foreground'
						"
						:title="crumb.label"
						@click="emit('select', crumb.value)"
					>
						{{ crumb.label }}
					</button>
				</template>
			</nav>

			<span v-if="levelOptions.length" class="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden="true" />

			<button
				v-for="name in visibleOptions"
				:key="name"
				type="button"
				data-chip
				:tabindex="-1"
				:aria-pressed="selected === name"
				:title="label(name)"
				class="h-8 max-w-56 shrink-0 truncate rounded-full border px-3 text-sm font-medium transition-[background-color,border-color,color] duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
				:class="
					selected === name
						? 'border-primary bg-surface-selected text-surface-selected-foreground'
						: 'border-border bg-card text-foreground hover:bg-surface-hover'
				"
				@click="emit('select', name)"
			>
				{{ shortLabel(name, level.parent) }}
			</button>
			<button
				v-if="overflowCount > 0"
				type="button"
				data-chip
				:tabindex="-1"
				class="h-8 shrink-0 rounded-full border border-dashed border-border px-3 text-sm font-medium text-muted-foreground hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
				@click="browseOpen = true"
			>
				{{ __("+{0} more", [overflowCount]) }}
			</button>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { ChevronRight, FolderTree } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContentStyled, PopoverTrigger } from "@/components/ui/popover";
import { ALL_GROUPS, useCategoryTree } from "@/composables/useCategoryTree";
import type { ItemGroup } from "@/types/pos.types";
import __ from "@/lib/translate";

/** Chips rendered for one level; the rest stay behind "+N more" / search. */
const MAX_CHIPS = 24;
const MAX_LISTED = 100;

const props = defineProps<{
	groups: ItemGroup[];
	parentGroups: ItemGroup[];
	selected: string;
}>();

const emit = defineEmits<{
	(e: "select", name: string): void;
	/** A pick from the browse popover, so the caller can move focus back to search. */
	(e: "picked"): void;
}>();

const tree = useCategoryTree(
	computed(() => props.groups),
	computed(() => props.parentGroups),
);

const label = (name: string) => (name === ALL_GROUPS ? __("All products") : __(name));

/** "Tools - Standard - Small" under "Tools - Standard" reads as "Small". */
function shortLabel(name: string, parent: string): string {
	const full = label(name);
	if (parent === ALL_GROUPS) return full;
	const parentLabel = label(parent);
	if (!full.startsWith(parentLabel)) return full;
	const rest = full.slice(parentLabel.length).replace(/^[\s\-–—/:>|›»]+/, "");
	return rest || full;
}

const crumbs = computed(() => {
	const path = props.selected && props.selected !== ALL_GROUPS ? tree.value.pathTo(props.selected) : [];
	const items = [{ value: ALL_GROUPS, label: label(ALL_GROUPS) }];
	let parent = ALL_GROUPS;
	for (const name of path) {
		items.push({ value: name, label: shortLabel(name, parent) });
		parent = name;
	}
	// A selection the tree doesn't know (e.g. stale after a profile change) still shows.
	if (props.selected && props.selected !== ALL_GROUPS && !path.length)
		items.push({ value: props.selected, label: label(props.selected) });
	return items;
});

const level = computed(() => tree.value.levelFor(props.selected || ALL_GROUPS));
const levelOptions = computed(() => level.value.options);
const visibleOptions = computed(() => levelOptions.value.slice(0, MAX_CHIPS));
const overflowCount = computed(() => Math.max(0, levelOptions.value.length - MAX_CHIPS));

const browseOpen = ref(false);
const query = ref("");
const searchInputRef = ref<{ $el?: HTMLElement } | null>(null);
const resultsRef = ref<HTMLElement | null>(null);
let pickedFromBrowse = false;

const browseResults = computed(() =>
	query.value.trim() ? tree.value.search(query.value, label) : levelOptions.value.slice(0, MAX_LISTED),
);
const hiddenCount = computed(() =>
	query.value.trim() ? 0 : Math.max(0, levelOptions.value.length - MAX_LISTED),
);

watch(browseOpen, (open) => {
	if (!open) query.value = "";
	else nextTick(() => focusSearchInput());
});

function focusSearchInput() {
	const el = searchInputRef.value?.$el as HTMLElement | undefined;
	(el?.tagName === "INPUT" ? el : el?.querySelector("input"))?.focus();
}

function parentPath(name: string): string {
	return tree.value
		.pathTo(name)
		.slice(0, -1)
		.map((n) => label(n))
		.join(" › ");
}

function pick(name: string) {
	pickedFromBrowse = true;
	emit("select", name);
	browseOpen.value = false;
}

function onCloseAutoFocus(event: Event) {
	if (!pickedFromBrowse) return;
	pickedFromBrowse = false;
	event.preventDefault();
	emit("picked");
}

function resultButtons(): HTMLElement[] {
	return Array.from(resultsRef.value?.querySelectorAll<HTMLElement>("[role='option']") || []);
}

function focusResult(index: number) {
	resultButtons()[index]?.focus();
}

function moveResult(event: KeyboardEvent, step: number) {
	const buttons = resultButtons();
	const index = buttons.indexOf(event.currentTarget as HTMLElement) + step;
	if (index < 0) focusSearchInput();
	else buttons[Math.min(index, buttons.length - 1)]?.focus();
}

/** One tab stop for the whole row; arrow keys move between crumbs and chips. */
const rowRef = ref<HTMLElement | null>(null);

function chips(): HTMLElement[] {
	return Array.from(rowRef.value?.querySelectorAll<HTMLElement>("[data-chip]") || []);
}

function syncRovingTabindex() {
	const all = chips();
	const current =
		all.find((el) => el.getAttribute("aria-pressed") === "true" || el.getAttribute("aria-current")) ||
		all[0];
	for (const el of all) el.tabIndex = el === current ? 0 : -1;
}

watch([() => props.selected, visibleOptions, crumbs], () => nextTick(syncRovingTabindex), {
	immediate: true,
	flush: "post",
});

function onRowKeydown(event: KeyboardEvent) {
	const all = chips();
	const index = all.indexOf(document.activeElement as HTMLElement);
	if (index < 0) return;
	const rtl = document.documentElement.dir === "rtl";
	let next = -1;
	if (event.key === "ArrowRight") next = index + (rtl ? -1 : 1);
	else if (event.key === "ArrowLeft") next = index + (rtl ? 1 : -1);
	else if (event.key === "Home") next = 0;
	else if (event.key === "End") next = all.length - 1;
	else return;
	event.preventDefault();
	const target = all[Math.max(0, Math.min(next, all.length - 1))];
	for (const el of all) el.tabIndex = el === target ? 0 : -1;
	target.focus();
	target.scrollIntoView({ block: "nearest", inline: "nearest" });
}
</script>
