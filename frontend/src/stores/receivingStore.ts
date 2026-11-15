import { computed, ref, watch } from "vue";
import { defineStore } from "pinia";
import { call } from "@/services/api";
import { toast } from "@/services/toast";
import { useAuthStore } from "@/stores/authStore";
import { usePosStore } from "@/stores/posStore";
import { isOnline } from "@/utils";
import __ from "@/lib/translate";
import type {
	IncomingTransfer,
	ReceiptDraft,
	ReceiptStatus,
	ReceivingLine,
	ReceivingSetup,
	SaveResult,
	TransferSummary,
} from "@/types/receiving.types";

const API = "xpos.api.receiving.";
const STORAGE_PREFIX = "xpos.receiving.draft.";

interface Header {
	stock_entry: string;
	posting_date: string;
	remarks: string;
}

function today(): string {
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function newRequestId(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return "rcv_" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function emptyHeader(): Header {
	return { stock_entry: "", posting_date: today(), remarks: "" };
}

export const useReceivingStore = defineStore("receiving", () => {
	const setup = ref<ReceivingSetup | null>(null);
	const setupError = ref("");
	const loadingSetup = ref(false);

	const transfers = ref<TransferSummary[]>([]);
	const drafts = ref<ReceiptDraft[]>([]);
	const listError = ref("");
	const loadingList = ref(false);

	const transfer = ref<IncomingTransfer | null>(null);
	const header = ref<Header>(emptyHeader());
	const lines = ref<ReceivingLine[]>([]);
	const requestId = ref(newRequestId());

	const saving = ref(false);
	const loadingTransfer = ref(false);
	const uncertain = ref(false);
	const draftDoc = ref<SaveResult | null>(null);
	const dirty = ref(false);
	const online = ref(isOnline());

	const profileName = computed(() => setup.value?.pos_profile ?? usePosStore().profileName);
	const canDraft = computed(() => !!setup.value?.can_draft);
	const canSubmit = computed(() => !!setup.value?.can_submit);
	const seeRates = computed(() => !!setup.value?.can_see_rates);

	const totalQty = computed(() => lines.value.reduce((n, l) => n + (l.qty || 0), 0));
	const totalReturn = computed(() => lines.value.reduce((n, l) => n + (l.return_qty || 0), 0));
	const totalAmount = computed(() => lines.value.reduce((n, l) => n + (l.qty || 0) * (l.rate ?? 0), 0));

	function storageKey(): string {
		return `${STORAGE_PREFIX}${useAuthStore().userName}.${profileName.value}`;
	}

	function persist(): void {
		try {
			if (!transfer.value || (!dirty.value && !draftDoc.value)) {
				localStorage.removeItem(storageKey());
				return;
			}
			localStorage.setItem(
				storageKey(),
				JSON.stringify({
					transfer: transfer.value,
					header: header.value,
					lines: lines.value,
					requestId: requestId.value,
					uncertain: uncertain.value,
					draftDoc: draftDoc.value,
				}),
			);
		} catch {}
	}

	function restore(): boolean {
		try {
			const raw = localStorage.getItem(storageKey());
			if (!raw) return false;
			const saved = JSON.parse(raw);
			if (!saved?.transfer || !Array.isArray(saved.lines)) return false;
			transfer.value = saved.transfer;
			header.value = { ...emptyHeader(), ...saved.header };
			lines.value = saved.lines;
			requestId.value = saved.requestId || newRequestId();
			uncertain.value = !!saved.uncertain;
			draftDoc.value = saved.draftDoc || null;
			dirty.value = true;
			return true;
		} catch {
			return false;
		}
	}

	watch([transfer, header, lines, uncertain, draftDoc, dirty], persist, { deep: true });

	async function loadSetup(): Promise<void> {
		loadingSetup.value = true;
		setupError.value = "";
		try {
			setup.value = await call<ReceivingSetup>(API + "get_receiving_setup", {
				pos_profile: usePosStore().profileName,
			});
		} catch (e) {
			setupError.value = e instanceof Error ? e.message : String(e);
		} finally {
			loadingSetup.value = false;
		}
	}

	async function loadList(txt = ""): Promise<void> {
		loadingList.value = true;
		listError.value = "";
		try {
			const [rows, saved] = await Promise.all([
				call<TransferSummary[]>(API + "list_incoming_transfers", {
					pos_profile: profileName.value,
					txt: txt || undefined,
				}),
				call<ReceiptDraft[]>(API + "list_receipt_drafts", { pos_profile: profileName.value }),
			]);
			transfers.value = rows || [];
			drafts.value = saved || [];
		} catch (e) {
			transfers.value = [];
			drafts.value = [];
			listError.value = e instanceof Error ? e.message : String(e);
		} finally {
			loadingList.value = false;
		}
	}

	function closeTransfer(): void {
		transfer.value = null;
		lines.value = [];
		header.value = emptyHeader();
		requestId.value = newRequestId();
		uncertain.value = false;
		draftDoc.value = null;
		dirty.value = false;
		persist();
	}

	async function openTransfer(name: string): Promise<boolean> {
		loadingTransfer.value = true;
		try {
			const se = await call<IncomingTransfer>(API + "get_incoming_transfer", {
				pos_profile: profileName.value,
				stock_entry: name,
			});
			closeTransfer();
			transfer.value = se;
			header.value.stock_entry = se.name;
			lines.value = se.items.map((r) => ({
				ste_detail: r.ste_detail,
				item_code: r.item_code,
				item_name: r.item_name,
				uom: r.uom,
				stock_uom: r.stock_uom,
				conversion_factor: r.conversion_factor,
				sent_qty: r.sent_qty,
				received_qty: r.received_qty,
				pending_qty: r.pending_qty,
				has_batch_no: r.has_batch_no,
				has_serial_no: r.has_serial_no,
				variant_of: r.variant_of,
				rate: r.basic_rate ?? null,
				qty: r.pending_qty,
				return_qty: 0,
			}));
			dirty.value = false;
			return true;
		} catch (e) {
			toast.error(e instanceof Error ? e.message : String(e), { id: "receiving-open" });
			return false;
		} finally {
			loadingTransfer.value = false;
		}
	}

	function touch(): void {
		dirty.value = true;
	}

	async function lookupItem(code: string): Promise<string | null> {
		return call<string | null>(API + "lookup_item", { pos_profile: profileName.value, code });
	}

	function countScan(itemCode: string): "added" | "full" | "missing" {
		const open = lines.value.filter((l) => l.item_code === itemCode);
		if (!open.length) return "missing";
		const line = open.find((l) => l.qty + l.return_qty + 1 <= l.pending_qty + 1e-9);
		if (!line) return "full";
		line.qty += 1;
		dirty.value = true;
		return "added";
	}

	function payload() {
		return {
			stock_entry: header.value.stock_entry,
			posting_date: header.value.posting_date,
			remarks: header.value.remarks,
			items: lines.value
				.filter((l) => l.qty > 0)
				.map((l) => ({ ste_detail: l.ste_detail, qty: l.qty })),
		};
	}

	function isUncertain(e: unknown): boolean {
		const err = e as { excType?: string; message?: string; name?: string };
		return !isOnline() || err?.message === "__offline__" || err?.name === "SyntaxError" || !err?.excType;
	}

	function announce(result: SaveResult): void {
		if (result.stock_posted) {
			toast.success(__("{0} submitted. Stock has been received.").replace("{0}", result.name), {
				id: "receiving-result",
			});
		} else {
			toast.info(__("{0} saved as a draft. No stock has moved yet.").replace("{0}", result.name), {
				id: "receiving-result",
			});
		}
	}

	function adopt(result: SaveResult): void {
		if (result.docstatus === 1) {
			closeTransfer();
		} else {
			draftDoc.value = result;
			dirty.value = false;
		}
	}

	async function reconcile(): Promise<ReceiptStatus> {
		const status = await call<ReceiptStatus>(API + "get_receipt_status", {
			pos_profile: profileName.value,
			request_id: requestId.value,
		});
		if (status.found) {
			uncertain.value = false;
			adopt(status as SaveResult);
		}
		return status;
	}

	async function save(action: "draft" | "submit"): Promise<SaveResult | null> {
		if (saving.value) return null;
		if (!online.value) {
			toast.error(__("You are offline. Stock receiving needs a connection."), {
				id: "receiving-offline",
			});
			return null;
		}
		saving.value = true;
		try {
			if (uncertain.value) {
				const status = await reconcile();
				if (status.found && (action === "draft" || status.docstatus === 1)) {
					announce(status as SaveResult);
					return status as SaveResult;
				}
			}
			const result = await call<SaveResult>(API + "save_receipt", {
				pos_profile: profileName.value,
				data: JSON.stringify(payload()),
				request_id: requestId.value,
				action,
			});
			uncertain.value = false;
			announce(result);
			adopt(result);
			return result;
		} catch (e) {
			if (isUncertain(e)) {
				uncertain.value = true;
				toast.warning(__("The connection dropped before an answer came back."), {
					id: "receiving-uncertain",
					description: __(
						"Nothing is assumed. Save again and the server is asked first whether the receipt was made.",
					),
				});
			} else {
				toast.error(e instanceof Error ? e.message : String(e), { id: "receiving-error" });
			}
			return null;
		} finally {
			saving.value = false;
		}
	}

	async function submitDraft(name = draftDoc.value?.name): Promise<SaveResult | null> {
		if (!name || saving.value) return null;
		saving.value = true;
		try {
			const result = await call<SaveResult>(API + "submit_receipt_draft", {
				pos_profile: profileName.value,
				name,
			});
			announce(result);
			if (draftDoc.value?.name === name) adopt(result);
			await loadList();
			return result;
		} catch (e) {
			toast.error(e instanceof Error ? e.message : String(e), { id: "receiving-error" });
			return null;
		} finally {
			saving.value = false;
		}
	}

	async function returnShortage(): Promise<SaveResult | null> {
		const rows = lines.value.filter((l) => l.return_qty > 0);
		if (!rows.length || !transfer.value || saving.value) return null;
		saving.value = true;
		try {
			const result = await call<SaveResult>(API + "return_transfer_shortage", {
				pos_profile: profileName.value,
				data: JSON.stringify({
					stock_entry: transfer.value.name,
					remarks: header.value.remarks,
					items: rows.map((l) => ({ ste_detail: l.ste_detail, return_qty: l.return_qty })),
				}),
				request_id: newRequestId(),
			});
			toast.success(
				__("{0} returned the shortage to the source warehouse.").replace("{0}", result.name),
				{
					id: "receiving-result",
				},
			);
			await openTransfer(transfer.value.name);
			return result;
		} catch (e) {
			toast.error(e instanceof Error ? e.message : String(e), { id: "receiving-error" });
			return null;
		} finally {
			saving.value = false;
		}
	}

	function setOnline(value: boolean): void {
		online.value = value;
	}

	return {
		setup,
		setupError,
		loadingSetup,
		transfers,
		drafts,
		listError,
		loadingList,
		transfer,
		header,
		lines,
		requestId,
		saving,
		loadingTransfer,
		uncertain,
		draftDoc,
		dirty,
		online,
		profileName,
		canDraft,
		canSubmit,
		seeRates,
		totalQty,
		totalReturn,
		totalAmount,
		loadSetup,
		loadList,
		restore,
		openTransfer,
		closeTransfer,
		touch,
		lookupItem,
		countScan,
		reconcile,
		save,
		submitDraft,
		returnShortage,
		setOnline,
	};
});
