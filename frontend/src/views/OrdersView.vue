<template>
	<div class="h-full min-h-0 flex flex-col">
		<div v-if="localInvoices.length > 0" class="shrink-0 px-3 sm:px-4 pt-3 space-y-2">
			<div class="flex items-center gap-2">
				<CloudOff class="h-4 w-4 text-amber-500" />
				<h3 class="text-sm font-semibold text-foreground">
					{{ __("Unsynced (local)") }}
				</h3>
				<Badge variant="secondary" class="text-[10px]">{{ localInvoices.length }}</Badge>
			</div>
			<Card
				v-for="inv in localInvoices"
				:key="inv.id"
				class="p-3 sm:p-4 cursor-pointer transition-all duration-200 border-amber-300/60 dark:border-amber-800/60 hover:border-primary/40 hover:shadow-md"
				@click="viewLocalInvoice(inv)"
			>
				<div class="flex items-center gap-2 sm:gap-4">
					<div class="min-w-0 flex-1">
						<div class="flex items-center gap-2 mb-1 flex-wrap">
							<User class="h-3 w-3 shrink-0" />
							<span class="font-semibold text-foreground text-sm leading-tight">{{
								inv.customer_name || __("Unknown Customer")
							}}</span>
							<Badge :variant="localStatusVariant(inv.status)" class="text-[10px]">
								{{ localStatusLabel(inv.status) }}
							</Badge>
						</div>
						<div
							class="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground"
						>
							<span class="truncate max-w-35 sm:max-w-none">LOCAL-{{ inv.id }}</span>
							<span v-if="inv.created_at" class="flex items-center gap-1 whitespace-nowrap">
								<Clock class="h-3 w-3 shrink-0" />
								{{ formatDateTime(inv.created_at) }}
							</span>
						</div>
						<p v-if="inv.error" class="text-xs text-destructive mt-0.5 truncate">
							{{ inv.error }}
						</p>
					</div>
					<div class="text-end shrink-0">
						<div class="font-bold text-foreground text-base sm:text-lg leading-tight">
							{{ money(inv.grand_total || 0) }}
						</div>
					</div>
					<ChevronRight class="w-4 h-4 sm:w-5 sm:h-5 text-muted-foreground/40 shrink-0" />
				</div>
			</Card>
		</div>

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
						class="p-3 sm:p-4 cursor-pointer transition-all duration-200 border-border/60 dark:border-transparent hover:border-primary/40 hover:shadow-md dark:hover:bg-accent/50 dark:hover:shadow-primary/5"
						@click="viewOrder(order)"
					>
						<div class="flex items-center gap-2 sm:gap-4">
							<div class="min-w-0 flex-1">
								<div class="flex items-center gap-2 mb-1 flex-wrap">
									<User class="h-3 w-3 shrink-0" />
									<span class="font-semibold text-foreground text-sm leading-tight">{{
										order.customer_name || order.customer
									}}</span>
									<Badge :variant="statusVariant(order.status)" class="text-[10px]">
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

							<div class="text-end shrink-0">
								<div class="font-bold text-foreground text-base sm:text-lg leading-tight">
									{{ money(order.grand_total) }}
								</div>
								<div class="flex flex-col items-end gap-0 text-xs">
									<span class="text-muted-foreground whitespace-nowrap">
										Paid:
										{{ money((order.paid_amount || 0) - (order.change_amount || 0)) }}
									</span>
									<span
										v-if="order.total_taxes_and_charges"
										class="text-muted-foreground hidden sm:inline whitespace-nowrap"
									>
										Tax: {{ money(Number(order.total_taxes_and_charges) || 0) }}
									</span>
								</div>
							</div>
							<ChevronRight class="w-4 h-4 sm:w-5 sm:h-5 text-muted-foreground/40 shrink-0" />
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
import { ref, onMounted } from "vue";
import { usePosStore } from "@/stores/posStore";
import { useMoney } from "@/composables/useMoney";
import type { Invoice } from "@/types/pos.types";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { FileText, ChevronRight, User, Calendar as CalendarIcon, Clock, CloudOff } from "lucide-vue-next";
import ListView from "@/components/core/ListView.vue";
import __ from "@/lib/translate";
import ReceiptPreviewDialog from "@/components/dialogs/ReceiptPreviewDialog.vue";
import { call, showError } from "@/services/api";
import { isElectron } from "@/services/electronBridge";
import { getAllPendingInvoices } from "@/services/dbBridge";

interface LocalInvoice {
	id: number;
	customer_name?: string;
	grand_total?: number;
	status: string;
	created_at?: string;
	error?: string;
	data: unknown;
}

const posStore = usePosStore();
const { money } = useMoney();
const selectedOrder = ref<Invoice | null>(null);
const showDetails = ref(false);
const localInvoices = ref<LocalInvoice[]>([]);

async function loadLocalInvoices() {
	if (!isElectron()) return;
	try {
		const rows = (await getAllPendingInvoices()) as unknown as (LocalInvoice & {
			data: unknown;
		})[];
		// Only unsynced real invoices (skip held drafts and already-synced ones,
		// which show up in the server-backed list below), newest first.
		localInvoices.value = rows
			.filter((r) => {
				if (r.status === "synced") return false;
				const d = parseData(r.data);
				return !d?.is_draft;
			})
			.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
	} catch (error) {
		console.error("Error loading local invoices:", error);
		localInvoices.value = [];
	}
}

function parseData(data: unknown): Record<string, unknown> | null {
	if (!data) return null;
	if (typeof data === "string") {
		try {
			return JSON.parse(data);
		} catch {
			return null;
		}
	}
	return data as Record<string, unknown>;
}

function viewLocalInvoice(inv: LocalInvoice) {
	const d = parseData(inv.data);
	if (!d) {
		showError(__("Could not read this invoice's details"));
		return;
	}
	selectedOrder.value = {
		...(d as unknown as Invoice),
		name: `LOCAL-${inv.id}`,
		customer_name: inv.customer_name || (d.customer_name as string) || (d.customer as string),
		grand_total: inv.grand_total ?? (d.grand_total as number),
	};
	showDetails.value = true;
}

function localStatusLabel(status: string): string {
	if (status === "dead_letter") return __("Needs attention");
	if (status === "pending") return __("Pending sync");
	if (status === "syncing") return __("Syncing");
	if (status === "failed") return __("Sync failed");
	if (status === "synced") return __("Synced");
	return status;
}

function localStatusVariant(
	status: string,
): "default" | "success" | "warning" | "destructive" | "secondary" | "outline" {
	if (status === "synced") return "success";
	if (status === "failed" || status === "dead_letter") return "destructive";
	if (status === "syncing") return "default";
	return "warning";
}

function formatDateTime(value: string): string {
	if (!value) return "";
	const d = new Date(value);
	if (Number.isNaN(d.getTime())) return "";
	return d.toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

onMounted(loadLocalInvoices);

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
	return new Date(date).toLocaleDateString(undefined, {
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
