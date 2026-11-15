<template>
	<aside
		ref="panelRef"
		role="dialog"
		aria-modal="false"
		aria-labelledby="customize-title"
		tabindex="-1"
		class="flex max-h-full w-88 max-w-full shrink-0 flex-col max-sm:w-full overflow-hidden rounded-2xl border border-primary/40 bg-card shadow-raised focus:outline-none"
		data-testid="customize-panel"
		@keydown.esc.stop="cancel"
	>
		<header class="shrink-0 border-b border-border px-4 py-3">
			<h2 id="customize-title" class="flex items-center gap-2 text-base font-bold">
				<SlidersHorizontal class="size-4.5 text-primary" aria-hidden="true" />
				{{ __("Customize view") }}
			</h2>
			<p class="mt-0.5 text-xs text-muted-foreground">
				{{ __("Changes preview live. Layout for this screen size: {0}.", [deviceLabel]) }}
			</p>
		</header>

		<div
			v-if="store.conflict"
			class="shrink-0 space-y-2 border-b border-warning/30 bg-warning-soft px-4 py-3 text-sm text-warning-soft-foreground"
			role="alert"
			data-testid="layout-conflict"
		>
			<p class="font-semibold">{{ __("This layout was changed on another device.") }}</p>
			<div class="flex gap-2">
				<Button size="sm" data-testid="conflict-keep-mine" @click="store.keepMine()">{{
					__("Keep mine")
				}}</Button>
				<Button
					size="sm"
					variant="outline"
					data-testid="conflict-use-theirs"
					@click="store.useTheirs()"
					>{{ __("Use theirs") }}</Button
				>
			</div>
		</div>

		<div v-if="draft" class="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-3 xpos-scrollbar">
			<section aria-labelledby="cz-pinned" data-testid="cz-pinned">
				<h3 id="cz-pinned" class="mb-1.5 text-sm font-semibold">{{ __("Pinned items") }}</h3>
				<p v-if="locks.pinned_items" class="text-xs text-muted-foreground">
					{{ __("Set by your manager.") }}
				</p>
				<template v-else>
					<ReorderList
						v-if="pinnedEntries.length"
						:items="pinnedEntries"
						:label="__('Pinned items')"
						removable
						@reorder="(ids) => (draft!.shared.pinnedItems = ids)"
						@remove="removePinned"
					/>
					<p v-else class="text-xs text-muted-foreground">{{ __("Nothing pinned yet.") }}</p>
					<div v-if="pinnedEntries.length < policy.max_pinned_items" class="relative mt-2">
						<Input
							v-model="pinSearch"
							size="compact"
							:placeholder="
								offline ? __('Search needs a connection') : __('Search an item to pin...')
							"
							:disabled="offline"
							:aria-label="__('Search an item to pin')"
							data-testid="pin-search"
							@input="searchPins"
						/>
						<ul
							v-if="pinResults.length"
							class="mt-1 max-h-40 overflow-y-auto rounded-lg border border-border bg-card"
							role="listbox"
						>
							<li
								v-for="row in pinResults"
								:key="row.item_code"
								role="option"
								:aria-selected="false"
							>
								<Button
									variant="ghost"
									size="sm"
									class="w-full justify-start truncate rounded-none"
									data-testid="pin-result"
									@click="addPinned(row)"
								>
									{{ row.item_name }}
								</Button>
							</li>
						</ul>
					</div>
					<p v-else class="mt-1 text-xs text-muted-foreground">
						{{ __("Limit reached ({0}).", [policy.max_pinned_items]) }}
					</p>
				</template>
			</section>

			<section aria-labelledby="cz-favs" data-testid="cz-favorites">
				<h3 id="cz-favs" class="mb-1.5 text-sm font-semibold">{{ __("Favorite categories") }}</h3>
				<p v-if="locks.favorite_categories" class="text-xs text-muted-foreground">
					{{ __("Set by your manager.") }}
				</p>
				<template v-else>
					<ReorderList
						v-if="favoriteEntries.length"
						:items="favoriteEntries"
						:label="__('Favorite categories')"
						removable
						@reorder="(ids) => (draft!.shared.favoriteCategories = ids)"
						@remove="
							(id) =>
								(draft!.shared.favoriteCategories = draft!.shared.favoriteCategories.filter(
									(n) => n !== id,
								))
						"
					/>
					<Select
						v-if="favoriteEntries.length < policy.max_favorite_categories && addableGroups.length"
						:key="favoriteEntries.length"
						:model-value="''"
						:items="addableGroups.map((name) => ({ label: __(name), value: name }))"
						:placeholder="__('Add a category...')"
						class="mt-2 w-full"
						data-testid="favorite-add"
						@update:model-value="addFavorite"
					/>
				</template>
			</section>

			<section aria-labelledby="cz-view" data-testid="cz-view">
				<h3 id="cz-view" class="mb-1.5 text-sm font-semibold">{{ __("Product list") }}</h3>
				<p v-if="locks.view_and_density" class="text-xs text-muted-foreground">
					{{ __("Set by your manager.") }}
				</p>
				<template v-else>
					<div class="grid grid-cols-2 gap-1.5" role="radiogroup" :aria-label="__('Grid or list')">
						<Button
							v-for="mode in VIEWS"
							:key="mode"
							:variant="draft.shared.view === mode ? 'default' : 'outline'"
							size="sm"
							role="radio"
							:aria-checked="draft.shared.view === mode"
							:data-testid="`view-${mode}`"
							@click="draft!.shared.view = mode"
						>
							{{ mode === "grid" ? __("Grid") : __("List") }}
						</Button>
					</div>
					<div class="mt-2 grid grid-cols-3 gap-1.5" role="radiogroup" :aria-label="__('Density')">
						<Button
							v-for="level in DENSITIES"
							:key="level"
							:variant="draft.device[deviceClass].density === level ? 'default' : 'outline'"
							size="sm"
							role="radio"
							:aria-checked="draft.device[deviceClass].density === level"
							:data-testid="`density-${level}`"
							@click="draft!.device[deviceClass].density = level"
						>
							{{ densityLabel[level] }}
						</Button>
					</div>
				</template>
			</section>

			<section aria-labelledby="cz-display" data-testid="cz-display">
				<h3 id="cz-display" class="mb-1.5 text-sm font-semibold">{{ __("Show on products") }}</h3>
				<p v-if="locks.product_display" class="text-xs text-muted-foreground">
					{{ __("Set by your manager.") }}
				</p>
				<div v-else class="space-y-1">
					<label
						v-for="field in policy.allowed_display_fields"
						:key="field"
						class="flex items-center gap-2 text-sm"
					>
						<Checkbox
							:checked="draft.shared.productDisplay.includes(field)"
							:data-testid="`display-${field}`"
							@update:checked="toggleDisplay(field, $event === true)"
						/>
						{{ displayLabel[field] ?? field }}
					</label>
					<p class="text-xs text-muted-foreground">
						{{ __("Price and out-of-stock notices always show.") }}
					</p>
				</div>
			</section>

			<section v-if="wide" aria-labelledby="cz-cart" data-testid="cz-cart">
				<h3 id="cz-cart" class="mb-1.5 text-sm font-semibold">{{ __("Cart") }}</h3>
				<p v-if="locks.cart_layout" class="text-xs text-muted-foreground">
					{{ __("Set by your manager.") }}
				</p>
				<template v-else>
					<div class="grid grid-cols-2 gap-1.5" role="radiogroup" :aria-label="__('Cart side')">
						<Button
							v-for="side in CART_SIDES"
							:key="side"
							:variant="draft.device[deviceClass].cartSide === side ? 'default' : 'outline'"
							size="sm"
							role="radio"
							:aria-checked="draft.device[deviceClass].cartSide === side"
							:data-testid="`cart-${side}`"
							@click="draft!.device[deviceClass].cartSide = side"
						>
							{{ side === "left" ? __("Start") : __("End") }}
						</Button>
					</div>
					<p class="mt-2 text-xs text-muted-foreground">
						{{ __("Open carts bar on small screens") }}
					</p>
					<div
						class="mt-1 grid grid-cols-2 gap-1.5"
						role="radiogroup"
						:aria-label="__('Open carts bar')"
						data-testid="cz-cart-tabs"
					>
						<Button
							v-for="place in CART_TAB_PLACEMENTS"
							:key="place"
							:variant="draft.device[deviceClass].cartTabs === place ? 'default' : 'outline'"
							size="sm"
							role="radio"
							:aria-checked="draft.device[deviceClass].cartTabs === place"
							:data-testid="`cart-tabs-${place}`"
							@click="draft!.device[deviceClass].cartTabs = place"
						>
							{{ place === "top" ? __("Top") : __("Bottom") }}
						</Button>
					</div>
					<div class="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
						<span class="shrink-0">{{ __("Width (px)") }}</span>
						<NumberInput
							:model-value="draft.device[deviceClass].cartWidth ?? currentCartWidth"
							:min="360"
							:max="640"
							:step="8"
							:precision="0"
							class="flex-1"
							data-testid="cart-width"
							@update:model-value="
								(value: number) => (draft!.device[deviceClass].cartWidth = Math.round(value))
							"
						/>
					</div>
				</template>
			</section>

			<section aria-labelledby="cz-actions" data-testid="cz-actions">
				<h3 id="cz-actions" class="mb-1.5 text-sm font-semibold">{{ __("Cart buttons") }}</h3>
				<p v-if="locks.quick_actions" class="text-xs text-muted-foreground">
					{{ __("Set by your manager.") }}
				</p>
				<template v-else>
					<p class="mb-1 text-xs text-muted-foreground">
						{{ __("The first {0} show on the cart; the rest go in More.", [visibleCount]) }}
					</p>
					<ReorderList
						:items="footerEntries"
						:label="__('Cart buttons')"
						:divider-at="visibleCount"
						:divider-label="__('More menu')"
						@reorder="(ids) => reorderActions('footer', ids)"
					/>
					<h4 class="mb-1 mt-3 text-xs font-semibold text-muted-foreground">
						{{ __("Cart line buttons") }}
					</h4>
					<ReorderList
						:items="rowEntries"
						:label="__('Cart line buttons')"
						:divider-at="visibleCount"
						:divider-label="__('More menu')"
						@reorder="(ids) => reorderActions('row', ids)"
					/>
				</template>
			</section>
		</div>

		<footer class="shrink-0 space-y-2 border-t border-border px-4 py-3">
			<p v-if="store.error" class="text-xs text-destructive-soft-foreground" role="alert">
				{{ store.error }}
			</p>
			<p v-if="offline" class="text-xs text-warning-soft-foreground" role="status">
				{{ __("Offline: changes are saved here and sync when you reconnect.") }}
			</p>
			<div class="flex items-center gap-2">
				<Button
					class="flex-1"
					:loading="store.saving"
					:disabled="!store.dirty"
					data-testid="customize-save"
					@click="save"
					>{{ __("Save") }}</Button
				>
				<Button variant="outline" class="flex-1" data-testid="customize-cancel" @click="cancel">{{
					__("Cancel")
				}}</Button>
			</div>
			<Button
				v-if="!confirmReset"
				variant="ghost"
				size="sm"
				class="w-full"
				data-testid="customize-reset"
				@click="confirmReset = true"
			>
				<RotateCcw class="size-3.5" />{{ __("Reset to defaults") }}
			</Button>
			<div v-else class="flex items-center gap-2 text-xs">
				<span class="flex-1">{{ __("Discard your saved layout?") }}</span>
				<Button
					size="sm"
					variant="destructive"
					data-testid="customize-reset-confirm"
					@click="reset"
					>{{ __("Reset") }}</Button
				>
				<Button size="sm" variant="outline" @click="confirmReset = false">{{ __("Keep") }}</Button>
			</div>
		</footer>
	</aside>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { RotateCcw, SlidersHorizontal } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { NumberInput } from "@/components/ui/number-input";
