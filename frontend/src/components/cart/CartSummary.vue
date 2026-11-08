<template>
	<div class="shrink-0 space-y-2.5 border-t border-border px-4 pt-2.5 pb-3" data-testid="cart-summary">
		<div
			v-if="!offlineStore.isOnline"
			class="flex items-start gap-2 rounded-xl border border-warning/30 bg-warning-soft px-3 py-2 text-xs text-warning-soft-foreground"
			role="status"
			data-testid="offline-strip"
		>
			<WifiOff class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
			<div class="min-w-0">
				<p class="font-semibold">
					{{ __("Offline: this sale is saved on this till and synced later.") }}
				</p>
				<p v-if="offlineRestrictions.length">
					{{ __("Needs a connection: {0}.", [offlineRestrictions.join(", ")]) }}
				</p>
				<p v-if="cartStore.pricingSource === 'offline'">
					{{ __("Prices calculated offline, will be confirmed when the invoice syncs") }}
				</p>
			</div>
		</div>
		<div
			v-else-if="cartStore.pricingSource === 'offline'"
			class="flex items-center gap-1.5 text-xs text-warning-soft-foreground"
			role="status"
		>
			<WifiOff class="size-3.5 shrink-0" aria-hidden="true" />
			{{ __("Prices calculated offline, will be confirmed when the invoice syncs") }}
		</div>

		<div
			v-if="cartStore.repriceReview"
			role="alert"
			class="space-y-1.5 rounded-xl border border-info/30 bg-info-soft px-3 py-2 text-xs text-info-soft-foreground"
		>
			<p class="font-semibold">{{ __("Prices changed - nothing was charged or saved") }}</p>
			<p>
				{{
					__(
						"The server priced this sale at {0}. Check the marked lines, then take payment again.",
						[money(cartStore.repriceReview.rounded_total || cartStore.repriceReview.grand_total)],
					)
				}}
			</p>
			<Button size="sm" variant="outline" @click="cartStore.acknowledgeRepricing()">
				{{ __("I have reviewed the new prices") }}
			</Button>
		</div>

		<div
			v-if="pendingList.length"
			class="rounded-xl border px-3 py-2 text-xs"
			:class="
				hasBlockers
					? 'border-warning/30 bg-warning-soft text-warning-soft-foreground'
					: 'border-info/25 bg-info-soft text-info-soft-foreground'
			"
			:role="hasBlockers ? 'alert' : 'status'"
			data-testid="checkout-requirements"
		>
			<p id="checkout-requirements-title" class="mb-1 flex items-center gap-1.5 text-sm font-semibold">
				<AlertTriangle class="size-4 shrink-0" aria-hidden="true" />
				{{ hasBlockers ? __("Before payment") : __("Check before payment") }}
			</p>
			<ul class="space-y-0.5">
				<li v-for="(entry, i) in pendingList" :key="i">
					<button
						v-if="entry.index !== undefined"
						type="button"
						class="text-start underline decoration-current/40 underline-offset-2 hover:decoration-current focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
						@click="focusLine(entry.index)"
					>
						{{ entry.message }}
					</button>
					<span v-else>{{ entry.message }}</span>
				</li>
			</ul>
		</div>

		<p
			v-if="cartStore.sourceOrder || cartStore.sourceQuotation"
			class="flex items-center gap-1.5 rounded-lg bg-info-soft px-2 py-1 text-xs font-semibold text-info-soft-foreground"
			data-testid="cart-source-doc"
		>
			<ScrollText class="size-3.5" aria-hidden="true" />
			{{
				cartStore.sourceOrder
					? __("Billing Sales Order {0}", [cartStore.sourceOrder.name])
					: __("From Quotation {0}", [cartStore.sourceQuotation])
			}}
		</p>
		<dl class="space-y-1 px-1 text-sm" data-testid="cart-totals">
			<div class="flex items-center justify-between">
				<dt class="text-foreground">
					{{ __("Subtotal") }}
					<span class="text-muted-foreground">({{ itemsLabel }})</span>
				</dt>
				<dd class="font-semibold text-foreground tabular-nums">{{ money(cartStore.subtotal) }}</dd>
			</div>

			<div v-if="!hasAnyDiscount" class="flex items-center justify-between">
				<dt class="text-muted-foreground">{{ __("Discount") }}</dt>
				<dd class="font-medium text-foreground tabular-nums">{{ money(0) }}</dd>
			</div>
			<div v-if="itemDiscountTotal > 0" class="flex items-center justify-between">
				<dt class="flex items-center gap-1 text-muted-foreground">
					<Percent class="size-3" aria-hidden="true" /> {{ __("Item Discounts") }}
				</dt>
				<dd class="font-medium text-success-soft-foreground tabular-nums">
					-{{ money(itemDiscountTotal) }}
				</dd>
			</div>
			<div v-if="cartStore.offerItemDiscountTotal > 0" class="flex items-center justify-between">
				<dt class="flex items-center gap-1 text-success-soft-foreground">
					<Ticket class="size-3" aria-hidden="true" /> {{ __("Offer Discount") }}
				</dt>
				<dd class="font-medium text-success-soft-foreground tabular-nums">
					-{{ money(cartStore.offerItemDiscountTotal) }}
				</dd>
			</div>
			<div v-if="cartStore.offerGrandTotalDiscountPct > 0" class="flex items-center justify-between">
				<dt class="flex items-center gap-1 text-success-soft-foreground">
					<Ticket class="size-3" aria-hidden="true" /> {{ __("Offer") }}
					<span class="text-xs">({{ percent(cartStore.offerGrandTotalDiscountPct) }})</span>
				</dt>
				<dd class="font-medium text-success-soft-foreground tabular-nums">
					-{{ money(grandTotalOfferDiscount) }}
				</dd>
			</div>
			<div
				v-if="cartStore.discountPercentage > 0 || cartStore.discountAmount > 0"
				class="flex items-center justify-between"
			>
				<dt class="flex items-center gap-1 text-muted-foreground">
					<Tag class="size-3" aria-hidden="true" />
					{{ __("Additional Discount") }}
					<span
						v-if="cartStore.discountPercentage > 0"
						class="text-xs text-success-soft-foreground"
					>
						({{ percent(cartStore.discountPercentage) }})
					</span>
				</dt>
				<dd class="font-medium text-success-soft-foreground tabular-nums">
					-{{ money(discountValue) }}
				</dd>
			</div>

			<div v-if="cartStore.calculatedTaxes.length === 0" class="flex items-center justify-between">
				<dt class="text-muted-foreground">{{ __("Tax") }}</dt>
				<dd class="font-medium text-foreground tabular-nums">{{ money(0) }}</dd>
			</div>
			<div
				v-for="(tax, idx) in cartStore.calculatedTaxes"
				:key="idx"
				class="flex items-center justify-between"
				data-testid="cart-tax-row"
			>
				<dt class="flex items-center gap-1 text-muted-foreground">
					{{ tax.description }}
					<span v-if="tax.rate" class="text-xs text-muted-foreground/70"
						>({{ percent(tax.rate) }})</span
					>
					<span
						v-if="tax.included_in_print_rate"
						class="text-[0.625rem] font-semibold uppercase text-info-soft-foreground"
					>
						{{ __("incl.") }}
					</span>
				</dt>
				<dd
					class="font-medium tabular-nums"
					:class="tax.included_in_print_rate ? 'text-info-soft-foreground' : 'text-foreground'"
				>
					{{ formatTaxAmount(tax.amount, tax.included_in_print_rate, money) }}
				</dd>
			</div>

			<div
				v-if="cartStore.redeemLoyaltyPoints && cartStore.loyaltyAmount > 0"
				class="flex items-center justify-between"
			>
				<dt class="flex items-center gap-1 text-muted-foreground">
					<Gift class="size-3.5" aria-hidden="true" /> {{ __("Loyalty") }}
				</dt>
				<dd class="font-medium text-success-soft-foreground tabular-nums">
					-{{ money(cartStore.loyaltyAmount) }}
				</dd>
			</div>
			<div v-if="cartStore.writeOffAmount > 0" class="flex items-center justify-between">
				<dt class="text-muted-foreground">{{ __("Write Off") }}</dt>
				<dd class="font-medium text-warning-soft-foreground tabular-nums">
					-{{ money(cartStore.writeOffAmount) }}
				</dd>
			</div>
			<div v-if="cartStore.selectedDeliveryCharge" class="flex items-center justify-between">
				<dt class="flex items-center gap-1 text-muted-foreground">
					<Truck class="size-3" aria-hidden="true" /> {{ cartStore.selectedDeliveryCharge.label }}
				</dt>
				<dd class="font-medium text-foreground tabular-nums">
					+{{ money(cartStore.selectedDeliveryCharge.rate) }}
				</dd>
			</div>
			<div
				v-if="cartStore.depositApplied > 0"
				class="flex items-center justify-between"
				data-testid="cart-deposit"
			>
				<dt class="text-muted-foreground">
					{{ __("Deposit on {0}", [cartStore.sourceOrder?.name || ""]) }}
				</dt>
				<dd class="font-medium text-success-soft-foreground tabular-nums">
					-{{ money(cartStore.depositApplied) }}
				</dd>
			</div>
			<div v-if="hasRounding" class="flex items-center justify-between" data-testid="cart-rounding">
				<dt class="text-muted-foreground">{{ __("Rounding") }}</dt>
				<dd class="font-medium text-foreground tabular-nums">
					{{ cartStore.roundingAdjustment > 0 ? "+" : "-"
					}}{{ money(Math.abs(cartStore.roundingAdjustment)) }}
				</dd>
			</div>

			<div class="mt-1.5 flex items-baseline justify-between border-t border-border pt-2">
				<dt class="text-lg font-bold text-foreground">
					{{ cartStore.isReturnMode ? __("Refund") : __("Total") }}
				</dt>
				<dd
					class="text-2xl font-extrabold tracking-tight tabular-nums"
					:class="
						cartStore.isReturnMode
							? 'text-warning-soft-foreground'
							: 'text-primary dark:text-focus'
					"
					data-testid="cart-grand-total"
				>
					{{ cartStore.isReturnMode ? "-" : "" }}{{ money(Math.abs(cartStore.grandTotal)) }}
				</dd>
			</div>
		</dl>

		<Popover v-model:open="moreOpen">
			<PopoverAnchor as-child>
				<div
					class="grid auto-cols-fr grid-flow-col gap-1.5"
					data-cart-actions
					data-testid="cart-actions"
				>
					<TooltipWrapper
						v-for="action in inlineActions"
						:key="action.id"
						:content="action.label"
						:shortcut="action.shortcut"
					>
						<Button
							variant="outline"
							class="h-11 min-w-0 rounded-xl px-1"
							:class="action.destructive && 'text-destructive-soft-foreground'"
							:disabled="action.disabled"
							:aria-pressed="action.pressed"
							:aria-label="action.label"
							:data-testid="action.testid"
							@click="action.run()"
						>
							<component :is="action.icon" class="size-5!" />
						</Button>
					</TooltipWrapper>

					<Button
						v-if="overflowActions.length"
						variant="outline"
						class="h-11 min-w-0 rounded-xl px-1"
						data-testid="cart-more"
						:aria-label="__('More actions')"
						:aria-expanded="moreOpen && moreView === 'menu'"
						@click="openPanel('menu')"
					>
						<MoreHorizontal class="size-5!" />
					</Button>
				</div>
			</PopoverAnchor>
			<PopoverContentStyled
				:class="moreView === 'menu' ? 'w-64 p-1.5' : 'w-80 space-y-3'"
				:align="moreView === 'menu' ? 'end' : 'center'"
				side="top"
				:role="moreView === 'menu' ? 'menu' : undefined"
				@interact-outside="keepOpenOnActions"
			>
				<template v-if="moreView === 'menu'">
					<template v-for="(action, index) in overflowActions" :key="action.id">
						<div
							v-if="action.id === 'clear_cart' && index > 0"
							class="my-1.5 h-px bg-border"
							role="separator"
						/>
						<PopoverMenuItem
							:destructive="action.destructive"
							:disabled="action.disabled"
							:data-testid="action.testid"
							@click="action.run(true)"
						>
							<template #icon><component :is="action.icon" /></template>
							{{ action.label }}
						</PopoverMenuItem>
					</template>
				</template>

				<CartDiscountForm
					v-else-if="moreView === 'discount'"
					ref="discountFormRef"
					v-model:type="discountType"
					v-model:value="discountInput"
					:symbol="posStore.currencySymbol"
					:precision="moneyPrecision"
					@apply="applyDiscount"
					@done="moreOpen = false"
				/>

				<CartCouponForm
					v-else-if="moreView === 'coupon'"
					v-model="couponInput"
					:loading="isApplyingCoupon"
					:error="couponError"
					@apply="applyCouponCode"
				/>

				<template v-else-if="moreView === 'gift'">
					<p class="text-sm font-semibold">{{ __("Sell gift card") }}</p>
					<div class="flex items-center gap-2">
						<NumberInput
							v-model="giftCardValue"
							:min="0"
							:precision="moneyPrecision"
							class="flex-1"
							data-testid="gift-card-value"
							:placeholder="__('Gift card value')"
							@keydown.enter="addGiftCard"
						/>
						<Button :disabled="!(giftCardValue > 0)" @click="addGiftCard">
							{{ __("Add gift card") }}
						</Button>
					</div>
					<p class="text-sm text-muted-foreground">
						{{
							__(
								"A new code is printed when the sale is paid. Gift cards are sold on their own sale.",
							)
						}}
					</p>
				</template>

				<template v-else>
					<div class="flex items-center justify-between">
						<p class="text-sm font-semibold">{{ __("Delivery Charges") }}</p>
						<Button
							v-if="cartStore.selectedDeliveryCharge"
							variant="ghost"
							size="sm"
							class="text-destructive-soft-foreground"
							@click="cartStore.setDeliveryCharge(null)"
						>
							{{ __("Remove") }}
						</Button>
					</div>
					<LoadingState v-if="isLoadingDelivery" compact />
					<p v-else-if="!availableDeliveryCharges.length" class="text-sm text-muted-foreground">
						{{ __("No delivery charges available for this profile") }}
					</p>
					<div v-else class="flex flex-wrap gap-2">
						<button
							v-for="charge in availableDeliveryCharges"
							:key="charge.name"
							type="button"
							class="h-9 rounded-lg border px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
							:class="
								cartStore.selectedDeliveryCharge?.name === charge.name
									? 'border-primary bg-primary text-primary-foreground'
									: 'border-border bg-card hover:bg-surface-hover'
							"
							:aria-pressed="cartStore.selectedDeliveryCharge?.name === charge.name"
							@click="selectDeliveryCharge(charge)"
						>
							{{ charge.label }} &mdash; {{ money(charge.rate) }}
						</button>
					</div>
				</template>
			</PopoverContentStyled>
		</Popover>

		<Button
			class="relative h-14 w-full gap-3 rounded-2xl text-lg font-bold shadow-primary transition-[transform,box-shadow,background-color] duration-fast active:translate-y-px active:shadow-pressed"
			:class="
				cartStore.isReturnMode &&
				'border-warning bg-warning text-warning-foreground shadow-raised hover:bg-warning/90'
			"
			:disabled="payDisabled"
			:aria-describedby="hasBlockers ? 'checkout-requirements-title' : undefined"
			data-testid="pay-button"
			@click="handleCheckout()"
		>
			<CreditCard class="size-6!" />
			{{ payButtonLabel }}
			<kbd
				class="absolute inset-e-4 hidden h-8 min-w-10 items-center justify-center rounded-lg border border-white/30 bg-white/15 px-2 font-mono text-sm font-semibold sm:inline-flex"
				aria-hidden="true"
				>F4</kbd
			>
		</Button>

		<SalesOrderDialog :mode="orderMode" @close="orderMode = null" @saved="orderMode = null" />
	</div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted, type Component } from "vue";
