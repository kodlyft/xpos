<template>
	<div class="flex flex-col h-full">
		<div
			v-if="cartStore.isReturnMode"
			class="shrink-0 bg-amber-500/10 border-b border-amber-500/20 px-4 py-2 flex items-center justify-between"
		>
			<div class="flex items-center gap-2">
				<RotateCcw class="w-4 h-4 text-amber-600" />
				<span class="text-sm font-semibold text-amber-700 dark:text-amber-400">{{
					__("Return Mode")
				}}</span>
				<span
					v-if="cartStore.returnAgainst"
					class="text-xs text-amber-600/70 dark:text-amber-400/70 font-mono"
				>
					{{ cartStore.returnAgainst }}
				</span>
			</div>
			<Button
				variant="ghost"
				size="icon-sm"
				class="text-amber-600 hover:text-amber-700"
				@click="cartStore.exitReturnMode()"
			>
				<X class="w-4 h-4" />
			</Button>
		</div>

		<div class="shrink-0 px-4 pt-4 pb-3 border-b">
			<div class="flex flex-wrap items-center justify-between mb-3 gap-2">
				<h2 class="shrink-0 text-base font-bold text-foreground flex items-center gap-2">
					<ShoppingCart class="w-5 h-5 text-primary dark:text-primary" />
					{{ __("Cart") }}
					<Badge v-if="cartStore.itemCount > 0" variant="secondary" class="text-[10px]">
						{{ cartStore.itemCount }}
					</Badge>
				</h2>
				<div class="flex flex-1 min-w-50 items-center justify-end gap-2">
					<Autocomplete
						v-if="posStore.salesPersonEnabled && !cartStore.isReturnMode"
						v-model="cartStore.salesPerson"
						doctype="Sales Person"
						query="xpos.api.customers.sales_person_query"
						:filters="{ pos_profile: posStore.profileName }"
						:placeholder="__('Sales Person')"
						:open-on-focus="true"
						:clearable="true"
						:compact="true"
						:min-chars="0"
						class="min-w-0 flex-1 max-w-44"
					/>
					<Button
						v-if="cartStore.customer && !cartStore.isReturnMode"
						variant="outline"
						size="sm"
						class="shrink-0 w-fit justify-start gap-2 border-violet-300 text-violet-600 hover:bg-violet-50 dark:border-violet-700 dark:text-violet-400 dark:hover:bg-violet-900/20"
						@click="customerStore.showLoyaltyDialog = true"
					>
						<Gift class="w-4 h-4" />
						{{ __("Loyalty Program") }}
					</Button>
				</div>
			</div>

			<div class="w-full flex items-center gap-2">
				<button
					@click="handleCustomerClick"
					class="flex-[0.9] flex items-center gap-3 p-2.5 rounded-lg border transition-all duration-200 group"
					:class="
						cartStore.isReturnMode
							? 'border-border bg-muted/50 cursor-not-allowed dark:border-muted-foreground/30'
							: 'border-dashed border-border hover:border-primary hover:bg-primary/5 dark:border-muted-foreground/30 dark:hover:border-primary'
					"
					:disabled="cartStore.isReturnMode"
				>
					<Avatar size="sm" class="group-hover:ring-2 group-hover:ring-primary/20 transition-all">
						<img
							v-if="cartStore.customer && cartStore.customer.image"
							:src="cartStore.customer.image as string"
							:alt="cartStore.customer.customer_name"
							class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
							loading="lazy"
						/>
						<AvatarFallback>
							<User class="w-3.5 h-3.5" />
						</AvatarFallback>
					</Avatar>
					<div class="text-start flex-1 min-w-0">
						<p class="text-sm font-medium text-foreground truncate">
							{{ cartStore.customerName }}
						</p>
						<template v-if="cartStore.customer">
							<div class="flex items-center gap-1.5 text-[10px] text-muted-foreground">
								<template v-if="cartStore.customer.mobile_no">
									<Phone class="w-3 h-3 shrink-0" />
									<span class="truncate">{{ cartStore.customer.mobile_no }}</span>
								</template>
								<template v-if="cartStore.customer.email_id">
									<Mail
										class="w-3 h-3 shrink-0"
										:class="{ 'ms-1': cartStore.customer.mobile_no }"
									/>
									<span class="truncate">{{ cartStore.customer.email_id }}</span>
								</template>
							</div>
							<p
								v-if="!cartStore.customer.mobile_no && !cartStore.customer.email_id"
								class="text-[11px] text-muted-foreground"
							>
								{{
									cartStore.isReturnMode
										? __("Customer locked for return")
										: __("Click to change customer")
								}}
							</p>
						</template>
						<p v-else class="text-[11px] text-muted-foreground">
							{{ __("Click to select customer") }}
						</p>
					</div>
					<Lock v-if="cartStore.isReturnMode" class="w-4 h-4 text-muted-foreground/50" />
					<ChevronDown v-else class="w-4 h-4 text-muted-foreground/50" />
				</button>
				<button
					v-if="cartStore.customer && !cartStore.isReturnMode"
					class="flex-[0.1] flex items-center gap-3 p-4 rounded-lg border transition-all duration-200 group border-dashed border-border hover:border-primary hover:bg-primary/5 dark:border-muted-foreground/30 dark:hover:border-primary"
					@click.stop="handleEditCustomer"
					title="Edit Customer"
				>
					<Pencil class="w-full" />
				</button>
			</div>

			<div v-if="showCreditInfo" class="mt-3 grid grid-cols-2 gap-2">
				<div
					class="rounded-lg border p-2.5"
					:class="isOverCreditLimit ? 'border-destructive/40 bg-destructive/5' : 'border-border bg-muted/30'"
				>
					<p class="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
						{{ __("Balance") }}
					</p>
					<p
						class="text-2xl font-extrabold"
						:class="isOverCreditLimit ? 'text-destructive' : 'text-foreground'"
					>
						{{ money(customerBalance ?? 0) }}
					</p>
				</div>
				<div
					class="rounded-lg border p-2.5"
					:class="isOverCreditLimit ? 'border-destructive/40 bg-destructive/5' : 'border-border bg-muted/30'"
				>
					<p class="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
						{{ __("Credit Limit") }}
					</p>
					<p
						class="text-2xl font-extrabold"
						:class="isOverCreditLimit ? 'text-destructive' : 'text-foreground'"
					>
						{{ customerCreditLimit > 0 ? money(customerCreditLimit) : __("No Limit") }}
					</p>
				</div>
				<p
					v-if="isOverCreditLimit"
					class="col-span-2 flex items-center gap-1.5 text-xs font-semibold text-destructive"
				>
					<AlertTriangle class="w-3.5 h-3.5 shrink-0" />
					{{ __("This sale exceeds the credit limit by {0}", [money(projectedBalance - customerCreditLimit)]) }}
				</p>
			</div>
		</div>

		<div ref="cartScrollContainer" class="flex-1 overflow-y-auto px-4 xpos-scrollbar">
			<div
				v-if="cartStore.isEmpty"
				class="flex flex-col items-center justify-center h-full text-center py-8"
			>
				<div class="w-20 h-20 rounded-full bg-muted flex items-center justify-center mb-4">
					<ShoppingCart class="w-10 h-10 text-muted-foreground/40" />
				</div>
				<p class="text-sm font-medium text-muted-foreground">{{ __("Cart is empty") }}</p>
				<p class="text-xs text-muted-foreground/70 mt-1">
					{{ __("Click on items to add them here") }}
				</p>
			</div>

			<div v-else class="space-y-0.5 py-0.5">
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
			v-if="posStore.displayAdditionalNotes && !cartStore.isEmpty"
			class="shrink-0 px-4 py-2 border-t border-border"
		>
			<textarea
				v-model="cartStore.orderNotes"
				rows="2"
				placeholder="Add order notes..."
				class="w-full text-xs rounded-md border border-input bg-background px-3 py-1.5 ring-offset-background focus:outline-none focus:ring-1 focus:ring-ring resize-none"
			/>
		</div>

		<div v-if="cartStore.hasOffers && !cartStore.isEmpty" class="shrink-0 px-4 pb-2 space-y-1">
			<div
				v-for="offer in cartStore.appliedOffers"
				:key="offer.name"
				class="flex items-center justify-between bg-emerald-500/5 border border-emerald-500/20 rounded-lg px-3 py-1.5 text-xs"
			>
				<span class="text-emerald-700 dark:text-emerald-400 font-medium">
					{{ offer.offer_name || offer.name }}
				</span>
				<button
					@click="cartStore.removeOffer(offer.name)"
					class="text-muted-foreground hover:text-destructive"
				>
					<X class="w-3.5 h-3.5" />
				</button>
			</div>
			<div
				v-if="cartStore.appliedCoupon"
				class="flex items-center justify-between bg-violet-500/5 border border-violet-500/20 rounded-lg px-3 py-1.5 text-xs"
			>
				<span class="text-violet-700 dark:text-violet-400 font-medium">
					{{ __("Coupon") }}:
					{{ cartStore.appliedCoupon.coupon_code || cartStore.appliedCoupon.name }}
				</span>
				<button
					@click="cartStore.removeCoupon()"
					class="text-muted-foreground hover:text-destructive"
				>
					<X class="w-3.5 h-3.5" />
				</button>
			</div>
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
import { Badge } from "@/components/ui/badge";
import { Autocomplete } from "@/components/ui/autocomplete";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
	ShoppingCart,
	User,
	ChevronDown,
	RotateCcw,
	X,
	Lock,
	Gift,
	Phone,
	Mail,
	Pencil,
	AlertTriangle,
} from "lucide-vue-next";
import __ from "@/lib/translate";
import CustomerEditDialog from "@/components/dialogs/CustomerEditDialog.vue";

const posStore = usePosStore();
const cartStore = useCartStore();
const customerStore = useCustomerStore();
const { money } = useMoney();

const cartScrollContainer = ref<HTMLElement | null>(null);

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

				const lastChild = container.querySelector(".space-y-1 > :last-child") as HTMLElement | null;
				if (lastChild) {
					lastChild.classList.add("ring-2", "ring-primary/50", "rounded-xl");
					setTimeout(() => {
						lastChild.classList.remove("ring-2", "ring-primary/50", "rounded-xl");
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
