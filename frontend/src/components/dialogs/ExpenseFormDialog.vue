<template>
	<Dialog :open="open" @update:open="handleOpenChange">
		<DialogContent class="sm:max-w-md">
			<DialogHeader>
				<div class="flex items-center gap-2">
					<div
						class="w-8 h-8 rounded-lg flex items-center justify-center bg-destructive/10 text-destructive"
					>
						<ArrowDownCircle class="w-4 h-4" />
					</div>
					<div>
						<DialogTitle class="text-base">{{ __("POS Expense") }}</DialogTitle>
						<DialogDescription class="text-xs">
							{{ __("Record a cash withdrawal") }}
						</DialogDescription>
					</div>
				</div>
			</DialogHeader>
			<div class="space-y-4">
				<div>
					<label class="text-sm font-semibold text-foreground mb-1.5 block">
						{{ __("Expense Account") }}
					</label>
					<Select
						v-model="form.expense_account"
						:items="expenseAccountOptions"
						:placeholder="__('Select expense account')"
					/>
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
				<Button variant="outline" class="flex-1" @click="close">
					{{ __("Cancel") }}
				</Button>
				<Button
					class="flex-1 font-bold bg-destructive hover:bg-destructive/90 text-destructive-foreground"
					:disabled="!canSubmit || isSaving"
					@click="submit"
				>
					<template v-if="isSaving">
						<Loader2 class="w-4 h-4 animate-spin" />
					</template>
					<template v-else>{{ __("Record Expense") }}</template>
				</Button>
			</DialogFooter>
		</DialogContent>
	</Dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { NumberInput } from "@/components/ui/number-input";
import { Select } from "@/components/ui/select";
import __ from "@/lib/translate";
import { useMoney } from "@/composables/useMoney";
import { ArrowDownCircle, Loader2 } from "lucide-vue-next";

interface ExpenseFormValues {
	expense_account: string;
	amount: number;
	reason: string;
}

interface SelectOption {
	label: string;
	value: string;
}

const props = withDefaults(
	defineProps<{
		open: boolean;
		expenseAccountOptions: SelectOption[];
		defaultExpenseAccount?: string;
		requireRemarks?: boolean;
		isSaving?: boolean;
	}>(),
	{
		defaultExpenseAccount: "",
		requireRemarks: false,
		isSaving: false,
	},
);

const emit = defineEmits<{
	(e: "update:open", value: boolean): void;
	(e: "submit", values: ExpenseFormValues): void;
}>();
const { moneyPrecision } = useMoney();

const form = ref<ExpenseFormValues>({
	expense_account: "",
	amount: 0,
	reason: "",
});

const canSubmit = computed(() => {
	if (form.value.amount <= 0) {
		return false;
	}
	if (form.value.expense_account.trim() === "") {
		return false;
	}
	if (props.requireRemarks && form.value.reason.trim() === "") {
		return false;
	}
	return true;
});

watch(
	() => props.open,
	(open) => {
		if (open) {
			resetForm();
		}
	},
);

watch(
	() => [props.open, props.defaultExpenseAccount, props.expenseAccountOptions] as const,
	([open]) => {
		if (!open || form.value.expense_account) {
			return;
		}

		const defaultAccount = resolveDefaultExpenseAccount();
		if (defaultAccount) {
			form.value.expense_account = defaultAccount;
		}
	},
	{ deep: true },
);

function resolveDefaultExpenseAccount() {
	if (!props.defaultExpenseAccount) {
		return "";
	}

	const hasDefaultAccount = props.expenseAccountOptions.some(
		(account) => account.value === props.defaultExpenseAccount,
	);
	return hasDefaultAccount ? props.defaultExpenseAccount : "";
}

function resetForm() {
	form.value = {
		expense_account: resolveDefaultExpenseAccount(),
		amount: 0,
		reason: "",
	};
}

function handleOpenChange(value: boolean) {
	emit("update:open", value);
}

function close() {
	emit("update:open", false);
}

function submit() {
	if (!canSubmit.value || props.isSaving) {
		return;
	}

	emit("submit", {
		expense_account: form.value.expense_account,
		amount: form.value.amount,
		reason: form.value.reason.trim(),
	});
}
</script>
