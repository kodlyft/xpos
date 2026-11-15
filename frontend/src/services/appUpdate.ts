import { ref } from "vue";
import type { DbState } from "@/services/idbService";
import { broadcast, onBroadcast } from "@/services/tabCoordinator";

export const updateWaiting = ref(false);
export const reloadNeeded = ref(false);

let waitingWorker: ServiceWorker | null = null;
let reloading = false;

export function noteWaitingWorker(worker: ServiceWorker): void {
	waitingWorker = worker;
	updateWaiting.value = true;
}

export interface UpdateState {
	cartEmpty: boolean;
	paymentDialogOpen: boolean;
	sendingCount: number;
	dbState: DbState;
}

export function updateBlockers(state: UpdateState): string[] {
	const reasons: string[] = [];
	if (!state.cartEmpty) reasons.push("a sale is in the cart");
	if (state.paymentDialogOpen) reasons.push("a payment is open");
	if (state.sendingCount > 0) reasons.push("sales are being sent");
	if (state.dbState === "upgrading") reasons.push("local storage is upgrading");
	return reasons;
}

function reloadOnce(): void {
	if (reloading) return;
	reloading = true;
	location.reload();
}

export function applyUpdate(): void {
	if (!waitingWorker) return reloadOnce();
	navigator.serviceWorker.addEventListener(
		"controllerchange",
		() => {
			broadcast("app-updated");
			reloadOnce();
		},
		{ once: true },
	);
	waitingWorker.postMessage({ type: "SKIP_WAITING" });
}

export function reloadForUpdate(): void {
	reloadOnce();
}

onBroadcast("app-updated", () => {
	reloadNeeded.value = true;
});
