<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { useMoney } from "@/composables/useMoney";
import { getDoc, showError } from "@/services/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Plus, ChevronRight, Calendar, Receipt } from "lucide-vue-next";
import __ from "@/lib/translate";
import type { PurchaseInvoice } from "@/types/pos.types";
import ListView from "@/components/core/ListView.vue";
import PurchaseInvoiceDetailDialog from "@/components/dialogs/PurchaseInvoiceDetailDialog.vue";

const router = useRouter();
const { money } = useMoney();

const selectedInvoice = ref<PurchaseInvoice | null>(null);
const isLoadingDetail = ref(false);

let detailRequestId = 0;

async function viewInvoice(invoice: PurchaseInvoice): Promise<void> {
	const id = ++detailRequestId;
	isLoadingDetail.value = true;
	selectedInvoice.value = { ...invoice, items: [] };
	try {
		const detail = await getDoc<PurchaseInvoice>("Purchase Invoice", invoice.name);
		if (id !== detailRequestId) return;
		selectedInvoice.value = detail || invoice;
	} catch {
		if (id !== detailRequestId) return;
		selectedInvoice.value = invoice;
		showError(__("Failed to fetch invoice details"));
	} finally {
		if (id === detailRequestId) isLoadingDetail.value = false;
	}
}

function createNewInvoice(): void {
	router.push("/purchase-invoice");
}

function formatDate(date: string): string {
	if (!date) return "-";
	return new Date(date).toLocaleDateString();
}

function statusVariant(
	status: string,
): "default" | "secondary" | "destructive" | "outline" | "success" | "warning" {
	switch (status) {
		case "Paid":
			return "success";
		case "Unpaid":
		case "Partly Paid":
		case "Overdue":
			return "warning";
		case "Draft":
			return "secondary";
		case "Cancelled":
			return "destructive";
		default:
			return "outline";
	}
}
</script>

<template>
	<div class="h-full min-h-0">
		<ListView
			:title="__('Purchase Invoices')"
			doctype="Purchase Invoice"
			:fields="[
				'name',
				'supplier',
				'supplier_name',
				'company',
				'posting_date',
				'bill_no',
				'grand_total',
				'outstanding_amount',
				'status',
				'docstatus',
			]"
			:base-filters="{ docstatus: 1 }"
			default-order-by="modified desc"
			:default-page-size="20"
			empty-title="No purchase invoices found"
			empty-description="Create a new invoice or adjust your filters"
			:empty-icon="Receipt"
			:hide-standard-filters-on-mobile="true"
			scroll-class="px-3 sm:px-4 py-3 xpos-scrollbar"
			item-key="name"
		>
			<template #header-actions>
				<Button size="sm" @click="createNewInvoice">
					<Plus class="w-4 h-4" />
					{{ __("New Invoice") }}
				</Button>
			</template>

			<template #item="{ item: invoice }">
				<Card interactive class="p-3 sm:p-4" @click="viewInvoice(invoice)">
					<div class="flex items-center gap-2 sm:gap-4">
						<div class="min-w-0 flex-1">
							<div class="flex items-center gap-2 mb-1 flex-wrap">
								<span class="font-semibold text-foreground text-sm leading-tight">
									{{ invoice.name }}
								</span>
								<Badge :variant="statusVariant(invoice.status)" class="text-[10px]">
									{{ __(invoice.status) }}
								</Badge>
							</div>
							<div
								class="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground"
							>
								<span class="flex items-center gap-1">
									<Receipt class="h-3 w-3 shrink-0" />
									{{ invoice.supplier_name || invoice.supplier }}
								</span>
								<span class="flex items-center gap-1 whitespace-nowrap">
									<Calendar class="h-3 w-3 shrink-0" />
									{{ formatDate(invoice.posting_date) }}
								</span>
							</div>
						</div>

						<div class="text-end shrink-0">
							<div class="font-bold text-foreground text-base sm:text-lg leading-tight">
								{{ money(invoice.grand_total || 0) }}
							</div>
							<div class="text-xs text-muted-foreground">
								{{ __("Outstanding") }}:
								{{ money(invoice.outstanding_amount || 0) }}
							</div>
						</div>
						<ChevronRight class="w-4 h-4 sm:w-5 sm:h-5 text-muted-foreground/40 shrink-0" />
					</div>
				</Card>
			</template>
		</ListView>

		<PurchaseInvoiceDetailDialog
			:invoice="selectedInvoice"
			:is-loading="isLoadingDetail"
			@close="selectedInvoice = null"
		/>
	</div>
</template>
