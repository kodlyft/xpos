<template>
	<div ref="rootEl" class="relative min-w-0">
		<div
			class="relative flex h-12 items-center rounded-xl border bg-card shadow-inset transition-[border-color,box-shadow] duration-fast focus-within:border-primary focus-within:ring-4 focus-within:ring-primary/12"
			:class="
				flashSuccess
					? 'border-success ring-2 ring-success/30'
					: flashError
						? 'border-destructive ring-2 ring-destructive/25'
						: 'border-border'
			"
		>
			<Search
				class="pointer-events-none absolute inset-s-3.5 size-5 text-muted-foreground"
				aria-hidden="true"
			/>
			<input
				v-model="localSearch"
				type="text"
				autocomplete="off"
				enterkeyhint="search"
				data-testid="barcode-input"
				class="h-full w-full min-w-0 bg-transparent ps-11 pe-24 text-base text-foreground placeholder:text-muted-foreground focus:outline-none sm:pe-32"
				:placeholder="__('Search products or scan barcode...')"
				:aria-label="__('Search products or scan barcode')"
				@input="onInput"
				@keydown.enter.prevent="onEnter"
				@keydown.down.prevent="emit('navigate', 'down')"
				@keydown.up.prevent="emit('navigate', 'up')"
			/>
			<div class="absolute inset-e-1.5 flex items-center gap-1">
				<Loader2
					v-if="isScanning"
					class="me-1 size-5 animate-spin text-muted-foreground"
					aria-hidden="true"
				/>
				<button
					v-else-if="localSearch"
					type="button"
					class="inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
					:aria-label="__('Clear search')"
					@click="clearSearch"
				>
					<X class="size-4" />
				</button>
				<kbd
					v-if="!localSearch && !isScanning"
					class="hidden h-7 min-w-7 items-center justify-center rounded-md border border-border bg-surface-sunken px-1.5 font-mono text-xs text-muted-foreground sm:inline-flex"
					aria-hidden="true"
					>/</kbd
				>
				<span class="mx-0.5 h-6 w-px bg-border" aria-hidden="true" />
				<TooltipWrapper :content="__('Scan barcode (F1)')" side="bottom">
					<button
						type="button"
						class="inline-flex size-9 items-center justify-center rounded-lg text-foreground transition-colors duration-fast hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
						:aria-label="__('Scan barcode')"
						@click="emit('scan')"
					>
						<ScanBarcode class="size-5" />
					</button>
				</TooltipWrapper>
			</div>
		</div>
		<p class="sr-only" role="status" aria-live="polite">{{ statusMessage }}</p>
	</div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { Loader2, ScanBarcode, Search, X } from "lucide-vue-next";
import { TooltipWrapper } from "@/components/ui/tooltip";
import __ from "@/lib/translate";
import { isOnline } from "@/utils";
import { usePosStore } from "@/stores/posStore";

const emit = defineEmits(["search", "navigate", "enter", "scan"]);

const rootEl = ref<HTMLElement | null>(null);
const localSearch = ref("");
const isScanning = ref(false);
const flashSuccess = ref(false);
const flashError = ref(false);
const statusMessage = ref("");
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let flashTimer: ReturnType<typeof setTimeout> | null = null;

function getInputEl(): HTMLInputElement | null {
	return rootEl.value?.querySelector("input") || null;
}

const posStore = usePosStore();

const LOCAL_DEBOUNCE_MS = 80;
const SERVER_DEBOUNCE_MS = 300;

function onInput() {
	if (debounceTimer) clearTimeout(debounceTimer);
	const local = !isOnline() && posStore.useOfflineMode;
	debounceTimer = setTimeout(
		() => {
			emit("search", localSearch.value);
		},
		local ? LOCAL_DEBOUNCE_MS : SERVER_DEBOUNCE_MS,
	);
}

function onEnter() {
	if (debounceTimer) clearTimeout(debounceTimer);
	const val = localSearch.value.trim();
	emit("enter", val);
}

function clearSearch() {
	localSearch.value = "";
	emit("search", "");
	getInputEl()?.focus();
}

function focus() {
	getInputEl()?.focus();
}

function select() {
	getInputEl()?.focus();
	getInputEl()?.select();
}

function blur() {
	getInputEl()?.blur();
}

function clear() {
	localSearch.value = "";
}

function isFocused(): boolean {
	return document.activeElement === getInputEl();
}

function setValue(val: string) {
	localSearch.value = val;
}

function flash(kind: "success" | "error") {
	flashSuccess.value = kind === "success";
	flashError.value = kind === "error";
	if (flashTimer) clearTimeout(flashTimer);
	flashTimer = setTimeout(() => {
		flashSuccess.value = false;
		flashError.value = false;
	}, 600);
}

function showSuccess() {
	flash("success");
	statusMessage.value = __("Item added");
	localSearch.value = "";
	focus();
}

function showError() {
	flash("error");
	statusMessage.value = __("No item found");
	select();
}

function setScanning(val: boolean) {
	isScanning.value = val;
}

function handleKeyboard(e: KeyboardEvent) {
	if (e.key === "/" && !isFocused()) {
		e.preventDefault();
		focus();
	}
	if (e.key === "Escape" && isFocused()) {
		clearSearch();
		blur();
	}
}

onMounted(() => {
	document.addEventListener("keydown", handleKeyboard);
});

onUnmounted(() => {
	document.removeEventListener("keydown", handleKeyboard);
	if (flashTimer) clearTimeout(flashTimer);
});

defineExpose({ focus, select, blur, clear, isFocused, setValue, showSuccess, showError, setScanning });
</script>
