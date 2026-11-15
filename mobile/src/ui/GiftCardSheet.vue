<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Gift, X } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatMinor, toMinor } from "@mobile/domain/money";
import { useApp } from "@mobile/composables/useApp";
import { useCheckout } from "@mobile/composables/useCheckout";

/**
 * Sells a gift card. Only the value is entered here; the sale then goes through the same payment, saving and
 * retry steps as any sale, so a retry can never issue a second card.
 */
const open = defineModel<boolean>({ default: false });
const { state } = useApp();
const { beginGiftCard } = useCheckout();
const digits = computed(() => state.cashier?.minorDigits ?? 2);
const cfg = computed(() => state.context.giftCards);
const amount = ref("");
const confirm = ref(false);
watch(open, (on) => {
	if (on) {
		amount.value = "";
		confirm.value = false;
	}
});

const minor = computed(() => {
	try {
		return toMinor(amount.value || "0", digits.value);
	} catch {
		return 0;
	}
});
const problem = computed(() => {
	const c = cfg.value;
	if (!c) return "Gift cards are not set up on this POS Profile.";
	if (minor.value <= 0) return "Enter the value of the card.";
	if (c.minAmount && minor.value < Math.round(c.minAmount * 10 ** digits.value))
		return `The smallest card is ${c.minAmount}.`;
	if (c.maxAmount && minor.value > Math.round(c.maxAmount * 10 ** digits.value))
		return `The largest card is ${c.maxAmount}.`;
	return null;
});

function go() {
	if (problem.value) return;
	if (!confirm.value) {
		confirm.value = true;
		return;
	}
	beginGiftCard(minor.value);
	open.value = false;
}
</script>

<template>
	<div
		v-if="open"
		class="fixed inset-0 z-30 flex items-end justify-center bg-[hsl(var(--scrim)/0.5)] md:items-center"
		@click.self="open = false"
		@keydown.esc="open = false"
	>
		<form
			class="w-full space-y-3 rounded-t-2xl border border-border bg-card p-4 shadow-overlay md:max-w-sm md:rounded-2xl"
			role="dialog"
			aria-modal="true"
			aria-label="Sell a gift card"
			@submit.prevent="go"
		>
			<div class="flex items-center justify-between">
				<h2 class="flex items-center gap-2 text-lg font-bold">
					<Gift class="size-5" /> Sell a gift card
				</h2>
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
			<label class="block space-y-1 text-sm font-medium"
				>Card value ({{ state.cashier?.currency }})
				<Input
					v-model="amount"
					class="h-12 text-lg tabular-nums"
					inputmode="decimal"
					:disabled="confirm"
					autofocus
				/>
			</label>
			<p v-if="cfg" class="text-xs text-muted-foreground">
				Between {{ cfg.minAmount }} and {{ cfg.maxAmount }}. A gift card is sold on its own, with no
				tax or discount. The code is shown once after payment.
			</p>
			<p v-if="amount && problem" class="text-xs text-destructive-soft-foreground" role="status">
				{{ problem }}
			</p>
			<p
				v-if="confirm && !problem"
				class="rounded-xl border border-warning/30 bg-warning-soft px-3 py-2 text-sm"
				role="status"
			>
				You are about to sell one card worth {{ formatMinor(minor, digits) }}. Tap again to continue
				to payment.
			</p>
			<Button type="submit" class="h-12 w-full text-base font-semibold" :disabled="!!problem">{{
				confirm ? "Continue to payment" : "Sell card"
			}}</Button>
		</form>
	</div>
</template>
