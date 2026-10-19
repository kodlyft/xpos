<template>
	<div class="h-full min-h-0 flex flex-col">
		<!-- Header -->
		<div class="flex items-center justify-between gap-3 px-4 py-3 border-b border-border/60 shrink-0">
			<div class="flex items-center gap-2 min-w-0">
				<Banknote class="w-5 h-5 text-primary shrink-0" />
				<h1 class="font-semibold text-base sm:text-lg truncate">
					{{ __("Cashier - Unsettled Invoices") }}
				</h1>
				<Badge v-if="invoices.length" variant="secondary" class="shrink-0">
					{{ invoices.length }}
				</Badge>
			</div>
			<div class="flex items-center gap-2 shrink-0">
				<span class="hidden md:inline text-xs text-muted-foreground">
					{{ __("Use ↑ ↓ to navigate, Enter to settle") }}
				</span>
				<Button variant="outline" size="sm" :disabled="isLoading" @click="loadList()">
					<RefreshCw class="w-4 h-4" :class="{ 'animate-spin': isLoading }" />
					<span class="hidden sm:inline">{{ __("Refresh") }}</span>
				</Button>
			</div>
		</div>

		<!-- Feature disabled -->
		<div
			v-if="!posStore.enableCashierSettlement"
			class="flex-1 flex flex-col items-center justify-center text-center p-8 text-muted-foreground"
		>
			<Inbox class="w-12 h-12 mb-3 opacity-40" />
			<p class="font-medium">{{ __("Cashier settlement is disabled") }}</p>
			<p class="text-sm max-w-sm mt-1">
				{{ __('Enable "Enable cashier settlement" in the POS Profile to use this screen.') }}
			</p>
		</div>

		<!-- Not a cashier -->
		<div
			v-else-if="!posStore.isCashier"
			class="flex-1 flex flex-col items-center justify-center text-center p-8 text-muted-foreground"
		>
			<Lock class="w-12 h-12 mb-3 opacity-40" />
			<p class="font-medium">{{ __("You are not a cashier") }}</p>
			<p class="text-sm max-w-sm mt-1">
				{{
					__(
						"Only users marked as cashier in the POS Profile can settle bills. Ask a manager to enable it for you.",
					)
				}}
			</p>
		</div>

		<!-- Empty state -->
		<div
			v-else-if="!invoices.length"
			class="flex-1 flex flex-col items-center justify-center text-center p-8 text-muted-foreground"
		>
			<Inbox class="w-12 h-12 mb-3 opacity-40" />
			<p class="font-medium">{{ __("No unsettled invoices") }}</p>
			<p class="text-sm mt-1">
				{{ __("New invoices from terminals will appear here automatically.") }}
			</p>
		</div>

		<!-- List -->
		<ScrollArea v-else class="flex-1 min-h-0">
			<div class="p-3 sm:p-4 space-y-2">
				<Card
					v-for="(inv, index) in invoices"
					:key="inv.name"
					:ref="(el) => setRowRef(el, index)"
					:data-row-index="index"
					tabindex="-1"
					class="p-3 sm:p-4 cursor-pointer transition-all duration-150 outline-none"
					:class="
						index === highlightedIndex
							? 'border-primary ring-2 ring-primary/40 shadow-md'
							: 'border-border/60 hover:border-primary/40 hover:shadow-sm'
					"
					@click="settle(inv)"
					@mouseenter="highlightedIndex = index"
				>
					<div class="flex items-center gap-2 sm:gap-4">
						<div class="min-w-0 flex-1">
							<div class="flex items-center gap-2 mb-1 flex-wrap">
								<User class="h-3 w-3 shrink-0" />
								<span class="font-semibold text-foreground text-sm leading-tight">
									{{ inv.customer_name || inv.customer }}
								</span>
							</div>
							<div
								class="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground"
							>
								<span class="truncate max-w-35 sm:max-w-none">{{ inv.name }}</span>
								<span class="flex items-center gap-1 whitespace-nowrap">
									<CalendarIcon class="h-3 w-3 shrink-0" />
									{{ formatDate(inv.posting_date) }}
								</span>
								<span
									v-if="inv.posting_time"
									class="flex items-center gap-1 whitespace-nowrap"
								>
									<Clock class="h-3 w-3 shrink-0" />
									{{ formatTime(String(inv.posting_time)) }}
								</span>
								<span v-if="inv.total_qty" class="whitespace-nowrap">
									{{ __("{0} items", [String(inv.total_qty)]) }}
								</span>
							</div>
						</div>
						<div class="text-end shrink-0">
							<div class="font-bold text-foreground text-base sm:text-lg leading-tight">
								{{ money(inv.grand_total) }}
							</div>
						</div>
						<ChevronRight class="w-4 h-4 sm:w-5 sm:h-5 text-muted-foreground/40 shrink-0" />
					</div>
				</Card>
			</div>
		</ScrollArea>
	</div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch, nextTick, type ComponentPublicInstance } from "vue";
