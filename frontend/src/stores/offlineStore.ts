import { defineStore } from "pinia";
import { hasGiftCardActivity } from "@/services/giftCards";
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
import type { InvoiceData, InvoiceItem, ReceiptSnapshot, RepriceResponse } from "@/types/pos.types";
import __ from "@/lib/translate";
import {
	completeLocalFiscalization,
	FiscalUncertainError,
	type FiscalPending,
} from "@/services/fbrLocalService";

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
		window.addEventListener("xpos:pending-invoices-changed", refreshPendingCount);
		window.addEventListener("online", handleOnline);
		window.addEventListener("offline", handleOffline);

		refreshPendingCount();
		startPeriodicSync();
	}

	function destroy() {
		window.removeEventListener("xpos:pending-invoices-changed", refreshPendingCount);
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
		if (hasGiftCardActivity(invoiceData)) return { success: false };
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
			const needsAttention = (inv: OfflineInvoice) =>
				inv.status === "dead_letter" ||
				inv.status === "needs_review" ||
				inv.status === "fiscal_uncertain";
			pendingCount.value = pendingInvoices.value.filter((inv) => !needsAttention(inv)).length;
			deadLetterCount.value = pendingInvoices.value.filter(needsAttention).length;
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
				if (
					invoice.status === "dead_letter" ||
					invoice.status === "needs_review" ||
					invoice.status === "fiscal_uncertain"
				) {
					continue;
				}
				try {
					invoice.status = "syncing";
					if (invoice.id) await updatePendingInvoice(invoice.id, { status: "syncing" });

					const outcome = await pushPending(invoice);
					if (outcome !== "synced") {
						syncErrors.value.push(
							outcome === "needs_review"
								? __("Invoice for {0}: prices changed, held for review", [
										invoice.customer_name || __("Unknown"),
									])
								: __("Invoice for {0}: FBR did not confirm it, check needed", [
										invoice.customer_name || __("Unknown"),
									]),
						);
						continue;
					}
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

			const outcome = await pushPending(invoice);
			await refreshPendingCount();
			await loadPendingInvoices();
			if (outcome === "needs_review") {
				showError(__("Prices changed since this sale was rung up. Review it in the pending list."));
				return false;
			}
			if (outcome === "fiscal_uncertain") {
				showError(
					invoice.error || __("FBR did not confirm this sale. Check it in the pending list."),
				);
				return false;
			}
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
			if ((inv as any).status === "fiscal_uncertain") continue;
			if ((inv as any).id) await deletePendingInvoice((inv as any).id);
		}
		await refreshPendingCount();
		await loadPendingInvoices();
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
		resolveReview,
		resolveFiscalCheck,
		recheckFiscalSale,
		consumePending,
		deletePending,
		clearAll,
		startPeriodicSync,
		stopPeriodicSync,
		syncOfflineData,
	};
});
