<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatMinor } from "@mobile/domain/money";
import { describeSale, type SaleRecord } from "@mobile/domain/sale";
import { bumpSales, getContainer, scopeIdFor, settlePending, useApp } from "@mobile/composables/useApp";
import { useCheckout } from "@mobile/composables/useCheckout";

const { state } = useApp();
const { reviewReprice } = useCheckout();
const sales = ref<SaleRecord[]>([]);
const busy = ref(false);

async function load() {
	const e = state.cashier;
	if (!e) return;
	const all = await getContainer().transactions.listSales(
		["captured", "posting", "posted", "reprice", "uncertain", "held", "rejected", "fiscal_pending"],
		60,
	);
	sales.value = all.filter((s) => s.scopeId === scopeIdFor(e));
}
onMounted(load);
watch(() => state.salesTick, load);

async function retry() {
	busy.value = true;
	try {
		await settlePending();
	} finally {
		busy.value = false;
		bumpSales();
	}
}
const tone = (s: SaleRecord) =>
	s.status === "posted"
		? "success"
		: ["rejected", "fiscal_pending"].includes(s.status)
			? "destructive"
			: "warning";
const waiting = () =>
	sales.value.filter((s) => ["captured", "held", "uncertain", "posting"].includes(s.status)).length;
</script>

<template>
	<div class="pad-safe-x mx-auto flex max-w-3xl flex-col gap-3 py-4">
		<div class="flex items-center justify-between gap-2">
			<h1 class="text-xl font-bold">Sales on this device</h1>
			<Button
				variant="outline"
				class="h-11"
				:loading="busy"
				:disabled="!waiting() || !state.online"
				@click="retry"
				>Send waiting ({{ waiting() }})</Button
			>
		</div>
		<p class="text-xs text-muted-foreground">
			Every sale stays here with its payments and receipt until ERPNext has posted it. Sales ERPNext
			refused are kept for a manager to reconcile; the app never deletes them. Offline selling is
			switched off until stock, serial/batch and receipt checks can run without the server.
		</p>
		<ul class="flex flex-col gap-2" aria-label="Sales">
			<li
				v-for="s in sales"
				:key="s.txnId"
				class="rounded-2xl border border-border bg-card p-3 shadow-raised"
			>
				<div class="flex items-center justify-between gap-2">
					<Badge :variant="tone(s)" dot>{{ s.status.replace("_", " ") }}</Badge>
					<span class="text-base font-bold tabular-nums"
						>{{ s.currency }} {{ formatMinor(s.payableMinor, s.minorDigits) }}</span
					>
				</div>
				<p class="mt-1 text-sm">{{ describeSale(s) }}</p>
				<p class="mt-1 truncate font-mono text-xs text-muted-foreground">
					{{ s.invoice ?? s.txnId }} · {{ new Date(s.createdAt).toLocaleString() }} ·
					{{ s.attempts }} attempt{{ s.attempts === 1 ? "" : "s" }}
				</p>
				<Button v-if="s.status === 'reprice'" class="mt-2 h-11" @click="reviewReprice(s)"
					>Review new prices</Button
				>
			</li>
			<li v-if="!sales.length" class="py-8 text-center text-sm text-muted-foreground">No sales yet.</li>
		</ul>
	</div>
</template>
