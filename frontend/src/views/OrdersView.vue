<template>
	<div class="h-full min-h-0 flex flex-col">
		<div class="flex-1 min-h-0">
			<ListView
				:title="__('Order History')"
				:doctype="posStore.invoiceType"
				:fields="[
					'name',
					'customer',
					'customer_name',
					'posting_date',
					'posting_time',
					'grand_total',
					'net_total',
					'paid_amount',
					'change_amount',
					'outstanding_amount',
					'total_taxes_and_charges',
					'status',
					'is_return',
					'return_against',
					'pos_profile',
					'owner',
				]"
				:base-filters="{
					docstatus: 1,
					is_pos: 1,
					pos_profile: posStore.profileName,
				}"
				:default-page-size="20"
				empty-title="No orders found"
				empty-description="Try adjusting your filters"
				:empty-icon="FileText"
				item-key="name"
			>
				<template #item="{ item: order }">
					<Card
						interactive
						class="bg-surface-raised p-3 hover:border-border hover:bg-surface-hover active:bg-surface-pressed aria-selected:bg-surface-selected sm:p-4"
						:aria-selected="
							showDetails && selectedOrder?.name === order.name ? 'true' : undefined
						"
						:aria-label="`${order.name} ${order.customer_name || order.customer}`"
						@click="viewOrder(order)"
					>
						<div class="flex items-center gap-2 sm:gap-4">
							<div class="min-w-0 flex-1">
								<div class="flex items-center gap-2 mb-1 flex-wrap">
									<User class="h-3 w-3 shrink-0" />
									<span class="font-semibold text-foreground text-sm leading-tight">{{
										order.customer_name || order.customer
									}}</span>
									<Badge :variant="statusVariant(order.status)" class="text-xs">
										{{ __(order.status) }}
									</Badge>
								</div>
								<div
									class="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground"
								>
									<span
										class="flex items-center gap-1 min-w-0 truncate max-w-30 sm:max-w-none"
									>
										{{ order.name }}
									</span>
									<span class="flex items-center gap-1 whitespace-nowrap">
										<CalendarIcon class="h-3 w-3 shrink-0" />
										{{ formatDate(order.posting_date) }}
									</span>
									<span
										v-if="order.posting_time"
										class="flex items-center gap-1 whitespace-nowrap"
									>
										<Clock class="h-3 w-3 shrink-0" />
										{{ formatTime(String(order.posting_time)) }}
									</span>
								</div>
							</div>

							<div class="text-end shrink-0 tabular-nums">
								<div class="font-bold text-foreground text-base sm:text-lg leading-tight">
									{{ money(order.grand_total) }}
								</div>
								<div class="flex flex-col items-end gap-0 text-xs">
									<span class="text-muted-foreground whitespace-nowrap">
										{{ __("Paid:") }}
										{{ money((order.paid_amount || 0) - (order.change_amount || 0)) }}
									</span>
									<span
										v-if="order.total_taxes_and_charges"
										class="text-muted-foreground hidden sm:inline whitespace-nowrap"
									>
										{{ __("Tax:") }}
										{{ money(Number(order.total_taxes_and_charges) || 0) }}
									</span>
								</div>
							</div>
							<ChevronRight class="w-4 h-4 sm:w-5 sm:h-5 text-muted-foreground shrink-0" />
						</div>
					</Card>
				</template>
			</ListView>
		</div>

		<ReceiptPreviewDialog
			v-model:open="showDetails"
			:invoice="selectedOrder"
			@close="showDetails = false"
		/>
	</div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { usePosStore } from "@/stores/posStore";
import { useMoney } from "@/composables/useMoney";
import type { Invoice } from "@/types/pos.types";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { FileText, ChevronRight, User, Calendar as CalendarIcon, Clock } from "lucide-vue-next";
import ListView from "@/components/core/ListView.vue";
import __ from "@/lib/translate";
import ReceiptPreviewDialog from "@/components/dialogs/ReceiptPreviewDialog.vue";
import { call, showError } from "@/services/api";

const posStore = usePosStore();
const { money } = useMoney();
const selectedOrder = ref<Invoice | null>(null);
const showDetails = ref(false);

async function viewOrder(order: Invoice) {
	try {
		const details = await call<Invoice>("xpos.api.invoices.get_invoice_details", {
			invoice_name: order.name,
		});
		selectedOrder.value = details;
		showDetails.value = true;
	} catch (error) {
		console.error("Error fetching order details:", error);
		showError(__("Failed to fetch order details"));
	}
}

function formatDate(date: string) {
	if (!date) return "";
	const [year, month, day] = date.split("-").map(Number);
	return new Date(year, month - 1, day).toLocaleDateString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
	});
}

function formatTime(time: string) {
	if (!time) return "";
	const [hours, minutes] = time.split(":");
	const h = parseInt(hours);
	const ampm = h >= 12 ? "PM" : "AM";
	const hour12 = h % 12 || 12;
	return `${hour12}:${minutes} ${ampm}`;
}

function statusVariant(
	status: string,
): "default" | "success" | "warning" | "destructive" | "secondary" | "outline" {
	const map: Record<string, "success" | "warning" | "destructive" | "secondary" | "outline"> = {
		Paid: "success",
		Unpaid: "warning",
		Overdue: "destructive",
		"Credit Note Issued": "outline",
		Cancelled: "secondary",
		Return: "warning",
	};
	return map[status] || "secondary";
}
</script>
