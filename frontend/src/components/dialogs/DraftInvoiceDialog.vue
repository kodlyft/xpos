<template>
	<Dialog
		:open="cartStore.showDraftDialog"
		@update:open="
			(val: boolean) => {
				if (!val) close();
			}
		"
	>
		<DialogContent class="max-w-3xl max-h-[75vh] flex flex-col p-0 gap-0">
			<DialogHeader class="shrink-0 px-5 pt-5 pb-3 border-b border-border">
				<div class="flex items-center gap-2">
					<div
						class="w-8 h-8 rounded-lg bg-warning/10 text-warning flex items-center justify-center"
					>
						<Clock class="w-4 h-4" />
					</div>
					<div>
						<DialogTitle class="text-base">
							{{ __("Recall Order") }}
						</DialogTitle>
						<DialogDescription class="text-xs">
							{{ __("Restore an open tab, or settle a past unpaid invoice") }}
						</DialogDescription>
					</div>
				</div>

				<div v-if="showUnpaidTab" class="flex items-center gap-1 pt-3" role="tablist">
					<Button
						v-for="tab in tabs"
						:key="tab.value"
						:variant="activeTab === tab.value ? 'default' : 'ghost'"
						size="sm"
						role="tab"
						:aria-selected="activeTab === tab.value"
						:data-testid="`recall-tab-${tab.value}`"
						@click="activeTab = tab.value"
					>
						{{ tab.label }}
					</Button>
				</div>
			</DialogHeader>

			<div class="shrink-0 px-5 pt-4 space-y-3">
				<Input
					v-model="searchTerm"
					:placeholder="
						activeTab === 'tabs'
							? __('Search by invoice or customer')
							: __('Search unpaid invoices')
					"
					data-testid="recall-search"
				/>

				<div
					v-if="activeTab === 'tabs' && posStore.allowOpenTabRecall"
					class="flex items-center gap-1"
				>
					<Button
						v-for="option in scopeOptions"
						:key="option.value"
						:variant="scope === option.value ? 'default' : 'outline'"
						size="sm"
						:data-testid="`recall-scope-${option.value}`"
						@click="setScope(option.value)"
					>
						{{ option.label }}
					</Button>
				</div>
			</div>

			<div class="flex-1 overflow-y-auto p-5 space-y-4 xpos-scrollbar">
				<div v-if="isLoading" class="flex items-center justify-center py-8">
					<Loader2 class="w-6 h-6 text-primary animate-spin" />
				</div>

				<template v-else-if="activeTab === 'tabs'">
					<div
						v-if="!visibleDrafts.length"
						class="flex flex-col items-center justify-center py-12 text-muted-foreground"
					>
						<FileText class="w-12 h-12 mb-3 text-muted-foreground/40" />
						<p class="text-sm font-medium">{{ __("No draft invoices found") }}</p>
						<p class="text-xs mt-1">
							{{
								scope === "profile"
									? __("No open tabs on this POS Profile")
									: __("Save your current order to create a draft")
							}}
						</p>
					</div>

					<div v-else class="space-y-2">
						<div
							v-for="draft in visibleDrafts"
							:key="draft.name"
							class="p-3 rounded-lg border border-border hover:border-primary/30 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus group"
							data-testid="open-tab-row"
							role="button"
							tabindex="0"
							@click="selectDraft(draft)"
							@keydown.self.enter.prevent="selectDraft(draft)"
							@keydown.self.space.prevent="selectDraft(draft)"
						>
							<div class="flex items-start justify-between">
								<div class="flex-1 min-w-0">
									<div class="flex items-center gap-2 mb-1 flex-wrap">
										<h3 class="text-sm font-medium text-foreground truncate">
											{{ draft.name }}
										</h3>
										<Badge variant="destructive" class="text-xs">
											{{ __("Draft") }}
										</Badge>
										<Badge
											v-if="isForeignTab(draft)"
											variant="outline"
											class="text-xs"
											data-testid="foreign-tab-badge"
										>
											{{ ownerLabel(draft) }}
										</Badge>
										<Badge
											v-if="draft.pos_awaiting_settlement"
											variant="secondary"
											class="text-xs"
										>
											{{ __("Sent to cashier") }}
										</Badge>
									</div>

									<div class="flex items-center gap-4 text-xs text-muted-foreground mb-2">
										<span class="flex items-center gap-1">
											<User class="w-3 h-3" />
											{{
												draft.customer_name ||
												draft.customer ||
												__("Walk-in Customer")
											}}
										</span>
										<span class="flex items-center gap-1">
											<Calendar class="w-3 h-3" />
											{{ formatDateTime(draft.creation) }}
										</span>
									</div>

									<div class="flex items-center gap-4 text-xs">
										<span class="text-muted-foreground">
											{{ plural(draft.total_qty || 0, __("item"), __("items")) }}
										</span>
										<span class="font-medium text-primary">
											{{ money(draft.grand_total || 0) }}
										</span>
										<span
											v-if="Number(draft.paid_amount) > 0"
											class="text-muted-foreground"
										>
											{{ __("Paid") }}: {{ money(draft.paid_amount || 0) }}
										</span>
									</div>
								</div>

								<div class="ms-3 flex items-center gap-2">
									<TooltipWrapper :content="__('Delete draft')">
										<Button
											variant="ghost"
											size="icon-sm"
											class="opacity-0 group-hover:opacity-100 text-destructive hover:text-destructive"
											@click.stop="deleteDraft(draft.name)"
										>
											<Trash2 class="w-3.5 h-3.5" />
										</Button>
									</TooltipWrapper>
									<Button
										variant="ghost"
										size="icon-sm"
										class="opacity-0 group-hover:opacity-100"
										@click.stop="selectDraft(draft)"
									>
										<ArrowRight class="w-3.5 h-3.5" />
									</Button>
								</div>
							</div>
						</div>
					</div>
				</template>

				<template v-else>
					<div
						v-if="!outstanding.length"
						class="flex flex-col items-center justify-center py-12 text-muted-foreground"
					>
						<Receipt class="w-12 h-12 mb-3 text-muted-foreground/40" />
						<p class="text-sm font-medium">{{ __("No unpaid invoices found") }}</p>
						<p class="text-xs mt-1">{{ __("Every submitted invoice is settled") }}</p>
					</div>

					<div v-else class="space-y-2">
						<div
							v-for="invoice in outstanding"
							:key="invoice.name"
							class="p-3 rounded-lg border border-border hover:border-primary/30 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
							data-testid="unpaid-invoice-row"
							role="button"
							tabindex="0"
							@click="selectedOutstanding = invoice"
							@keydown.self.enter.prevent="selectedOutstanding = invoice"
							@keydown.self.space.prevent="selectedOutstanding = invoice"
						>
							<div class="flex items-start justify-between gap-3">
								<div class="flex-1 min-w-0">
									<div class="flex items-center gap-2 mb-1 flex-wrap">
										<h3 class="text-sm font-medium text-foreground truncate">
											{{ invoice.name }}
										</h3>
										<Badge variant="warning" class="text-xs">
											{{ invoice.status || __("Unpaid") }}
										</Badge>
									</div>
									<div class="flex items-center gap-4 text-xs text-muted-foreground">
										<span class="flex items-center gap-1">
											<User class="w-3 h-3" />
											{{ invoice.customer_name || invoice.customer }}
										</span>
										<span class="flex items-center gap-1">
											<Calendar class="w-3 h-3" />
											{{ invoice.posting_date }}
										</span>
									</div>
								</div>

								<div class="text-end shrink-0">
									<div class="text-xs text-muted-foreground">
										{{ money(invoice.grand_total) }}
									</div>
									<div class="text-sm font-semibold text-primary">
										{{ money(invoice.outstanding_amount) }}
									</div>
								</div>
							</div>
						</div>
					</div>
				</template>
			</div>

			<DialogFooter class="shrink-0 border-t border-border px-5 py-4">
				<Button variant="outline" class="flex-1" @click="close">
					{{ __("Cancel") }}
				</Button>
				<Button class="flex-1" @click="refresh" :disabled="isLoading">
					<RefreshCw class="w-4 h-4 me-2" :class="{ 'animate-spin': isLoading }" />
					{{ __("Refresh") }}
				</Button>
			</DialogFooter>
		</DialogContent>
	</Dialog>

	<SettleOutstandingDialog
		:invoice="selectedOutstanding"
		@close="selectedOutstanding = null"
		@settled="onSettled"
	/>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from "vue";
