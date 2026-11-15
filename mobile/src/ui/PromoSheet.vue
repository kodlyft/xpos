<script setup lang="ts">
import { computed, ref } from "vue";
import { Tag, X } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useApp } from "@mobile/composables/useApp";
import { useCart } from "@mobile/composables/useCart";
import { useCustomer } from "@mobile/composables/useCustomer";

/**
 * Coupons, loyalty points and an extra invoice discount. Each is only a request: the server validates it for this
 * customer and user in the next quote and says why when it refuses.
 */
const open = defineModel<boolean>({ default: false });
const { state } = useApp();
const { cart } = useCart();
const { customer } = useCustomer();

const code = ref("");
const points = ref("");
const pct = ref("");
const canDiscount = computed(() => !!state.context.permissions.apply_additional_discount);
const available = computed(() => customer.customer?.loyaltyPoints ?? 0);
const loyalty = computed(() => customer.customer?.loyaltyProgram);

function addCoupon() {
	const c = code.value.trim();
	if (c && !cart.coupons.includes(c)) cart.coupons = [...cart.coupons, c];
	code.value = "";
}
function removeCoupon(c: string) {
	cart.coupons = cart.coupons.filter((x) => x !== c);
}
function applyPoints() {
	const n = Math.floor(Number(points.value));
	cart.loyaltyPoints = Number.isFinite(n) && n > 0 ? Math.min(n, available.value) : 0;
	points.value = cart.loyaltyPoints ? String(cart.loyaltyPoints) : "";
}
function applyPct() {
	const n = Number(pct.value);
	cart.extraDiscountPct = Number.isFinite(n) && n > 0 ? n : 0;
}
</script>

<template>
	<div
		v-if="open"
		class="fixed inset-0 z-30 flex items-end justify-center bg-[hsl(var(--scrim)/0.5)] md:items-center"
		@click.self="open = false"
		@keydown.esc="open = false"
	>
		<div
			class="w-full space-y-4 rounded-t-2xl border border-border bg-card p-4 shadow-overlay md:max-w-sm md:rounded-2xl"
			role="dialog"
			aria-modal="true"
			aria-label="Coupons, points and discount"
		>
			<div class="flex items-center justify-between">
				<h2 class="flex items-center gap-2 text-lg font-bold"><Tag class="size-5" /> Promotions</h2>
				<Button variant="ghost" size="icon" class="size-11" aria-label="Close" @click="open = false"
					><X
				/></Button>
			</div>

			<form class="space-y-2" @submit.prevent="addCoupon">
				<label class="text-sm font-medium" for="coupon">Coupon code</label>
				<div class="flex gap-2">
					<Input id="coupon" v-model="code" class="h-11 text-base" autocapitalize="characters" />
					<Button type="submit" class="h-11" :disabled="!code.trim()">Apply</Button>
				</div>
				<ul v-if="cart.coupons.length" class="flex flex-wrap gap-2" aria-label="Coupons on this sale">
					<li
						v-for="c in cart.coupons"
						:key="c"
						class="inline-flex items-center gap-1 rounded-lg border border-border bg-surface-sunken ps-2 text-sm"
					>
						{{ c }}
						<Button
							variant="ghost"
							size="icon"
							class="size-9"
							:aria-label="`Remove coupon ${c}`"
							@click="removeCoupon(c)"
							><X
						/></Button>
					</li>
				</ul>
			</form>

			<form v-if="loyalty" class="space-y-2" @submit.prevent="applyPoints">
				<label class="text-sm font-medium" for="points"
					>Loyalty points to redeem (customer has {{ available }})</label
				>
				<div class="flex gap-2">
					<Input
						id="points"
						v-model="points"
						class="h-11 text-base tabular-nums"
						inputmode="numeric"
						:placeholder="String(cart.loyaltyPoints || 0)"
					/>
					<Button type="submit" class="h-11">Set</Button>
				</div>
				<p v-if="cart.loyaltyPoints" class="text-xs text-muted-foreground">
					{{ cart.loyaltyPoints }} points requested. The server works out their value.
				</p>
			</form>

			<form v-if="canDiscount" class="space-y-2" @submit.prevent="applyPct">
				<label class="text-sm font-medium" for="extra">Extra discount on the whole sale (%)</label>
				<div class="flex gap-2">
					<Input
						id="extra"
						v-model="pct"
						class="h-11 text-base tabular-nums"
						inputmode="decimal"
						:placeholder="String(cart.extraDiscountPct || 0)"
					/>
					<Button type="submit" class="h-11">Set</Button>
				</div>
				<p class="text-xs text-muted-foreground">
					Limited by your discount allowance on this POS Profile; the server refuses more.
				</p>
			</form>
		</div>
	</div>
</template>
