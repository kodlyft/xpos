<script setup lang="ts">
import { onMounted, ref } from "vue";
import type { CatalogItem } from "@mobile/ports";
import { formatMinor } from "@mobile/domain/money";
import OmniSearch from "@mobile/ui/OmniSearch.vue";

const props = defineProps<{ scopeId: string; currency: string; minorDigits: number }>();
const emit = defineEmits<{ pick: [item: CatalogItem] }>();
const query = ref("");
const last = ref<CatalogItem | null>(null);
const bar = ref<InstanceType<typeof OmniSearch>>();
onMounted(() => bar.value?.focus());
</script>

<template>
	<div class="pad-safe-x flex flex-col gap-3 pb-2">
		<OmniSearch
			ref="bar"
			:scope-id="scopeId"
			v-model="query"
			large
			strict
			placeholder="Scan or type a barcode, then Enter"
			:minor-digits="minorDigits"
			@scanned="last = $event"
			@pick="emit('pick', $event)"
		/>
		<div
			v-if="last"
			class="rounded-2xl border border-border bg-card p-4 shadow-raised"
			aria-live="polite"
		>
			<p class="text-xs uppercase tracking-wide text-muted-foreground">Last scanned</p>
			<p class="text-lg font-semibold leading-snug">{{ last.name }}</p>
			<p class="text-2xl font-bold tabular-nums text-primary">
				{{ props.currency }} {{ formatMinor(last.priceMinor, props.minorDigits) }}
			</p>
		</div>
		<p v-else class="py-6 text-center text-sm text-muted-foreground">
			Scan an item with a handheld scanner, or type its barcode, then press Enter. Each scan adds one to
			the cart.
		</p>
	</div>
</template>