import { Select } from "@/components/ui/select";
import ReorderList from "@/components/core/ReorderList.vue";
import { call } from "@/services/api";
import { CART_SIDES, CART_TAB_PLACEMENTS, DENSITIES, VIEWS, visibleActionCount } from "@/services/posLayout";
import { useLayoutStore } from "@/stores/layoutStore";
import { useItemStore } from "@/stores/itemStore";
import { usePosStore } from "@/stores/posStore";
import { hasPermission } from "@/services/userRights";
import { isOnline } from "@/utils";
import type { POSItem } from "@/types/pos.types";
import __ from "@/lib/translate";

defineProps<{ currentCartWidth: number; wide: boolean }>();
const emit = defineEmits<{ (e: "close"): void }>();

const store = useLayoutStore();
const itemStore = useItemStore();
const posStore = usePosStore();

const panelRef = ref<HTMLElement | null>(null);
const confirmReset = ref(false);
const pinSearch = ref("");
const pinResults = ref<POSItem[]>([]);
let searchTimer: ReturnType<typeof setTimeout> | undefined;

const draft = computed(() => store.draft);
const policy = computed(() => store.policy);
const locks = computed(() => store.policy.locks);
const deviceClass = computed(() => store.deviceClass);
const offline = computed(() => !isOnline());
const deviceLabel = computed(
	() => ({ desktop: __("Desktop"), tablet: __("Tablet"), phone: __("Phone") })[deviceClass.value],
);
const visibleCount = computed(() =>
	visibleActionCount(Number.MAX_SAFE_INTEGER, policy.value.min_visible_actions),
);

