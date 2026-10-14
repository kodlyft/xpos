<template>
	<Dialog
		:open="open"
		@update:open="
			(val: boolean) => {
				if (!val) close();
			}
		"
	>
		<DialogContent class="max-w-2xl max-h-[80vh] flex flex-col p-0 gap-0">
			<DialogHeader class="shrink-0 px-5 pt-5 pb-3 border-b border-border">
				<div class="flex items-center gap-2">
					<RotateCcw class="w-5 h-5 text-amber-500" />
					<DialogTitle class="text-base">{{ __("Return Invoice") }}</DialogTitle>
				</div>
				<DialogDescription class="text-xs">{{
					__("Search and select an invoice to return")
				}}</DialogDescription>
			</DialogHeader>

			<div class="flex-1 overflow-y-auto p-5 space-y-4 xpos-scrollbar">
				<div v-if="!selectedInvoice">
					<div class="relative mb-3">
						<Search
							class="absolute inset-s-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground"
						/>
						<Input
							v-model="searchTerm"
							type="text"
							:placeholder="__('Search by invoice number, customer...')"
							class="ps-9"
							@input="debouncedSearch"
						/>
					</div>

					<div v-if="isSearching" class="flex items-center justify-center py-8">
						<Loader2 class="w-6 h-6 text-primary animate-spin" />
					</div>

					<div
						v-else-if="invoices.length > 0"
						class="space-y-2 max-h-60 overflow-y-auto xpos-scrollbar"
					>
						<button
							v-for="inv in invoices"
							:key="inv.name"
							@click="selectInvoice(inv.name)"
							class="w-full flex items-center justify-between p-3 rounded-lg border border-border hover:border-primary/40 transition-all text-start"
						>
							<div>
								<span class="font-semibold text-foreground text-sm">{{ inv.name }}</span>
								<p class="text-xs text-muted-foreground">
									{{ inv.customer_name }} &bull; {{ inv.posting_date }}
								</p>
							</div>
							<span class="font-bold text-foreground text-sm">{{
								money(inv.grand_total)
							}}</span>
						</button>
					</div>

					<p
						v-else-if="searchTerm.length >= 2"
						class="text-center text-sm text-muted-foreground py-8"
					>
						{{ __("No invoices found") }}
					</p>
					<p v-else class="text-center text-sm text-muted-foreground py-8">
						{{ __("Enter an invoice number or customer name to search") }}
					</p>
				</div>

				<div v-else>
					<div class="flex items-center justify-between mb-3">
						<div>
							<h3 class="text-sm font-semibold text-foreground">
								{{ selectedInvoice.name }}
							</h3>
							<p class="text-xs text-muted-foreground">
								{{ selectedInvoice.customer_name }}
							</p>
						</div>
						<Button
							variant="outline"
							size="sm"
							@click="
								selectedInvoice = null;
								returnItems = [];
							"
						>
							<ArrowLeft class="w-4 h-4" />
							{{ __("Back") }}
						</Button>
					</div>

					<div class="border border-border rounded-lg overflow-hidden">
						<div class="overflow-x-auto">
							<table class="w-full text-sm min-w-85">
								<thead class="bg-muted">
									<tr>
										<th class="text-start px-3 py-2 text-muted-foreground font-medium">
											{{ __("Item") }}
										</th>
										<th class="text-center px-3 py-2 text-muted-foreground font-medium">
											{{ __("Sold") }}
										</th>
										<th class="text-center px-3 py-2 text-muted-foreground font-medium">
											{{ __("Return Qty") }}
										</th>
										<th class="text-end px-3 py-2 text-muted-foreground font-medium">
											{{ __("Amount") }}
										</th>
									</tr>
								</thead>
								<tbody>
									<tr
										v-for="(item, idx) in returnItems"
										:key="idx"
										class="border-t border-border"
									>
										<td class="px-3 py-2">
											<p class="font-medium text-foreground">
												{{ item.item_name }}
											</p>
											<p class="text-[11px] text-muted-foreground font-mono">
												{{ item.item_code }}
											</p>
										</td>
										<td class="px-3 py-2 text-center text-muted-foreground">
											{{ item.max_qty }}
										</td>
										<td class="px-3 py-2 text-center">
											<NumberInput
												v-model="item.return_qty"
												:min="0"
												:max="item.max_qty"
												:precision="0"
												class="w-20 text-center text-sm mx-auto"
											/>
										</td>
										<td class="px-3 py-2 text-end font-medium text-foreground">
											{{ money(item.rate * (item.return_qty || 0)) }}
										</td>
									</tr>
								</tbody>
							</table>
						</div>
					</div>
				</div>
			</div>
			<DialogFooter class="shrink-0 border-t border-border px-5 py-4">
				<Button variant="outline" class="flex-1" @click="close">{{ __("Cancel") }}</Button>
				<Button
					v-if="selectedInvoice"
					class="flex-1 font-bold bg-amber-500 hover:bg-amber-600 text-white"
					:disabled="!hasReturnItems"
					@click="processReturn"
				>
					<RotateCcw class="w-4 h-4" />
					{{ __("Process Return") }}
				</Button>
			</DialogFooter>
		</DialogContent>
	</Dialog>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import { useCartStore } from "@/stores/cartStore";
