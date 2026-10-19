<template>
	<Dialog
		:open="!!invoice"
		@update:open="
			(val: boolean) => {
				if (!val) emit('close');
			}
		"
	>
		<DialogScrollContent class="max-w-2xl p-0">
			<DialogHeader class="p-6 pb-4 border-b border-border">
				<div class="flex items-center justify-between">
					<div>
						<DialogTitle class="text-lg">
							{{ invoice?.name }}
							<Badge v-if="invoice" :variant="statusVariant(invoice.status)" class="text-xs">
								{{ invoice.status }}
							</Badge>
						</DialogTitle>
						<DialogDescription>{{ __("Invoice details") }}</DialogDescription>
					</div>
				</div>
			</DialogHeader>

			<div v-if="invoice" class="p-6 space-y-6 max-h-[60vh] overflow-y-auto">
				<div class="grid grid-cols-2 sm:grid-cols-3 gap-4">
					<div class="space-y-1">
						<span class="text-xs text-muted-foreground uppercase tracking-wide">{{
							__("Customer")
						}}</span>
						<p class="font-medium text-foreground">
							{{ invoice.customer_name }}
						</p>
					</div>
					<div class="space-y-1">
						<span class="text-xs text-muted-foreground uppercase tracking-wide">{{
							__("Date & Time")
						}}</span>
						<DateTimePicker
							:model-value="orderDateTime(invoice)"
							mode="datetime"
							:disabled="true"
							:clearable="false"
							placeholder="Posting date"
							class="w-full"
						/>
					</div>
					<div class="space-y-1">
						<span class="text-xs text-muted-foreground uppercase tracking-wide">{{
							__("POS Profile")
						}}</span>
						<p class="font-medium text-foreground">
							{{ invoice.pos_profile || "-" }}
						</p>
					</div>
					<div class="space-y-1">
						<span class="text-xs text-muted-foreground uppercase tracking-wide">{{
							__("Created By")
						}}</span>
						<p class="font-medium text-foreground">
							{{ invoice.owner || "-" }}
						</p>
					</div>
					<div v-if="invoice.sales_partner" class="space-y-1">
						<span class="text-xs text-muted-foreground uppercase tracking-wide">{{
							__("Sales Partner")
						}}</span>
						<p class="font-medium text-foreground">
							{{ invoice.sales_partner }}
						</p>
					</div>
					<div v-if="invoice.coupon_code" class="space-y-1">
						<span class="text-xs text-muted-foreground uppercase tracking-wide">{{
							__("Coupon")
						}}</span>
						<p class="font-medium text-foreground">
							{{ invoice.coupon_code }}
						</p>
					</div>
				</div>

				<div v-if="invoice.items" class="space-y-2">
					<h3 class="text-sm font-semibold text-foreground">
						{{ __("Items") }} ({{ invoice.items.length }})
					</h3>
					<div class="rounded-lg border border-border overflow-hidden">
						<div class="overflow-x-auto">
							<table class="w-full text-sm min-w-90">
								<thead class="bg-muted/50">
									<tr>
										<th
											class="text-start px-4 py-2.5 text-muted-foreground font-medium text-xs uppercase tracking-wide"
										>
											{{ __("Item") }}
										</th>
										<th
											class="text-end px-4 py-2.5 text-muted-foreground font-medium text-xs uppercase tracking-wide"
										>
											{{ __("Qty") }}
										</th>
										<th
											class="text-end px-4 py-2.5 text-muted-foreground font-medium text-xs uppercase tracking-wide"
										>
											{{ __("Rate") }}
										</th>
										<th
											class="text-end px-4 py-2.5 text-muted-foreground font-medium text-xs uppercase tracking-wide"
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
										<td class="px-4 py-3">
											<div class="text-foreground font-medium">
												{{ item.item_name }}
											</div>
											<div
												v-if="item.discount_percentage || item.discount_amount"
												class="text-xs text-muted-foreground"
											>
												{{ __("Discount") }}:
												{{
													item.discount_percentage
														? percent(item.discount_percentage)
														: money(item.discount_amount || 0)
												}}
											</div>
										</td>
										<td class="px-4 py-3 text-end text-muted-foreground">
											{{ qty(item.qty) }} {{ item.uom }}
										</td>
										<td class="px-4 py-3 text-end text-muted-foreground">
											{{ amount(item.rate) }}
										</td>
										<td class="px-4 py-3 text-end font-medium text-foreground">
											{{ amount(item.amount ?? 0) }}
										</td>
									</tr>
								</tbody>
							</table>
						</div>
					</div>
				</div>

				<div class="space-y-2">
					<h3 class="text-sm font-semibold text-foreground">{{ __("Summary") }}</h3>
					<div class="rounded-lg border border-border p-4 space-y-2">
						<div class="flex justify-between text-sm">
							<span class="text-muted-foreground">{{ __("Net Total") }}</span>
							<span class="text-foreground">{{ money(invoice!.net_total) }}</span>
						</div>
						<div v-if="invoice!.total_taxes_and_charges" class="flex justify-between text-sm">
							<span class="text-muted-foreground">{{ __("Taxes & Charges") }}</span>
							<span class="text-foreground">{{
								money(Number(invoice!.total_taxes_and_charges) || 0)
							}}</span>
						</div>
						<div
							v-if="invoice!.discount_amount || invoice!.additional_discount_percentage"
							class="flex justify-between text-sm"
						>
							<span class="text-muted-foreground">
								{{ __("Discount") }}
								<span v-if="invoice!.additional_discount_percentage"
									>({{ percent(invoice!.additional_discount_percentage) }})</span
								>
							</span>
							<span class="text-destructive"
								>-{{ money(Number(invoice!.discount_amount) || 0) }}</span
							>
						</div>
						<div v-if="invoice!.loyalty_amount" class="flex justify-between text-sm">
							<span class="text-muted-foreground">{{ __("Loyalty Points Redeemed") }}</span>
							<span class="text-destructive">-{{ money(invoice!.loyalty_amount) }}</span>
						</div>
						<div class="flex justify-between text-base font-bold pt-2 border-t border-border">
							<span class="text-foreground">{{ __("Grand Total") }}</span>
							<span class="text-foreground">{{ money(invoice!.grand_total) }}</span>
						</div>
					</div>
				</div>

				<div
					v-if="invoice.taxes && Array.isArray(invoice.taxes) && invoice.taxes.length > 0"
					class="space-y-2"
				>
					<h3 class="text-sm font-semibold text-foreground">
						{{ __("Taxes Breakdown") }}
					</h3>
					<div class="rounded-lg border border-border divide-y divide-border">
						<div
							v-for="tax in invoice.taxes as any[]"
							:key="tax.description"
							class="flex justify-between px-4 py-2.5 text-sm"
						>
							<span class="text-muted-foreground"
								>{{ tax.description }} ({{ percent(tax.rate) }})</span
							>
							<span class="text-foreground font-medium">{{ money(tax.tax_amount) }}</span>
						</div>
					</div>
				</div>

				<div v-if="invoice.payments && invoice.payments.length > 0" class="space-y-2">
					<h3 class="text-sm font-semibold text-foreground">{{ __("Payments") }}</h3>
					<div class="rounded-lg border border-border divide-y divide-border">
						<div
							v-for="p in invoice.payments"
							:key="p.mode_of_payment"
							class="flex justify-between items-center px-4 py-2.5"
						>
							<span class="text-muted-foreground text-sm">{{ p.mode_of_payment }}</span>
							<span class="font-medium text-foreground">{{ money(p.amount) }}</span>
						</div>
						<div
							v-if="invoice.change_amount"
							class="flex justify-between items-center px-4 py-2.5 bg-muted/30"
						>
							<span class="text-muted-foreground text-sm">{{ __("Change Given") }}</span>
							<span class="font-medium text-foreground">{{
								money(Number(invoice.change_amount) || 0)
							}}</span>
						</div>
					</div>
				</div>

				<div v-if="invoice.loyalty_program || invoice.loyalty_points" class="space-y-2">
					<h3 class="text-sm font-semibold text-foreground">
						{{ __("Loyalty Information") }}
					</h3>
					<div class="rounded-lg border border-border p-4 space-y-2">
						<div v-if="invoice.loyalty_program" class="flex justify-between text-sm">
							<span class="text-muted-foreground">{{ __("Program") }}</span>
							<span class="text-foreground">{{ invoice.loyalty_program }}</span>
						</div>
						<div v-if="invoice.loyalty_points" class="flex justify-between text-sm">
							<span class="text-muted-foreground">{{ __("Points Earned") }}</span>
							<span class="text-foreground font-medium">{{ invoice.loyalty_points }}</span>
						</div>
						<div v-if="invoice.redeem_loyalty_points" class="flex justify-between text-sm">
							<span class="text-muted-foreground">{{ __("Points Redeemed") }}</span>
							<span class="text-foreground">{{ invoice.redeem_loyalty_points }}</span>
						</div>
					</div>
				</div>

				<div v-if="invoice.remarks" class="space-y-2">
					<h3 class="text-sm font-semibold text-foreground">{{ __("Remarks") }}</h3>
					<div class="rounded-lg border border-border p-4 text-sm text-muted-foreground">
						{{ invoice.remarks }}
					</div>
				</div>
			</div>

			<DialogFooter class="p-6 pt-4 border-t border-border gap-2 sm:gap-2">
				<Button
					v-if="hasPermission('allow_reprint_invoice')"
					variant="outline"
					size="sm"
					@click="printInvoice(invoice!.name)"
				>
					<Printer class="w-4 h-4" />
					{{ __("Print") }}
				</Button>
				<Button
					v-if="invoice && !invoice.is_return"
					variant="outline"
					size="sm"
					class="text-blue-600 border-blue-300 hover:bg-blue-50 dark:hover:bg-blue-950"
					:disabled="isRepeatLoading"
					@click="repeatFromOrder(invoice)"
				>
					<Loader2 v-if="isRepeatLoading" class="w-4 h-4 animate-spin" />
					<Repeat v-else class="w-4 h-4" />
					{{ __("Repeat") }}
				</Button>
				<Button
					v-if="invoice && !invoice.is_return && invoice.status !== 'Cancelled'"
					variant="outline"
					size="sm"
					class="text-amber-600 border-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950"
					@click="returnFromOrder(invoice)"
				>
					<RotateCcw class="w-4 h-4" />
					{{ __("Return") }}
				</Button>
				<div class="flex-1"></div>
				<Button size="sm" @click="emit('close')">{{ __("Close") }}</Button>
			</DialogFooter>
		</DialogScrollContent>
	</Dialog>
