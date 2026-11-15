<template>
	<div class="shrink-0 space-y-1.5 px-3" data-testid="cart-tabs" :data-placement="placement">
		<div
			v-if="sessions.persistError"
			class="flex items-center gap-2 rounded-lg border border-warning/30 bg-warning-soft px-3 py-1.5 text-xs text-warning-soft-foreground"
			role="alert"
			data-testid="cart-persist-error"
		>
			<AlertTriangle class="size-4 shrink-0" aria-hidden="true" />
			<span class="min-w-0 flex-1">
				{{ __("Open carts are not being saved on this device. They stay usable until you reload.") }}
			</span>
		</div>

		<div
			v-if="sessions.ownership === 'other' || sessions.ownership === 'lost'"
			class="flex items-center gap-2 rounded-lg border border-info/30 bg-info-soft px-3 py-1.5 text-xs text-info-soft-foreground"
			role="status"
			data-testid="cart-owner-banner"
		>
			<Layers class="size-4 shrink-0" aria-hidden="true" />
			<span class="min-w-0 flex-1">
				{{
					sessions.ownership === "lost"
						? __("Another window took over the saved carts. Payment is disabled here.")
						: __("The saved carts are open in another window. Carts here are not saved.")
				}}
			</span>
			<Button size="sm" variant="outline" data-testid="cart-take-over" @click="sessions.takeOver()">
				{{ __("Use carts here") }}
			</Button>
		</div>

		<div
			class="flex gap-1 border-border"
			:class="
				placement === 'bottom' ? 'order-last items-start border-t px-1' : 'items-end border-b px-1'
			"
			data-testid="cart-tabstrip"
		>
			<div
				ref="listRef"
				role="tablist"
				:aria-label="__('Open carts')"
				class="xpos-scrollbar-none hidden min-w-0 flex-1 items-center gap-1 overflow-x-auto md:flex"
				data-testid="cart-tablist"
				@keydown="onListKeydown"
			>
				<div
					v-for="tab in tabs"
					:key="tab.id"
					role="presentation"
					class="flex shrink-0 items-center border transition-colors duration-fast"
					:class="[
						placement === 'bottom' ? 'rounded-b-xl' : 'rounded-t-xl',
						tab.active
							? [
									'border-border bg-card text-foreground',
									placement === 'bottom' ? 'border-t-card -mt-px' : 'border-b-card -mb-px',
								]
							: 'border-transparent text-muted-foreground hover:bg-surface-hover',
					]"
				>
					<button
						:id="`cart-tab-${tab.id}`"
						type="button"
						role="tab"
						:aria-selected="tab.active"
						:tabindex="tab.active ? 0 : -1"
						:data-cart-id="tab.id"
						aria-keyshortcuts="Delete"
						class="flex h-10 min-w-20 max-w-36 items-center gap-2 rounded-lg ps-3 pe-1 text-sm font-semibold pointer-coarse:h-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
						@click="select(tab.id)"
					>
						<Loader2
							v-if="tab.status === 'submitting'"
							class="size-4 shrink-0 animate-spin"
							aria-hidden="true"
						/>
						<AlertTriangle
							v-else-if="tab.attention"
							class="size-4 shrink-0 text-warning"
							aria-hidden="true"
						/>
						<span class="truncate">{{ tab.label }}</span>
						<span
							v-if="tab.itemCount > 0"
							class="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-bold text-primary-foreground tabular-nums"
							>{{ tab.itemCount }}</span
						>
						<span v-if="statusText(tab)" class="sr-only">{{ statusText(tab) }}</span>
					</button>
					<button
						type="button"
						tabindex="-1"
						class="me-1 inline-flex size-8 shrink-0 pointer-coarse:size-10 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-pressed hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
						:aria-label="__('Close {0}', [tab.label])"
						:data-testid="`close-${tab.id}`"
						@click.stop="requestClose(tab.id)"
					>
						<X class="size-4" aria-hidden="true" />
					</button>
				</div>
			</div>

			<Popover v-model:open="menuOpen">
				<PopoverTrigger as-child>
					<button
						type="button"
						class="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-lg border border-border bg-card px-3 text-sm font-semibold text-foreground shadow-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus md:hidden"
						:aria-label="__('Switch cart')"
						data-testid="cart-switcher"
					>
						<AlertTriangle
							v-if="activeTab?.attention"
							class="size-4 shrink-0 text-warning"
							aria-hidden="true"
						/>
						<span class="min-w-0 flex-1 truncate text-start">{{ activeTab?.label }}</span>
						<span class="shrink-0 text-xs text-muted-foreground tabular-nums">
							{{ __("{0} of {1}", [String(sessions.activeIndex + 1), String(tabs.length)]) }}
						</span>
						<ChevronDown class="size-4 shrink-0" aria-hidden="true" />
					</button>
				</PopoverTrigger>
				<PopoverContentStyled class="w-72 p-1.5" align="end">
					<ul class="max-h-72 space-y-0.5 overflow-y-auto" :aria-label="__('Open carts')">
						<li v-for="tab in tabs" :key="tab.id" class="flex items-center gap-1">
							<button
								type="button"
								class="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-xl px-3 text-start text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
								:class="
									tab.active
										? 'bg-surface-selected text-foreground'
										: 'hover:bg-surface-hover'
								"
								:aria-current="tab.active ? 'true' : undefined"
								:data-testid="`switch-${tab.id}`"
								@click="chooseFromMenu(tab.id)"
							>
								<Loader2
									v-if="tab.status === 'submitting'"
									class="size-4 animate-spin"
									aria-hidden="true"
								/>
								<AlertTriangle
									v-else-if="tab.attention"
									class="size-4 text-warning"
									aria-hidden="true"
								/>
								<span class="min-w-0 flex-1 truncate">{{ tab.label }}</span>
								<span
									v-if="tab.itemCount > 0"
									class="text-xs text-muted-foreground tabular-nums"
									>{{ tab.itemCount }}</span
								>
								<span v-if="statusText(tab)" class="sr-only">{{ statusText(tab) }}</span>
							</button>
							<button
								type="button"
								class="inline-flex size-11 shrink-0 items-center justify-center rounded-xl text-muted-foreground hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
								:aria-label="__('Close {0}', [tab.label])"
								@click="requestClose(tab.id)"
							>
								<X class="size-4" aria-hidden="true" />
							</button>
						</li>
					</ul>
				</PopoverContentStyled>
			</Popover>

			<Popover v-if="tabs.length > OVERFLOW_AT" v-model:open="overflowOpen">
				<PopoverTrigger as-child>
					<button
						type="button"
						class="hidden size-10 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus md:inline-flex"
						:aria-label="__('All carts')"
						data-testid="cart-overflow"
					>
						<ChevronDown class="size-4" aria-hidden="true" />
					</button>
				</PopoverTrigger>
				<PopoverContentStyled class="w-72 p-1.5" align="end">
					<ul class="max-h-72 space-y-0.5 overflow-y-auto" :aria-label="__('All carts')">
						<li v-for="tab in tabs" :key="tab.id">
							<button
								type="button"
								class="flex min-h-11 w-full items-center gap-2 rounded-xl px-3 text-start text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
								:class="tab.active ? 'bg-surface-selected' : 'hover:bg-surface-hover'"
								@click="chooseFromMenu(tab.id, true)"
							>
								<span class="min-w-0 flex-1 truncate">{{ tab.label }}</span>
								<span
									v-if="tab.itemCount > 0"
									class="text-xs text-muted-foreground tabular-nums"
									>{{ tab.itemCount }}</span
								>
							</button>
						</li>
					</ul>
				</PopoverContentStyled>
			</Popover>

			<Button
				type="button"
				variant="ghost"
				class="mb-1 h-11 min-w-11 shrink-0 gap-1.5 px-3 md:h-9"
				:disabled="sessions.atLimit"
				:title="sessions.atLimit ? limitText : __('New cart ({0})', [newCartKeys])"
				:aria-label="__('New cart')"
				data-testid="new-cart"
				@click="newCart"
			>
				<Plus class="size-4" aria-hidden="true" />
				<span class="hidden lg:inline">{{ __("New cart") }}</span>
			</Button>
		</div>
		<p v-if="sessions.atLimit" class="px-1 text-xs text-muted-foreground" data-testid="cart-limit">
			{{ limitText }}
		</p>

		<ConfirmDialog
			:open="!!confirmId"
			:title="__('Close this cart?')"
			:description="
				__('{0} has items in it. Closing the cart removes them from this screen.', [confirmLabel])
			"
			:confirm-label="__('Close cart')"
			variant="destructive"
			:icon="Trash2"
			@confirm="confirmClose"
			@cancel="confirmId = ''"
		/>

		<Dialog :open="!!sessions.pendingRecovery" @update:open="() => {}">
			<DialogContent class="max-w-sm">
				<DialogHeader data-testid="cart-recovery">
					<DialogTitle>{{ __("Unfinished carts from an earlier shift") }}</DialogTitle>
					<DialogDescription>
						{{
							__(
								"{0} cart(s) were left open. Bring them back as open carts, or discard them.",
								[String(recoverableCount)],
							)
						}}
					</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button
						variant="outline"
						class="flex-1"
						data-testid="discard-carts"
						@click="sessions.discardPrevious()"
					>
						{{ __("Discard") }}
					</Button>
					<Button class="flex-1" data-testid="recover-carts" @click="sessions.recoverPrevious()">
						{{ __("Bring them back") }}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	</div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { AlertTriangle, ChevronDown, Layers, Loader2, Plus, Trash2, X } from "lucide-vue-next";