import { usePosStore } from "@/stores/posStore";
import { useMoney } from "@/composables/useMoney";
import { call } from "@/services/api";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Search, RotateCcw, ArrowLeft, Loader2 } from "lucide-vue-next";
import __ from "@/lib/translate";
import type { GiftCardRefund } from "@/types/pos.types";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: "close"): void }>();

const cartStore = useCartStore();
const posStore = usePosStore();
const { money } = useMoney();

interface SearchInvoice {
	name: string;
	customer: string;
	customer_name: string;
	posting_date: string;
	grand_total: number;
}

interface ReturnItem {
	item_code: string;
	item_name: string;
	rate: number;
	uom: string;
	stock_uom: string;
	max_qty: number;
	return_qty: number;
	gift_card?: string;
	serial_no?: string;
	batch_no?: string;
}

const searchTerm = ref("");
const invoices = ref<SearchInvoice[]>([]);
const isSearching = ref(false);
const selectedInvoice = ref<SearchInvoice | null>(null);
const returnItems = ref<ReturnItem[]>([]);
const giftCardRefunds = ref<GiftCardRefund[]>([]);

let searchTimeout: ReturnType<typeof setTimeout> | null = null;

const hasReturnItems = computed(() => returnItems.value.some((i) => i.return_qty > 0));

function debouncedSearch() {
	if (searchTimeout) clearTimeout(searchTimeout);
	searchTimeout = setTimeout(() => searchInvoices(), 300);
}

async function searchInvoices() {
	if (searchTerm.value.length < 2) {
		invoices.value = [];
		return;
	}
	isSearching.value = true;
	try {
		const result = await call<{ invoices: SearchInvoice[]; has_more: boolean }>(
			"xpos.api.invoices.search_invoices_for_return",
			{
				company: posStore.companyName,
				invoice_name: searchTerm.value,
				customer_name: searchTerm.value,
				pos_profile: posStore.profileName,
			},
		);
		invoices.value = result?.invoices || [];
	} catch (error) {
		console.error("Error searching invoices:", error);
	} finally {
		isSearching.value = false;
	}
}

async function selectInvoice(invoiceName: string) {
	const inv = invoices.value.find((i) => i.name === invoiceName);
	if (!inv) return;
	selectedInvoice.value = inv;

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
				amount: number;
				uom: string;
				serial_no?: string;
				batch_no?: string;
				remaining_returnable_qty: number;
				already_returned_qty: number;
				gift_card?: string;
			}>;
			gift_card_refunds?: GiftCardRefund[];
		}>("xpos.api.invoices.get_invoice_for_return", {
			invoice_name: invoiceName,
			pos_profile: posStore.profileName,
		});
		if (result?.customer) {
			selectedInvoice.value = {
				...selectedInvoice.value!,
				customer: result.customer,
				customer_name: result.customer_name || selectedInvoice.value!.customer_name,
			};
		}

		returnItems.value = (result?.items || []).map((item) => ({
			item_code: item.item_code,
			item_name: item.item_name,
			rate: item.rate,
			uom: item.uom,
			stock_uom: item.uom,
			max_qty: item.remaining_returnable_qty,
			return_qty: item.remaining_returnable_qty,
			serial_no: item.serial_no,
			batch_no: item.batch_no,
			gift_card: item.gift_card,
		}));
		giftCardRefunds.value = result?.gift_card_refunds || [];
	} catch (error) {
		console.error("Error fetching invoice for return:", error);
	}
}

function processReturn() {
	if (!selectedInvoice.value || !hasReturnItems.value) return;

	cartStore.clearCart();
	const allowedItemCodes = returnItems.value.map((i) => i.item_code);
	cartStore.enterReturnMode(selectedInvoice.value.name, allowedItemCodes);

	cartStore.setCustomer({
		name: selectedInvoice.value.customer || selectedInvoice.value.customer_name,
		customer_name: selectedInvoice.value.customer_name,
	});

	for (const item of returnItems.value) {
		if (item.return_qty > 0) {
			cartStore.addItemWithDetails(
				{
					item_code: item.item_code,
					item_name: item.item_name,
					rate: item.rate,
					uom: item.uom,
					stock_uom: item.stock_uom || item.uom,
				},
				item.return_qty,
				item.rate,
				item.uom,
				item.serial_no,
				item.batch_no,
			);
			if (item.gift_card) {
				// a returned gift card line must name the card, so the server can void exactly that one
				const line = cartStore.items.findLast((row) => row.item_code === item.item_code);
				if (line) line.gift_card = item.gift_card;
			}
		}
	}
	cartStore.returnGiftCards = giftCardRefunds.value;
	cartStore.setGiftCardTender(
		giftCardRefunds.value.length > 0 || returnItems.value.some((i) => !!i.gift_card),
	);

	close();
}

function close() {
	searchTerm.value = "";
	invoices.value = [];
	selectedInvoice.value = null;
	returnItems.value = [];
	giftCardRefunds.value = [];
	emit("close");
}
</script>