import { usePosStore } from "@/stores/posStore";
import { useMoney } from "@/composables/useMoney";
import { useCartStore } from "@/stores/cartStore";
import { call, showError } from "@/services/api";
import { __ } from "@/lib/translate";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
	Banknote,
	RefreshCw,
	Inbox,
	Lock,
	User,
	Clock,
	Calendar as CalendarIcon,
	ChevronRight,
} from "lucide-vue-next";

interface UnsettledInvoice {
	name: string;
	customer: string;
	customer_name?: string;
	posting_date: string;
	posting_time?: string;
	grand_total: number;
	total_qty?: number;
	currency?: string;
}

const REFRESH_INTERVAL_MS = 12000;

const posStore = usePosStore();
const { money } = useMoney();
const cartStore = useCartStore();

const invoices = ref<UnsettledInvoice[]>([]);
const isLoading = ref(false);
const highlightedIndex = ref(0);
const rowRefs = ref<Record<number, HTMLElement>>({});
let refreshTimer: ReturnType<typeof setInterval> | null = null;

function setRowRef(el: Element | ComponentPublicInstance | null, index: number) {
	const node = (el as ComponentPublicInstance)?.$el ?? (el as HTMLElement | null);
	if (node instanceof HTMLElement) {
		rowRefs.value[index] = node;
	} else {
		delete rowRefs.value[index];
	}
}

async function loadList() {
	if (!posStore.enableCashierSettlement || !posStore.isCashier) return;
	// Don't refresh while the cashier is settling an invoice.
	if (cartStore.showPaymentDialog) return;

	isLoading.value = true;
	try {
		const result = await call<UnsettledInvoice[]>("xpos.api.invoices.get_unsettled_invoices", {
			pos_profile: posStore.profileName,
		});
		invoices.value = result || [];
		if (highlightedIndex.value >= invoices.value.length) {
			highlightedIndex.value = Math.max(0, invoices.value.length - 1);
		}
	} catch (error) {
		console.error("Error loading unsettled invoices:", error);
	} finally {
		isLoading.value = false;
	}
}

async function settle(inv: UnsettledInvoice) {
	const ok = await cartStore.loadDraftInvoice(inv.name);
	if (!ok) {
		showError(__("Failed to open invoice for settlement"));
		return;
	}
	cartStore.openPaymentDialog();
}

function scrollHighlightedIntoView() {
	nextTick(() => {
		rowRefs.value[highlightedIndex.value]?.scrollIntoView({ block: "nearest" });
	});
}

function handleKeydown(e: KeyboardEvent) {
	if (!posStore.enableCashierSettlement || !posStore.isCashier) return;
	// Ignore while the payment dialog (or any other dialog) is open or focus is in an input.
	if (cartStore.showPaymentDialog) return;
	const target = document.activeElement;
	const tag = (target?.tagName || "").toLowerCase();
	if (tag === "input" || tag === "textarea" || tag === "select") return;
	if (target?.closest("[role='dialog']")) return;
	if (!invoices.value.length) return;

	if (e.key === "ArrowDown") {
		e.preventDefault();
		highlightedIndex.value = Math.min(highlightedIndex.value + 1, invoices.value.length - 1);
		scrollHighlightedIntoView();
	} else if (e.key === "ArrowUp") {
		e.preventDefault();
		highlightedIndex.value = Math.max(highlightedIndex.value - 1, 0);
		scrollHighlightedIntoView();
	} else if (e.key === "Enter") {
		const inv = invoices.value[highlightedIndex.value];
		if (inv) {
			e.preventDefault();
			settle(inv);
		}
	}
}

// Refresh the list once the cashier finishes (payment dialog closes after a settle).
watch(
	() => cartStore.showPaymentDialog,
	(open, wasOpen) => {
		if (wasOpen && !open) loadList();
	},
);

onMounted(() => {
	loadList();
	refreshTimer = setInterval(loadList, REFRESH_INTERVAL_MS);
	window.addEventListener("keydown", handleKeydown);
});

onUnmounted(() => {
	if (refreshTimer) clearInterval(refreshTimer);
	window.removeEventListener("keydown", handleKeydown);
});

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
</script>
