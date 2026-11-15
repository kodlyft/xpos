<template>
	<Dialog
		:open="!!invoice"
		@update:open="
			(val) => {
				if (!val) emit('close');
			}
		"
	>
		<DialogContent class="max-w-6xl p-0">
			<DialogHeader class="p-6 pb-4 border-b border-border">
				<div class="flex items-center justify-between gap-3">
					<div>
						<DialogTitle class="text-lg">
							{{ invoice?.name }}
							<Badge
								v-if="invoice"
								:variant="statusVariant(invoice.status)"
								class="text-xs ms-2"
							>
								{{ __(invoice.status) }}
							</Badge>
						</DialogTitle>
						<DialogDescription>{{ __("Purchase Invoice Details") }}</DialogDescription>
					</div>
				</div>
			</DialogHeader>

			<div v-if="invoice" class="p-6 space-y-6 max-h-[65vh] overflow-y-auto">
				<div class="grid grid-cols-2 sm:grid-cols-4 gap-4">
					<div class="space-y-1">
						<span class="text-xs text-muted-foreground uppercase tracking-wide">
							{{ __("Supplier") }}
						</span>
						<p class="font-medium text-foreground">
							{{ invoice.supplier_name || invoice.supplier }}
						</p>
					</div>
					<div class="space-y-1">
						<span class="text-xs text-muted-foreground uppercase tracking-wide">
							{{ __("Date") }}
						</span>
						<p class="font-medium text-foreground">{{ formatDate(invoice.posting_date) }}</p>
					</div>
					<div class="space-y-1">
						<span class="text-xs text-muted-foreground uppercase tracking-wide">
							{{ __("Company") }}
						</span>
						<p class="font-medium text-foreground">{{ invoice.company }}</p>
					</div>
					<div v-if="invoice.bill_no" class="space-y-1">
						<span class="text-xs text-muted-foreground uppercase tracking-wide">
							{{ __("Supplier Bill") }}
						</span>
						<p class="font-medium text-foreground">{{ invoice.bill_no }}</p>
					</div>
					<div v-if="invoice.purchase_order" class="space-y-1">
						<span class="text-xs text-muted-foreground uppercase tracking-wide">
							{{ __("Purchase Order") }}
						</span>
						<p class="font-medium text-foreground">{{ invoice.purchase_order }}</p>
					</div>
					<div v-if="invoice.purchase_receipt" class="space-y-1">
						<span class="text-xs text-muted-foreground uppercase tracking-wide">
							{{ __("Purchase Receipt") }}
						</span>
						<p class="font-medium text-foreground">{{ invoice.purchase_receipt }}</p>
					</div>
					<div v-if="(invoice as any).is_paid" class="space-y-1">
						<span class="text-xs text-muted-foreground uppercase tracking-wide">
							{{ __("Payment Status") }}
						</span>
						<p class="font-medium text-success">{{ __("Paid") }}</p>
					</div>
				</div>

				<div v-if="invoice.remarks" class="space-y-1">
					<span class="text-xs text-muted-foreground uppercase tracking-wide">
						{{ __("Remarks") }}
					</span>
					<p class="text-sm text-foreground">{{ invoice.remarks }}</p>
				</div>

				<div v-if="isLoading" class="py-8 text-center text-muted-foreground">
					{{ __("Loading items...") }}
				</div>
				<div v-else-if="invoice.items?.length" class="space-y-3">
					<h3 class="text-sm font-semibold text-foreground">
						{{ __("Items") }} ({{ invoice.items.length }})
					</h3>
					<div class="rounded-lg border border-border overflow-hidden">
						<div class="overflow-x-auto">
							<table class="w-full text-sm min-w-225">
								<thead class="bg-muted/50">
									<tr>
										<th
											class="text-start px-3 py-2.5 text-muted-foreground font-medium text-xs uppercase tracking-wide"
										>
											{{ __("Item") }}
										</th>
										<th
											class="text-center px-2 py-2.5 text-muted-foreground font-medium text-xs uppercase tracking-wide"
										>
											{{ __("Qty") }}
										</th>
										<th
											class="text-center px-2 py-2.5 text-muted-foreground font-medium text-xs uppercase tracking-wide"
										>
											{{ __("UOM") }}
										</th>
										<th
											class="text-center px-2 py-2.5 text-muted-foreground font-medium text-xs uppercase tracking-wide"
										>
											{{ __("CF") }}
										</th>
										<th
											class="text-end px-2 py-2.5 text-muted-foreground font-medium text-xs uppercase tracking-wide"
										>
											{{ __("Rate") }}
										</th>
										<th
											class="text-end px-2 py-2.5 text-muted-foreground font-medium text-xs uppercase tracking-wide"
										>
											{{ __("Gross") }}
										</th>
										<th
											class="text-end px-2 py-2.5 text-muted-foreground font-medium text-xs uppercase tracking-wide"
										>
											{{ __("Disc%") }}
										</th>
										<th
											class="text-end px-2 py-2.5 text-muted-foreground font-medium text-xs uppercase tracking-wide"
										>
											{{ __("Disc Amt") }}
										</th>
										<th
											class="text-end px-2 py-2.5 text-muted-foreground font-medium text-xs uppercase tracking-wide"
										>
											{{ __("Net") }}
										</th>
										<th
											class="text-end px-2 py-2.5 text-muted-foreground font-medium text-xs uppercase tracking-wide"
										>
											{{ __("Tax") }}
										</th>
										<th
											class="text-end px-3 py-2.5 text-muted-foreground font-medium text-xs uppercase tracking-wide"
										>
											{{ __("Amount") }}
										</th>
									</tr>
								</thead>
								<tbody class="divide-y divide-border">
									<tr
										v-for="item in invoice.items"
										:key="item.item_code"
										class="hover:bg-muted/30 transition-colors"
									>
										<td class="px-3 py-2.5">
											<div class="text-foreground font-medium text-xs">
												{{ item.item_name }}
											</div>
											<div class="text-[11px] text-muted-foreground">
												{{ item.item_code }}
											</div>
											<div
												v-if="getField(item, 'warehouse')"
												class="text-[11px] text-muted-foreground"
											>
												{{ getField(item, "warehouse") }}
											</div>
											<div
												v-if="getField(item, 'batch_no')"
												class="text-[11px] text-info"
											>
												{{ __("Batch") }}: {{ getField(item, "batch_no") }}
											</div>
										</td>
										<td class="px-2 py-2.5 text-center text-muted-foreground text-xs">
											{{ qty(item.qty) }}
										</td>
										<td class="px-2 py-2.5 text-center text-muted-foreground text-xs">
											{{ item.uom || item.stock_uom || "-" }}
										</td>
										<td class="px-2 py-2.5 text-center text-muted-foreground text-xs">
											{{ getField(item, "conversion_factor") || 1 }}
										</td>
										<td class="px-2 py-2.5 text-end text-muted-foreground text-xs">
											{{ money(item.rate || 0) }}
										</td>
										<td class="px-2 py-2.5 text-end text-muted-foreground text-xs">
											{{ money(getGross(item)) }}
										</td>
										<td class="px-2 py-2.5 text-end text-muted-foreground text-xs">
											{{
												getField(item, "discount_percentage")
													? percent(getField(item, "discount_percentage"), 1)
													: "-"
											}}
										</td>
										<td class="px-2 py-2.5 text-end text-muted-foreground text-xs">
											{{
												getField(item, "discount_amount")
													? money(Number(getField(item, "discount_amount")))
													: "-"
											}}
										</td>
										<td class="px-2 py-2.5 text-end text-muted-foreground text-xs">
											{{ money(getNet(item)) }}
										</td>
										<td class="px-2 py-2.5 text-end text-muted-foreground text-xs">
											{{ money(getTax(item)) }}
										</td>
										<td class="px-3 py-2.5 text-end font-medium text-foreground text-xs">
											{{ money(getItemAmount(item)) }}
										</td>
									</tr>
								</tbody>
							</table>
						</div>
					</div>

					<!-- Totals summary -->
					<div class="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm pt-1">
						<div>
							<span class="text-xs text-muted-foreground block">{{ __("Total Qty") }}</span>
							<span class="font-semibold">{{ totalQty }}</span>
						</div>
						<div>
							<span class="text-xs text-muted-foreground block">{{ __("Gross Total") }}</span>
							<span class="font-semibold">{{ money(grossTotal) }}</span>
						</div>
						<div>
							<span class="text-xs text-muted-foreground block">{{
								__("Total Discount")
							}}</span>
							<span class="font-semibold text-destructive">-{{ money(totalDiscountAmt) }}</span>
						</div>
						<div>
							<span class="text-xs text-muted-foreground block">{{ __("Net Total") }}</span>
							<span class="font-semibold">{{
								money(Number((invoice as any).net_total || 0))
							}}</span>
						</div>
					</div>
					<div class="flex items-center justify-between gap-4 text-sm border-t border-border pt-3">
						<div class="flex gap-6">
							<div class="text-muted-foreground">
								{{ __("Tax Total") }}:
								<strong>{{
									money(Number((invoice as any).total_taxes_and_charges || 0))
								}}</strong>
							</div>
							<div
								v-if="Number((invoice as any).discount_amount || 0) > 0"
								class="text-muted-foreground"
							>
								{{ __("Addl. Discount") }}:
								<strong class="text-destructive"
									>-{{ money(Number((invoice as any).discount_amount)) }}</strong
								>
							</div>
							<div class="text-muted-foreground">
								{{ __("Outstanding") }}:
								<strong>{{ money(invoice.outstanding_amount || 0) }}</strong>
							</div>
						</div>
						<div>
							<span class="text-muted-foreground">{{ __("Grand Total") }}</span>
							<span class="font-bold text-foreground text-base ms-2">
								{{ money(invoice.grand_total || 0) }}
							</span>
						</div>
					</div>
				</div>
			</div>

			<DialogFooter class="p-4 border-t border-border gap-2 sm:gap-2">
				<div class="flex-1"></div>
				<Button size="sm" @click="emit('close')">{{ __("Close") }}</Button>
			</DialogFooter>
		</DialogContent>
	</Dialog>
