<template>
	<div class="h-full min-h-0">
		<ListView
			:key="browserListKey"
			:title="__('Expenses')"
			doctype="POS Cash Movement"
			:fields="browserFields"
			:base-filters="browserBaseFilters"
			default-order-by="posting_date desc, creation desc"
			:default-page-size="20"
			empty-title="No expenses found"
			:empty-description="emptyDescription"
			:empty-icon="Receipt"
			item-key="name"
		>
			<template #header-actions>
				<Button size="sm" @click="openForm" :disabled="!canAddExpense">
					<Plus class="w-4 h-4 me-1" />
					{{ __("New Expense") }}
				</Button>
			</template>

			<template #item="{ item: expense }">
				<Card interactive class="p-3 sm:p-4" @click="openExpenseDetail(expense)">
					<div class="flex items-center gap-2 sm:gap-4">
						<div
							class="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 bg-destructive/10 text-destructive"
						>
							<ArrowDownCircle class="w-4 h-4" />
						</div>
						<div class="min-w-0 flex-1">
							<div class="flex items-center gap-2 mb-1 flex-wrap">
								<span
									class="font-semibold text-foreground text-sm leading-tight min-w-0 wrap-anywhere"
								>
									{{ expenseTitle(expense) }}
								</span>
								<Badge :variant="statusVariant(expense.docstatus)" class="text-[10px]">
									{{ __(statusLabel(expense.docstatus)) }}
								</Badge>
							</div>
							<div
								class="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground"
							>
								<span class="flex items-center gap-1 min-w-0 truncate max-w-30 sm:max-w-none">
									{{ expense.name }}
								</span>
								<span
									v-if="expense.posting_date"
									class="flex items-center gap-1 whitespace-nowrap"
								>
									<CalendarIcon class="h-3 w-3 shrink-0" />
									{{ formatDate(expense.posting_date) }}
								</span>
								<span
									v-if="expense.expense_account"
									class="min-w-0 truncate max-w-40 sm:max-w-none"
								>
									{{ expense.expense_account }}
								</span>
								<span
									v-if="expense.remarks"
									class="hidden sm:inline min-w-0 truncate max-w-70"
								>
									{{ expense.remarks }}
								</span>
							</div>
						</div>

						<div class="text-end shrink-0">
							<div class="font-bold text-base sm:text-lg leading-tight text-destructive">
								{{ money(expense.amount) }}
							</div>
							<div class="text-xs text-muted-foreground whitespace-nowrap">
								{{ __("Expense") }}
							</div>
						</div>

						<Button
							v-if="canDelete(expense)"
							variant="ghost"
							size="icon"
							class="text-destructive h-8 w-8 shrink-0"
							@click.stop="handleDelete(expense.name)"
						>
							<Trash2 class="w-4 h-4" />
						</Button>
					</div>
				</Card>
			</template>
		</ListView>

		<ExpenseFormDialog
			:open="showForm"
			:expense-account-options="expenseAccountOptions"
			:default-expense-account="posStore.defaultPosExpenseAccount"
			:require-remarks="posStore.requireCashMovementRemarks"
			:is-saving="isSaving"
			@update:open="showForm = $event"
			@submit="handleSave"
		/>

		<ExpenseDetailDialog :expense="selectedExpense" @close="selectedExpense = null" />
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
import ExpenseDetailDialog from "@/components/dialogs/ExpenseDetailDialog.vue";
import ExpenseFormDialog from "@/components/dialogs/ExpenseFormDialog.vue";
import { Plus, Trash2, Receipt, ArrowDownCircle, Calendar as CalendarIcon } from "lucide-vue-next";
import __ from "@/lib/translate";

const posStore = usePosStore();
const { money } = useMoney();
const paymentStore = usePaymentStore();

interface Expense {
	id: number | string;
	name: string;
	expense_account?: string;
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
const selectedExpense = ref<Expense | null>(null);
const browserListKey = ref(0);

const browserFields = [
	"name",
	"posting_date",
	"expense_account",
	"remarks",
	"amount",
	"docstatus",
	"company",
	"pos_profile",
	"user",
	"creation",
];

const browserBaseFilters = computed(() => ({
	movement_type: "Expense",
	pos_opening_shift: posStore.posOpeningShift?.name || "__missing_shift__",
}));

const emptyDescription = computed(() =>
	posStore.posOpeningShift?.name ? __("Try adjusting your filters") : __("Open a shift to view expenses"),
);

const canAddExpense = computed(() => hasPermission("expense") && posStore.allowPosExpense);

const expenseAccountOptions = computed(() => {
	const ctx = paymentStore.cashMovementContext;
	if (ctx?.expense_accounts) {
		return ctx.expense_accounts.map((account) => ({
			label: account.account,
			value: account.account,
		}));
	}
	return [];
});

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

function expenseTitle(expense: Expense) {
	return expense.remarks?.trim() || expense.expense_account || expense.to_account || __("Expense");
}

function canDelete(expense: Expense) {
	return expense.docstatus === 0 || !!expense.can_delete;
}

function openForm() {
	showForm.value = true;
}

function openExpenseDetail(expense: Expense | Record<string, unknown>) {
	selectedExpense.value = normalizeExpense(expense);
}

function refreshBrowserList() {
	browserListKey.value += 1;
}

function normalizeExpense(row: Record<string, unknown> | Expense): Expense {
	const record = row as Record<string, unknown>;
	const name = String(record.name || record.id || "");
	return {
		id: String(record.id || name),
		name,
		expense_account: String(record.expense_account || record.to_account || "") || undefined,
		to_account: String(record.to_account || record.expense_account || "") || undefined,
		amount: Number(record.amount || 0),
		remarks: String(record.remarks || "") || undefined,
		posting_date: String(record.posting_date || "") || undefined,
		docstatus: Number(record.docstatus || 0),
		can_delete: Boolean(record.can_delete ?? Number(record.docstatus || 0) < 2),
		company: String(record.company || "") || undefined,
		pos_profile: String(record.pos_profile || "") || undefined,
		user: String(record.user || "") || undefined,
		movement_type: String(record.movement_type || "Expense") || undefined,
		creation: String(record.creation || "") || undefined,
	};
}

async function handleSave(values: { expense_account: string; amount: number; reason: string }) {
	isSaving.value = true;
	try {
		await paymentStore.createPosExpense({
			pos_profile: posStore.profileName,
			company: posStore.companyName,
			expense_account: values.expense_account,
			amount: values.amount,
			reason: values.reason,
			pos_opening_shift: posStore.posOpeningShift?.name || "",
		});

		showSuccess(__("POS expense recorded"));
		showForm.value = false;
		refreshBrowserList();
	} catch (error) {
		showError(__("Failed to record expense"));
		console.error("Failed to save expense", error);
	} finally {
		isSaving.value = false;
	}
}

async function handleDelete(id: number | string) {
	try {
		await call("frappe.client.cancel", { doctype: "POS Cash Movement", name: String(id) });
		showSuccess(__("Expense cancelled"));
		refreshBrowserList();
	} catch (error) {
		showError(__("Failed to cancel expense"));
		console.error("Failed to cancel expense:", error);
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
