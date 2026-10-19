<script setup lang="ts">
import { computed, ref, watch, nextTick, type HTMLAttributes } from "vue";
import { Search, X, ChevronDown, Loader2, Check } from "lucide-vue-next";
import { PopoverRoot, PopoverPortal, PopoverContent, PopoverAnchor } from "radix-vue";
import { cn } from "@/lib/utils";
import { call, getValue } from "@/services/api";

export interface AutocompleteOption {
	label: string;
	value: string;
	description?: string;
	icon?: string;
	disabled?: boolean;
	group?: string;
}

const props = withDefaults(
	defineProps<{
		modelValue?: string;
		options?: AutocompleteOption[];
		placeholder?: string;
		disabled?: boolean;
		loading?: boolean;
		clearable?: boolean;
		minChars?: number;
		maxVisible?: number;
		label?: string;
		remoteSearch?: boolean;
		showSearchIcon?: boolean;
		emptyText?: string;
		class?: HTMLAttributes["class"];
		doctype?: string;
		query?: string;
		pageLength?: number;
		filters?: Record<string, unknown>;
		referenceDoctype?: string;
		ignoreUserPermissions?: boolean;
		labelField?: string;
		openOnFocus?: boolean;
		compact?: boolean;
		tableNavigation?: boolean;
	}>(),
	{
		placeholder: "Search or select...",
		disabled: false,
		loading: false,
		clearable: true,
		minChars: 0,
		maxVisible: 8,
		remoteSearch: false,
		showSearchIcon: true,
		emptyText: "No results found",
		options: () => [],
		pageLength: 20,
		filters: () => ({}),
		ignoreUserPermissions: false,
		labelField: "name",
		openOnFocus: false,
		compact: false,
		tableNavigation: false,
	},
);

const emit = defineEmits<{
	(e: "update:modelValue", value: string): void;
	(e: "search", query: string): void;
	(e: "select", option: AutocompleteOption): void;
	(e: "clear"): void;
	(e: "focus"): void;
	(e: "blur"): void;
}>();

const isLinkMode = computed(() => !!props.doctype);

const rootRef = ref<HTMLElement | null>(null);
const inputRef = ref<HTMLInputElement | null>(null);
const open = ref(false);
const query = ref("");
const highlightedIndex = ref(-1);
const linkLoading = ref(false);
const linkOptions = ref<AutocompleteOption[]>([]);
const resolvedLabel = ref("");

const isLoading = computed(() => props.loading || linkLoading.value);

const selectedOption = computed(() => mergedOptions.value.find((o) => o.value === props.modelValue));

const displayText = computed(() => {
	if (isLinkMode.value && resolvedLabel.value) return resolvedLabel.value;
	return selectedOption.value?.label ?? selectedOption.value?.value ?? "";
});

const mergedOptions = computed(() => (isLinkMode.value ? linkOptions.value : props.options));

const filteredOptions = computed(() => {
	if (isLinkMode.value || props.remoteSearch) return mergedOptions.value;

	const q = query.value.trim().toLowerCase();
	if (!q || q.length < props.minChars) return mergedOptions.value;

	return mergedOptions.value.filter(
		(opt) =>
			opt.label.toLowerCase().includes(q) ||
			opt.value.toLowerCase().includes(q) ||
			(opt.description && opt.description.toLowerCase().includes(q)),
	);
});

const matchCount = computed(() => filteredOptions.value.length);

const groupedOptions = computed(() => {
	const groups: Record<string, AutocompleteOption[]> = {};
	const ungrouped: AutocompleteOption[] = [];

	for (const opt of filteredOptions.value.slice(0, props.maxVisible)) {
		if (opt.group) {
			if (!groups[opt.group]) groups[opt.group] = [];
			groups[opt.group].push(opt);
		} else {
			ungrouped.push(opt);
		}
	}

	return { groups, ungrouped };
});

const flatVisibleOptions = computed(() => filteredOptions.value.slice(0, props.maxVisible));

const effectiveShowSearchIcon = computed(() => (props.compact ? false : props.showSearchIcon));
const effectiveClearable = computed(() => props.clearable);