import { usePosStore } from "@/stores/posStore";
import { hasPermission } from "@/services/userRights";
import { useCartStore } from "@/stores/cartStore";
import { useCartSessionStore } from "@/stores/cartSessionStore";
import { useOfferStore } from "@/stores/offerStore";
import { call, showSuccess, showError, showInfo } from "@/services/api";
import { __ } from "@/lib/translate";
import { isTabConflictError } from "@/utils";
import { useOfflineStore } from "@/stores/offlineStore";
import { usePrintInvoice } from "@/composables/usePrintInvoice";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip";
import { NumberInput } from "@/components/ui/number-input";
import { Separator } from "@/components/ui/separator";
import { Popover, PopoverAnchor, PopoverContentStyled, PopoverMenuItem } from "@/components/ui/popover";
import CartDiscountForm from "./CartDiscountForm.vue";
import CartCouponForm from "./CartCouponForm.vue";
import { useLayoutStore } from "@/stores/layoutStore";
import { visibleActionCount } from "@/services/posLayout";
import { LoadingState } from "@/components/ui/state";
import {
	Tag,
	Ticket,
	Pause,
	Trash2,
	CreditCard,
	Gift,
	Loader2,
	Percent,
	FileText,
	ClipboardList,
	ScrollText,
	Truck,
	WifiOff,
	X,
	MoreHorizontal,
	AlertTriangle,
} from "lucide-vue-next";
import type { DeliveryCharge } from "@/types/pos.types";
import { useMoney } from "@/composables/useMoney";
import { formatTaxAmount } from "@/utils/numberFormat";
import SalesOrderDialog from "@/components/dialogs/SalesOrderDialog.vue";

