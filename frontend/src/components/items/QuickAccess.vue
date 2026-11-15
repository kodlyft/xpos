<template>
	<div v-if="chips.length || pinned.length" class="space-y-1.5" data-testid="quick-access">
		<div
			v-if="chips.length"
			class="flex min-w-0 items-center gap-1.5 overflow-x-auto xpos-scrollbar"
			role="group"
			:aria-label="__('Favorite categories')"
			data-testid="favorite-categories"
		>
			<Star class="size-3.5 shrink-0 text-warning" aria-hidden="true" />
			<Button
				v-for="name in chips"
				:key="name"
				:variant="selected === name ? 'default' : 'outline'"
				size="sm"
				class="shrink-0 rounded-full"
				:aria-pressed="selected === name"
				data-testid="favorite-category"
				@click="$emit('selectGroup', name)"
			>
				{{ __(name) }}
			</Button>
		</div>

		<div
			v-if="pinned.length"
			class="flex min-w-0 items-stretch gap-1.5 overflow-x-auto pb-0.5 xpos-scrollbar"
			role="group"
			:aria-label="__('Pinned items')"
			data-testid="pinned-items"
		>
			<Button
				v-for="item in pinned"
				:key="item.item_code"
				variant="outline"
				class="h-auto min-w-32 max-w-48 shrink-0 flex-col items-start gap-0 rounded-xl px-2.5 py-1.5 text-start"
				:disabled="unavailable(item)"
				:aria-label="__('Add {0}', [item.item_name])"
				data-testid="pinned-item"
				@click="$emit('addItem', item)"
			>
				<span class="truncate text-xs font-semibold text-foreground" dir="auto">{{
					item.item_name
				}}</span>
				<span class="text-sm font-bold tabular-nums text-foreground">{{ money(item.rate) }}</span>
			</Button>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { Star } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { useMoney } from "@/composables/useMoney";
import { usePosStore } from "@/stores/posStore";
import type { POSItem } from "@/types/pos.types";
import __ from "@/lib/translate";

const props = defineProps<{
	favorites: string[];
	pinned: POSItem[];
	selected: string;
	/** Item group names the profile can browse; a favorite outside it is not shown. */
	groups: string[];
}>();

defineEmits<{
	(e: "selectGroup", name: string): void;
	(e: "addItem", item: POSItem): void;
}>();

const { money } = useMoney();
const posStore = usePosStore();

const chips = computed(() => props.favorites.filter((name) => props.groups.includes(name)));

/** A pinned tile follows the same stock rule as the catalogue; pinning never makes an item sellable. */
function unavailable(item: POSItem): boolean {
	if (Number(item.is_stock_item) === 0) return false;
	if (posStore.stockSettings?.allow_negative_stock) return false;
	return item.actual_qty !== undefined && item.actual_qty <= 0;
}
</script>