</template>

<script setup lang="ts">
import { computed } from "vue";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import __ from "@/lib/translate";
import { useMoney } from "@/composables/useMoney";
import type { PurchaseInvoice, PurchaseItem } from "@/types/pos.types";

const props = defineProps<{
	invoice: PurchaseInvoice | null;
	isLoading?: boolean;
}>();

const emit = defineEmits<{
	close: [];
}>();

const { money, percent, qty } = useMoney();

function getField(item: PurchaseItem, field: string): any {
	return (item as any)[field];
}

function formatDate(date: string): string {
	if (!date) return "-";
	return new Date(date).toLocaleDateString();
}

function getGross(item: PurchaseItem): number {
	return (item.qty || 0) * (item.rate || 0);
}

function getNet(item: PurchaseItem): number {
	const net = Number(getField(item, "net_amount"));
	if (net) return net;
	const gross = getGross(item);
	const discPct = Number(getField(item, "discount_percentage") || 0);
	const discAmt = Number(getField(item, "discount_amount") || 0);
	if (discAmt > 0) return gross - discAmt;
	if (discPct > 0) return gross * (1 - discPct / 100);
	return gross;
}

function getTax(item: PurchaseItem): number {
	// item_tax_amount is available on Purchase Invoice Item from getDoc
	const tax = Number(getField(item, "item_tax_amount") || 0);
	return tax;
}

function getItemAmount(item: PurchaseItem): number {
	return Number(item.amount || 0) || getGross(item);
}

const totalQty = computed(() =>
	(props.invoice?.items || []).reduce((sum: number, item: PurchaseItem) => sum + (item.qty || 0), 0),
);

const grossTotal = computed(() =>
	(props.invoice?.items || []).reduce((sum: number, item: PurchaseItem) => sum + getGross(item), 0),
);

const totalDiscountAmt = computed(() =>
	(props.invoice?.items || []).reduce((sum: number, item: PurchaseItem) => {
		const gross = getGross(item);
		const net = getNet(item);
		return sum + (gross - net);
	}, 0),
);

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
