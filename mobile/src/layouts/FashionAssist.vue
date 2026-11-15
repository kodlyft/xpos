<script setup lang="ts">
import { computed, ref } from "vue";
import { Button } from "@/components/ui/button";
import type { CatalogItem } from "@mobile/ports";
import { formatMinor } from "@mobile/domain/money";
import { useCatalogPager } from "@mobile/composables/useCatalogPager";
import { getContainer } from "@mobile/composables/useApp";
import OmniSearch from "@mobile/ui/OmniSearch.vue";

const props = defineProps<{ scopeId: string; currency: string; minorDigits: number }>();
const emit = defineEmits<{ pick: [item: CatalogItem] }>();

const query = ref("");
// Only variant items: the style cards come from their `variant_of` template.
const { items, loading, hasMore, loadMore } = useCatalogPager(props.scopeId, query, { variantsOnly: true });
const templates = computed(() => {
	const seen = new Map<string, CatalogItem>();
	for (const it of items.value) if (it.variantOf && !seen.has(it.variantOf)) seen.set(it.variantOf, it);
	return [...seen.values()];
});

const open = ref<string | null>(null);
const variants = ref<CatalogItem[]>([]);
const chosen = ref<Record<string, string>>({});

async function openTemplate(it: CatalogItem) {
	open.value = it.variantOf;
	chosen.value = {};
	variants.value = await getContainer().catalog.variantsOf(props.scopeId, it.variantOf!);
}

// The attributes come from the server (Item Variant Attribute), e.g. Colour and Size. Nothing is assumed.
const attributeNames = computed(() => [...new Set(variants.value.flatMap((v) => Object.keys(v.attrs)))]);
function matches(v: CatalogItem, except?: string) {
	return Object.entries(chosen.value).every(([k, val]) => k === except || v.attrs[k] === val);
}
function optionsFor(attr: string) {
	return [...new Set(variants.value.map((v) => v.attrs[attr]).filter(Boolean))];
}
/** A value is available when some variant has it and agrees with the other choices already made. */
const available = (attr: string, value: string) =>
	variants.value.some((v) => v.attrs[attr] === value && matches(v, attr));
function toggle(attr: string, value: string) {
	const next = { ...chosen.value };
	if (next[attr] === value) delete next[attr];
	else next[attr] = value;
	chosen.value = next;
}
const selected = computed(() =>
	attributeNames.value.length && attributeNames.value.every((a) => chosen.value[a])
		? (variants.value.find((v) => matches(v)) ?? null)
		: null,
);
const title = computed(
	() => templates.value.find((t) => t.variantOf === open.value)?.name ?? open.value ?? "",
);
</script>

<template>
	<div class="pad-safe-x flex flex-col gap-3 pb-2">
		<OmniSearch
			v-model="query"
			:scope-id="scopeId"
			placeholder="Search styles or scan barcode…"
			:minor-digits="minorDigits"
			@pick="emit('pick', $event)"
		/>

		<section
			v-if="open"
			class="flex flex-col gap-3 rounded-2xl border border-border bg-card p-4 shadow-raised"
			aria-label="Choose options"
		>
			<div class="flex items-start justify-between gap-2">
				<h2 class="text-base font-semibold">{{ title }}</h2>
				<Button variant="ghost" class="h-11" @click="open = null">Close</Button>
			</div>
			<fieldset v-for="attr in attributeNames" :key="attr">
				<legend class="mb-1 text-sm font-medium">{{ attr }}</legend>
				<div class="flex flex-wrap gap-2">
					<Button
						v-for="value in optionsFor(attr)"
						:key="value"
						class="h-11 min-w-12"
						variant="outline"
						:aria-pressed="chosen[attr] === value"
						:disabled="!available(attr, value)"
						@click="toggle(attr, value)"
						>{{ value }}</Button
					>
				</div>
			</fieldset>
			<template v-if="!attributeNames.length">
				<p class="text-sm text-muted-foreground">
					This style has no variant attributes on the server. Pick the item:
				</p>
				<Button
					v-for="v in variants"
					:key="v.itemCode"
					variant="outline"
					class="h-11 justify-between"
					@click="emit('pick', v)"
				>
					<span class="truncate">{{ v.name }}</span>
					<span class="tabular-nums">{{ formatMinor(v.priceMinor, minorDigits) }}</span>
				</Button>
			</template>
			<p v-else-if="selected" class="text-sm" aria-live="polite">
				{{ selected.name }} ·
				<strong class="tabular-nums"
					>{{ currency }} {{ formatMinor(selected.priceMinor, minorDigits) }}</strong
				>
			</p>
			<p v-else class="text-sm text-muted-foreground" aria-live="polite">Choose every option.</p>
			<Button
				v-if="attributeNames.length"
				class="h-12 rounded-xl text-base font-semibold"
				:disabled="!selected"
				@click="selected && emit('pick', selected)"
				>Add to cart</Button
			>
		</section>

		<ul class="grid grid-cols-2 gap-3 md:grid-cols-3" aria-label="Styles">
			<li v-for="t in templates" :key="t.variantOf!">
				<button
					type="button"
					class="flex min-h-20 w-full flex-col items-start gap-1 rounded-2xl border border-border bg-card p-3 text-left shadow-raised transition-shadow hover:shadow-raised-hover active:shadow-pressed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
					@click="openTemplate(t)"
				>
					<span class="text-sm font-medium leading-snug">{{ t.variantOf }}</span>
					<span class="text-xs text-muted-foreground"
						>from {{ formatMinor(t.priceMinor, minorDigits) }} · choose options</span
					>
				</button>
			</li>
		</ul>
		<p v-if="!loading && !templates.length" class="py-6 text-center text-sm text-muted-foreground">
			{{ query ? `No styles start with “${query}”.` : "This catalog has no variant items." }}
		</p>
		<Button v-if="hasMore()" variant="outline" class="h-11" :loading="loading" @click="loadMore"
			>Load more</Button
		>
	</div>
</template>
