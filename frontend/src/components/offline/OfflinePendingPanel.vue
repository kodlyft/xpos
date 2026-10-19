<template>
	<Dialog
		:open="open"
		@update:open="
			(val: boolean) => {
				if (!val) emit('close');
			}
		"
	>
		<DialogContent class="max-w-lg max-h-[80vh] flex flex-col p-0 gap-0" :hide-close="true">
			<DialogHeader
				class="shrink-0 flex-row items-center justify-between space-y-0 px-5 py-3 border-b border-border"
			>
				<div class="flex items-center gap-3">
					<div
						class="w-8 h-8 rounded-lg flex items-center justify-center shadow-sm"
						:class="
							offlineStore.isOnline
								? 'bg-linear-to-br from-emerald-500 to-emerald-600'
								: 'bg-linear-to-br from-red-500 to-red-600'
						"
					>
						<WifiOff v-if="!offlineStore.isOnline" class="w-4 h-4 text-white" />
						<Wifi v-else class="w-4 h-4 text-white" />
					</div>
					<div>
						<DialogTitle class="text-base">{{ __("Offline Invoices") }}</DialogTitle>
						<DialogDescription class="text-xs">
							{{ offlineStore.isOnline ? __("Online") : __("Offline") }} &mdash;
							{{ offlineStore.pendingCount }} {{ __("") }}
						</DialogDescription>
					</div>
				</div>
				<Button variant="ghost" size="icon-sm" @click="emit('close')">
					<X class="w-5 h-5" />
				</Button>
			</DialogHeader>

			<div class="flex-1 overflow-y-auto p-4 space-y-3">
				<div v-if="offlineStore.pendingCount > 0" class="flex gap-2">
					<Button
						variant="default"
						size="sm"
						class="flex-1 gap-1.5"
						:disabled="!offlineStore.isOnline || offlineStore.isSyncing"
						@click="offlineStore.syncPendingInvoices()"
					>
						<Loader2 v-if="offlineStore.isSyncing" class="w-4 h-4 animate-spin" />
						<CloudUpload v-else class="w-4 h-4" />
						{{ __("Sync All") }} ({{ offlineStore.pendingCount }})
					</Button>
					<Button
						v-if="posStore.allowDeleteOfflineInvoice"
						variant="destructive"
						size="sm"
						class="gap-1.5"
						@click="confirmClearAll"
					>
						<Trash2 class="w-4 h-4" />
						{{ __("Clear All") }}
					</Button>
				</div>
				<p
					v-if="offlineStore.pendingCount > 0 && !posStore.allowDeleteOfflineInvoice"
					class="text-xs text-muted-foreground"
				>
					{{ __("Deleting offline invoices is disabled for this POS Profile.") }}
				</p>
				<div
					v-if="offlineStore.pendingInvoices.length === 0"
					class="flex flex-col items-center justify-center py-10 text-muted-foreground"
				>
					<CheckCircle2 class="w-12 h-12 mb-3 text-emerald-400" />
					<p class="text-sm font-medium">{{ __("All caught up") }}!</p>
					<p class="text-xs mt-1">{{ __("No pending offline invoices.") }}</p>
				</div>

				<div
					v-for="inv in offlineStore.pendingInvoices"
					:key="inv.id"
					class="rounded-xl border border-border bg-card p-3 space-y-2"
					:class="isDraft(inv) ? 'border-amber-300 dark:border-amber-700' : ''"
				>
					<div class="flex items-center justify-between">
						<div>
							<p class="text-sm font-medium">
								{{ inv.customer_name || __("Unknown Customer") }}
							</p>
							<p class="text-xs text-muted-foreground">
								{{ formatTime(inv.created_at) }}
							</p>
						</div>
						<div class="text-end">
							<p class="text-sm font-bold">
								{{ money(inv.grand_total) }}
							</p>
							<Badge :variant="statusVariant(inv.status)" class="text-[10px]">
								{{ statusLabel(inv.status) }}
							</Badge>
							<Badge
								v-if="isDraft(inv)"
								variant="outline"
								class="text-[10px] text-amber-600 border-amber-400"
							>
								{{ __("Draft") }}
							</Badge>
						</div>
					</div>

					<p class="text-xs text-muted-foreground">
						{{ getItemCount(inv.data) }} item(s) &bull;
						{{ getPaymentMethods(inv.data) }}
					</p>

					<p v-if="inv.error" class="text-xs text-destructive">Error: {{ inv.error }}</p>

					<div v-if="inv.status === 'needs_review' && inv.review" class="text-xs space-y-0.5">
						<p class="font-medium">
							{{
								__("Server price total: {0}", [
									money(inv.review.rounded_total || inv.review.grand_total),
								])
							}}
						</p>
						<p
							v-for="change in inv.review.lines"
							:key="change.index"
							class="text-muted-foreground"
						>
							{{ change.item_code }}: {{ money(change.quoted_rate) }} &rarr;
							{{ change.rate === null ? __("removed") : money(change.rate) }}
						</p>
						<p v-if="inv.review.offer_conflict" class="text-muted-foreground">
							{{
								__(
									"A pricing rule sets the invoice discount, which replaces this sale's POS Offer discounts. It can only be posted at the new prices.",
								)
							}}
						</p>
					</div>

					<div v-if="inv.status === 'fiscal_uncertain' && inv.fiscal" class="text-xs space-y-1.5">
						<p class="text-muted-foreground">
							{{
								__(
									"Look up sale {0} in FBR's records. If it is there, enter its fiscal number. If it is not, record that and it is sent to FBR again.",
									[inv.fiscal.usin || inv.local_id || ""],
								)
							}}
						</p>
						<template v-if="canResolveFiscal">
							<input
								v-model="fiscalNumbers[inv.id!]"
								class="w-full rounded-md border bg-background px-2 py-1 text-xs"
								:placeholder="__('FBR fiscal number')"
								:aria-label="__('FBR fiscal number')"
							/>
							<textarea
								v-model="fiscalEvidence[inv.id!]"
								rows="2"
								class="w-full rounded-md border bg-background px-2 py-1 text-xs"
								:placeholder="__('Where you checked and what you found')"
								:aria-label="__('Where you checked and what you found')"
							/>
						</template>
						<p v-else class="text-muted-foreground">
							{{ __("A supervisor with Resolve FBR Check records the result.") }}
						</p>
					</div>

					<div class="flex gap-2 pt-1">
						<template v-if="inv.status === 'fiscal_uncertain' && inv.fiscal">
							<template v-if="canResolveFiscal">
								<Button
									variant="default"
									size="sm"
									class="flex-1 text-xs"
									:disabled="
										!offlineStore.isOnline ||
										!fiscalNumbers[inv.id!]?.trim() ||
										!hasEvidence(inv.id)
									"
									@click="resolveFiscal(inv.id, true)"
								>
									{{ __("Recorded: save fiscal number") }}
								</Button>
								<Button
									variant="outline"
									size="sm"
									class="flex-1 text-xs"
									:disabled="!offlineStore.isOnline || !hasEvidence(inv.id)"
									@click="resolveFiscal(inv.id, false)"
								>
									{{ __("Not in FBR records: send again") }}
								</Button>
							</template>
							<Button
								v-else
								variant="outline"
								size="sm"
								class="flex-1 text-xs"
								:disabled="!offlineStore.isOnline"
								@click="inv.id && offlineStore.recheckFiscalSale(inv.id)"
							>
								{{ __("Check again") }}
							</Button>
						</template>
						<Button
							v-else-if="isDraft(inv)"
							variant="default"
							size="sm"
							class="flex-1 gap-1 text-xs bg-amber-500 hover:bg-amber-600"
							@click="inv.id && loadToCart(inv)"
						>
							<ShoppingCart class="w-3.5 h-3.5" />
							{{ __("Load to Cart") }}
						</Button>
						<template v-else-if="inv.status === 'needs_review'">
							<Button
								variant="default"
								size="sm"
								class="flex-1 text-xs"
								:disabled="!offlineStore.isOnline || offlineStore.isSyncing"
								@click="inv.id && offlineStore.resolveReview(inv.id, false)"
							>
								{{ __("Post at new prices") }}
							</Button>
							<Button
								v-if="hasPermission('allow_change_price') && !inv.review?.offer_conflict"
								variant="outline"
								size="sm"
								class="flex-1 text-xs"
								:disabled="!offlineStore.isOnline || offlineStore.isSyncing"
								@click="inv.id && offlineStore.resolveReview(inv.id, true)"
							>
								{{ __("Keep charged prices") }}
							</Button>
						</template>
						<Button
							v-else-if="inv.status === 'dead_letter'"
							variant="outline"
							size="sm"
							class="flex-1 gap-1 text-xs border-destructive text-destructive"
							:disabled="!offlineStore.isOnline || offlineStore.isSyncing"
							@click="inv.id && requeue(inv.id)"
						>
							<RefreshCw class="w-3.5 h-3.5" />
							{{ __("Requeue") }}
						</Button>
						<Button
							v-else
							variant="outline"
							size="sm"
							class="flex-1 gap-1 text-xs"
							:disabled="!offlineStore.isOnline || offlineStore.isSyncing"
							@click="inv.id && offlineStore.retrySingle(inv.id)"
						>
							<RefreshCw class="w-3.5 h-3.5" />
							{{ __("Retry") }}
						</Button>
						<Button
							v-if="posStore.allowDeleteOfflineInvoice && inv.status !== 'fiscal_uncertain'"
							variant="ghost"
							size="sm"
							class="text-destructive gap-1 text-xs"
							@click="inv.id && offlineStore.deletePending(inv.id)"
						>
							<Trash2 class="w-3.5 h-3.5" />
							{{ __("Delete") }}
						</Button>
					</div>
				</div>

				<p v-if="offlineStore.lastSyncTime" class="text-xs text-center text-muted-foreground pt-2">
					{{ __("Last sync") }}: {{ formatTime(offlineStore.lastSyncTime) }}
				</p>
			</div>
		</DialogContent>
	</Dialog>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive } from "vue";
