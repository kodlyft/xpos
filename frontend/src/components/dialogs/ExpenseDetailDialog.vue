<template>
	<Dialog
		:open="!!expense"
		@update:open="
			(value: boolean) => {
				if (!value) emit('close');
			}
		"
	>
		<DialogContent class="sm:max-w-lg">
			<DialogHeader>
				<div class="flex items-start gap-3">
					<div
						class="w-9 h-9 rounded-lg flex items-center justify-center bg-destructive/10 text-destructive shrink-0"
					>
						<ArrowDownCircle class="w-4 h-4" />
					</div>
					<div class="min-w-0 flex-1">
						<DialogTitle class="text-base flex items-center gap-2 flex-wrap">
							<span class="min-w-0 truncate">{{ expenseTitle }}</span>
							<Badge
								v-if="expense"
								:variant="statusVariant(expense.docstatus)"
								class="text-[10px]"
							>
								{{ __(statusLabel(expense.docstatus)) }}
							</Badge>
						</DialogTitle>
						<DialogDescription>{{ expense?.name }}</DialogDescription>
					</div>
				</div>
			</DialogHeader>

			<div v-if="expense" class="space-y-5">
				<div class="rounded-lg border border-border p-4 bg-muted/20">
					<div class="text-xs text-muted-foreground uppercase tracking-wide mb-1">
						{{ __("Amount") }}
					</div>
					<div class="text-2xl font-bold text-destructive">
						{{ money(expense.amount) }}
					</div>
				</div>

				<div class="grid grid-cols-2 sm:grid-cols-3 gap-4">
					<div class="space-y-1">
						<span class="text-xs text-muted-foreground uppercase tracking-wide">
							{{ __("Posting Date") }}
						</span>
						<p class="font-medium text-foreground">{{ formatDate(expense.posting_date) }}</p>
					</div>
					<div class="space-y-1">
						<span class="text-xs text-muted-foreground uppercase tracking-wide">
							{{ __("Expense Account") }}
						</span>
						<p class="font-medium text-foreground wrap-break-word">
							{{ expense.expense_account || expense.to_account || "-" }}
						</p>
					</div>
					<div class="space-y-1">
						<span class="text-xs text-muted-foreground uppercase tracking-wide">
							{{ __("Reference") }}
						</span>
						<p class="font-medium text-foreground break-all">{{ expense.name }}</p>
					</div>
					<div v-if="expense.company" class="space-y-1">
						<span class="text-xs text-muted-foreground uppercase tracking-wide">
							{{ __("Company") }}
						</span>
						<p class="font-medium text-foreground wrap-break-word">{{ expense.company }}</p>
					</div>
					<div v-if="expense.pos_profile" class="space-y-1">
						<span class="text-xs text-muted-foreground uppercase tracking-wide">
							{{ __("POS Profile") }}
						</span>
						<p class="font-medium text-foreground wrap-break-word">{{ expense.pos_profile }}</p>
					</div>
					<div v-if="expense.user" class="space-y-1">
						<span class="text-xs text-muted-foreground uppercase tracking-wide">
							{{ __("User") }}
						</span>
						<p class="font-medium text-foreground wrap-break-word">{{ expense.user }}</p>
					</div>
				</div>

				<div v-if="expense.remarks" class="space-y-1">
					<span class="text-xs text-muted-foreground uppercase tracking-wide">
						{{ __("Reason / Notes") }}
					</span>
					<p class="text-sm text-foreground whitespace-pre-wrap wrap-break-word">
						{{ expense.remarks }}
					</p>
				</div>
			</div>
		</DialogContent>
	</Dialog>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useMoney } from "@/composables/useMoney";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ArrowDownCircle } from "lucide-vue-next";
import __ from "@/lib/translate";

interface ExpenseDetail {
	name: string;
	expense_account?: string;
	to_account?: string;
	amount: number;
	remarks?: string;
	posting_date?: string;
	docstatus: number;
	company?: string;
	pos_profile?: string;
	user?: string;
}

const props = defineProps<{
	expense: ExpenseDetail | null;
}>();

const emit = defineEmits<{
	(e: "close"): void;
}>();

const { money } = useMoney();

const expenseTitle = computed(() => {
	if (!props.expense) {
		return "";
	}
	return (
		props.expense.remarks?.trim() ||
		props.expense.expense_account ||
		props.expense.to_account ||
		__("Expense")
	);
});

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

function formatDate(date?: string) {
	if (!date) return "-";
	return new Date(date).toLocaleDateString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
	});
}
</script>