import { useCartSessionStore, MAX_CARTS, type CartTab } from "@/stores/cartSessionStore";
import { Button } from "@/components/ui/button";
import { Popover, PopoverTrigger, PopoverContentStyled } from "@/components/ui/popover";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import ConfirmDialog from "@/components/dialogs/ConfirmDialog.vue";
import { showError } from "@/services/api";
import { cartKeys } from "@/services/cartShortcuts";
import __ from "@/lib/translate";

withDefaults(defineProps<{ placement?: "top" | "bottom" }>(), { placement: "top" });

/** More carts than this and the strip gains an "all carts" menu. */
const OVERFLOW_AT = 4;

const sessions = useCartSessionStore();
const listRef = ref<HTMLElement | null>(null);
const menuOpen = ref(false);
const overflowOpen = ref(false);
const confirmId = ref("");

const tabs = computed(() => sessions.tabs);
const activeTab = computed(() => tabs.value.find((t) => t.active));
const limitText = computed(() =>
	__("{0} carts are open, the most this screen keeps. Finish or close one first.", [String(MAX_CARTS)]),
);
const confirmLabel = computed(() => tabs.value.find((t) => t.id === confirmId.value)?.label ?? "");
const recoverableCount = computed(
	() => sessions.pendingRecovery?.sessions.filter((s) => s.snapshot.items.length > 0).length ?? 0,
);
const newCartKeys = computed(() =>
	cartKeys("new-cart")
		.map((k) => (k.length === 1 ? k.toUpperCase() : k.charAt(0).toUpperCase() + k.slice(1)))
		.join("+"),
);

