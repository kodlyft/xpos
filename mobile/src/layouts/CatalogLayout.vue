<script setup lang="ts">
import { ref } from "vue";
import { Button } from "@/components/ui/button";
import type { CatalogItem } from "@mobile/ports";
import { useCatalogPager } from "@mobile/composables/useCatalogPager";
import OmniSearch from "@mobile/ui/OmniSearch.vue";
import ItemTile from "@mobile/ui/ItemTile.vue";

const props = defineProps<{ scopeId: string; currency: string; minorDigits: number }>();
const emit = defineEmits<{ pick: [item: CatalogItem] }>();
const query = ref("");
const { items, loading, error, hasMore, loadMore } = useCatalogPager(props.scopeId, query);
</script>

<template>
	<div class="pad-safe-x flex flex-col gap-3 pb-2">
		<OmniSearch
			v-model="query"
			:scope-id="scopeId"
			:minor-digits="minorDigits"
			@pick="emit('pick', $event)"
		/>
		<p v-if="error" class="text-sm text-destructive" role="alert">{{ error }}</p>
		<ul class="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4" aria-label="Products">
			<li v-for="it in items" :key="it.itemCode">
				<ItemTile
					:item="it"
					:currency="currency"
					:minor-digits="minorDigits"
					@pick="emit('pick', $event)"
				/>
			</li>
		</ul>
		<p v-if="!loading && !items.length" class="py-8 text-center text-sm text-muted-foreground">
			{{ query ? `No products start with “${query}”.` : "This catalog has no items." }}
		</p>
		<Button v-if="hasMore()" variant="outline" class="h-11" :loading="loading" @click="loadMore"
			>Load more</Button
		>
	</div>
</template>
