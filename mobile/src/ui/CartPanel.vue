<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Gift, Minus, Package, Plus, SlidersHorizontal, Tag, Trash2, UserRound } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { formatMinor, lineTotalMinor } from "@mobile/domain/money";
import { lineKey, useCart } from "@mobile/composables/useCart";
import { useCheckout } from "@mobile/composables/useCheckout";
import { useApp } from "@mobile/composables/useApp";
import { useCustomer } from "@mobile/composables/useCustomer";
import { useLiveQuote } from "@mobile/composables/useQuote";
import ShiftSheet from "./ShiftSheet.vue";
import CustomerSheet from "./CustomerSheet.vue";
import PromoSheet from "./PromoSheet.vue";
import LineSheet from "./LineSheet.vue";
import GiftCardSheet from "./GiftCardSheet.vue";
import { toastOn } from "@mobile/composables/useToast";

const props = defineProps<{ compact?: boolean; scopeId: string; currency: string; minorDigits: number }>();
const { cart, total, count, change, remove, clear } = useCart({
	code: props.currency,
	minorDigits: props.minorDigits,
});
const { state } = useApp();
const { flow, blocker, begin } = useCheckout();
const { displayName, isDefault, customer } = useCustomer();
const { live } = useLiveQuote();
toastOn(() => cart.error);
toastOn(() => flow.error, "warning");
const shiftOpen = ref(false);
const customerOpen = ref(false);
const promoOpen = ref(false);
const giftOpen = ref(false);
const adjusting = ref<string | null>(null);

watch(
	() => state.sessionExpired,
	(expired) => {
		if (!expired) flow.error = "";
	},
);

const money = (m: number) => formatMinor(m, props.minorDigits);
/** The server's quote for exactly what is in the cart now; null while it is being asked or after a change. */
const quote = computed(() => (live.status === "ready" ? live.quote : null));
const quoted = (index: number) => quote.value?.lines[index];
const due = computed(() => quote.value?.payableMinor ?? total.value);
const canAdjust = computed(
	() =>
		!!state.context.permissions.show_edit_discount_field ||
		!!state.context.permissions.allow_change_price,
);
const canGift = computed(
	() => !!state.context.giftCards && !!state.context.permissions.sell_gift_card && !cart.lines.length,
);
const promoCount = computed(
	() => cart.coupons.length + (cart.loyaltyPoints ? 1 : 0) + (cart.extraDiscountPct ? 1 : 0),
);
const chargeBlock = computed(() => {
	const why = blocker();
	if (why) return why;
	if (live.status === "problem") return live.message;
	if (live.status === "loading") return "Checking prices for this customer…";
	return null;
});
</script>

