<template>
	<div class="h-full min-h-0">
		<ListView
			:key="browserListKey"
			:title="__('Bank Drops')"
			doctype="POS Cash Movement"
			:fields="browserFields"
			:base-filters="browserBaseFilters"
			default-order-by="posting_date desc, creation desc"
			:default-page-size="20"
			empty-title="No bank drops found"
			:empty-description="emptyDescription"
			:empty-icon="Landmark"
			item-key="name"
		>
			<template #header-actions>
				<Button size="sm" @click="openForm" :disabled="!canAddBankDrop">
					<Plus class="w-4 h-4 me-1" />
					{{ __("New Bank Drop") }}
				</Button>
			</template>

			<template #item="{ item: drop }">
				<Card interactive class="p-3 sm:p-4" @click="openBankDropDetail(drop)">
					<div class="flex items-center gap-2 sm:gap-4">
						<div
							class="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 bg-success/10 text-success"
						>
							<ArrowUpCircle class="w-4 h-4" />
						</div>
						<div class="min-w-0 flex-1">
							<div class="flex items-center gap-2 mb-1 flex-wrap">
								<span
									class="font-semibold text-foreground text-sm leading-tight min-w-0 wrap-anywhere"
								>
									{{ bankDropTitle(drop) }}
								</span>
								<Badge
									:variant="statusVariant(Number(drop.docstatus || 0))"
									class="text-[10px]"
								>
									{{ __(statusLabel(Number(drop.docstatus || 0))) }}
								</Badge>
							</div>
							<div
								class="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground"
							>
								<span class="flex items-center gap-1 min-w-0 truncate max-w-30 sm:max-w-none">
									{{ drop.name }}
								</span>
								<span
									v-if="drop.posting_date"
									class="flex items-center gap-1 whitespace-nowrap"
								>
									<CalendarIcon class="h-3 w-3 shrink-0" />
									{{ formatDate(String(drop.posting_date)) }}
								</span>
								<span
									v-if="drop.target_account"
									class="min-w-0 truncate max-w-40 sm:max-w-none"
								>
									{{ drop.target_account }}
								</span>
								<span v-if="drop.remarks" class="hidden sm:inline min-w-0 truncate max-w-70">
									{{ drop.remarks }}
								</span>
							</div>
						</div>

						<div class="text-end shrink-0">
							<div class="font-bold text-base sm:text-lg leading-tight text-success">
								{{ money(drop.amount) }}
							</div>
							<div class="text-xs text-muted-foreground whitespace-nowrap">
								{{ __("Deposit") }}
							</div>
						</div>

						<Button
							v-if="canDelete(normalizeBankDrop(drop))"
							variant="ghost"
							size="icon"
							class="text-destructive h-8 w-8 shrink-0"
							@click.stop="handleDelete(String(drop.name || drop.id || ''))"
						>
							<Trash2 class="w-4 h-4" />
						</Button>

						<ChevronRight class="w-4 h-4 sm:w-5 sm:h-5 text-muted-foreground/40 shrink-0" />
					</div>
				</Card>
			</template>
		</ListView>

		<Dialog :open="showForm" @update:open="showForm = $event">
			<DialogContent class="sm:max-w-md">
				<DialogHeader>
					<div class="flex items-center gap-2">
						<div
							class="w-8 h-8 rounded-lg flex items-center justify-center bg-success/10 text-success"
						>
							<ArrowUpCircle class="w-4 h-4" />
						</div>
						<div>
							<DialogTitle class="text-base">{{ __("Cash Deposit") }}</DialogTitle>
							<DialogDescription class="text-xs">
								{{ __("Record a cash deposit") }}
							</DialogDescription>
						</div>
					</div>
				</DialogHeader>
				<div class="space-y-4">
					<div>
						<label class="text-sm font-semibold text-foreground mb-1.5 block">
							{{ __("Deposit To") }}
						</label>
						<Select v-model="form.target_account" :items="depositAccountOptions" />
					</div>
					<div>
						<label class="text-sm font-semibold text-foreground mb-1.5 block">
							{{ __("Amount") }}
						</label>
						<NumberInput
							v-model="form.amount"
							:min="0"
							:precision="moneyPrecision"
							class="text-lg font-bold"
							placeholder="0.00"
						/>
					</div>
					<div>
						<label class="text-sm font-semibold text-foreground mb-1.5 block">
							{{ __("Reason / Notes") }}
						</label>
						<textarea
							v-model="form.reason"
							rows="3"
							class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring resize-none"
							:placeholder="__('Enter reason for this transaction...')"
						/>
					</div>
				</div>
				<DialogFooter class="mt-4">
					<Button variant="outline" class="flex-1" @click="showForm = false">
						{{ __("Cancel") }}
					</Button>
					<Button
						class="flex-1 font-bold bg-success hover:bg-success/90 text-success-foreground"
						:disabled="!canSubmit || isSaving"
						@click="handleSave"
					>
						<template v-if="isSaving">
							<Loader2 class="w-4 h-4 animate-spin" />
						</template>
						<template v-else>{{ __("Record Deposit") }}</template>
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>

		<BankDropDetailDialog :bank-drop="selectedBankDrop" @close="selectedBankDrop = null" />
	</div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { usePosStore } from "@/stores/posStore";
