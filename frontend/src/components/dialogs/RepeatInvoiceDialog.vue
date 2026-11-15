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
					<Repeat class="w-5 h-5 text-info" />
					<DialogTitle class="text-base">{{ __("Repeat Invoice") }}</DialogTitle>
					<Badge variant="outline" class="text-[10px] font-mono">Ctrl+G</Badge>
				</div>
				<DialogDescription class="text-xs">{{
					__("Search and select a past invoice to load into the cart")
				}}</DialogDescription>
			</DialogHeader>

			<div class="flex-1 overflow-y-auto p-5 space-y-4 xpos-scrollbar">
				<div class="relative">
					<Search
						class="absolute inset-s-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground"
					/>
					<Input
						ref="searchInputRef"
						v-model="searchTerm"
						type="text"
						:placeholder="__('Search by invoice number or customer name...')"
						class="ps-9"
						@input="debouncedSearch"
					/>
				</div>
				<div v-if="isSearching" class="flex items-center justify-center py-8">
					<Loader2 class="w-6 h-6 text-primary animate-spin" />
				</div>
				<div v-else-if="invoices.length > 0" class="space-y-2">
					<div class="max-h-80 overflow-y-auto space-y-2 xpos-scrollbar">
						<button
							v-for="inv in invoices"
							:key="inv.name"
							@click="selectInvoice(inv)"
							class="w-full flex items-center justify-between p-3 rounded-lg border border-border hover:border-primary/40 hover:bg-primary/5 transition-all text-start group"
							:disabled="isLoading"
						>
							<div class="flex-1 min-w-0">
								<div class="flex items-center gap-2">
									<FileText
										class="w-4 h-4 text-muted-foreground group-hover:text-primary shrink-0"
									/>
									<span class="font-semibold text-foreground text-sm">{{ inv.name }}</span>
								</div>
								<div class="flex items-center gap-3 mt-1 ms-6 text-xs text-muted-foreground">
									<span>{{ inv.customer_name }}</span>
									<span>&bull;</span>
									<span>{{ inv.posting_date }}</span>
									<span>&bull;</span>
									<span>{{ qty(inv.total_qty) }} items</span>
								</div>
							</div>
							<span class="font-bold text-foreground text-sm shrink-0 ms-3">
								{{ money(inv.grand_total) }}
							</span>
						</button>
					</div>

					<div v-if="hasMore" class="flex justify-center pt-2">
						<Button variant="outline" size="sm" @click="loadMore" :disabled="isSearching">
							<Loader2 v-if="isSearching" class="w-4 h-4 animate-spin" />
							{{ __("Load More") }}
						</Button>
					</div>
				</div>

				<p v-else-if="searchTerm.length >= 2" class="text-center text-sm text-muted-foreground py-8">
					{{ __("No invoices found") }}
				</p>
				<p v-else class="text-center text-sm text-muted-foreground py-8">
					{{ __("Enter an invoice number or customer name to search") }}
				</p>
			</div>
			<DialogFooter class="shrink-0 border-t border-border px-5 py-4">
				<Button variant="outline" class="flex-1" @click="close">{{ __("Cancel") }}</Button>
			</DialogFooter>
		</DialogContent>
	</Dialog>
</template>

<script setup lang="ts">
import { ref, watch, nextTick } from "vue";
import { useCartStore } from "@/stores/cartStore";
import { useCartSessionStore } from "@/stores/cartSessionStore";
import { usePosStore } from "@/stores/posStore";
import { useMoney } from "@/composables/useMoney";
import { call, showError } from "@/services/api";
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
import { Badge } from "@/components/ui/badge";
import { Search, Repeat, FileText, Loader2 } from "lucide-vue-next";
import __ from "@/lib/translate";

interface SearchInvoice {
	name: string;
	customer: string;
	customer_name: string;
	posting_date: string;
	grand_total: number;
	currency: string;
	total_qty: number;
}

interface RepeatItem {
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
}

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: "close"): void }>();

const cartStore = useCartStore();
const cartSessions = useCartSessionStore();
const posStore = usePosStore();
const { money, qty } = useMoney();

const searchInputRef = ref<InstanceType<typeof Input> | null>(null);
const searchTerm = ref("");
const invoices = ref<SearchInvoice[]>([]);
const isSearching = ref(false);
const isLoading = ref(false);
const hasMore = ref(false);
const currentPage = ref(1);

let searchTimeout: ReturnType<typeof setTimeout> | null = null;

watch(
	() => props.open,
	(val) => {
		if (val) {
			nextTick(() => {
				const el = searchInputRef.value?.$el as HTMLElement | undefined;
				if (el) {
					const input = el.tagName === "INPUT" ? el : el.querySelector("input");
					input?.focus();
				}
			});
		}
	},
);

function debouncedSearch() {
	if (searchTimeout) clearTimeout(searchTimeout);
	currentPage.value = 1;
	searchTimeout = setTimeout(() => searchInvoices(), 300);
}

async function searchInvoices() {
	if (searchTerm.value.length < 2) {
		invoices.value = [];
		hasMore.value = false;
		return;
	}
	isSearching.value = true;
	try {
		const result = await call<{ invoices: SearchInvoice[]; has_more: boolean }>(
			"xpos.api.invoices.search_invoices_for_repeat",
			{
				company: posStore.companyName,
				search_term: searchTerm.value,
				pos_profile: posStore.profileName,
				page: currentPage.value,
			},
		);
		if (currentPage.value === 1) {
			invoices.value = result?.invoices || [];
		} else {
			invoices.value.push(...(result?.invoices || []));
		}
		hasMore.value = result?.has_more || false;
	} catch (error) {
		console.error("Error searching invoices:", error);
	} finally {
		isSearching.value = false;
	}
}

function loadMore() {
	currentPage.value++;
	searchInvoices();
}

async function selectInvoice(inv: SearchInvoice) {
	isLoading.value = true;
	try {
		const result = await call<{
			name: string;
			customer: string;
			customer_name: string;
			posting_date: string;
			grand_total: number;
			currency: string;
			items: RepeatItem[];
		}>("xpos.api.invoices.get_invoice_for_repeat", {
			invoice_name: inv.name,
			pos_profile: posStore.profileName,
		});

		if (!result || !result.items || result.items.length === 0) {
			showError("No items found in this invoice");
			return;
		}

		const target = await cartSessions.loadIntoCart(() =>
			cartStore.loadFromInvoice({
				customer: result.customer,
				customer_name: result.customer_name,
				items: result.items,
			}),
		);
		if (!target.ok) {
			showError(target.reason || "");
			return;
		}

		close();
	} catch (error) {
		console.error("Error loading invoice for repeat:", error);
		showError("Failed to load invoice");
	} finally {
		isLoading.value = false;
	}
}

function close() {
	searchTerm.value = "";
	invoices.value = [];
	hasMore.value = false;
	currentPage.value = 1;
	isLoading.value = false;
	emit("close");
}
</script>
