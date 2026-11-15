import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { call, showSuccess, showError, showInfo } from "@/services/api";
import { usePosStore } from "@/stores/posStore";
import {
	addPendingInvoice,
	claimPendingInvoice,
	findPendingInvoiceByLocalId,
	getAllPendingInvoices,
	recoverStaleClaims,
	updatePendingInvoice,
	deletePendingInvoice,
	countPendingInvoices,
	countDeadLetters,
	exportPendingInvoices,
	retryDeadLetter as retryDeadLetterBridge,
	adjustCachedStock,
} from "@/services/dbBridge";
import { getDbState, onDbStateChange, type DbState, type PendingInvoice } from "@/services/idbService";
import { classifySyncError, nextAttemptAt } from "@/services/syncClassify";
import { offlineSaleBlockers, type OfflineBlocker } from "@/services/offlinePolicy";
import {
	currentCatalogEvidence,
	getCatalogStatus,
	syncCatalog,
	type CatalogStatus,
} from "@/services/catalogSync";
import {
	StorageWriteError,
	getStorageHealth,
	requestPersistence,
	type StorageHealth,
} from "@/services/storageHealth";
import { broadcast, onBroadcast, runExclusive } from "@/services/tabCoordinator";
import { currentOwner } from "@/services/sessionScope";
import type { InvoiceData, InvoiceItem, ReceiptSnapshot, RepriceResponse } from "@/types/pos.types";
import __ from "@/lib/translate";
import {
	completeLocalFiscalization,
	FiscalUncertainError,
	type FiscalPending,
} from "@/services/fbrLocalService";

export type OfflineInvoice = PendingInvoice;

export type SaveFailure = "blocked" | "held" | "quota" | "unavailable" | "data" | "unknown";

export interface SaveOfflineResult {
	success: boolean;
	localId?: number;
	reason?: SaveFailure;
	blockers?: OfflineBlocker[];
}

const DRAIN_BREAKER = 3;