import { useMoney } from "@/composables/useMoney";
import { usePaymentStore } from "@/stores/paymentStore";
import { hasPermission } from "@/services/userRights";
import { call, showSuccess, showError } from "@/services/api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import ListView from "@/components/core/ListView.vue";
import BankDropDetailDialog from "@/components/dialogs/BankDropDetailDialog.vue";
import { NumberInput } from "@/components/ui/number-input";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	Plus,
	Trash2,
	Landmark,
	Loader2,
	ArrowUpCircle,
	Calendar as CalendarIcon,
	ChevronRight,
} from "lucide-vue-next";
import __ from "@/lib/translate";
import { Select } from "@/components/ui/select";

const posStore = usePosStore();
const { money, moneyPrecision } = useMoney();
const paymentStore = usePaymentStore();

interface BankDrop {
	id: number | string;
	name: string;
	target_account?: string;
	to_account?: string;
	amount: number;
	remarks?: string;
	posting_date?: string;
	docstatus: number;
	can_delete?: boolean;
	company?: string;
	pos_profile?: string;
	user?: string;
	movement_type?: string;
	creation?: string;
}

const isSaving = ref(false);
const showForm = ref(false);
const selectedBankDrop = ref<BankDrop | null>(null);
const browserListKey = ref(0);

const browserFields = [
	"name",
	"posting_date",
	"target_account",
	"remarks",
	"amount",
	"docstatus",
	"company",
	"pos_profile",
	"user",
	"creation",
];

const browserBaseFilters = computed(() => ({
	movement_type: "Deposit",
	pos_opening_shift: posStore.posOpeningShift?.name || "__missing_shift__",
}));

const emptyDescription = computed(() =>
	posStore.posOpeningShift?.name ? __("Try adjusting your filters") : __("Open a shift to view bank drops"),
);

const canAddBankDrop = computed(() => hasPermission("bank_drop") && posStore.allowCashDeposit);

const form = ref({
	target_account: "",
	amount: 0,
	reason: "",
});

const depositAccountOptions = computed(() => {
	const ctx = paymentStore.cashMovementContext;
	if (ctx?.deposit_accounts) {
		return ctx.deposit_accounts.map((account) => ({
			label: account.name,
			value: account.name,
		}));
	}
	return [];
});

const canSubmit = computed(() => form.value.amount > 0 && form.value.target_account.trim() !== "");

function formatDate(date: string) {
	if (!date) return "";
	return new Date(date).toLocaleDateString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
	});
}

