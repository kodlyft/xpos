<template>
	<div class="flex h-full min-h-0 flex-col">
		<PageHeader :title="__('Sales Orders')" :icon="ScrollText">
			<div
				class="inline-flex gap-1 rounded-xl border border-border bg-surface-sunken p-1"
				role="tablist"
			>
				<Button
					v-for="t in tabs"
					:key="t.value"
					size="sm"
					role="tab"
					:variant="tab === t.value ? 'default' : 'ghost'"
					:aria-selected="tab === t.value"
					:data-testid="`so-tab-${t.value}`"
					@click="tab = t.value"
				>
					{{ t.label }}
				</Button>
			</div>
			<Input
				v-model="search"
				type="search"
				class="ms-auto w-full sm:w-72"
				:placeholder="__('Search by number or customer')"
				data-testid="so-search"
			/>
		</PageHeader>

		<div class="flex min-h-0 flex-1 flex-col gap-4 p-3 sm:p-4">
			<LoadingState v-if="isLoading" variant="skeleton" :rows="5" />
			<ErrorState
				v-else-if="loadError"
				:title="__('Could not load records')"
				:description="loadError"
				retryable
				@retry="fetchRows"
			/>
			<EmptyState
				v-else-if="!rows.length"
				:icon="ScrollText"
				:title="tab === 'orders' ? __('No open sales orders') : __('No open quotations')"
				:description="
					tab === 'orders'
						? __('Orders saved from the cart appear here until they are fully billed.')
						: __('Quotations appear here until they expire or are ordered.')
				"
			/>
			<ul v-else class="flex-1 space-y-2 overflow-y-auto">
				<li
					v-for="row in rows"
					:key="row.name"
					class="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-3"
					data-testid="so-row"
				>
					<div class="min-w-0 flex-1">
						<p class="font-semibold">{{ row.name }}</p>
						<p class="truncate text-sm text-muted-foreground">
							{{ row.customer_name || row.customer }} · {{ row.transaction_date }}
						</p>
					</div>
					<div class="text-end text-sm">
						<p class="font-bold tabular-nums">{{ money(row.grand_total) }}</p>
						<p v-if="tab === 'orders'" class="text-muted-foreground">
							<template v-if="row.advance_paid">
								{{ __("Deposit {0}", [money(row.advance_paid)]) }} ·
							</template>
							{{ __("{0} billed", [percent(row.per_billed || 0, 0)]) }}
						</p>
						<p v-else-if="row.valid_till" class="text-muted-foreground">
							{{ __("Valid till {0}", [row.valid_till]) }}
						</p>
					</div>
					<Button
						size="sm"
						:loading="loadingName === row.name"
						:disabled="!!loadingName"
						data-testid="so-load"
						@click="requestLoad(row.name)"
					>
						<ShoppingCart class="size-4" />
						{{ __("Load into cart") }}
					</Button>
				</li>
			</ul>
		</div>

		<ConfirmDialog
			:open="!!pendingName"
			:title="__('Replace the cart?')"
			:description="__('The items in the cart will be removed.')"
			:confirm-label="__('Replace')"
			variant="destructive"
			@confirm="confirmLoad"
			@cancel="pendingName = ''"
		/>
	</div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted } from "vue";
import { useRouter } from "vue-router";
import { usePosStore } from "@/stores/posStore";
import { useCartStore } from "@/stores/cartStore";
import { useCartSessionStore } from "@/stores/cartSessionStore";
import { useMoney } from "@/composables/useMoney";
import { call, showError } from "@/services/api";
import { extractErrorMessage } from "@/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/state";
import { PageHeader } from "@/components/ui/page";
import ConfirmDialog from "@/components/dialogs/ConfirmDialog.vue";
import { ScrollText, ShoppingCart } from "lucide-vue-next";
import { __ } from "@/lib/translate";
import type { OrderForCart } from "@/types/pos.types";

type Tab = "orders" | "quotations";
interface Row {
	name: string;
	customer: string;
	customer_name?: string;
	transaction_date: string;
	grand_total: number;
	advance_paid?: number;
	per_billed?: number;
	valid_till?: string;
}

const router = useRouter();
const posStore = usePosStore();
const cartStore = useCartStore();
const cartSessions = useCartSessionStore();
const { money, percent } = useMoney();

const tabs: { value: Tab; label: string }[] = [
	{ value: "orders", label: __("Sales Orders") },
	{ value: "quotations", label: __("Quotations") },
];
const tab = ref<Tab>("orders");
const search = ref("");
const rows = ref<Row[]>([]);
const isLoading = ref(false);
const loadingName = ref("");
const pendingName = ref("");
let requestId = 0;
let searchTimer: ReturnType<typeof setTimeout> | undefined;

const loadError = ref("");

async function fetchRows() {
	const id = ++requestId;
	isLoading.value = true;
	loadError.value = "";
	try {
		const result = await call<Row[]>(
			tab.value === "orders"
				? "xpos.api.sales_orders.search_orders"
				: "xpos.api.sales_orders.search_quotations",
			{ pos_profile: posStore.profileName, search: search.value.trim() || undefined },
		);
		if (id === requestId) rows.value = result || [];
	} catch (error: unknown) {
		if (id === requestId) {
			rows.value = [];
			loadError.value = extractErrorMessage(error);
		}
		showError(extractErrorMessage(error));
	} finally {
		if (id === requestId) isLoading.value = false;
	}
}

watch(tab, fetchRows);
watch(search, () => {
	clearTimeout(searchTimer);
	searchTimer = setTimeout(fetchRows, 300);
});
onMounted(fetchRows);

function requestLoad(name: string) {
	if (cartStore.isEmpty) void load(name);
	else pendingName.value = name;
}

function confirmLoad() {
	const name = pendingName.value;
	pendingName.value = "";
	void load(name);
}

async function load(name: string) {
	loadingName.value = name;
	try {
		const isOrder = tab.value === "orders";
		const doc = await call<OrderForCart>(
			isOrder
				? "xpos.api.sales_orders.get_order_for_cart"
				: "xpos.api.sales_orders.get_quotation_for_cart",
			isOrder
				? { sales_order: name, pos_profile: posStore.profileName }
				: { quotation: name, pos_profile: posStore.profileName },
		);
		const target = await cartSessions.loadIntoCart(() =>
			isOrder ? cartStore.loadSalesOrder(doc) : cartStore.loadQuotation(doc),
		);
		if (!target.ok) {
			showError(target.reason || "");
			return;
		}
		await router.push("/pos");
	} catch (error: unknown) {
		showError(extractErrorMessage(error));
	} finally {
		loadingName.value = "";
	}
}
</script>