const posStore = usePosStore();
const { money, moneyPrecision, percent } = useMoney();
const cartStore = useCartStore();
const cartSessions = useCartSessionStore();
const offerStore = useOfferStore();
const offlineStore = useOfflineStore();
const { printInvoice } = usePrintInvoice();

const orderMode = ref<"order" | "quotation" | null>(null);
const canSaveAsOrder = computed(() => posStore.allowSalesOrder && !cartStore.isReturnMode);
const orderable = computed(
	() =>
		offlineStore.isOnline &&
		!cartStore.isEmpty &&
		!!cartStore.customer?.name &&
		!cartStore.sourceOrder &&
		!cartStore.isGiftCardSale,
);
type PanelView = "menu" | "discount" | "coupon" | "gift" | "delivery";
const layoutStore = useLayoutStore();
const moreOpen = ref(false);
const moreView = ref<PanelView>("menu");
const discountFormRef = ref<InstanceType<typeof CartDiscountForm> | null>(null);

/** Discount and coupon live in the one action panel, wherever their button sits. */
function panelFlag(view: "discount" | "coupon") {
	return computed({
		get: () => moreOpen.value && moreView.value === view,
		set: (open: boolean) => {
			if (open) {
				moreView.value = view;
				moreOpen.value = true;
			} else if (moreView.value === view) {
				moreOpen.value = false;
			}
		},
	});
}
const showDiscount = panelFlag("discount");
const showCoupon = panelFlag("coupon");

