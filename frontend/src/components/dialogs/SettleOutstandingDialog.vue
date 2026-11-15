<template>
	<Dialog :open="!!invoice" @update:open="(val: boolean) => !val && emit('close')">
		<DialogContent class="max-w-md flex flex-col p-0 gap-0">
			<DialogHeader class="shrink-0 px-5 pt-5 pb-3 border-b border-border">
				<div class="flex items-center gap-2">
					<div
						class="w-8 h-8 rounded-lg bg-success/10 text-success flex items-center justify-center"
					>
						<Banknote class="w-4 h-4" />
					</div>
					<div>
						<DialogTitle class="text-base">{{ __("Settle Invoice") }}</DialogTitle>
						<DialogDescription class="text-xs">
							{{ invoice?.name }}
						</DialogDescription>
					</div>
				</div>
			</DialogHeader>

			<div v-if="invoice" class="p-5 space-y-4">
				<div class="rounded-lg border border-border p-3 space-y-1.5 text-sm">
					<div class="flex items-center justify-between">
						<span class="text-muted-foreground">{{ __("Customer") }}</span>
						<span class="font-medium">{{ invoice.customer_name || invoice.customer }}</span>
					</div>
					<div class="flex items-center justify-between">
						<span class="text-muted-foreground">{{ __("Invoice total") }}</span>
						<span>{{ money(invoice.grand_total) }}</span>
					</div>
					<div class="flex items-center justify-between">
						<span class="text-muted-foreground">{{ __("Outstanding") }}</span>
						<span class="font-semibold text-primary">
							{{ money(invoice.outstanding_amount) }}
						</span>
					</div>
				</div>

				<div>
					<label class="text-sm font-semibold text-foreground mb-1.5 block">
						{{ __("Amount") }}
					</label>
					<NumberInput v-model="amount" data-testid="settle-amount" />
					<p v-if="exceedsOutstanding" class="text-xs text-destructive mt-1.5">
						{{ __("Amount cannot exceed the outstanding balance.") }}
					</p>
				</div>

				<div>
					<label class="text-sm font-semibold text-foreground mb-1.5 block">
						{{ __("Mode of Payment") }}
					</label>
					<Select
						v-model="modeOfPayment"
						:items="modeOptions"
						:placeholder="__('Select mode of payment')"
					/>
				</div>
			</div>

			<DialogFooter class="shrink-0 border-t border-border px-5 py-4">
				<Button variant="outline" class="flex-1" @click="emit('close')">
					{{ __("Cancel") }}
				</Button>
				<Button class="flex-1" :disabled="!canSubmit" data-testid="settle-confirm" @click="submit">
					<Loader2 v-if="isSaving" class="w-4 h-4 me-2 animate-spin" />
					{{ __("Take Payment") }}
				</Button>
			</DialogFooter>
		</DialogContent>
	</Dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { usePosStore } from "@/stores/posStore";
import { useMoney } from "@/composables/useMoney";
import { call, showSuccess, showError } from "@/services/api";
import { extractErrorMessage } from "@/utils";
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
import { Banknote, Loader2 } from "lucide-vue-next";
import { __ } from "@/lib/translate";
import type { OutstandingInvoice } from "@/types/pos.types";

const props = defineProps<{ invoice: OutstandingInvoice | null }>();
const emit = defineEmits<{ (e: "close"): void; (e: "settled"): void }>();

const posStore = usePosStore();
const { money } = useMoney();

const amount = ref(0);
const modeOfPayment = ref("");
const isSaving = ref(false);

const modeOptions = computed(() =>
	(posStore.posProfile?.payments || []).map((p) => ({
		label: p.mode_of_payment,
		value: p.mode_of_payment,
	})),
);

const exceedsOutstanding = computed(
	() => !!props.invoice && amount.value > Number(props.invoice.outstanding_amount) + 0.009,
);

const canSubmit = computed(
	() => !isSaving.value && amount.value > 0 && !exceedsOutstanding.value && !!modeOfPayment.value,
);

watch(
	() => props.invoice,
	(invoice) => {
		if (!invoice) return;
		amount.value = Number(invoice.outstanding_amount) || 0;
		modeOfPayment.value =
			posStore.posProfile?.payments?.find((p) => p.default)?.mode_of_payment ||
			modeOptions.value[0]?.value ||
			"";
	},
	{ immediate: true },
);

async function submit() {
	if (!props.invoice || !canSubmit.value) return;

	const shiftName = posStore.posOpeningShift?.name || "";
	if (!shiftName) {
		showError(__("No open shift found. Please open a shift first."));
		return;
	}

	isSaving.value = true;
	try {
		await call("xpos.api.payments.settle_outstanding_invoice", {
			invoice: props.invoice.name,
			amount: amount.value,
			mode_of_payment: modeOfPayment.value,
			pos_opening_shift: shiftName,
			pos_profile: posStore.profileName,
		});
		showSuccess(__("Payment recorded against {0}", [props.invoice.name]));
		emit("settled");
	} catch (error: unknown) {
		showError(__("Failed to settle invoice: {0}", [extractErrorMessage(error)]));
	} finally {
		isSaving.value = false;
	}
}
</script>