import { useOfflineStore } from "@/stores/offlineStore";
import { usePosStore } from "@/stores/posStore";
import { useMoney } from "@/composables/useMoney";
import { useCartStore } from "@/stores/cartStore";
import { showSuccess, showError } from "@/services/api";
import { hasPermission } from "@/services/userRights";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
	X,
	Wifi,
	WifiOff,
	CloudUpload,
	Loader2,
	Trash2,
	CheckCircle2,
	RefreshCw,
	ShoppingCart,
} from "lucide-vue-next";
import __ from "@/lib/translate";

defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const offlineStore = useOfflineStore();
const fiscalNumbers = reactive<Record<number, string>>({});
const fiscalEvidence = reactive<Record<number, string>>({});
const canResolveFiscal = computed(() => hasPermission("resolve_fiscal_check"));

function hasEvidence(id: number | undefined) {
	return !!id && (fiscalEvidence[id]?.trim().length ?? 0) >= 10;
}

function resolveFiscal(id: number | undefined, recorded: boolean) {
	if (!id || !hasEvidence(id)) return;
	const number = recorded ? fiscalNumbers[id]?.trim() : null;
	if (recorded && !number) return;
	offlineStore.resolveFiscalCheck(id, number || null, fiscalEvidence[id].trim());
}
const posStore = usePosStore();
const { money } = useMoney();
const cartStore = useCartStore();