function openPanel(view: PanelView) {
	if (moreOpen.value && moreView.value === view) {
		moreOpen.value = false;
		return;
	}
	moreView.value = view;
	moreOpen.value = true;
	if (view === "gift") showGiftCard.value = true;
	else if (view === "delivery") {
		showDelivery.value = false;
		void toggleDelivery();
	} else if (view === "discount") nextTick(() => setTimeout(() => discountFormRef.value?.focus()));
}

/** A click on an action button toggles the panel itself; do not let "outside" close it first. */
function keepOpenOnActions(event: Event) {
	const target = (event as CustomEvent<{ originalEvent?: Event }>).detail?.originalEvent?.target;
	if (target instanceof Element && target.closest("[data-cart-actions]")) event.preventDefault();
}

interface CartAction {
	id: string;
	label: string;
	icon: Component;
	testid?: string;
	shortcut?: string;
	disabled?: boolean;
	pressed?: boolean;
	destructive?: boolean;
	run: (fromMenu?: boolean) => void;
}

function menuRun(fromMenu: boolean | undefined, action: () => unknown) {
	if (fromMenu) moreOpen.value = false;
	action();
}

const actionRegistry = computed<Record<string, (CartAction & { available: boolean }) | undefined>>(() => ({
	hold: {
		id: "hold",
		available: true,
		label: __("Hold sale"),
		icon: Pause,
		testid: "hold-order",
		shortcut: "Ctrl+H",
		disabled: cartStore.isEmpty,
		run: (m) => menuRun(m, holdOrder),
	},
	discount: {
		id: "discount",
		available: hasPermission("apply_additional_discount"),
		label: __("Discount"),
		icon: Percent,
		testid: "cart-discount",
		disabled: cartStore.isEmpty,
		pressed: showDiscount.value || hasDiscount.value,
		run: () => openPanel("discount"),
	},
	coupon: {
		id: "coupon",
		available: posStore.allowCouponEntry,
		label: __("Coupon"),
		icon: Ticket,
		testid: "cart-coupon",
		disabled: cartStore.isEmpty,
		pressed: showCoupon.value || !!cartStore.appliedCoupon,
		run: () => openPanel("coupon"),
	},
	clear_discounts: {
		id: "clear_discounts",
		available: true,
		label: __("Clear all discounts"),
		icon: X,
		testid: "clear-discounts",
		disabled: !hasAnyDiscount.value,
		run: (m) => menuRun(m, clearAllDiscounts),
	},
	delivery_charge: {
		id: "delivery_charge",
		available: !cartStore.isReturnMode && posStore.useDeliveryCharges,
		label: cartStore.selectedDeliveryCharge ? __("Change delivery charge") : __("Delivery charge"),
		icon: Truck,
		testid: "cart-delivery",
		disabled: cartStore.isEmpty,
		run: () => openPanel("delivery"),
	},
	restore_draft: {
		id: "restore_draft",
		available: true,
		label: __("Restore draft"),
		icon: FileText,
		testid: "restore-draft",
		run: (m) => menuRun(m, () => cartStore.openDraftDialog()),
	},
	gift_card: {
		id: "gift_card",
		available: canSellGiftCards.value,
		label: __("Sell gift card"),
		icon: Gift,
		testid: "sell-gift-card",
		disabled: !offlineStore.isOnline || (!cartStore.isEmpty && !cartStore.isGiftCardSale),
		run: () => openPanel("gift"),
	},
	sales_order: {
		id: "sales_order",
		available: canSaveAsOrder.value,
		label: __("Save as sales order"),
		icon: ClipboardList,
		testid: "save-as-order",
		disabled: !orderable.value,
		run: (m) => menuRun(m, () => (orderMode.value = "order")),
	},
	quotation: {
		id: "quotation",
		available: canSaveAsOrder.value,
		label: __("Save as quotation"),
		icon: FileText,
		testid: "save-as-quotation",
		disabled: !orderable.value,
		run: (m) => menuRun(m, () => (orderMode.value = "quotation")),
	},
	clear_cart: {
		id: "clear_cart",
		available: true,
		label: __("Clear cart"),
		icon: Trash2,
		testid: "clear-cart",
		destructive: true,
		disabled: cartStore.isEmpty,
		run: (m) => menuRun(m, handleClearCart),
	},
}));