function statusLabel(docstatus: number) {
	return (
		{
			0: "Draft",
			1: "Submitted",
			2: "Cancelled",
		}[Number(docstatus) || 0] || "Unknown"
	);
}

function statusVariant(
	docstatus: number,
): "default" | "success" | "warning" | "destructive" | "secondary" | "outline" {
	const variants: Record<number, "success" | "secondary" | "outline"> = {
		0: "outline",
		1: "success",
		2: "secondary",
	};
	return variants[Number(docstatus) || 0] || "secondary";
}

function bankDropTitle(drop: BankDrop | Record<string, unknown>) {
	const bankDrop = normalizeBankDrop(drop);
	return bankDrop.remarks?.trim() || bankDrop.target_account || bankDrop.to_account || __("Cash Deposit");
}

function canDelete(drop: BankDrop) {
	return drop.docstatus === 0 || !!drop.can_delete;
}

function openForm() {
	form.value = { target_account: "", amount: 0, reason: "" };
	if (posStore.backOfficeCashAccount) {
		const hasDefault = depositAccountOptions.value.some(
			(account) => account.value === posStore.backOfficeCashAccount,
		);
		if (hasDefault) {
			form.value.target_account = posStore.backOfficeCashAccount;
		}
	}
	showForm.value = true;
}

function openBankDropDetail(drop: BankDrop | Record<string, unknown>) {
	selectedBankDrop.value = normalizeBankDrop(drop);
}

function refreshBrowserList() {
	browserListKey.value += 1;
}

function normalizeBankDrop(row: Record<string, unknown> | BankDrop): BankDrop {
	const record = row as Record<string, unknown>;
	const name = String(record.name || record.id || "");
	return {
		id: String(record.id || name),
		name,
		target_account: String(record.target_account || record.to_account || "") || undefined,
		to_account: String(record.to_account || record.target_account || "") || undefined,
		amount: Number(record.amount || 0),
		remarks: String(record.remarks || "") || undefined,
		posting_date: String(record.posting_date || "") || undefined,
		docstatus: Number(record.docstatus || 0),
		can_delete: Boolean(record.can_delete ?? Number(record.docstatus || 0) < 2),
		company: String(record.company || "") || undefined,
		pos_profile: String(record.pos_profile || "") || undefined,
		user: String(record.user || "") || undefined,
		movement_type: String(record.movement_type || "Deposit") || undefined,
		creation: String(record.creation || "") || undefined,
	};
}

async function handleSave() {
	if (!canSubmit.value) return;
	isSaving.value = true;
	try {
		await paymentStore.createCashDeposit({
			pos_profile: posStore.profileName,
			company: posStore.companyName,
			target_account: form.value.target_account,
			amount: form.value.amount,
			reason: form.value.reason,
			pos_opening_shift: posStore.posOpeningShift?.name || "",
		});

		showSuccess(__("Cash deposit recorded"));
		showForm.value = false;
		refreshBrowserList();
	} catch (error) {
		showError(__("Failed to record deposit"));
		console.error("Failed to save bank drop", error);
	} finally {
		isSaving.value = false;
	}
}

async function handleDelete(id: number | string) {
	try {
		await call("frappe.client.cancel", { doctype: "POS Cash Movement", name: String(id) });

		if (selectedBankDrop.value && String(selectedBankDrop.value.id) === String(id)) {
			selectedBankDrop.value = null;
		}

		showSuccess(__("Deposit cancelled"));
		refreshBrowserList();
	} catch (error) {
		showError(__("Failed to cancel deposit"));
		console.error("Failed to cancel bank drop:", error);
	}
}

watch(
	[() => posStore.posOpeningShift?.name, () => posStore.profileName],
	async ([shift, profileName]) => {
		if (shift && profileName) {
			await paymentStore.fetchCashMovementContext(profileName, shift);
		}
	},
	{ immediate: true },
);
</script>