onMounted(() => {
	offlineStore.loadPendingInvoices();
});

async function requeue(id: number) {
	const ok = await offlineStore.retryDeadLetterInvoice(id);
	if (ok) {
		showSuccess(__("Invoice requeued for sync"));
	} else {
		showError(__("Failed to requeue invoice"));
	}
}

function isDraft(inv: (typeof offlineStore.pendingInvoices)[number]): boolean {
	const d = inv.data as Record<string, unknown> | null | undefined;
	return !!(d && d.is_draft);
}

async function loadToCart(inv: (typeof offlineStore.pendingInvoices)[number]) {
	try {
		const data = inv.data as {
			customer: string;
			customer_name?: string;
			items: Array<{
				item_code: string;
				item_name: string;
				local_item_name?: string;
				qty: number;
				rate: number;
				uom: string;
				stock_uom?: string;
				discount_percentage?: number;
				discount_amount?: number;
				serial_no?: string;
				batch_no?: string;
			}>;
		};
		cartStore.loadFromInvoice({
			customer: data.customer,
			customer_name: data.customer_name || data.customer,
			items: data.items || [],
		});
		if (inv.id) await offlineStore.consumePending(inv.id);
		showSuccess(__("Draft loaded into cart"));
		emit("close");
	} catch (e) {
		showError(__("Failed to load draft into cart"));
	}
}

function statusVariant(status: string) {
	if (status === "pending") return "secondary" as const;
	if (status === "syncing") return "default" as const;
	if (
		status === "failed" ||
		status === "dead_letter" ||
		status === "needs_review" ||
		status === "fiscal_uncertain"
	)
		return "destructive" as const;
	return "secondary" as const;
}

function statusLabel(status: string): string {
	if (status === "dead_letter") return __("Needs attention");
	if (status === "needs_review") return __("Price review");
	if (status === "fiscal_uncertain") return __("FBR check");
	return status;
}

function formatTime(isoString: string) {
	try {
		const d = new Date(isoString);
		return d.toLocaleString(undefined, {
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		});
	} catch {
		return isoString;
	}
}

function getItemCount(data: unknown): number {
	if (data && typeof data === "object" && "items" in data) {
		const items = (data as { items?: unknown[] }).items;
		return Array.isArray(items) ? items.length : 0;
	}
	return 0;
}

function getPaymentMethods(data: unknown): string {
	if (data && typeof data === "object" && "payments" in data) {
		const payments = (data as { payments?: { mode_of_payment?: string }[] }).payments;
		if (Array.isArray(payments)) {
			return (
				payments
					.map((p) => p.mode_of_payment)
					.filter(Boolean)
					.join(", ") || "N/A"
			);
		}
	}
	return "N/A";
}

function confirmClearAll() {
	if (confirm(__("Delete all pending offline invoices? This cannot be undone."))) {
		offlineStore.clearAll();
	}
}
</script>