/** The cashier's ordered actions that this sale, profile and user may actually use. */
const orderedActions = computed<CartAction[]>(() =>
	layoutStore.shared.quickActions.footer
		.map((id) => actionRegistry.value[id])
		.filter((action): action is CartAction & { available: boolean } => !!action?.available),
);
const inlineCount = computed(() =>
	visibleActionCount(orderedActions.value.length, layoutStore.policy.min_visible_actions),
);
// Exactly one slot is the More button, so overflow only starts once more than N actions exist.
const inlineActions = computed(() => orderedActions.value.slice(0, inlineCount.value));
const overflowActions = computed(() => orderedActions.value.slice(inlineCount.value));

watch(moreOpen, (open) => {
	if (open) return;
	moreView.value = "menu";
	showGiftCard.value = false;
	showDelivery.value = false;
});

const itemsLabel = computed(() =>
	cartStore.items.length === 1 ? __("1 item") : __("{0} items", [cartStore.items.length]),
);
const showGiftCard = ref(false);
const giftCardValue = ref(0);
const canSellGiftCards = computed(
	() => !!posStore.giftCards && !cartStore.isReturnMode && hasPermission("sell_gift_card"),
);

function addGiftCard() {
	const result = cartStore.addGiftCardLine(giftCardValue.value);
	if (!result.success) {
		showError(result.message || __("Could not add the gift card."));
		return;
	}
	giftCardValue.value = 0;
	showGiftCard.value = false;
	moreOpen.value = false;
}
const showDelivery = ref(false);
const isLoadingDelivery = ref(false);
const availableDeliveryCharges = ref<DeliveryCharge[]>([]);
const discountType = ref("percentage");
const discountInput = ref(0);
const couponInput = ref("");
const couponError = ref("");
const isApplyingCoupon = ref(false);