function statusText(tab: CartTab): string {
	if (tab.status === "submitting") return __("Payment is being saved");
	if (tab.status === "uncertain") return __("Payment not confirmed");
	if (tab.attention) return __("Needs attention");
	return "";
}

function report(result: { ok: boolean; reason?: string }): void {
	if (!result.ok && result.reason) showError(result.reason);
}

function select(id: string): void {
	report(sessions.switchTo(id));
}

function chooseFromMenu(id: string, overflow = false): void {
	report(sessions.switchTo(id));
	if (overflow) overflowOpen.value = false;
	else menuOpen.value = false;
}

function newCart(): void {
	report(sessions.create());
	menuOpen.value = false;
}

function requestClose(id: string): void {
	const result = sessions.close(id);
	if (result.needsConfirm) confirmId.value = id;
	else report(result);
}

function confirmClose(): void {
	const id = confirmId.value;
	confirmId.value = "";
	if (id) report(sessions.close(id, { confirmed: true }));
}

function tabElement(id: string): HTMLElement | null {
	return listRef.value?.querySelector<HTMLElement>(`[data-cart-id="${id}"]`) ?? null;
}

/** Arrow keys move between carts, Delete closes the focused one. Focus stays on the tab strip. */
function onListKeydown(event: KeyboardEvent): void {
	const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("[role='tab']");
	if (!target) return;
	const id = target.dataset.cartId ?? "";
	const list = tabs.value;
	const index = list.findIndex((t) => t.id === id);
	if (index < 0) return;

	const rtl = document.documentElement.dir === "rtl";
	let next = -1;
	if (event.key === "ArrowRight") next = rtl ? index - 1 : index + 1;
	else if (event.key === "ArrowLeft") next = rtl ? index + 1 : index - 1;
	else if (event.key === "Home") next = 0;
	else if (event.key === "End") next = list.length - 1;
	else if (event.key === "Delete") {
		event.preventDefault();
		requestClose(id);
		return;
	} else return;

	// Alt+Arrow is the global next/previous cart shortcut; leave it to that handler.
	if (event.altKey) return;
	event.preventDefault();
	if (next < 0 || next >= list.length) return;
	const result = sessions.switchTo(list[next].id, { focus: false });
	report(result);
	if (result.ok) void nextTick(() => tabElement(list[next].id)?.focus());
}

/** Alt+W (or the chosen keys): close the cart on screen, asking first if it has items. */
function onCloseShortcut(): void {
	requestClose(sessions.activeId);
}
onMounted(() => window.addEventListener("xpos:close-cart", onCloseShortcut));
onBeforeUnmount(() => window.removeEventListener("xpos:close-cart", onCloseShortcut));

watch(
	() => sessions.activeId,
	() => {
		void nextTick(() =>
			tabElement(sessions.activeId)?.scrollIntoView?.({ block: "nearest", inline: "nearest" }),
		);
	},
);
</script>
