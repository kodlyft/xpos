<script setup lang="ts">
import { ScanBarcode, Search, X } from "@lucide/vue";

// Same markup and tokens as the web POS SearchBar (frontend/src/components/items/SearchBar.vue).
defineProps<{
	label: string;
	placeholder?: string;
	scan?: boolean;
	large?: boolean;
	inputmode?: "search" | "numeric";
}>();
const model = defineModel<string>({ default: "" });
const emit = defineEmits<{ enter: []; scan: [] }>();
</script>

<template>
	<div class="relative min-w-0">
		<div
			class="relative flex items-center rounded-xl border border-border bg-card shadow-inset transition-[border-color,box-shadow] duration-fast focus-within:border-primary focus-within:ring-4 focus-within:ring-primary/12"
			:class="large ? 'h-14' : 'h-12'"
		>
			<Search
				class="pointer-events-none absolute left-3.5 size-5 text-muted-foreground"
				aria-hidden="true"
			/>
			<input
				v-model="model"
				type="text"
				:inputmode="inputmode ?? 'search'"
				autocomplete="off"
				autocapitalize="none"
				spellcheck="false"
				enterkeyhint="search"
				:aria-label="label"
				:placeholder="placeholder"
				class="h-full w-full min-w-0 bg-transparent ps-11 pe-24 text-base text-foreground placeholder:text-muted-foreground focus:outline-none"
				@keydown.enter.prevent="emit('enter')"
			/>
			<div class="absolute right-0.5 flex items-center gap-1">
				<button
					v-if="model"
					type="button"
					class="inline-flex size-11 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
					aria-label="Clear search"
					@click="model = ''"
				>
					<X class="size-4" />
				</button>
				<template v-if="scan">
					<span class="mx-0.5 h-6 w-px bg-border" aria-hidden="true" />
					<button
						type="button"
						class="inline-flex size-11 items-center justify-center rounded-lg text-foreground transition-colors duration-fast hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
						aria-label="Scan barcode with the camera"
						@click="emit('scan')"
					>
						<ScanBarcode class="size-5" />
					</button>
				</template>
			</div>
		</div>
	</div>
</template>