const hasDiscount = computed(() => cartStore.discountPercentage > 0 || cartStore.discountAmount > 0);

const grandTotalOfferDiscount = computed(() => {
	if (cartStore.offerGrandTotalDiscountPct <= 0) return 0;
	const baseTotal =
		cartStore.subtotal +
		cartStore.calculatedTaxes.filter((t) => !t.included_in_print_rate).reduce((s, t) => s + t.amount, 0) -
		cartStore.offerItemDiscountTotal;
	return (baseTotal * cartStore.offerGrandTotalDiscountPct) / 100;
});

const hasAnyDiscount = computed(
	() =>
		hasDiscount.value ||
		itemDiscountTotal.value > 0 ||
		cartStore.hasOffers ||
		cartStore.offerItemDiscountTotal > 0 ||
		cartStore.offerGrandTotalDiscountPct > 0,
);

function clearAllDiscounts() {
	cartStore.clearAllDiscounts();
	discountInput.value = 0;
	showDiscount.value = false;
	showCoupon.value = false;
}

function handleClearCart() {
	if (cartStore.isEmpty) return;
	window.dispatchEvent(new CustomEvent("xpos:clear-cart"));
}

const itemDiscountTotal = computed(() => {
	return cartStore.items.reduce((sum, item) => {
		const itemTotal = item.qty * item.rate;
		if (item.discount_percentage > 0) {
			return sum + Math.abs((itemTotal * item.discount_percentage) / 100);
		}
		return sum + Math.abs(item.discount_amount || 0);
	}, 0);
});

const discountValue = computed(() => cartStore.additionalDiscount);

const blockingCount = computed(() => cartStore.pendingRequirements.filter((r) => r.blocking).length);
const hasBlockers = computed(() => blockingCount.value > 0);

/** Serial/batch notes point at their line; pricing issues are listed as text. */
const pendingList = computed(() => {
	const entries: { message: string; index?: number }[] = cartStore.pricingIssues.map((message) => ({
		message,
	}));
	// one line per kind; the rows carry the detail, this only points at the first one
	const serials = cartStore.pendingRequirements.filter((r) => r.kind === "serial");
	const batches = cartStore.pendingRequirements.filter((r) => r.kind === "batch");
	if (serials.length) {
		entries.push({
			index: serials[0].index,
			message:
				serials.length === 1
					? serials[0].message
					: __("Choose serial numbers on {0} lines", [serials.length]),
		});
	}
	if (batches.length) {
		entries.push({
			index: batches[0].index,
			message:
				batches.length === 1 ? batches[0].message : __("{0} lines have no batch", [batches.length]),
		});
	}
	return entries;
});

const payDisabled = computed(() => cartStore.isEmpty || !cartStore.customer || hasBlockers.value);

const hasRounding = computed(() => Math.abs(cartStore.roundingAdjustment) >= 0.005);

/** What a dropped connection takes away on this profile, named so the cashier is not surprised. */
const offlineRestrictions = computed(() => {
	const needs: string[] = [];
	if (posStore.giftCardMode || canSellGiftCards.value) needs.push(__("gift cards"));
	if (posStore.useCustomerCredit) needs.push(__("customer credit"));
	if (posStore.allowCouponEntry) needs.push(__("coupons"));
	return needs;
});

function focusLine(index: number) {
	const row = document.querySelector<HTMLElement>(`[data-cart-index="${index}"]`);
	row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
	row?.focus();
}

const payButtonLabel = computed(() => {
	if (cartStore.isEmpty) return __("Add items to pay");
	if (!cartStore.customer) return __("Select customer first");
	if (hasBlockers.value) {
		return blockingCount.value === 1
			? __("Choose serial for 1 line")
			: __("Choose serials for {0} lines", [blockingCount.value]);
	}
	if (posStore.enableCashierSettlement && !cartStore.isReturnMode) return __("Send to Cashier");
	const amt = `${money(Math.abs(cartStore.grandTotal))}`;
	return cartStore.isReturnMode ? __("Process Return {0}", [amt]) : __("Pay {0}", [amt]);
});

function handleCheckout() {
	if (cartStore.isEmpty) return;
	if (posStore.enableCashierSettlement && !cartStore.isReturnMode) {
		if (hasBlockers.value) {
			showError(cartStore.checkoutBlockers.join("\n"));
			return;
		}
		sendToCashier();
		return;
	}
	const opened = cartStore.openPaymentDialog();
	if (!opened.success) showError(opened.message);
}

function openDiscount() {
	if (!hasPermission("apply_additional_discount") || cartStore.isEmpty) return;
	if (!(moreOpen.value && moreView.value === "discount")) openPanel("discount");
}

// F4 / menu "Process Payment" and Ctrl+H come here, so they behave exactly like the buttons.
function onCheckoutRequest(event: Event) {
	event.preventDefault();
	handleCheckout();
}

function onHoldRequest(event: Event) {
	event.preventDefault();
	void holdOrder();
}

