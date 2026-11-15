<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { ShoppingCart, X } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import type { CatalogItem } from "@mobile/ports";
import { formatMinor } from "@mobile/domain/money";
import { SELLING_LAYOUTS, useLayoutChoice } from "@mobile/composables/useLayoutChoice";
import { useCart } from "@mobile/composables/useCart";
import { refreshCatalog, useApp } from "@mobile/composables/useApp";
import CartPanel from "@mobile/ui/CartPanel.vue";
import CatalogLayout from "@mobile/layouts/CatalogLayout.vue";
import ScanCounter from "@mobile/layouts/ScanCounter.vue";
import FashionAssist from "@mobile/layouts/FashionAssist.vue";
import { toastOn } from "@mobile/composables/useToast";

const layout = useLayoutChoice();
const { state } = useApp();
// The signed-in cashier's profile decides the currency and its precision; they are never assumed.
const CURRENCY = state.cashier!.currency;
const DIGITS = state.cashier!.minorDigits;
const { cart, total, count, add } = useCart({ code: CURRENCY, minorDigits: DIGITS });
toastOn(() => cart.error, "warning");
const sheet = ref(false);
const closeBtn = ref<HTMLButtonElement>();
const wide = ref(false);

function mq() {
	wide.value = window.matchMedia("(min-width: 768px)").matches;
}
onMounted(() => {
	mq();
	window.addEventListener("resize", mq);
});
onBeforeUnmount(() => window.removeEventListener("resize", mq));

const view = computed(
	() => ({ catalog: CatalogLayout, scan: ScanCounter, fashion: FashionAssist })[layout.value],
);
const hint = computed(() => SELLING_LAYOUTS.find((l) => l.id === layout.value)?.hint);
function pick(item: CatalogItem) {
	add(item);
}
async function openSheet() {
	sheet.value = true;
	await Promise.resolve();
	closeBtn.value?.focus();
}
</script>

<template>
	<div class="flex h-full min-h-0 flex-col">
		<div class="pad-safe-x shrink-0 pt-2 pb-1">
			<div role="tablist" aria-label="Selling layout" class="flex gap-1">
				<button
					v-for="l in SELLING_LAYOUTS"
					:key="l.id"
					role="tab"
					type="button"
					:aria-selected="layout === l.id"
					:aria-label="l.label"
					class="inline-flex h-11 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg border px-2 text-sm font-semibold md:flex-none md:gap-2 md:px-3 transition-[background-color,border-color,box-shadow] duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
					:class="
						layout === l.id
							? 'border-primary bg-primary text-primary-foreground shadow-primary'
							: 'border-transparent text-foreground hover:bg-surface-hover'
					"
					@click="layout = l.id"
				>
					<component :is="l.icon" class="size-4.5 shrink-0" aria-hidden="true" /><span
						class="truncate md:hidden"
						>{{ l.short }}</span
					><span class="hidden md:inline">{{ l.label }}</span>
				</button>
			</div>
			<p class="mt-1 text-xs text-muted-foreground">
				{{ hint }} · {{ state.catalog.items.toLocaleString() }} items · same cart in every layout
			</p>
		</div>

		<div class="flex min-h-0 flex-1">
			<div class="min-w-0 flex-1 overflow-y-auto">
				<component
					:is="view"
					v-if="state.catalog.ready"
					:scope-id="state.catalog.scopeId"
					:currency="CURRENCY"
					:minor-digits="DIGITS"
					@pick="pick"
				/>
				<div v-else class="pad-safe-x flex flex-col gap-3 py-8 text-center" role="status">
					<template v-if="state.catalog.syncing">
						<p class="text-base font-semibold">Downloading the catalog…</p>
						<p class="text-sm text-muted-foreground tabular-nums">
							{{ state.catalog.downloaded.toLocaleString() }} of
							{{ state.catalog.total.toLocaleString() }} items
						</p>
					</template>
					<template v-else>
						<p class="text-base font-semibold">No catalog on this device</p>
						<p class="text-sm text-muted-foreground">
							Connect to the server to download the items you can sell.
						</p>
						<Button class="mx-auto h-11" @click="refreshCatalog">Download the catalog</Button>
					</template>
				</div>
			</div>
			<aside
				v-if="wide"
				class="my-2 me-3 w-96 shrink-0 overflow-hidden rounded-2xl border border-border bg-card shadow-raised"
			>
				<CartPanel
					:compact="layout === 'scan'"
					:scope-id="state.catalog.scopeId"
					:currency="CURRENCY"
					:minor-digits="DIGITS"
				/>
			</aside>
		</div>

		<div v-if="!wide" class="pad-safe-x shrink-0 py-2">
			<Button class="h-12 w-full justify-between rounded-xl text-base" @click="openSheet">
				<span class="flex items-center gap-2"
					><ShoppingCart /> Cart · {{ count }} item{{ count === 1 ? "" : "s" }}</span
				>
				<span class="tabular-nums">{{ CURRENCY }} {{ formatMinor(total, DIGITS) }}</span>
			</Button>
		</div>

		<div
			v-if="sheet && !wide"
			class="fixed inset-0 z-20 flex flex-col justify-end bg-[hsl(var(--scrim)/0.5)]"
			@click.self="sheet = false"
			@keydown.esc="sheet = false"
		>
			<div
				class="relative flex max-h-[85%] min-h-[50%] flex-col rounded-t-2xl border border-border bg-card shadow-overlay"
				role="dialog"
				aria-modal="true"
				aria-label="Cart"
			>
				<button
					ref="closeBtn"
					type="button"
					class="absolute right-2 top-2 z-10 inline-flex size-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
					aria-label="Close cart"
					@click="sheet = false"
				>
					<X class="size-5" />
				</button>
				<CartPanel :scope-id="state.catalog.scopeId" :currency="CURRENCY" :minor-digits="DIGITS" />
			</div>
		</div>
	</div>
</template>