export const useOfflineStore = defineStore("offline", () => {
	const isSyncing = ref(false);
	const pendingCount = ref(0);
	const deadLetterCount = ref(0);
	const pendingInvoices = ref<OfflineInvoice[]>([]);
	const lastSyncTime = ref("");
	const syncErrors = ref<string[]>([]);
	const isOnline = ref(typeof navigator !== "undefined" ? navigator.onLine : true);
	const posStore = usePosStore();
	const dbState = ref<DbState>(getDbState());
	const catalogStatus = ref<CatalogStatus | null>(null);
	const storageHealth = ref<StorageHealth | null>(null);
	const storagePersisted = computed(() => storageHealth.value?.persisted ?? null);

	function isStockRejection(error: unknown): boolean {
		const excType = (error as { excType?: string })?.excType;
		if (excType) return excType === "XPosInsufficientStockError";
		const msg = error instanceof Error ? error.message : String(error ?? "");
		return /insufficient stock|not enough stock/i.test(msg);
	}
	/**
	 * Send one queued sale. A sale the server repriced is held for review (nothing was
	 * posted); any answer without a finished invoice keeps the entry so it is never lost.
	 */
	async function pushPending(
		invoice: OfflineInvoice,
	): Promise<"synced" | "needs_review" | "fiscal_uncertain"> {
		let result = await call<{ name?: string; status?: string; message?: string }>(
			"xpos.api.invoices.create_invoice",
			{ data: JSON.stringify(invoice.data), local_id: invoice.local_id },
		);
		result = await finishFiscalization(invoice, result);
		if (result?.status === "fbr_uncertain") return "fiscal_uncertain";
		if (result?.status === "reprice_required") {
			invoice.status = "needs_review";
			invoice.review = result as unknown as RepriceResponse;
			invoice.error = result.message;
			if (invoice.id)
				await updatePendingInvoice(invoice.id, {
					status: "needs_review",
					review: invoice.review,
					error: invoice.error,
					claimed_by: null,
					claim_expires: null,
				});
			return "needs_review";
		}
		if (!result?.name) {
			throw new Error(__("The server did not confirm this sale. It stays queued."));
		}
		if (invoice.id) await deletePendingInvoice(invoice.id);
		return "synced";
	}

	/**
	 * A sale the server saved as a draft waiting for FBR: get the number from the local service,
	 * or, when FBR may already have it, hold the entry for a check (status ``fiscal_uncertain``).
	 */
	async function finishFiscalization<T extends { name?: string; status?: string; message?: string }>(
		invoice: OfflineInvoice,
		result: T,
	): Promise<T> {
		let message = result?.message;
		if (result?.status === "fbr_local_required") {
			try {
				return await completeLocalFiscalization<T>(result as unknown as FiscalPending);
			} catch (error) {
				if (!(error instanceof FiscalUncertainError)) throw error;
				message = error.message;
			}
		} else if (result?.status !== "fbr_uncertain") {
			return result;
		}
		const pending = result as unknown as FiscalPending;
		invoice.status = "fiscal_uncertain";
		invoice.fiscal = {
			name: pending.name,
			doctype: pending.doctype,
			usin: pending.usin || invoice.local_id,
			pos_profile: pending.pos_profile || (invoice.data as { pos_profile?: string })?.pos_profile,
		};
		invoice.error = message;
		if (invoice.id)
			await updatePendingInvoice(invoice.id, {
				status: "fiscal_uncertain",
				fiscal: invoice.fiscal,
				error: message,
				claimed_by: null,
				claim_expires: null,
			});
		return { ...result, status: "fbr_uncertain", message };
	}

	/**
	 * Record what FBR's records show for a sale whose FBR outcome was unknown (the found
	 * number, or that it is not there), then send the same sale again to finish it. The
	 * server reuses a recorded number and sends to FBR again only after "not recorded".
	 */
	async function resolveFiscalCheck(
		id: number,
		fiscalNumber: string | null,
		evidence: string,
	): Promise<boolean> {
		const invoice = pendingInvoices.value.find((i) => i.id === id);
		if (!invoice?.fiscal) return false;
		try {
			await call("xpos.api.invoices.resolve_fiscal_check", {
				usin: invoice.fiscal.usin || invoice.local_id,
				pos_profile:
					invoice.fiscal.pos_profile || (invoice.data as { pos_profile?: string })?.pos_profile,
				resolution: fiscalNumber ? "Recorded" : "Not Recorded",
				fbr_invoice_number: fiscalNumber || undefined,
				evidence,
			});
		} catch (error: unknown) {
			showError(error instanceof Error ? error.message : String(error));
			return false;
		}
		return recheckFiscalSale(id);
	}

	/** Send a sale held for an FBR check again; it finishes only once the check was recorded. */
	async function recheckFiscalSale(id: number): Promise<boolean> {
		const invoice = pendingInvoices.value.find((i) => i.id === id);
		if (!invoice?.fiscal) return false;
		try {
			const outcome = await pushPending(invoice);
			if (outcome !== "synced") {
				showError(invoice.error || __("FBR has still not confirmed this sale."));
				return false;
			}
			showSuccess(
				__("Sale {0} fiscalized and saved.", [invoice.fiscal.usin || invoice.local_id || ""]),
			);
			return true;
		} catch (error: unknown) {
			showError(error instanceof Error ? error.message : String(error));
			return false;
		} finally {
			await refreshPendingCount();
			await loadPendingInvoices();
		}
	}

	/**
	 * Settle a sale held for review: post it at the server's prices, or (with price-change
	 * rights) at the prices the customer was actually charged.
	 */
	async function resolveReview(id: number, keepCaptured: boolean): Promise<boolean> {
		const invoice = pendingInvoices.value.find((i) => i.id === id);
		// ERPNext re-applies its own invoice discount, so charged prices cannot be kept here.
		if (!invoice?.review || (keepCaptured && invoice.review.offer_conflict)) return false;
		const data = invoice.data as InvoiceData;
		if (!keepCaptured) {
			for (const change of invoice.review.lines) {
				const line: InvoiceItem | undefined =
					(change.row_id && data.items.find((i) => i.row_id === change.row_id)) ||
					data.items[change.index];
				if (!line || line.item_code !== change.item_code || change.rate === null) continue;
				line.rate = change.price_list_rate ?? change.rate;
				line.price_list_rate = line.rate;
				line.discount_percentage = change.discount_percentage || 0;
				line.discount_amount = line.discount_percentage ? 0 : change.discount_amount || 0;
			}
			if (invoice.review.discount_changed) {
				data.additional_discount_percentage = invoice.review.additional_discount_percentage || 0;
				data.discount_amount = data.additional_discount_percentage
					? 0
					: invoice.review.discount_amount || 0;
			}
		}
		await updatePendingInvoice(id, {
			data,
			status: "pending",
			review: undefined,
			error: undefined,
			retry_count: 0,
		});
		await loadPendingInvoices();
		return retrySingle(id);
	}

	const SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
	let persistenceAsked = false;
	const MIN_RETRY_DELAY_MS = 5_000;
	let syncIntervalId: ReturnType<typeof setInterval> | null = null;
	let retryTimerId: ReturnType<typeof setTimeout> | null = null;
	let removeListeners: Array<() => void> = [];

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
		if (isSyncing.value) return "text-info";
		if (deadLetterCount.value > 0) return "text-destructive";
		if (!isOnline.value) return "text-destructive";
		if (pendingCount.value > 0) return "text-warning";
		return "text-success";
	});

	function init() {
		window.addEventListener("xpos:pending-invoices-changed", refreshPendingCount);
		window.addEventListener("online", handleOnline);
		window.addEventListener("offline", handleOffline);
		removeListeners = [
			onDbStateChange((state) => {
				dbState.value = state;
			}),
			onBroadcast("queue-changed", () => {
				void refreshPendingCount();
				void loadPendingInvoices();
			}),
			onBroadcast("catalog-activated", () => void refreshCatalogStatus()),
		];

		void recoverStaleClaims()
			.catch((error) => console.warn("[XPOS Offline] Could not recover interrupted sends", error))
			.finally(() => refreshPendingCount());
		void refreshStorageHealth();
		void refreshCatalogStatus();
		startPeriodicSync();
	}

	function destroy() {
		window.removeEventListener("xpos:pending-invoices-changed", refreshPendingCount);
		window.removeEventListener("online", handleOnline);
		window.removeEventListener("offline", handleOffline);
		removeListeners.forEach((remove) => remove());
		removeListeners = [];
		stopPeriodicSync();
		if (retryTimerId) clearTimeout(retryTimerId);
		retryTimerId = null;
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

	async function refreshCatalogStatus() {
		try {
			catalogStatus.value = await getCatalogStatus();
		} catch {
			catalogStatus.value = null;
		}
	}

	async function refreshStorageHealth() {
		storageHealth.value = await getStorageHealth();
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

	function outstandingOf(invoiceData: InvoiceData, grandTotal?: number): number {
		if (!grandTotal || grandTotal <= 0) return 0;
		const paid = (invoiceData.payments || []).reduce((sum, payment) => sum + (payment.amount || 0), 0);
		return Math.max(Math.round((grandTotal - (paid - (invoiceData.change_amount || 0))) * 100) / 100, 0);
	}

	async function offlineBlockers(invoiceData: InvoiceData, outstanding = 0): Promise<OfflineBlocker[]> {
		await Promise.all([refreshCatalogStatus(), refreshStorageHealth()]);
		return offlineSaleBlockers({
			invoice: invoiceData,
			offlinePaymentModes: posStore.offlinePaymentModes,
			outstanding,
			catalog: catalogStatus.value,
			dbState: getDbState(),
			storage: storageHealth.value,
		});
	}

	async function saveOffline(
		invoiceData: InvoiceData,
		customerName?: string,
		grandTotal?: number,
		reservations?: { item_code: string; stock_qty: number }[],
		receipt?: ReceiptSnapshot,
	): Promise<SaveOfflineResult> {
		try {
			const existing = invoiceData.local_id
				? await findPendingInvoiceByLocalId(invoiceData.local_id)
				: undefined;
			const blockers = await offlineBlockers(invoiceData, outstandingOf(invoiceData, grandTotal));
			if (blockers.length) {
				// A sale already journaled by a send that lost its answer may have reached the server.
				if (existing) {
					await addPendingInvoice({ data: invoiceData as unknown, hold: "offline_blocked" });
					await refreshPendingCount();
					await loadPendingInvoices();
					broadcast("queue-changed");
				}
				return { success: false, reason: existing ? "held" : "blocked", blockers };
			}

			const result = await addPendingInvoice({
				data: invoiceData as unknown,
				customer_name: customerName || invoiceData.customer,
				grand_total: grandTotal,
				receipt,
				reservations,
				catalog_evidence: await currentCatalogEvidence(),
			});

			if (existing) {
				if (!existing.reservations && reservations?.length && existing.id) {
					await updatePendingInvoice(existing.id, { reservations });
					await reserveStock(reservations);
				}
			} else {
				await reserveStock(reservations);
			}

			await refreshPendingCount();
			await loadPendingInvoices();
			broadcast("queue-changed");

			return { success: true, localId: result.id };
		} catch (error) {
			console.error("Failed to save offline invoice:", error);
			void refreshStorageHealth();
			const reason = error instanceof StorageWriteError ? error.reason : "unknown";
			return { success: false, reason };
		}
	}

	async function loadPendingInvoices() {
		try {
			pendingInvoices.value = (await getAllPendingInvoices()) as OfflineInvoice[];
			const needsAttention = (inv: OfflineInvoice) =>
				inv.status === "dead_letter" ||
				inv.status === "needs_review" ||
				inv.status === "fiscal_uncertain" ||
				!!inv.hold;
			pendingCount.value = pendingInvoices.value.filter((inv) => !needsAttention(inv)).length;
			deadLetterCount.value = pendingInvoices.value.filter(needsAttention).length;
		} catch {
			pendingInvoices.value = [];
			pendingCount.value = 0;
			deadLetterCount.value = 0;
		}
	}

	type SendOutcome = "synced" | "needs_review" | "fiscal_uncertain" | "rejected" | "retry" | "skipped";

	function dueForBackgroundSend(invoice: OfflineInvoice, now: number): boolean {
		if (invoice.hold) return false;
		if ((invoice.data as Record<string, unknown>)?.is_draft) return false;
		if (["dead_letter", "needs_review", "fiscal_uncertain"].includes(invoice.status)) return false;
		if (invoice.next_attempt_at && Date.parse(invoice.next_attempt_at) > now) return false;
		const session = currentOwner();
		if (invoice.owner && session && invoice.owner.user !== session.user) return false;
		return true;
	}

	/** Send one queued sale under a claim, and record how it went. */
	async function attemptSend(invoice: OfflineInvoice): Promise<SendOutcome> {
		if (!invoice.id) return "skipped";
		const claimed = await claimPendingInvoice(invoice.id);
		if (!claimed) return "skipped";
		Object.assign(invoice, claimed);

		try {
			const outcome = await pushPending(invoice);
			if (outcome === "synced") invoice.status = "pending";
			return outcome;
		} catch (error: unknown) {
			const failure = classifySyncError(error);
			invoice.error = failure.message;
			if (failure.kind === "rejected") {
				invoice.status = "dead_letter";
				invoice.rejection = {
					code: failure.code,
					message: failure.message,
					at: new Date().toISOString(),
				};
				await updatePendingInvoice(invoice.id, {
					status: "dead_letter",
					error: invoice.error,
					rejection: invoice.rejection,
					claimed_by: null,
					claim_expires: null,
				});
				if (isStockRejection(error)) await reconcileStockFromServer(itemCodesOf(invoice));
				return "rejected";
			}
			const attempts = (invoice.attempts || 0) + 1;
			invoice.attempts = attempts;
			invoice.retry_count = attempts;
			invoice.status = "failed";
			invoice.next_attempt_at = nextAttemptAt(attempts);
			await updatePendingInvoice(invoice.id, {
				status: "failed",
				attempts,
				retry_count: attempts,
				next_attempt_at: invoice.next_attempt_at,
				error: invoice.error,
				claimed_by: null,
				claim_expires: null,
			});
			return "retry";
		}
	}

	async function syncPendingInvoices(): Promise<void> {
		if (isSyncing.value || !isOnline.value) return;
		if (!currentOwner()) return;

		isSyncing.value = true;
		syncErrors.value = [];

		try {
			const locked = await runExclusive("xpos-queue-drain", async (lock) => {
				await recoverStaleClaims();
				const invoices = (await getAllPendingInvoices()) as OfflineInvoice[];
				if (invoices.length === 0) return;

				let synced = 0;
				let failed = 0;
				let rejected = 0;
				let consecutiveTransient = 0;

				for (const invoice of invoices) {
					if (!isOnline.value) break;
					if (!dueForBackgroundSend(invoice, Date.now())) continue;
					await lock.renew();

					const outcome = await attemptSend(invoice);
					if (outcome === "skipped") continue;
					consecutiveTransient = outcome === "retry" ? consecutiveTransient + 1 : 0;

					if (outcome === "synced") synced++;
					else if (outcome === "rejected") {
						rejected++;
						syncErrors.value.push(
							`Invoice for ${invoice.customer_name || "Unknown"}: ${invoice.error}`,
						);
					} else if (outcome === "retry") failed++;
					else
						syncErrors.value.push(
							outcome === "needs_review"
								? __("Invoice for {0}: prices changed, held for review", [
										invoice.customer_name || __("Unknown"),
									])
								: __("Invoice for {0}: FBR did not confirm it, check needed", [
										invoice.customer_name || __("Unknown"),
									]),
						);
					if (consecutiveTransient >= DRAIN_BREAKER) break;
				}

				if (synced > 0) showSuccess(`Synced ${synced} offline invoice${synced > 1 ? "s" : ""}`);
				if (failed > 0)
					showError(`Could not send ${failed} invoice${failed > 1 ? "s" : ""}. Will retry.`);
				if (rejected > 0) {
					showError(
						__(
							"{0} offline invoice(s) were refused by the server. Review them in the pending list.",
							[String(rejected)],
						),
					);
				}
			});
			void locked;
			await refreshPendingCount();
			await loadPendingInvoices();
			lastSyncTime.value = new Date().toISOString();
			broadcast("queue-changed");
		} catch (error) {
			console.error("Sync error:", error);
		} finally {
			isSyncing.value = false;
			scheduleRetry();
		}
	}

	function scheduleRetry(): void {
		if (retryTimerId) clearTimeout(retryTimerId);
		retryTimerId = null;
		const due = pendingInvoices.value
			.filter((inv) => inv.status === "failed" && !inv.hold && inv.next_attempt_at)
			.map((inv) => Date.parse(inv.next_attempt_at as string))
			.filter((time) => Number.isFinite(time));
		if (!due.length) return;
		const delay = Math.max(Math.min(...due) - Date.now(), MIN_RETRY_DELAY_MS);
		if (delay >= SYNC_INTERVAL_MS) return;
		retryTimerId = setTimeout(() => void syncPendingInvoices(), delay);
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

		if (invoice.hold) {
			await updatePendingInvoice(id, { hold: null });
			invoice.hold = null;
		}
		const outcome = await attemptSend(invoice);
		await refreshPendingCount();
		await loadPendingInvoices();
		broadcast("queue-changed");

		switch (outcome) {
			case "synced":
				showSuccess(__("Invoice synced successfully"));
				return true;
			case "needs_review":
				showError(__("Prices changed since this sale was rung up. Review it in the pending list."));
				return false;
			case "fiscal_uncertain":
				showError(
					invoice.error || __("FBR did not confirm this sale. Check it in the pending list."),
				);
				return false;
			case "skipped":
				showInfo(__("Another tab is already sending this sale."));
				return false;
			case "rejected":
				showError(invoice.error || __("The server refused this sale."));
				return false;
			default:
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
			if ((inv as any).status === "fiscal_uncertain") continue;
			if ((inv as any).id) await deletePendingInvoice((inv as any).id);
		}
		await refreshPendingCount();
		await loadPendingInvoices();
	}

	async function downloadPendingExport(): Promise<void> {
		const blob = new Blob([await exportPendingInvoices()], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const link = document.createElement("a");
		link.href = url;
		link.download = `xpos-pending-sales-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
		link.click();
		setTimeout(() => URL.revokeObjectURL(url), 10_000);
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
			if (posStore.useOfflineMode) {
				if (!persistenceAsked) {
					persistenceAsked = true;
					void requestPersistence().then(() => refreshStorageHealth());
				}
				syncCatalog(posStore.profileName)
					.then(() => refreshCatalogStatus())
					.catch((err) => {
						console.warn("[XPOS Sync] Failed to sync catalogue:", err);
						void refreshCatalogStatus();
					});
			}

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
		dbState,
		catalogStatus,
		storageHealth,
		storagePersisted,
		init,
		destroy,
		refreshPendingCount,
		refreshDeadLetterCount,
		refreshCatalogStatus,
		refreshStorageHealth,
		retryDeadLetterInvoice,
		offlineBlockers,
		saveOffline,
		loadPendingInvoices,
		syncPendingInvoices,
		retrySingle,
		resolveReview,
		resolveFiscalCheck,
		recheckFiscalSale,
		consumePending,
		deletePending,
		clearAll,
		downloadPendingExport,
		startPeriodicSync,
		stopPeriodicSync,
		syncOfflineData,
	};
});