onMounted(() => {
	window.addEventListener("xpos:checkout", onCheckoutRequest);
	window.addEventListener("xpos:hold-sale", onHoldRequest);
	window.addEventListener("xpos:focus-discount", openDiscount);
});

onUnmounted(() => {
	window.removeEventListener("xpos:checkout", onCheckoutRequest);
	window.removeEventListener("xpos:hold-sale", onHoldRequest);
	window.removeEventListener("xpos:focus-discount", openDiscount);
});

function applyDiscount() {
	cartStore.setDiscount(discountType.value as "percentage" | "amount", discountInput.value || 0);
}

async function loadDeliveryCharges(): Promise<DeliveryCharge[]> {
	if (!posStore.profileName || !posStore.companyName) {
		availableDeliveryCharges.value = [];
		return [];
	}

	isLoadingDelivery.value = true;
	try {
		const charges = await offerStore.fetchDeliveryCharges(
			posStore.profileName,
			posStore.companyName,
			cartStore.customer?.name || "",
		);
		availableDeliveryCharges.value = charges;
		return charges;
	} finally {
		isLoadingDelivery.value = false;
	}
}

function syncSelectedDeliveryCharge(charges: DeliveryCharge[]) {
	const currentCharge = cartStore.selectedDeliveryCharge;
	const matchingCharge = currentCharge
		? charges.find((charge) => charge.name === currentCharge.name)
		: undefined;

	if (matchingCharge) {
		cartStore.setDeliveryCharge(matchingCharge);
		return;
	}

	if (currentCharge) {
		cartStore.setDeliveryCharge(null);
		showInfo(
			__("Delivery charge {0} is no longer available and was removed.", [
				currentCharge.label || currentCharge.name,
			]),
		);
	}

	if (posStore.autoSetDeliveryCharges && charges.length > 0) {
		cartStore.setDeliveryCharge(charges[0]);
	}
}

async function syncAutoDeliveryCharge() {
	if (cartStore.isReturnMode || cartStore.isEmpty) {
		availableDeliveryCharges.value = [];
		cartStore.setDeliveryCharge(null);
		return;
	}

	if (!posStore.useDeliveryCharges) {
		availableDeliveryCharges.value = [];
		showDelivery.value = false;
		if (cartStore.selectedDeliveryCharge) {
			cartStore.setDeliveryCharge(null);
			showInfo(__("Delivery charges are disabled for this POS Profile; the charge was removed."));
		}
		return;
	}

	if (!posStore.autoSetDeliveryCharges && !cartStore.selectedDeliveryCharge) {
		return;
	}

	const token = cartStore.captureCart();
	const charges = await loadDeliveryCharges();
	if (!cartStore.isCurrentCart(token)) return;
	syncSelectedDeliveryCharge(charges);
}

watch(
	[
		() => posStore.useDeliveryCharges,
		() => posStore.autoSetDeliveryCharges,
		() => posStore.profileName,
		() => posStore.companyName,
		() => cartStore.customer?.name || "",
		() => cartStore.isReturnMode,
		() => cartStore.isEmpty,
	],
	() => {
		void syncAutoDeliveryCharge();
	},
	{ immediate: true },
);

watch(
	() => cartStore.isEmpty,
	(empty) => {
		if (!empty) return;
		discountInput.value = 0;
		discountType.value = "percentage";
		couponInput.value = "";
		couponError.value = "";
		showDiscount.value = false;
		showCoupon.value = false;
		showDelivery.value = false;
	},
);

async function toggleDelivery() {
	showDelivery.value = !showDelivery.value;
	if (showDelivery.value) {
		const charges = await loadDeliveryCharges();
		syncSelectedDeliveryCharge(charges);
	}
}

function selectDeliveryCharge(charge: DeliveryCharge) {
	if (cartStore.selectedDeliveryCharge?.name === charge.name) {
		cartStore.setDeliveryCharge(null);
	} else {
		cartStore.setDeliveryCharge(charge);
	}
}

async function applyCouponCode() {
	if (!couponInput.value) return;
	isApplyingCoupon.value = true;
	couponError.value = "";
	const token = cartStore.captureCart();

	try {
		if (offerStore.offers.length === 0) {
			await offerStore.fetchOffers(
				posStore.profileName,
				cartStore.items.map((i) => i.item_code),
				cartStore.customer?.name || "",
			);
		}

		const result = await offerStore.fetchCoupon(
			couponInput.value,
			cartStore.customer?.name || "",
			posStore.companyName,
		);
		if (!cartStore.isCurrentCart(token)) return;
		if (cartStore.appliedCoupon) cartStore.removeCoupon();
		if (result.coupon) {
			const posOfferName = (result.coupon as Record<string, unknown>).pos_offer as string | undefined;
			const storeOffer = posOfferName
				? offerStore.offers.find((o) => o.name === posOfferName)
				: undefined;
			const linkedOffer = storeOffer || result.offer;
			if (linkedOffer) {
				(result.coupon as Record<string, unknown>)._offer = linkedOffer;
			}
			cartStore.applyCoupon(result.coupon);
			showCoupon.value = false;
			couponInput.value = "";
		} else {
			couponError.value = result.msg || __("Invalid or expired coupon code");
		}
	} catch (error) {
		couponError.value = __("Failed to validate coupon");
	} finally {
		isApplyingCoupon.value = false;
	}
}

