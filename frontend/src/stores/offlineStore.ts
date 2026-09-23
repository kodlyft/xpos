import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { call, showSuccess, showError, showInfo } from "@/services/api";
import { usePosStore } from "@/stores/posStore";
import {
	addPendingInvoice,
	getAllPendingInvoices,
	updatePendingInvoice,
	deletePendingInvoice,
	countPendingInvoices,
	countDeadLetters,
	retryDeadLetter as retryDeadLetterBridge,
	adjustCachedStock,
} from "@/services/dbBridge";
import type { PendingInvoice } from "@/services/idbService";
import type { InvoiceData, ReceiptSnapshot } from "@/types/pos.types";
import __ from "@/lib/translate";

export type OfflineInvoice = PendingInvoice;

export const useOfflineStore = defineStore("offline", () => {
	const isSyncing = ref(false);
	const pendingCount = ref(0);
	const deadLetterCount = ref(0);
	const pendingInvoices = ref<OfflineInvoice[]>([]);
	const lastSyncTime = ref("");
	const syncErrors = ref<string[]>([]);
	const isOnline = ref(typeof navigator !== "undefined" ? navigator.onLine : true);
	const posStore = usePosStore();

	const MAX_RETRIES = 3;

	function isStockRejection(error: unknown): boolean {
		const excType = (error as { excType?: string })?.excType;
		if (excType) return excType === "XPosInsufficientStockError";
		const msg = error instanceof Error ? error.message : String(error ?? "");
		return /insufficient stock|not enough stock/i.test(msg);
	}
	const SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
	let syncIntervalId: ReturnType<typeof setInterval> | null = null;

	const hasPending = computed(() => pendingCount.value > 0);
	const hasDeadLetters = computed(() => deadLetterCount.value > 0);

	const offlineModeEnabled = computed(() => {
		return !!posStore.useOfflineMode;
	});

	const allowDeleteOfflineInvoice = computed(() => {
		return !!posStore.allowDeleteOfflineInvoice;
	});

	const statusLabel = computed(() => {
		if (isSyncing.value) return "Syncing...";
		if (deadLetterCount.value > 0) return `${deadLetterCount.value} need attention`;
		if (!isOnline.value) return "Offline";
		if (pendingCount.value > 0) return `${pendingCount.value} pending`;
		return "Online";
	});

	const statusColor = computed(() => {
		if (isSyncing.value) return "text-blue-500";
		if (deadLetterCount.value > 0) return "text-red-500";
		if (!isOnline.value) return "text-red-500";
		if (pendingCount.value > 0) return "text-amber-500";
		return "text-emerald-500";
	});

	function init() {
		window.addEventListener("online", handleOnline);
		window.addEventListener("offline", handleOffline);

		refreshPendingCount();
		startPeriodicSync();
	}

	function destroy() {
		window.removeEventListener("online", handleOnline);
		window.removeEventListener("offline", handleOffline);
		stopPeriodicSync();
	}

	function handleOnline() {
		isOnline.value = true;
		showSuccess(__("Internet connection restored"));

		if (offlineModeEnabled.value && pendingCount.value > 0) {
			syncPendingInvoices();
		}
	}

	function handleOffline() {
		isOnline.value = false;
		showError(__("You are offline. Check your internet connection."));
	}

	function ensureDeleteAllowed(): boolean {
		if (allowDeleteOfflineInvoice.value) {
			return true;
		}

		showInfo(__("Deleting offline invoices is disabled for this POS Profile."));
		return false;
	}

	async function refreshPendingCount() {
		try {
			pendingCount.value = await countPendingInvoices();
		} catch {
			pendingCount.value = 0;
		}
		await refreshDeadLetterCount();
	}

	async function refreshDeadLetterCount() {
		try {
			deadLetterCount.value = await countDeadLetters();
		} catch {
			deadLetterCount.value = 0;
		}
	}

	async function retryDeadLetterInvoice(id: number): Promise<boolean> {
		try {
			const ok = await retryDeadLetterBridge("pending_invoices", id);
			if (ok) {
				await loadPendingInvoices();
				await refreshDeadLetterCount();
				syncPendingInvoices();
			}
			return ok;
		} catch (error) {
			console.error("Failed to requeue dead-letter invoice:", error);
			return false;
		}
	}

	function itemCodesOf(invoice: OfflineInvoice): string[] {
		const items = (invoice.data as InvoiceData | undefined)?.items;
		return Array.isArray(items) ? items.map((i) => i.item_code).filter(Boolean) : [];
	}

	async function reserveStock(reservations?: { item_code: string; stock_qty: number }[]): Promise<void> {
		if (!reservations?.length) return;
		const warehouse = usePosStore().warehouse;
		if (!warehouse) return;

		await adjustCachedStock(
			warehouse,
			reservations.map((r) => ({ item_code: r.item_code, delta: -r.stock_qty })),
		);
	}

	async function reconcileStockFromServer(itemCodes: string[]): Promise<void> {
		const posStore = usePosStore();
		const warehouse = posStore.warehouse;
		if (!warehouse || itemCodes.length === 0) return;

		try {
			const fresh = await call<{ item_code: string; actual_qty: number }[]>(
				"xpos.api.items.get_stock_availability",
				{
					items: JSON.stringify([...new Set(itemCodes)]),
					warehouse,
					pos_profile: posStore.profileName || undefined,
				},
			);
			if (!fresh?.length) return;

			const { updateStockQty } = await import("@/services/dbBridge");
			for (const row of fresh) {
				await updateStockQty(warehouse, row.item_code, row.actual_qty || 0);
			}
		} catch (error) {
			console.warn("[XPOS Offline] Failed to reconcile stock after rejection:", error);
		}
	}

	async function saveOffline(
		invoiceData: InvoiceData,
		customerName?: string,
		grandTotal?: number,
		reservations?: { item_code: string; stock_qty: number }[],
		receipt?: ReceiptSnapshot,
	): Promise<{ success: boolean; localId?: number }> {
		try {
			const record = {
				data: invoiceData as unknown,
				customer_name: customerName || invoiceData.customer,
				grand_total: grandTotal,
				receipt,
			};

			const result = await addPendingInvoice(record);

			await reserveStock(reservations);

			await refreshPendingCount();
			await loadPendingInvoices();

			return { success: true, localId: (result as any).id ?? result };
		} catch (error) {
			console.error("Failed to save offline invoice:", error);
			return { success: false };
		}
	}

	async function loadPendingInvoices() {
		try {
			pendingInvoices.value = (await getAllPendingInvoices()) as OfflineInvoice[];
			pendingCount.value = pendingInvoices.value.filter((inv) => inv.status !== "dead_letter").length;
			deadLetterCount.value = pendingInvoices.value.filter(
				(inv) => inv.status === "dead_letter",
			).length;
		} catch {
			pendingInvoices.value = [];
			pendingCount.value = 0;
			deadLetterCount.value = 0;
		}
	}

	async function syncPendingInvoices(): Promise<void> {
		if (isSyncing.value || !isOnline.value) return;

		isSyncing.value = true;
		syncErrors.value = [];

		try {
			const invoices = (await getAllPendingInvoices()) as OfflineInvoice[];
			if (invoices.length === 0) {
				isSyncing.value = false;
				return;
			}

			let synced = 0;
			let failed = 0;
			let rejected = 0;

			for (const invoice of invoices) {
				if (!isOnline.value) {
					break;
				}
				if ((invoice.data as Record<string, unknown>)?.is_draft) {
					continue;
				}
				if (invoice.status === "dead_letter") {
					continue;
				}
				try {
					invoice.status = "syncing";
					if (invoice.id) await updatePendingInvoice(invoice.id, { status: "syncing" });

					await call<{ name: string }>("xpos.api.invoices.create_invoice", {
						data: JSON.stringify(invoice.data),
						local_id: invoice.local_id,
					});
					if (invoice.id) await deletePendingInvoice(invoice.id);
					synced++;
				} catch (error: unknown) {
					invoice.error = error instanceof Error ? error.message : String(error);

					if (isStockRejection(error)) {
						rejected++;
						invoice.status = "dead_letter";
						syncErrors.value.push(
							`Invoice for ${invoice.customer_name || "Unknown"}: ${invoice.error}`,
						);
						if (invoice.id)
							await updatePendingInvoice(invoice.id, {
								status: "dead_letter",
								error: invoice.error,
							});

						await reconcileStockFromServer(itemCodesOf(invoice));
						continue;
					}

					failed++;
					invoice.retry_count = (invoice.retry_count || 0) + 1;
					invoice.status = invoice.retry_count >= MAX_RETRIES ? "dead_letter" : "failed";

					if (invoice.status === "dead_letter") {
						syncErrors.value.push(
							`Invoice for ${invoice.customer_name || "Unknown"}: ${invoice.error}`,
						);
					}

					if (invoice.id)
						await updatePendingInvoice(invoice.id, {
							status: invoice.status,
							retry_count: invoice.retry_count,
							error: invoice.error,
						});
				}
			}

			await refreshPendingCount();
			await loadPendingInvoices();
			lastSyncTime.value = new Date().toISOString();

			if (synced > 0) {
				showSuccess(`Synced ${synced} offline invoice${synced > 1 ? "s" : ""}`);
			}
			if (failed > 0) {
				showError(`Failed to sync ${failed} invoice${failed > 1 ? "s" : ""}. Will retry.`);
			}
			if (rejected > 0) {
				showError(
					__(
						"{0} offline invoice(s) were rejected for insufficient stock and will not retry. Review them in the pending list.",
						[String(rejected)],
					),
				);
			}
		} catch (error) {
			console.error("Sync error:", error);
		} finally {
			isSyncing.value = false;
		}
	}

	async function retrySingle(id: number): Promise<boolean> {
		if (!isOnline.value) {
			showError(__("Cannot sync while offline"));
			return false;
		}

		const invoices = (await getAllPendingInvoices()) as OfflineInvoice[];
		const invoice = invoices.find((i) => i.id === id);
		if (!invoice) return false;

		if ((invoice.data as Record<string, unknown>)?.is_draft) {
			showError(__("Cannot sync a draft invoice. Load it to cart first."));
			return false;
		}

		try {
			invoice.status = "syncing";
			await updatePendingInvoice(invoice.id!, { status: "syncing" });

			await call<{ name: string }>("xpos.api.invoices.create_invoice", {
				data: JSON.stringify(invoice.data),
				local_id: invoice.local_id,
			});

			await deletePendingInvoice(id);
			await refreshPendingCount();
			await loadPendingInvoices();
			showSuccess(__("Invoice synced successfully"));
			return true;
		} catch (error: unknown) {
			invoice.error = error instanceof Error ? error.message : String(error);

			if (isStockRejection(error)) {
				invoice.status = "dead_letter";
				await updatePendingInvoice(invoice.id!, {
					status: "dead_letter",
					error: invoice.error,
				});
				await loadPendingInvoices();
				showError(invoice.error);
				return false;
			}

			invoice.retry_count = (invoice.retry_count || 0) + 1;
			invoice.status = invoice.retry_count >= MAX_RETRIES ? "dead_letter" : "failed";
			await updatePendingInvoice(invoice.id!, {
				status: invoice.status,
				retry_count: invoice.retry_count,
				error: invoice.error,
			});
			await loadPendingInvoices();
			showError(__("Sync failed:") + " " + invoice.error);
			return false;
		}
	}

	async function consumePending(id: number): Promise<void> {
		await deletePendingInvoice(id);
		await refreshPendingCount();
		await loadPendingInvoices();
	}

	async function deletePending(id: number): Promise<void> {
		if (!ensureDeleteAllowed()) return;

		await consumePending(id);
	}

	async function clearAll(): Promise<void> {
		if (!ensureDeleteAllowed()) return;

		const invoices = await getAllPendingInvoices();
		for (const inv of invoices) {
			if ((inv as any).id) await deletePendingInvoice((inv as any).id);
		}
		await refreshPendingCount();
		pendingInvoices.value = [];
	}

	function startPeriodicSync(): void {
		if (syncIntervalId) return;
		syncIntervalId = setInterval(() => {
			syncOfflineData();
		}, SYNC_INTERVAL_MS);
		syncOfflineData();
	}

	function stopPeriodicSync(): void {
		if (syncIntervalId) {
			clearInterval(syncIntervalId);
			syncIntervalId = null;
		}
	}

	async function syncOfflineData(): Promise<void> {
		if (!isOnline.value) return;

		const posStore = usePosStore();
		if (!posStore.isReady || !posStore.profileName) return;

		try {
			const { useItemStore } = await import("@/stores/itemStore");
			const itemStore = useItemStore();
			itemStore.cacheAllItems(posStore.profileName).catch((err) => {
				console.warn("[XPOS Sync] Failed to sync items:", err);
			});

			const { useCustomerStore } = await import("@/stores/customerStore");
			const customerStore = useCustomerStore();
			customerStore.cacheAllCustomers(posStore.profileName).catch((err) => {
				console.warn("[XPOS Sync] Failed to sync customers:", err);
			});

			if (pendingCount.value > 0) {
				syncPendingInvoices();
			}
		} catch (error) {
			console.warn("[XPOS Sync] Background sync error:", error);
		}
	}

	return {
		isSyncing,
		pendingCount,
		deadLetterCount,
		pendingInvoices,
		lastSyncTime,
		syncErrors,
		hasPending,
		hasDeadLetters,
		offlineModeEnabled,
		allowDeleteOfflineInvoice,
		statusLabel,
		statusColor,
		isOnline,
		init,
		destroy,
		refreshPendingCount,
		refreshDeadLetterCount,
		retryDeadLetterInvoice,
		saveOffline,
		loadPendingInvoices,
		syncPendingInvoices,
		retrySingle,
		consumePending,
		deletePending,
		clearAll,
		startPeriodicSync,
		stopPeriodicSync,
		syncOfflineData,
	};
});