const densityLabel = { compact: __("Compact"), comfortable: __("Comfortable"), touch: __("Touch") } as const;
const displayLabel: Record<string, string> = {
	image: __("Image"),
	item_code: __("Item code"),
	stock: __("Stock level"),
	uom: __("Unit"),
};
const footerLabel: Record<string, string> = {
	hold: __("Hold sale"),
	discount: __("Discount"),
	coupon: __("Coupon"),
	clear_discounts: __("Clear all discounts"),
	delivery_charge: __("Delivery charge"),
	restore_draft: __("Restore draft"),
	gift_card: __("Sell gift card"),
	sales_order: __("Save as sales order"),
	quotation: __("Save as quotation"),
	clear_cart: __("Clear cart"),
};
const rowLabel: Record<string, string> = {
	uom: __("Unit of measure"),
	tracking: __("Serial / batch"),
	item_discount: __("Item discount"),
	remove: __("Remove line"),
};

const pinnedEntries = computed(() =>
	(draft.value?.shared.pinnedItems ?? []).map((id) => ({ id, label: store.itemInfo[id]?.item_name ?? id })),
);
const favoriteEntries = computed(() =>
	(draft.value?.shared.favoriteCategories ?? []).map((id) => ({ id, label: __(id) })),
);
/** Only buttons this profile and user can actually use are listed, so the order shown is what the cart shows. */
const footerUsable: Record<string, () => boolean> = {
	discount: () => hasPermission("apply_additional_discount"),
	coupon: () => posStore.allowCouponEntry,
	delivery_charge: () => posStore.useDeliveryCharges,
	gift_card: () => !!posStore.giftCards && hasPermission("sell_gift_card"),
	sales_order: () => posStore.allowSalesOrder,
	quotation: () => posStore.allowSalesOrder,
};
const rowUsable: Record<string, () => boolean> = {
	item_discount: () => hasPermission("show_edit_discount_field"),
};
const footerEntries = computed(() =>
	(draft.value?.shared.quickActions.footer ?? [])
		.filter((id) => footerUsable[id]?.() ?? true)
		.map((id) => ({ id, label: footerLabel[id] ?? id })),
);
const rowEntries = computed(() =>
	(draft.value?.shared.quickActions.row ?? [])
		.filter((id) => rowUsable[id]?.() ?? true)
		.map((id) => ({ id, label: rowLabel[id] ?? id })),
);