function extractErrorMessage(error: unknown): string {
	if (!error) return __("Unknown error");
	if (typeof error === "string") return error;
	const err = error as Record<string, unknown>;
	if (err._server_messages) {
		try {
			const msgs = JSON.parse(err._server_messages as string);
			const parsed = typeof msgs === "string" ? [msgs] : msgs;
			return parsed
				.map((m: string) => {
					try {
						return JSON.parse(m).message || m;
					} catch {
						return m;
					}
				})
				.join(", ");
		} catch {
			/* fallthrough */
		}
	}
	if (err.message && typeof err.message === "string") return err.message;
	if (err.exc_type && typeof err.exc_type === "string") return err.exc_type;
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

async function holdOrder() {
	if (cartStore.isEmpty) return;
	if (cartStore.sourceOrder) {
		showError(__("A sale billing a Sales Order cannot be held. Take payment or clear the cart."));
		return;
	}

	const profileName = posStore.profileName;
	const shiftName = posStore.posOpeningShift?.name || "";

	if (!profileName) {
		showError(__("POS Profile is not set. Please close and reopen the shift."));
		return;
	}

	if (!shiftName) {
		showError(__("No open shift found. Please open a shift first."));
		return;
	}

	try {
		const data = cartStore.getInvoiceData(profileName, shiftName);
		if (!data.customer) {
			const bootCustomer = (window.xpos?.boot as Record<string, unknown>)?.sysdefaults as
				| Record<string, string>
				| undefined;
			data.customer = bootCustomer?.customer || "";
		}

		if (!data.customer) {
			showError(__("Please select a customer before holding the order."));
			return;
		}

		if (!data.items || data.items.length === 0) {
			showError(__("No items in cart to save."));
			return;
		}

		const origin = { cartId: cartStore.cartId, localId: data.local_id };
		const serverData = { ...data };
		if (offlineStore.isOnline) {
			await call("xpos.api.invoices.save_draft_invoice", {
				data: JSON.stringify(serverData),
			});
			cartSessions.finish(origin);
			showSuccess(__("Order saved as draft"));
		} else {
			await offlineStore.saveOffline(
				{ ...serverData, is_draft: true } as Parameters<typeof offlineStore.saveOffline>[0],
				cartStore.customerName || data.customer,
				cartStore.grandTotal || 0,
			);
			cartSessions.finish(origin);
			showSuccess(__("No connection – draft saved offline"));
		}
	} catch (error: unknown) {
		if (handleTabConflict(error)) return;
		showError(__("Failed to save draft: {0}", [extractErrorMessage(error)]));
	}
}

function handleTabConflict(error: unknown): boolean {
	if (!isTabConflictError(error)) return false;

	showError(__("This tab was changed on another terminal. Reload it and try again."));
	cartStore.openDraftDialog();
	return true;
}

async function sendToCashier() {
	if (cartStore.isEmpty) return;

	const profileName = posStore.profileName;
	const shiftName = posStore.posOpeningShift?.name || "";

	if (!profileName) {
		showError(__("POS Profile is not set. Please close and reopen the shift."));
		return;
	}

	if (!shiftName) {
		showError(__("No open shift found. Please open a shift first."));
		return;
	}

	try {
		const data = cartStore.getInvoiceData(profileName, shiftName);
		data.pos_awaiting_settlement = true;

		if (!data.customer) {
			const bootCustomer = (window.xpos?.boot as Record<string, unknown>)?.sysdefaults as
				| Record<string, string>
				| undefined;
			data.customer = bootCustomer?.customer || "";
		}

		if (!data.customer) {
			showError(__("Please select a customer before sending to cashier."));
			return;
		}

		if (!data.items || data.items.length === 0) {
			showError(__("No items in cart to send."));
			return;
		}

		const origin = { cartId: cartStore.cartId, localId: data.local_id };
		const serverData = { ...data };
		if (offlineStore.isOnline) {
			const result = await call<{ name: string }>("xpos.api.invoices.save_draft_invoice", {
				data: JSON.stringify(serverData),
			});
			if (posStore.printBackupReceipt && result?.name) {
				await printInvoice(result.name);
			}
			cartSessions.finish(origin);
			showSuccess(__("Sent to cashier"));
		} else {
			await offlineStore.saveOffline(
				{ ...serverData, is_draft: true } as Parameters<typeof offlineStore.saveOffline>[0],
				cartStore.customerName || data.customer,
				cartStore.grandTotal || 0,
			);
			cartSessions.finish(origin);
			showSuccess(__("No connection – will sync to cashier when back online"));
		}
	} catch (error: unknown) {
		if (handleTabConflict(error)) return;
		showError(__("Failed to send to cashier: {0}", [extractErrorMessage(error)]));
	}
}
</script>