watch(
	() => props.modelValue,
	async (value) => {
		if (!isLinkMode.value) {
			if (!open.value) query.value = displayText.value;
			return;
		}

		if (!value) {
			resolvedLabel.value = "";
			if (!open.value) query.value = "";
			return;
		}

		if (value === resolvedLabel.value) {
			if (!open.value) query.value = resolvedLabel.value;
			return;
		}

		await resolveLinkLabel(value);
		if (!open.value) query.value = resolvedLabel.value;
	},
	{ immediate: true },
);

watch(
	() => props.modelValue,
	() => {
		if (isLinkMode.value) return;
		if (!open.value) {
			query.value = displayText.value;
		}
	},
	{ immediate: true },
);

watch(open, (isOpen) => {
	if (isOpen) {
		if (isLinkMode.value) {
			query.value = resolvedLabel.value;
			highlightedIndex.value = -1;
			void searchLink(query.value);
		} else {
			highlightedIndex.value = -1;
		}
		return;
	}

	query.value = displayText.value;
	highlightedIndex.value = -1;
});

async function resolveLinkLabel(value: string) {
	if (!props.doctype) return;
	try {
		const response = await getValue<Record<string, unknown>>(props.doctype, value, [props.labelField!]);
		const maybeMessage = response as { message?: Record<string, unknown> };
		const row = maybeMessage?.message ?? (response as Record<string, unknown>);
		resolvedLabel.value = String(row?.[props.labelField!] ?? value);
	} catch {
		resolvedLabel.value = value;
	}
}

function normalizeLinkResponse(rows: unknown[]): AutocompleteOption[] {
	return rows
		.map((row): AutocompleteOption | null => {
			if (Array.isArray(row)) {
				const value = String(row[0] ?? "");
				if (!value) return null;
				return { value, label: value, description: row[1] ? String(row[1]) : undefined };
			}
			if (row && typeof row === "object") {
				const record = row as Record<string, unknown>;
				const val = String(record.value ?? "");
				if (!val) return null;
				return {
					value: val,
					label: val,
					description: record.description ? String(record.description) : undefined,
				};
			}
			return null;
		})
		.filter((r): r is AutocompleteOption => !!r);
}

async function searchLink(text: string) {
	if (!props.doctype) return;
	const trimmed = (text ?? "").trim();
	if (trimmed.length < props.minChars) {
		linkOptions.value = [];
		return;
	}

	linkLoading.value = true;
	try {
		const response = await call<unknown[]>("frappe.desk.search.search_link", {
			doctype: props.doctype,
			query: props.query,
			txt: trimmed,
			page_length: props.pageLength,
			filters: props.filters,
			reference_doctype: props.referenceDoctype,
			ignore_user_permissions: props.ignoreUserPermissions,
		});
		linkOptions.value = normalizeLinkResponse(response ?? []);
	} catch {
		linkOptions.value = [];
	} finally {
		linkLoading.value = false;
	}
}

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function onInput() {
	if (!open.value) open.value = true;
	highlightedIndex.value = -1;

	if (debounceTimer) clearTimeout(debounceTimer);
	debounceTimer = setTimeout(() => {
		if (isLinkMode.value) {
			void searchLink(query.value);
		}
		emit("search", query.value);
	}, 250);
}

function selectOption(option: AutocompleteOption) {
	if (option.disabled) return;

	if (isLinkMode.value) {
		resolvedLabel.value = option.description ?? option.label ?? option.value;
		query.value = resolvedLabel.value;
	} else {
		query.value = option.label;
	}

	emit("update:modelValue", option.value);
	emit("select", option);
	open.value = false;
}

function clearSelection() {
	resolvedLabel.value = "";
	emit("update:modelValue", "");
	emit("clear");
	query.value = "";
	linkOptions.value = [];
	open.value = false;
	nextTick(() => {
		getInputEl()?.focus();
	});
}

