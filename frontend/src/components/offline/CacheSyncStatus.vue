<template>
	<details class="relative text-xs" v-if="pos.useOfflineMode">
		<summary
			class="cursor-pointer rounded px-3 py-2"
			:class="ready ? 'text-emerald-600' : 'text-amber-600'"
		>
			{{ label }}
		</summary>
		<div
			class="absolute right-0 top-full z-50 w-80 rounded border bg-background p-4 shadow-lg space-y-3"
			aria-live="polite"
		>
			<p>{{ __("Cache for this register’s eligible customers and products") }}</p>
			<div v-for="kind in kinds" :key="kind">
				<strong>{{ __(kind) }}: </strong>
				<span v-if="!state(kind)">{{ __("Not checked this session") }}</span>
				<span v-else-if="state(kind)!.loading">{{ __("Refreshing…") }}</span>
				<span v-else-if="state(kind)!.error">{{ __("Refresh failed — retry") }}</span>
				<span v-else
					>{{ state(kind)!.count.toLocaleString() }}
					{{
						state(kind)!.complete
							? __("loaded — all eligible")
							: __("loaded — limited by settings")
					}}<br />{{ __("Refreshed") }}
					{{ new Date(state(kind)!.updatedAt).toLocaleTimeString() }}</span
				>
			</div>
			<p>
				{{ offline.pendingCount }} {{ __("pending sales") }} · {{ offline.deadLetterCount }}
				{{ __("need attention") }}
			</p>
			<p>{{ __("Stock reflects the last refresh and may change at another till.") }}</p>
			<button
				class="rounded border px-3 py-2"
				:disabled="!offline.isOnline || loading"
				@click="refresh"
			>
				{{ __("Refresh now") }}
			</button>
		</div>
	</details>
</template>
<script setup lang="ts">
import { computed, onUnmounted, ref } from "vue";
import { useCacheStatus } from "@/stores/cacheStatus";
import { usePosStore } from "@/stores/posStore";
import { useOfflineStore } from "@/stores/offlineStore";
import { useCustomerStore } from "@/stores/customerStore";
import { useItemStore } from "@/stores/itemStore";
import { __ } from "@/lib/translate";
const cache = useCacheStatus(),
	pos = usePosStore(),
	offline = useOfflineStore();
const kinds = ["Customers", "Products and stock"];
const now = ref(Date.now());
const timer = setInterval(() => {
	now.value = Date.now();
	offline.refreshPendingCount();
}, 15000);
onUnmounted(() => clearInterval(timer));
const state = (kind: string) =>
	cache.states[kind]?.profile === pos.profileName ? cache.states[kind] : undefined;
const loading = computed(() => kinds.some((k) => state(k)?.loading));
const ready = computed(
	() =>
		offline.isOnline &&
		!offline.pendingCount &&
		!offline.deadLetterCount &&
		kinds.every((k) => {
			const s = state(k);
			return s && s.complete && !s.error && !s.loading && now.value - s.updatedAt < 300000;
		}),
);
const label = computed(() =>
	!offline.isOnline
		? __("Offline cache")
		: loading.value
			? __("Refreshing data…")
			: ready.value
				? __("In sync")
				: __("Check data sync"),
);
async function refresh() {
	await Promise.all([
		useCustomerStore().cacheAllCustomers(pos.profileName),
		useItemStore().cacheAllItems(pos.profileName),
		offline.syncPendingInvoices(),
	]);
	now.value = Date.now();
	await offline.refreshPendingCount();
}
</script>