/** Reorder the listed buttons; buttons not usable here keep their place after them. */
function reorderActions(kind: "footer" | "row", ids: string[]) {
	if (!draft.value) return;
	const all = draft.value.shared.quickActions[kind];
	draft.value.shared.quickActions[kind] = [...ids, ...all.filter((id) => !ids.includes(id))];
}
const addableGroups = computed(() =>
	itemStore.itemGroups
		.map((group) => group.name)
		.filter((name) => !(draft.value?.shared.favoriteCategories ?? []).includes(name)),
);

function removePinned(id: string) {
	if (draft.value)
		draft.value.shared.pinnedItems = draft.value.shared.pinnedItems.filter((code) => code !== id);
}

function addPinned(row: POSItem) {
	if (!draft.value || draft.value.shared.pinnedItems.includes(row.item_code)) return;
	store.itemInfo[row.item_code] = row;
	draft.value.shared.pinnedItems = [...draft.value.shared.pinnedItems, row.item_code];
	pinSearch.value = "";
	pinResults.value = [];
}

function searchPins() {
	clearTimeout(searchTimer);
	const term = pinSearch.value.trim();
	if (!term || offline.value) {
		pinResults.value = [];
		return;
	}
	searchTimer = setTimeout(async () => {
		try {
			pinResults.value = await call<POSItem[]>("xpos.api.items.get_pos_items", {
				pos_profile: posStore.profileName,
				search_term: term,
				page_length: 6,
			});
		} catch {
			pinResults.value = [];
		}
	}, 250);
}

function addFavorite(name: string | undefined) {
	if (name && draft.value && !draft.value.shared.favoriteCategories.includes(name)) {
		draft.value.shared.favoriteCategories = [...draft.value.shared.favoriteCategories, name];
	}
}

function toggleDisplay(field: string, on: boolean) {
	if (!draft.value) return;
	const current = draft.value.shared.productDisplay.filter((name) => name !== field);
	draft.value.shared.productDisplay = on
		? policy.value.allowed_display_fields.filter((name) => name === field || current.includes(name))
		: current;
}

async function save() {
	if (await store.save()) emit("close");
}

function cancel() {
	store.cancelCustomize();
	emit("close");
}

async function reset() {
	confirmReset.value = false;
	if (await store.reset()) emit("close");
}

onMounted(() => panelRef.value?.focus());
</script>