import { useCartStore } from "@/stores/cartStore";
import { useCartSessionStore } from "@/stores/cartSessionStore";
import { usePosStore } from "@/stores/posStore";
import { useMoney } from "@/composables/useMoney";
import { call, showSuccess, showError, showInfo } from "@/services/api";
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
import { Input } from "@/components/ui/input";
import { TooltipWrapper } from "@/components/ui/tooltip";
import SettleOutstandingDialog from "./SettleOutstandingDialog.vue";
import {
	Clock,
	FileText,
	Receipt,
	Loader2,
	User,
	Calendar,
	ArrowRight,
	Trash2,
	RefreshCw,
} from "lucide-vue-next";
import { __ } from "@/lib/translate";
import { debounce } from "@/utils";
import type { OpenTab, OutstandingInvoice } from "@/types/pos.types";

type Scope = "shift" | "profile";
type Tab = "tabs" | "unpaid";

const cartStore = useCartStore();
const cartSessions = useCartSessionStore();
const posStore = usePosStore();
const { money } = useMoney();

const drafts = ref<OpenTab[]>([]);
const outstanding = ref<OutstandingInvoice[]>([]);
const selectedOutstanding = ref<OutstandingInvoice | null>(null);
const isLoading = ref(false);
const scope = ref<Scope>("shift");
const activeTab = ref<Tab>("tabs");
const searchTerm = ref("");

