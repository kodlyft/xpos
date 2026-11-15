<template>
	<div class="flex h-full flex-col">
		<div
			v-if="cartStore.isReturnMode"
			class="flex shrink-0 items-center justify-between gap-2 border-b border-warning/30 bg-warning-soft px-4 py-2 text-warning-soft-foreground"
			role="status"
			data-testid="return-banner"
		>
			<div class="flex min-w-0 items-center gap-2">
				<RotateCcw class="size-4 shrink-0" aria-hidden="true" />
				<span class="text-sm font-semibold">{{ __("Return Mode") }}</span>
				<span v-if="cartStore.returnAgainst" class="truncate font-mono text-xs opacity-80">
					{{ __("against {0}", [cartStore.returnAgainst]) }}
				</span>
			</div>
			<Button
				variant="ghost"
				size="sm"
				class="shrink-0 text-warning-soft-foreground"
				data-testid="exit-return"
				@click="cartStore.exitReturnMode()"
			>
				<X class="size-4" />
				{{ __("Exit") }}
			</Button>
		</div>

		<div class="shrink-0 space-y-2 px-4 pt-3 pb-2">
			<div class="flex items-center justify-between gap-2">
				<h2 class="flex shrink-0 items-center gap-2 text-lg font-bold text-foreground">
					<ShoppingCart class="size-5 shrink-0 text-primary" aria-hidden="true" />
					<span class="truncate" :title="__('Current sale')">{{ __("Sale") }}</span>
				</h2>
				<Autocomplete
					v-if="posStore.salesPersonEnabled && !cartStore.isReturnMode"
					v-model="cartStore.salesPerson"
					doctype="Sales Person"
					query="xpos.api.customers.sales_person_query"
					:filters="{ pos_profile: posStore.profileName }"
					:placeholder="__('Sales Person')"
					:open-on-focus="true"
					:clearable="true"
					:min-chars="0"
					compact
					:show-search-icon="false"
					class="min-w-0 flex-1"
					data-testid="cart-sales-person"
				/>
				<span
					class="shrink-0 rounded-lg border border-border bg-surface-sunken px-2 py-0.5 text-xs font-semibold text-muted-foreground tabular-nums"
					data-testid="cart-item-count"
				>
					{{ unitsLabel }} &middot; {{ productsLabel }}
				</span>
			</div>

			<div
				class="rounded-2xl border border-border bg-surface-raised p-2 shadow-raised"
				:class="cartStore.isReturnMode && 'bg-surface-sunken'"
				data-testid="cart-customer"
			>
				<div class="flex items-center gap-2">
					<button
						type="button"
						class="flex min-w-0 flex-1 items-center gap-2.5 rounded-xl p-0.5 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed"
						:disabled="cartStore.isReturnMode"
						:aria-label="cartStore.customer ? __('Change customer') : __('Select customer')"
						@click="handleCustomerClick"
					>
						<Avatar class="size-9">
							<AvatarImage
								v-if="cartStore.customer?.image"
								:src="cartStore.customer.image as string"
								:alt="cartStore.customer.customer_name"
							/>
							<AvatarFallback class="bg-primary/10 text-sm text-primary">
								<User v-if="!cartStore.customer" class="size-4.5" aria-hidden="true" />
								<template v-else>{{ customerInitials }}</template>
							</AvatarFallback>
						</Avatar>
						<span class="min-w-0 flex-1">
							<span
								class="block truncate text-[0.9375rem] font-semibold leading-tight text-foreground"
							>
								{{ cartStore.customerName }}
							</span>
							<span class="block truncate text-xs text-muted-foreground">
								<template v-if="cartStore.isReturnMode">{{
									__("Customer locked for return")
								}}</template>
								<template v-else-if="!cartStore.customer">{{
									__("Click to select customer")
								}}</template>
								<template
									v-else-if="cartStore.customer.mobile_no || cartStore.customer.email_id"
								>
									{{ cartStore.customer.mobile_no || cartStore.customer.email_id }}
								</template>
								<template v-else>{{ __("Customer") }}</template>
							</span>
						</span>
					</button>
					<Lock
						v-if="cartStore.isReturnMode"
						class="me-2 size-4.5 shrink-0 text-muted-foreground"
					/>
					<template v-else>
						<Button
							variant="outline"
							size="sm"
							class="shrink-0 font-semibold"
							data-testid="customer-change"
							@click="handleCustomerClick"
						>
							{{ cartStore.customer ? __("Change") : __("Select") }}
						</Button>
						<template v-if="cartStore.customer">
							<Button
								variant="outline"
								size="icon-sm"
								class="shrink-0"
								:aria-label="__('Edit Customer')"
								:title="__('Edit Customer')"
								data-testid="customer-edit"
								@click="handleEditCustomer"
							>
								<Pencil class="size-4!" />
							</Button>
							<Button
								variant="outline"
								size="icon-sm"
								class="shrink-0"
								:aria-label="__('Loyalty Program')"
								:title="__('Loyalty Program')"
								data-testid="customer-loyalty"
								@click="customerStore.showLoyaltyDialog = true"
							>
								<Gift class="size-4!" />
							</Button>
						</template>
					</template>
				</div>

				<div
					v-if="showCreditInfo"
					class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border px-2.5 py-1.5 text-xs"
					:class="
						isOverCreditLimit
							? 'border-destructive/30 bg-destructive-soft text-destructive-soft-foreground'
							: 'border-border bg-surface-sunken'
					"
					data-testid="customer-credit-info"
				>
					<span>
						<span class="text-muted-foreground">{{ __("Balance") }}</span>
						<span class="ms-1 font-bold tabular-nums">{{ money(customerBalance ?? 0) }}</span>
					</span>
					<span>
						<span class="text-muted-foreground">{{ __("Credit Limit") }}</span>
						<span class="ms-1 font-bold tabular-nums">
							{{ customerCreditLimit > 0 ? money(customerCreditLimit) : __("No Limit") }}
						</span>
					</span>
					<p
						v-if="isOverCreditLimit"
						class="flex w-full items-center gap-1.5 font-semibold"
						role="alert"
					>
						<AlertTriangle class="size-3.5 shrink-0" />
						{{
							__("This sale exceeds the credit limit by {0}", [
								money(projectedBalance - customerCreditLimit),
							])
						}}
					</p>
				</div>
			</div>
		</div>

		<div ref="cartScrollContainer" class="flex-1 overflow-y-auto px-4 xpos-scrollbar">
			<EmptyState
				v-if="cartStore.isEmpty"
				:icon="ShoppingCart"
				:title="__('Cart is empty')"
				:description="__('Click on items to add them here')"
				class="h-full"
			/>

			<div v-else class="space-y-2 py-1">
				<CartItem
					v-for="(item, index) in cartStore.items"
					:key="
						item.item_code +
						'-' +
						(item.serial_no || '') +
						'-' +
						(item.batch_no || '') +
						'-' +
						index
					"
					:item="item"
					:index="index"
					:currency-symbol="posStore.currencySymbol"
					@update-qty="handleUpdateQty"
					@update-rate="cartStore.updateItemRate"
					@update-discount="cartStore.updateItemDiscount"
					@update-uom="cartStore.updateItemUOM"
					@remove="cartStore.removeItem"
				/>
			</div>
		</div>

		<div
			v-if="(cartStore.hasOffers || posStore.displayAdditionalNotes) && !cartStore.isEmpty"
			class="shrink-0 space-y-2 border-t border-border px-4 py-2"
		>
			<div v-if="cartStore.hasOffers" class="flex flex-wrap gap-1.5" data-testid="cart-offers">
				<span
					v-for="offer in cartStore.appliedOffers"
					:key="offer.name"
					class="inline-flex max-w-full items-center gap-1 rounded-lg border border-success/30 bg-success-soft py-0.5 ps-2 pe-0.5 text-xs font-medium text-success-soft-foreground"
				>
					<Ticket class="size-3.5 shrink-0" aria-hidden="true" />
					<span class="truncate">{{ offer.offer_name || offer.name }}</span>
					<button
						type="button"
						class="rounded-md p-0.5 hover:bg-success/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
						:aria-label="__('Remove offer {0}', [String(offer.offer_name || offer.name)])"
						@click="cartStore.removeOffer(offer.name)"
					>
						<X class="size-3.5" />
					</button>
				</span>
				<span
					v-if="cartStore.appliedCoupon"
					class="inline-flex max-w-full items-center gap-1 rounded-lg border border-info/30 bg-info-soft py-0.5 ps-2 pe-0.5 text-xs font-medium text-info-soft-foreground"
				>
					<Ticket class="size-3.5 shrink-0" aria-hidden="true" />
					<span class="truncate">
						{{ __("Coupon") }}:
						{{ cartStore.appliedCoupon.coupon_code || cartStore.appliedCoupon.name }}
					</span>
					<button
						type="button"
						class="rounded-md p-0.5 hover:bg-info/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
						:aria-label="__('Remove coupon')"
						@click="cartStore.removeCoupon()"
					>
						<X class="size-3.5" />
					</button>
				</span>
			</div>
			<textarea
				v-if="posStore.displayAdditionalNotes"
				v-model="cartStore.orderNotes"
				rows="1"
				:placeholder="__('Add order notes...')"
				:aria-label="__('Order notes')"
				class="block w-full resize-none rounded-xl border border-border bg-card px-3 py-1.5 text-sm shadow-inset focus:outline-none focus:ring-4 focus:ring-primary/12"
			/>
		</div>

		<CartSummary />
		<CustomerEditDialog />
	</div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from "vue";