<template>
	<section class="flex h-full min-h-0 flex-col" aria-label="Cart">
		<div class="shrink-0 space-y-2 px-4 pt-3 pb-2">
			<div class="flex items-center justify-between gap-2">
				<button
					type="button"
					class="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-xl border border-border bg-surface-raised px-3 text-start shadow-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus active:shadow-pressed"
					:aria-label="`Customer: ${displayName}. Change customer`"
					@click="customerOpen = true"
				>
					<UserRound class="size-5 shrink-0 text-primary" aria-hidden="true" />
					<span class="min-w-0">
						<span class="block truncate text-sm font-semibold">{{ displayName }}</span>
						<span class="block truncate text-xs text-muted-foreground">{{
							isDefault ? "Default customer" : (customer.customer?.priceList ?? "")
						}}</span>
					</span>
				</button>
				<span
					class="shrink-0 rounded-lg border border-border bg-surface-sunken px-2 py-0.5 text-xs font-semibold text-muted-foreground tabular-nums"
					>{{ count }} units</span
				>
				<Button
					v-if="cart.lines.length"
					variant="ghost"
					size="icon"
					class="size-11"
					aria-label="Clear cart"
					@click="clear"
					><Trash2
				/></Button>
			</div>
		</div>

		<ul
			v-if="cart.lines.length"
			class="xpos-scrollbar min-h-0 flex-1 space-y-2 overflow-y-auto px-4 pb-2"
			aria-label="Cart lines"
		>
			<li
				v-for="(l, i) in cart.lines"
				:key="lineKey(l)"
				class="rounded-2xl border border-border bg-surface-raised px-3 shadow-raised"
				:class="compact ? 'py-1.5' : 'py-2.5'"
			>
				<div class="flex gap-3">
					<div
						v-if="!compact"
						class="flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border bg-card"
					>
						<Package class="size-5 text-muted-foreground/60" />
					</div>
					<div class="min-w-0 flex-1">
						<div class="flex items-start gap-3">
							<div class="min-w-0 flex-1">
								<p
									class="line-clamp-2 text-[0.9375rem] font-semibold leading-snug text-foreground"
								>
									{{ l.name }}
								</p>
								<p class="mt-0.5 truncate font-mono text-xs text-muted-foreground">
									{{ l.itemCode }}{{ quoted(i) ? "" : "" }}
								</p>
							</div>
							<span class="shrink-0 text-base font-bold text-foreground tabular-nums">{{
								money(quoted(i)?.amountMinor ?? lineTotalMinor(l.priceMinor, l.qtyMilli))
							}}</span>
						</div>
						<p
							v-if="quoted(i) && (quoted(i)!.discountPct > 0 || quoted(i)!.rules)"
							class="mt-0.5 flex items-center gap-1 text-xs font-medium text-success-soft-foreground"
						>
							<Tag class="size-3" aria-hidden="true" />
							{{ quoted(i)!.discountPct > 0 ? `${quoted(i)!.discountPct}% off, ` : "" }}was
							{{ quoted(i)!.priceListRate }}
							{{ quoted(i)!.rules ? "(promotion)" : "(discount)" }}
						</p>
						<div class="mt-2 flex items-center gap-2">
							<p
								class="min-w-0 flex-1 truncate text-sm font-semibold text-foreground tabular-nums"
							>
								{{ quoted(i) ? quoted(i)!.rate : money(l.priceMinor) }} / {{ l.uom }}
							</p>
							<Button
								v-if="canAdjust"
								variant="ghost"
								size="icon"
								class="size-11 text-muted-foreground"
								:aria-label="`Adjust price or discount of ${l.name}`"
								@click="adjusting = lineKey(l)"
								><SlidersHorizontal
							/></Button>
							<div
								class="flex shrink-0 items-center rounded-xl border border-border bg-card shadow-inset"
								role="group"
								:aria-label="`Quantity for ${l.name}`"
							>
								<button
									type="button"
									class="flex size-11 items-center justify-center rounded-s-xl text-foreground transition-colors duration-fast hover:bg-surface-hover active:bg-surface-pressed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
									:aria-label="`Decrease ${l.name}`"
									@click="change(lineKey(l), -1)"
								>
									<Minus class="size-4" />
								</button>
								<span
									class="flex h-11 min-w-12 items-center justify-center border-x border-border text-center text-base font-semibold text-foreground tabular-nums"
									aria-live="polite"
									>{{ l.qtyMilli / 1000 }}</span
								>
								<button
									type="button"
									class="flex size-11 items-center justify-center rounded-e-xl text-primary transition-colors duration-fast hover:bg-surface-hover active:bg-surface-pressed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
									:aria-label="`Increase ${l.name}`"
									@click="change(lineKey(l), 1)"
								>
									<Plus class="size-4" />
								</button>
							</div>
							<Button
								variant="ghost"
								size="icon"
								class="size-11 text-muted-foreground"
								:aria-label="`Remove ${l.name}`"
								@click="remove(lineKey(l))"
								><Trash2
							/></Button>
						</div>
					</div>
				</div>
			</li>
			<li
				v-for="(f, i) in quote?.extras.freeLines ?? []"
				:key="`free-${i}`"
				class="rounded-2xl border border-dashed border-success/40 bg-success-soft px-3 py-2 text-sm text-success-soft-foreground"
			>
				Free: {{ f.qty }} x {{ f.item_name ?? f.item_code }} (promotion)
			</li>
		</ul>
		<div v-else class="flex-1 space-y-3 px-4 py-8 text-center">
			<p class="text-sm text-muted-foreground">The cart is empty. Tap an item to add it.</p>
			<Button v-if="canGift" variant="outline" class="h-11" @click="giftOpen = true"
				><Gift /> Sell a gift card</Button
			>
		</div>

		<div class="shrink-0 space-y-2.5 border-t border-border px-4 pt-2.5 pb-3">
			<ul
				v-if="quote?.notices.length"
				class="space-y-1 text-xs text-muted-foreground"
				aria-label="Notices"
			>
				<li v-for="n in quote.notices" :key="n">{{ n }}</li>
			</ul>
			<p
				v-if="live.status === 'problem'"
				class="rounded-xl border border-warning/30 bg-warning-soft px-3 py-2 text-xs text-warning-soft-foreground"
				role="alert"
			>
				{{ live.message }}
			</p>
			<Button
				v-if="cart.lines.length"
				variant="outline"
				class="h-11 w-full justify-between rounded-xl text-sm font-semibold"
				@click="promoOpen = true"
			>
				<span class="flex items-center gap-2"><Tag /> Coupons, points, discount</span>
				<span v-if="promoCount" class="tabular-nums">{{ promoCount }}</span>
			</Button>
			<dl class="px-1 text-sm tabular-nums">
				<template v-if="quote">
					<div class="flex justify-between text-muted-foreground">
						<dt>Items</dt>
						<dd>{{ money(quote.netMinor) }}</dd>
					</div>
					<div v-if="quote.discountMinor" class="flex justify-between text-success-soft-foreground">
						<dt>Discount</dt>
						<dd>-{{ money(quote.discountMinor) }}</dd>
					</div>
					<div v-if="quote.taxMinor" class="flex justify-between text-muted-foreground">
						<dt>Taxes</dt>
						<dd>{{ money(quote.taxMinor) }}</dd>
					</div>
					<div v-if="quote.loyaltyMinor" class="flex justify-between text-success-soft-foreground">
						<dt>Loyalty points</dt>
						<dd>-{{ money(quote.loyaltyMinor) }}</dd>
					</div>
				</template>
				<div class="flex items-baseline justify-between">
					<dt class="text-lg font-bold text-foreground">Total</dt>
					<dd class="text-2xl font-extrabold tracking-tight tabular-nums">
						{{ currency }} {{ money(due) }}
					</dd>
				</div>
			</dl>
			<Button
				v-if="cart.lines.length && !state.context.openShift && state.online"
				variant="outline"
				class="h-12 w-full rounded-xl text-base font-semibold"
				@click="shiftOpen = true"
				>Open shift to start selling</Button
			>
			<Button
				v-else
				class="h-12 w-full rounded-xl text-base font-semibold"
				:disabled="!!chargeBlock"
				:loading="flow.step === 'quoting'"
				@click="begin"
				>Charge {{ currency }} {{ money(due) }}</Button
			>
			<p v-if="cart.lines.length && chargeBlock" class="text-center text-xs text-muted-foreground">
				{{ chargeBlock }}
			</p>
			<ShiftSheet v-model="shiftOpen" />
			<CustomerSheet v-model="customerOpen" />
			<PromoSheet v-model="promoOpen" />
			<LineSheet :line-key="adjusting" @close="adjusting = null" />
			<GiftCardSheet v-model="giftOpen" />
		</div>
	</section>
</template>