</template>

<script setup lang="ts">
import { RotateCcw, Printer, Repeat, Loader2 } from "lucide-vue-next";
import {
	Dialog,
	DialogContent as DialogScrollContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { hasPermission } from "@/services/userRights";
import { DateTimePicker } from "@/components/ui/datetime-picker";
import { usePosStore } from "@/stores/posStore";
import { useMoney } from "@/composables/useMoney";
import { useCartStore } from "@/stores/cartStore";
import __ from "@/lib/translate";
import { ref } from "vue";
import { Invoice } from "@/types/pos.types";
import { useRouter } from "vue-router";
import { call, showError } from "@/services/api";
import { usePrintInvoice } from "@/composables/usePrintInvoice";
import { Badge } from "../ui/badge";

const props = defineProps<{
	invoice: Invoice | null;
}>();

const emit = defineEmits<{ close: [] }>();

const posStore = usePosStore();
const { openInvoicePrintView } = usePrintInvoice();
const { money, amount, qty, percent } = useMoney();
const cartStore = useCartStore();
const router = useRouter();

const isRepeatLoading = ref(false);

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

function orderDateTime(order: Invoice): string {
	const date = order.posting_date || "";
	const time = order.posting_time ? String(order.posting_time) : "00:00:00";
	if (!date) return "";
	return `${date} ${time}`;
}

function printInvoice(name: string) {
	void openInvoicePrintView(name);
}

async function repeatFromOrder(order: Invoice) {
	isRepeatLoading.value = true;
	try {
		const result = await call<{
			name: string;
			customer: string;
			customer_name: string;
			items: Array<{
				item_code: string;
				item_name: string;
				qty: number;
				rate: number;
				uom: string;
				stock_uom?: string;
				discount_percentage?: number;
				discount_amount?: number;
				serial_no?: string;
				batch_no?: string;
			}>;
		}>("xpos.api.invoices.get_invoice_for_repeat", {
			invoice_name: order.name,
			pos_profile: posStore.profileName,
		});

		if (!result || !result.items || result.items.length === 0) {
			showError(__("No items found in this invoice"));
			return;
		}

		cartStore.loadFromInvoice({
			customer: result.customer,
			customer_name: result.customer_name,
			items: result.items,
		});

		emit("close");
		router.push("/pos");
	} catch (error) {
		console.error("Error repeating order:", error);
		showError(__("Failed to repeat invoice"));
	} finally {
		isRepeatLoading.value = false;
	}
}

async function returnFromOrder(order: Invoice) {
	emit("close");

	try {
		const details = await call<{
			items: Array<{
				item_code: string;
				item_name: string;
				rate: number;
				qty: number;
				uom: string;
				stock_uom: string;
				serial_no?: string;
				batch_no?: string;
				remaining_returnable_qty?: number;
			}>;
		}>("xpos.api.invoices.get_invoice_for_return", {
			doctype: posStore.invoiceType,
			invoice_name: order.name,
		});

		cartStore.clearCart();
		const allowedItemCodes = (details?.items || []).map((i) => i.item_code);
		cartStore.enterReturnMode(order.name, allowedItemCodes);
		cartStore.setCustomer({
			name: order.customer || order.customer_name || "",
			customer_name: order.customer_name,
		});

		if (details?.items) {
			for (const item of details.items) {
				const returnQty = item.remaining_returnable_qty ?? item.qty;
				if (returnQty > 0) {
					cartStore.addItemWithDetails(
						{
							item_code: item.item_code,
							item_name: item.item_name,
							rate: item.rate,
							uom: item.uom,
							stock_uom: item.stock_uom || item.uom,
						},
						returnQty,
						item.rate,
						item.uom,
						item.serial_no,
						item.batch_no,
					);
				}
			}
		}

		router.push("/pos");
	} catch (error) {
		console.error("Error preparing return:", error);
	}
}
</script>