import { usePosStore } from "@/stores/posStore";
import { useCartStore } from "@/stores/cartStore";
import { useCustomerStore } from "@/stores/customerStore";
import { showError } from "@/services/api";
import { useMoney } from "@/composables/useMoney";
import CartItem from "./CartItem.vue";
import CartSummary from "./CartSummary.vue";
import { Button } from "@/components/ui/button";
import { Autocomplete } from "@/components/ui/autocomplete";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { EmptyState } from "@/components/ui/state";
import { ShoppingCart, User, RotateCcw, X, Lock, Gift, Pencil, AlertTriangle, Ticket } from "lucide-vue-next";
import { initials } from "@/lib/utils";
import __ from "@/lib/translate";
import CustomerEditDialog from "@/components/dialogs/CustomerEditDialog.vue";

const posStore = usePosStore();
const cartStore = useCartStore();
const customerStore = useCustomerStore();
const { money, qty } = useMoney();

const cartScrollContainer = ref<HTMLElement | null>(null);
const customerInitials = computed(() => initials(cartStore.customerName));

onMounted(() => {
	window.addEventListener("xpos:focus-cart-item", handleFocusCartItem);
});

onUnmounted(() => {
	window.removeEventListener("xpos:focus-cart-item", handleFocusCartItem);
});