const isDialogOpen = computed(() => cartStore.showDraftDialog);
const showUnpaidTab = computed(() => posStore.allowOutstandingSettlement);

const tabs = computed(() => [
	{ value: "tabs" as const, label: __("Open tabs") },
	{ value: "unpaid" as const, label: __("Unpaid invoices") },
]);

const scopeOptions = computed(() => [
	{ value: "shift" as const, label: __("This shift") },
	{ value: "profile" as const, label: __("All shifts") },
]);

const visibleDrafts = computed(() => {
	const term = searchTerm.value.trim().toLowerCase();
	if (!term) return drafts.value;
	return drafts.value.filter((draft) =>
		[draft.name, draft.customer, draft.customer_name]
			.filter(Boolean)
			.some((field) => String(field).toLowerCase().includes(term)),
	);
});

function isForeignTab(draft: OpenTab): boolean {
	const currentShift = posStore.posOpeningShift?.name;
	return !!draft.pos_opening_shift && !!currentShift && draft.pos_opening_shift !== currentShift;
}

function ownerLabel(draft: OpenTab): string {
	return draft.owner || draft.pos_opening_shift || __("Other shift");
}

watch(isDialogOpen, (open) => {
	if (open) {
		refresh();
	} else {
		searchTerm.value = "";
	}
});

watch(activeTab, () => {
	searchTerm.value = "";
	refresh();
});

const searchOutstandingDebounced = debounce(() => fetchOutstanding(), 300);

watch(searchTerm, () => {
	if (activeTab.value === "unpaid") searchOutstandingDebounced();
});

onMounted(() => {
	if (isDialogOpen.value) {
		refresh();
	}
});

async function refresh() {
	if (activeTab.value === "unpaid") {
		await fetchOutstanding();
	} else {
		await fetchDrafts();
	}
}

function setScope(next: Scope) {
	if (scope.value === next) return;
	scope.value = next;
	fetchDrafts();
}

async function fetchDrafts() {
	isLoading.value = true;
	try {
		drafts.value = await cartStore.fetchDraftInvoices(scope.value);
	} catch (error) {
		console.error("Error fetching drafts:", error);
		showError(__("Failed to fetch draft invoices"));
		drafts.value = [];
	} finally {
		isLoading.value = false;
	}
}

async function fetchOutstanding() {
	isLoading.value = true;
	try {
		const result = await call<OutstandingInvoice[]>("xpos.api.payments.get_outstanding_invoices", {
			pos_profile: posStore.profileName,
			company: posStore.company?.name || "",
			search_term: searchTerm.value.trim(),
			page_length: 50,
		});
		outstanding.value = result || [];
	} catch (error) {
		console.error("Error fetching outstanding invoices:", error);
		showError(__("Failed to fetch unpaid invoices"));
		outstanding.value = [];
	} finally {
		isLoading.value = false;
	}
}

async function selectDraft(draft: OpenTab) {
	try {
		const open = cartSessions.findByDraft(draft.name);
		if (open) {
			cartSessions.switchTo(open);
			showInfo(__("That order is already open in a cart."));
			close();
			return;
		}
		const loadedInto = await cartSessions.loadIntoCart(() => cartStore.loadDraftInvoice(draft.name));
		if (loadedInto.reason) {
			showError(loadedInto.reason);
			return;
		}
		const success = loadedInto.loaded;
		if (success) {
			showSuccess(__("Draft invoice restored to cart"));
			close();
		} else {
			showError(__("Failed to load draft invoice"));
		}
	} catch (error) {
		console.error("Error loading draft:", error);
		showError(__("Failed to load draft invoice"));
	}
}

async function deleteDraft(draftName: string) {
	if (!confirm(__("Are you sure you want to delete this draft?"))) {
		return;
	}

	try {
		await call("xpos.api.invoices.delete_draft_invoice", {
			name: draftName,
			pos_opening_shift: posStore.posOpeningShift?.name || "",
		});
		showSuccess(__("Draft invoice deleted"));
		await fetchDrafts();
	} catch (error) {
		console.error("Error deleting draft:", error);
		showError(__("Failed to delete draft invoice"));
	}
}

function onSettled() {
	selectedOutstanding.value = null;
	fetchOutstanding();
}

function close() {
	cartStore.closeDraftDialog();
}

function formatDateTime(isoString: string | undefined) {
	if (!isoString) return "";
	try {
		return new Intl.DateTimeFormat(undefined, {
			year: "numeric",
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		}).format(new Date(isoString));
	} catch {
		return isoString;
	}
}

function plural(count: number, singular: string, pluralForm: string) {
	return `${count} ${count === 1 ? singular : pluralForm}`;
}
</script>
