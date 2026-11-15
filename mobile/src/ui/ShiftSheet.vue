<script setup lang="ts">
import { computed, ref } from "vue";
import { X } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toMinor } from "@mobile/domain/money";
import { openShift, useApp } from "@mobile/composables/useApp";
import { toastOn } from "@mobile/composables/useToast";

const open = defineModel<boolean>({ default: false });
const { state } = useApp();
const amounts = ref<Record<string, string>>({});
const busy = ref(false);
const error = ref("");
toastOn(error);
const modes = computed(() => state.context.paymentModes);

async function submit() {
	busy.value = true;
	error.value = "";
	try {
		const digits = state.cashier?.minorDigits ?? 2;
		const minor: Record<string, number> = {};
		for (const m of modes.value)
			minor[m.mode_of_payment] = toMinor(amounts.value[m.mode_of_payment] || "0", digits);
		await openShift(minor);
		open.value = false;
	} catch (e) {
		error.value = e instanceof Error ? e.message : "The shift could not be opened.";
	} finally {
		busy.value = false;
	}
}
</script>

<template>
	<div
		v-if="open"
		class="fixed inset-0 z-30 flex items-end justify-center bg-[hsl(var(--scrim)/0.5)] md:items-center"
	>
		<form
			class="w-full space-y-3 rounded-t-2xl border border-border bg-card p-4 shadow-overlay md:max-w-sm md:rounded-2xl"
			role="dialog"
			aria-modal="true"
			aria-label="Open shift"
			@submit.prevent="submit"
		>
			<div class="flex items-center justify-between">
				<h2 class="text-lg font-bold">Open shift</h2>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					class="size-11"
					aria-label="Close"
					@click="open = false"
					><X
				/></Button>
			</div>
			<p class="text-sm text-muted-foreground">
				Enter the opening amount counted for each payment method (0 if none).
			</p>
			<label
				v-for="m in modes"
				:key="m.mode_of_payment"
				class="flex items-center justify-between gap-3 text-sm font-medium"
			>
				{{ m.mode_of_payment }}
				<Input
					v-model="amounts[m.mode_of_payment]"
					inputmode="decimal"
					placeholder="0"
					class="h-11 w-32 text-end text-base tabular-nums"
				/>
			</label>
			<Button type="submit" class="h-12 w-full text-base font-semibold" :loading="busy"
				>Open shift</Button
			>
		</form>
	</div>
</template>