function onFocus() {
	if (isLinkMode.value) {
		if (!props.disabled) {
			open.value = true;
			void searchLink(query.value);
		}
	} else if (props.openOnFocus) {
		open.value = true;
		if (props.remoteSearch) emit("search", "");
	} else {
		open.value = true;
		query.value = "";
	}
	emit("focus");
}

function onKeydown(e: KeyboardEvent) {
	const opts = flatVisibleOptions.value;

	switch (e.key) {
		case "ArrowDown":
			if (props.tableNavigation && !open.value) return;
			e.preventDefault();
			if (!open.value) open.value = true;
			highlightedIndex.value = Math.min(highlightedIndex.value + 1, opts.length - 1);
			scrollToHighlighted();
			break;
		case "ArrowUp":
			if (props.tableNavigation && !open.value) return;
			e.preventDefault();
			if (!open.value) open.value = true;
			highlightedIndex.value = Math.max(highlightedIndex.value - 1, 0);
			scrollToHighlighted();
			break;
		case "Enter":
			if (props.tableNavigation && !open.value) return;
			if (highlightedIndex.value < 0 || highlightedIndex.value >= opts.length) return;
			e.preventDefault();
			if (highlightedIndex.value >= 0 && highlightedIndex.value < opts.length) {
				selectOption(opts[highlightedIndex.value]);
			}
			break;
		case "Escape":
			if (!open.value) return;
			e.preventDefault();
			open.value = false;
			break;
		case "Tab":
			open.value = false;
			break;
	}
}

function scrollToHighlighted() {
	nextTick(() => {
		const item = rootRef.value
			?.closest("body")
			?.querySelector(`[data-autocomplete-index="${highlightedIndex.value}"]`) as HTMLElement | null;
		item?.scrollIntoView({ block: "nearest" });
	});
}

function getInputEl(): HTMLInputElement | null {
	return inputRef.value ?? rootRef.value?.querySelector("input") ?? null;
}

function focus() {
	getInputEl()?.focus();
}

function select() {
	const el = getInputEl();
	el?.focus();
	el?.select();
}

defineExpose({ focus, select, getInputEl, inputRef });
</script>

