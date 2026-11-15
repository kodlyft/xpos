<template>
	<div
		v-if="messages.length"
		class="relative z-10 flex shrink-0 flex-col gap-1 bg-warning-soft px-4 py-2 text-sm text-warning-soft-foreground shadow"
		role="status"
		data-testid="app-status-banner"
	>
		<div v-for="message in messages" :key="message.key" class="flex flex-wrap items-center gap-3">
			<span>{{ message.text }}</span>
			<button
				v-if="message.action"
				type="button"
				class="rounded border border-current px-2 py-0.5 font-medium disabled:opacity-50"
				:disabled="message.disabled"
				:title="message.hint"
				@click="message.action"
			>
				{{ message.label }}
			</button>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useCartStore } from "@/stores/cartStore";
import { useOfflineStore } from "@/stores/offlineStore";
import {
	applyUpdate,
	reloadForUpdate,
	reloadNeeded,
	updateBlockers,
	updateWaiting,
} from "@/services/appUpdate";
import __ from "@/lib/translate";

const PERSIST_DISMISSED_KEY = "xpos-persist-notice-dismissed";

function readDismissed(): boolean {
	try {
		return localStorage.getItem(PERSIST_DISMISSED_KEY) === "1";
	} catch {
		return false;
	}
}

const persistDismissed = ref(readDismissed());

function dismissPersist() {
	persistDismissed.value = true;
	try {
		localStorage.setItem(PERSIST_DISMISSED_KEY, "1");
	} catch {
		/* the notice just returns on the next load */
	}
}

const cartStore = useCartStore();
const offlineStore = useOfflineStore();

const blockers = computed(() =>
	updateBlockers({
		cartEmpty: cartStore.isEmpty,
		paymentDialogOpen: cartStore.showPaymentDialog,
		sendingCount: offlineStore.pendingInvoices.filter((invoice) => invoice.status === "syncing").length,
		dbState: offlineStore.dbState,
	}),
);

const messages = computed(() => {
	const list: {
		key: string;
		text: string;
		label?: string;
		action?: () => void;
		disabled?: boolean;
		hint?: string;
	}[] = [];
	const hint = blockers.value.length ? __("Not now: {0}", [blockers.value.join(", ")]) : "";
	if (offlineStore.dbState === "needs_reload" || reloadNeeded.value) {
		list.push({
			key: "reload",
			text: __("A newer version of X POS is in use on this device. Reload to keep selling."),
			label: __("Reload"),
			action: reloadForUpdate,
			disabled: blockers.value.length > 0,
			hint,
		});
	} else if (updateWaiting.value) {
		list.push({
			key: "update",
			text: __("A new version of X POS is ready. Queued sales are kept."),
			label: __("Update now"),
			action: applyUpdate,
			disabled: blockers.value.length > 0,
			hint,
		});
	}
	if (offlineStore.dbState === "storage_unavailable") {
		list.push({
			key: "storage",
			text: __("This browser's offline storage is not working. Sales cannot be kept safely offline."),
		});
	}
	if (offlineStore.storageHealth?.level === "full") {
		list.push({
			key: "full",
			text: __("This device is almost out of storage. Free space before selling offline."),
		});
	}
	if (
		offlineStore.offlineModeEnabled &&
		offlineStore.storagePersisted === false &&
		offlineStore.pendingInvoices.length > 0 &&
		!persistDismissed.value
	) {
		list.push({
			key: "persist",
			text: __(
				"The browser may clear offline data on this device. Sync often and do not clear site data.",
			),
			label: __("Dismiss"),
			action: dismissPersist,
		});
	}
	return list;
});
</script>
