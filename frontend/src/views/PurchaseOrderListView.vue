<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRouter } from "vue-router";
import { usePurchaseStore } from "@/stores/purchaseStore";
import { useMoney } from "@/composables/useMoney";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Plus, ChevronRight, Calendar, Package, Edit, Trash2 } from "lucide-vue-next";
import __ from "@/lib/translate";
import { showError } from "@/services/api";
import type { PurchaseOrder } from "@/types/pos.types";
import ListView from "@/components/core/ListView.vue";
import PurchaseOrderDetailDialog from "@/components/dialogs/PurchaseOrderDetailDialog.vue";

const router = useRouter();
const purchaseStore = usePurchaseStore();
const { money, percent } = useMoney();

const selectedOrder = ref<PurchaseOrder | null>(null);
const isLoadingDetail = ref(false);

const draftOrders = ref<
	Array<{
		name: string;
		supplier: string;
		supplier_name: string;
		transaction_date: string;
		creation: string;
		modified: string;
		items_count: number;
	}>
>([]);

let detailRequestId = 0;

async function viewOrder(order: PurchaseOrder): Promise<void> {
	const id = ++detailRequestId;
	isLoadingDetail.value = true;
	selectedOrder.value = { ...order, items: [] };
	try {
		const detail = await purchaseStore.fetchReceiptDetail(order.name);
		if (id !== detailRequestId) return;
		selectedOrder.value = { ...order, items: detail?.items || [] };
	} catch {
		if (id !== detailRequestId) return;
		selectedOrder.value = order;
		showError(__("Failed to fetch order details"));
	} finally {
		if (id === detailRequestId) isLoadingDetail.value = false;
	}
}

function createNewOrder(): void {
	purchaseStore.clearCart();
	purchaseStore.clearSupplier();
	purchaseStore.currentDraftName = null;
	router.push("/purchase-order");
}

async function editDraftOrder(draft: { name: string }): Promise<void> {
	await purchaseStore.loadDraft(draft.name);
	router.push("/purchase-order");
}

async function deleteDraftOrder(name: string): Promise<void> {
	await purchaseStore.deleteDraft(name);
	await loadDrafts();
}

async function loadDrafts(): Promise<void> {
	draftOrders.value = await purchaseStore.getAllDrafts();
}

function editSubmittedOrder(order: PurchaseOrder): void {
	purchaseStore.loadFromOrder(order);
	selectedOrder.value = null;
	router.push("/purchase-order");
}

function formatDate(date: string): string {
	if (!date) return "-";
	return new Date(date).toLocaleDateString();
}

function statusVariant(
	status: string,
): "default" | "secondary" | "destructive" | "outline" | "success" | "warning" {
	switch (status) {
		case "Completed":
			return "success";
		case "Draft":
			return "secondary";
		case "To Receive and Bill":
		case "To Receive":
		case "To Bill":
			return "warning";
		case "Cancelled":
			return "destructive";
		default:
			return "outline";
	}
}

onMounted(() => {
	purchaseStore.init();
	loadDrafts();
});
</script>

<template>
	<div class="h-full min-h-0">
		<ListView
			:title="__('Purchase Orders')"
			doctype="Purchase Order"
			:fields="[
				'name',
				'supplier',
				'supplier_name',
				'company',
				'transaction_date',
				'grand_total',
				'status',
				'docstatus',
				'per_received',
				'per_billed',
			]"
			:base-filters="{ docstatus: 1 }"
			default-order-by="modified desc"
			:default-page-size="20"
			empty-title="No purchase orders found"
			empty-description="Create a new order or adjust your filters"
			:empty-icon="Package"
			:hide-standard-filters-on-mobile="true"
			scroll-class="px-3 sm:px-4 py-3 xpos-scrollbar"
			item-key="name"
		>
			<template #header-actions>
				<Button size="sm" @click="createNewOrder">
					<Plus class="w-4 h-4" />
					{{ __("New Purchase Order") }}
				</Button>
			</template>

			<template #aside>
				<div
					v-if="draftOrders.length > 0"
					class="w-64 border-e border-border bg-card flex flex-col shrink-0"
				>
					<div class="px-3 py-2 border-b border-border bg-muted">
						<span class="text-sm font-medium text-foreground">
							{{ __("Drafts") }} ({{ draftOrders.length }})
						</span>
					</div>
					<ScrollArea class="flex-1 min-h-0">
						<div class="divide-y divide-border">
							<div
								v-for="draft in draftOrders"
								:key="draft.name"
								class="p-3 hover:bg-muted/50 transition-colors"
							>
								<div class="flex items-center justify-between mb-1">
									<span class="text-sm font-medium text-foreground truncate">
										{{ draft.supplier_name || draft.supplier || __("No Supplier") }}
									</span>
									<Badge variant="secondary" class="text-[10px]">{{ __("Draft") }}</Badge>
								</div>
								<div class="text-xs text-muted-foreground mb-2">
									{{ formatDate(draft.modified) }} · {{ draft.items_count || 0 }}
									{{ __("items") }}
								</div>
								<div class="flex gap-1">
									<Button
										@click="editDraftOrder(draft)"
										variant="outline"
										size="sm"
										class="flex-1 h-7"
									>
										<Edit class="w-3 h-3" />
										{{ __("Edit") }}
									</Button>
									<Button
										@click="deleteDraftOrder(draft.name)"
										variant="ghost"
										size="icon"
										class="h-7 w-7 text-destructive hover:text-destructive"
									>
										<Trash2 class="w-3 h-3" />
									</Button>
								</div>
							</div>
						</div>
					</ScrollArea>
				</div>
			</template>

			<template #item="{ item: order }">
				<Card interactive class="p-3 sm:p-4" @click="viewOrder(order)">
					<div class="flex items-center gap-2 sm:gap-4">
						<div class="min-w-0 flex-1">
							<div class="flex items-center gap-2 mb-1 flex-wrap">
								<span class="font-semibold text-foreground text-sm leading-tight">{{
									order.name
								}}</span>
								<Badge :variant="statusVariant(order.status)" class="text-[10px]">
									{{ __(order.status) }}
								</Badge>
							</div>
							<div
								class="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground"
							>
								<span class="flex items-center gap-1">
									<Package class="h-3 w-3 shrink-0" />
									{{ order.supplier_name || order.supplier }}
								</span>
								<span class="flex items-center gap-1 whitespace-nowrap">
									<Calendar class="h-3 w-3 shrink-0" />
									{{ formatDate(order.transaction_date) }}
								</span>
							</div>
						</div>

						<div class="text-end shrink-0">
							<div class="font-bold text-foreground text-base sm:text-lg leading-tight">
								{{ money(order.grand_total) }}
							</div>
							<div class="flex items-center gap-2 justify-end text-xs text-muted-foreground">
								<span>{{ __("Recv") }}: {{ percent(order.per_received || 0) }}</span>
								<span>{{ __("Billed") }}: {{ percent(order.per_billed || 0) }}</span>
							</div>
						</div>
						<ChevronRight class="w-4 h-4 sm:w-5 sm:h-5 text-muted-foreground/40 shrink-0" />
					</div>
				</Card>
			</template>
		</ListView>

		<PurchaseOrderDetailDialog
			:order="selectedOrder"
			:is-loading="isLoadingDetail"
			@close="selectedOrder = null"
			@edit="editSubmittedOrder"
		/>
	</div>
</template>