<template>
	<div ref="rootRef" :class="cn('w-full', props.class)">
		<label v-if="label && !compact" class="block text-sm font-medium text-foreground mb-1.5">
			{{ label }}
		</label>

		<PopoverRoot v-model:open="open">
			<PopoverAnchor as-child>
				<div class="relative">
					<Search
						v-if="effectiveShowSearchIcon"
						class="absolute inset-s-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none"
					/>
					<input
						ref="inputRef"
						v-model="query"
						type="text"
						autocomplete="new-password"
						:placeholder="modelValue ? displayText : placeholder"
						:disabled="disabled"
						:class="
							cn(
								'flex w-full rounded-lg border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-all placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:border-transparent disabled:cursor-not-allowed disabled:opacity-50',
								compact ? 'h-7 text-xs' : 'h-8',
								effectiveShowSearchIcon && 'ps-9',
								effectiveClearable && modelValue ? (compact ? 'pe-12' : 'pe-16') : 'pe-8',
							)
						"
						@input="onInput"
						@focus="onFocus"
						@keydown="onKeydown"
					/>

					<div class="absolute inset-e-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
						<button
							v-if="effectiveClearable && modelValue"
							type="button"
							tabindex="-1"
							class="p-0.5 rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
							@mousedown.prevent="clearSelection"
						>
							<X class="h-3.5 w-3.5" />
						</button>
						<Loader2 v-if="isLoading" class="h-4 w-4 text-muted-foreground animate-spin" />
						<button
							v-else
							type="button"
							tabindex="-1"
							class="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
							@mousedown.prevent="
								open = !open;
								if (open && isLinkMode) void searchLink(query);
							"
						>
							<ChevronDown
								class="h-4 w-4 transition-transform duration-200"
								:class="{ 'rotate-180': open }"
							/>
						</button>
					</div>
				</div>
			</PopoverAnchor>

			<PopoverPortal>
				<PopoverContent
					align="start"
					side="bottom"
					:side-offset="4"
					class="z-99999 w-(--radix-popover-trigger-width) min-w-55 max-h-70 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-xl outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2"
					@open-auto-focus.prevent
					@focus-outside.prevent
				>
					<div
						v-if="isLoading && filteredOptions.length === 0"
						class="flex items-center justify-center py-6 text-sm text-muted-foreground"
					>
						<Loader2 class="h-5 w-5 text-primary animate-spin" />
						<span class="ms-2">Searching...</span>
					</div>

					<div v-else-if="filteredOptions.length === 0" class="py-6 text-center">
						<Search class="h-8 w-8 text-muted-foreground/30 mx-auto mb-2" />
						<p class="text-sm text-muted-foreground">{{ emptyText }}</p>
					</div>

					<template v-else>
						<template v-for="(groupOptions, groupName) in groupedOptions.groups" :key="groupName">
							<div
								class="px-3 py-1.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider bg-muted/40 border-b border-border/50 sticky top-0"
							>
								{{ groupName }}
							</div>
							<button
								v-for="option in groupOptions"
								:key="option.value"
								:data-autocomplete-index="flatVisibleOptions.indexOf(option)"
								type="button"
								:disabled="option.disabled"
								class="flex w-full items-center gap-2.5 rounded-sm px-2 py-2 text-start text-sm transition-colors outline-none cursor-pointer"
								:class="[
									flatVisibleOptions.indexOf(option) === highlightedIndex
										? 'bg-accent text-accent-foreground'
										: 'hover:bg-accent/50',
									option.disabled && 'opacity-50! cursor-not-allowed!',
									option.value === modelValue && 'font-medium text-primary',
								]"
								role="option"
								:aria-selected="option.value === modelValue"
								@click="selectOption(option)"
								@mouseenter="highlightedIndex = flatVisibleOptions.indexOf(option)"
							>
								<div class="flex-1 min-w-0">
									<div class="truncate">{{ option.label }}</div>
									<div
										v-if="option.description"
										class="text-xs text-muted-foreground truncate mt-0.5"
									>
										{{ option.description }}
									</div>
								</div>
								<Check
									v-if="option.value === modelValue"
									class="h-4 w-4 text-primary shrink-0"
								/>
							</button>
						</template>

						<button
							v-for="option in groupedOptions.ungrouped"
							:key="option.value"
							:data-autocomplete-index="flatVisibleOptions.indexOf(option)"
							type="button"
							:disabled="option.disabled"
							class="flex w-full items-center gap-2.5 rounded-sm px-2 py-2 text-start text-sm transition-colors outline-none cursor-pointer"
							:class="[
								flatVisibleOptions.indexOf(option) === highlightedIndex
									? 'bg-accent text-accent-foreground'
									: 'hover:bg-accent/50',
								option.disabled && 'opacity-50! cursor-not-allowed!',
								option.value === modelValue && 'font-medium text-primary',
							]"
							role="option"
							:aria-selected="option.value === modelValue"
							@click="selectOption(option)"
							@mouseenter="highlightedIndex = flatVisibleOptions.indexOf(option)"
						>
							<div class="flex-1 min-w-0">
								<div class="truncate">{{ option.label }}</div>
								<div
									v-if="option.description"
									class="text-xs text-muted-foreground truncate mt-0.5"
								>
									{{ option.description }}
								</div>
							</div>
							<Check v-if="option.value === modelValue" class="h-4 w-4 text-primary shrink-0" />
						</button>
					</template>

					<div
						v-if="filteredOptions.length > maxVisible"
						class="px-3 py-2 text-xs text-center text-muted-foreground border-t border-border bg-muted/30 rounded-b-lg"
					>
						{{ filteredOptions.length - maxVisible }} more - type to refine
					</div>

					<div
						v-else-if="query && matchCount > 0 && matchCount <= maxVisible"
						class="px-3 py-1.5 text-[11px] text-center text-muted-foreground border-t border-border/50 bg-muted/20 rounded-b-lg"
					>
						{{ matchCount }} {{ matchCount === 1 ? "match" : "matches" }}
					</div>
				</PopoverContent>
			</PopoverPortal>
		</PopoverRoot>
	</div>
</template>