function handleFocusCartItem() {
	if (cartStore.isEmpty) return;
	const firstItemEl = document.querySelector('[data-cart-index="0"]');
	const allInputs = firstItemEl?.querySelectorAll('input[type="number"]');
	if (!allInputs || allInputs.length === 0) return;
	const qtyEl = (allInputs.length > 1 ? allInputs[1] : allInputs[0]) as HTMLInputElement;
	qtyEl.focus();
	qtyEl.select();
}

watch(
	() => cartStore.items.length,
	(newLen, oldLen) => {
		if (newLen > oldLen) {
			nextTick(() => {
				const container = cartScrollContainer.value;
				if (!container) return;

				container.scrollTo({
					top: container.scrollHeight,
					behavior: "smooth",
				});

				const rows = container.querySelectorAll<HTMLElement>("[data-cart-index]");
				const lastChild = rows[rows.length - 1];
				if (lastChild) {
					lastChild.classList.add("ring-2", "ring-primary/50");
					setTimeout(() => {
						lastChild.classList.remove("ring-2", "ring-primary/50");
					}, 800);
				}
			});
		}
	},
);

watch(
	() => cartStore.customer?.name,
	(name) => {
		if (name && posStore.showCustomerBalance) customerStore.getCustomerInfo(name);
	},
	{ immediate: true },
);

const unitsLabel = computed(() => {
	const units = cartStore.items.reduce((sum, item) => sum + Math.abs(Number(item.qty) || 0), 0);
	return units === 1 ? __("1 unit") : __("{0} units", [qty(units)]);
});
const productsLabel = computed(() => {
	const products = new Set(cartStore.items.map((item) => item.item_code)).size;
	return products === 1 ? __("1 product") : __("{0} products", [products]);
});

const customerFinancials = computed(() =>
	cartStore.customer && customerStore.selectedCustomerInfo?.name === cartStore.customer.name
		? customerStore.selectedCustomerInfo
		: null,
);
const customerBalance = computed(() => customerFinancials.value?.balance ?? null);
const customerCreditLimit = computed(() => customerFinancials.value?.credit_limit ?? 0);
const projectedBalance = computed(() => (customerBalance.value ?? 0) + Math.max(cartStore.grandTotal, 0));
const isOverCreditLimit = computed(
	() => customerCreditLimit.value > 0 && projectedBalance.value > customerCreditLimit.value,
);
const showCreditInfo = computed(
	() =>
		posStore.showCustomerBalance &&
		!cartStore.isReturnMode &&
		((customerBalance.value ?? 0) > 0 || customerCreditLimit.value > 0),
);

function handleCustomerClick() {
	if (cartStore.isReturnMode) {
		showError(__("Customer cannot be changed in return mode"));
		return;
	}
	customerStore.showCustomerDialog = true;
	customerStore.searchCustomers();
}

function handleEditCustomer() {
	customerStore.showCustomerEditDialog = true;
}

function handleUpdateQty(index: number, qty: number) {
	const result = cartStore.updateItemQty(index, qty);
	if (!result.success && result.message) {
		showError(result.message);
	}
}
</script>
