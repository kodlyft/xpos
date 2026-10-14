<template>
	<Dialog :open="cards.length > 0" @update:open="(val: boolean) => !val && confirmClose()">
		<DialogContent class="max-w-md" data-testid="gift-card-issued">
			<DialogHeader>
				<DialogTitle class="flex items-center gap-2">
					<Gift class="w-5 h-5" />
					{{ __("Gift card issued") }}
				</DialogTitle>
				<DialogDescription>
					{{
						__(
							"Give the code to the customer now. It is shown only once and cannot be looked up again.",
						)
					}}
				</DialogDescription>
			</DialogHeader>

			<div class="space-y-3">
				<div
					v-for="card in cards"
					:key="card.gift_card"
					class="rounded-lg border border-border p-3 text-center"
				>
					<p
						class="font-mono text-xl font-bold tracking-widest select-all"
						data-testid="gift-card-code-issued"
					>
						{{ card.code }}
					</p>
					<p class="mt-1 text-sm text-muted-foreground">
						{{ formatWithSymbol(card.currency, card.amount) }}
						<span v-if="card.valid_upto"> · {{ __("valid until {0}", [card.valid_upto]) }}</span>
					</p>
				</div>
			</div>

			<DialogFooter class="gap-2">
				<Button variant="outline" @click="printSlip">
					<Printer class="w-4 h-4" />
					{{ __("Print card slip") }}
				</Button>
				<Button @click="confirmClose">{{ __("Done") }}</Button>
			</DialogFooter>
		</DialogContent>
	</Dialog>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { Gift, Printer } from "lucide-vue-next";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useCartStore } from "@/stores/cartStore";
import { formatWithSymbol } from "@/composables/useCurrency";
import { printHtml } from "@/composables/usePrintInvoice";
import { buildGiftCardSlipHtml } from "@/services/receiptTemplate";
import { __ } from "@/lib/translate";

const cartStore = useCartStore();
const cards = computed(() => cartStore.issuedGiftCards);

function printSlip() {
	printHtml(buildGiftCardSlipHtml(cards.value));
}

function confirmClose() {
	if (window.confirm(__("Close? The gift card code will not be shown again."))) {
		cartStore.dismissIssuedGiftCards();
	}
}
</script>
