import { net } from "electron";
import { upsertBatch, query, execute, getMeta, setMeta } from "../database/dbService";
import { getPrimaryKeyForTable } from "../sync/syncConfig";
import { createLogger } from "../logger";

const log = createLogger("TillClient");

interface TillSyncContext {
	hubUrl: string;
	tillId: string;
	hubSecret?: string;
}

let context: TillSyncContext | null = null;

function hubFetch<T = unknown>(path: string, opts: { method?: string; body?: string } = {}): Promise<T> {
	if (!context) throw new Error("Till context not initialized");

	const url = `${context.hubUrl}${path}`;
	const method = opts.method || "GET";

	return new Promise((resolve, reject) => {
		const request = net.request({ method, url });
		request.setHeader("Content-Type", "application/json");
		request.setHeader("X-Till-Id", context!.tillId);
		if (context!.hubSecret) {
			request.setHeader("Authorization", `Bearer ${context!.hubSecret}`);
		}

		let body = "";
		request.on("response", (response) => {
			response.on("data", (chunk: Uint8Array) => {
				body += chunk.toString();
			});
			response.on("end", () => {
				try {
					const data = JSON.parse(body);
					if (response.statusCode && response.statusCode >= 400) {
						reject(new Error(data.error || `HTTP ${response.statusCode}`));
					} else {
						resolve(data as T);
					}
				} catch {
					reject(new Error(`Invalid JSON from hub: ${path}`));
				}
			});
		});

		request.on("error", reject);

		if (opts.body) request.write(opts.body);
		request.end();
	});
}

const PULL_TABLES = [
	"companies",
	"countries",
	"currencies",
	"uom",
	"brands",
	"industries",
	"modes_of_payment",
	"cost_centers",
	"warehouses",
	"accounts",
	"price_lists",
	"mode_of_payment_accounts",
	"pos_profiles",
	"pos_payment_methods",
	"items",
	"item_groups",
	"item_barcodes",
	"uom_conversion_details",
	"item_prices",
	"item_taxes",
	"item_vendors",
	"item_reorder_levels",
	"item_tax_templates",
	"item_tax_template_details",
	"sales_taxes_templates",
	"sales_taxes_charges",
	"pricing_rules",
	"pricing_rule_item_codes",
	"pricing_rule_item_groups",
	"pricing_rule_brands",
	"customers",
	"suppliers",
	"bins",
	"pos_users",
] as const;

async function pullFromHub(): Promise<number> {
	let totalPulled = 0;

	for (const table of PULL_TABLES) {
		const primaryKey = getPrimaryKeyForTable(table);
		const since = await getMeta(`till_last_sync_${table}`);
		let offset = 0;
		let hasMore = true;

		while (hasMore) {
			const params = new URLSearchParams({ limit: "500", offset: String(offset) });
			if (since) params.set("since", since);

			const result = await hubFetch<{ data: Record<string, unknown>[]; count: number }>(
				`/api/pull/${table}?${params}`,
			);

			if (result.data.length > 0) {
				await upsertBatch(table, result.data, primaryKey);
				totalPulled += result.data.length;
			}

			if (result.count < 500) {
				hasMore = false;
			} else {
				offset += 500;
			}
		}

		await setMeta(`till_last_sync_${table}`, new Date().toISOString());
	}

	return totalPulled;
}

async function pullDeletionsFromHub(): Promise<number> {
	const since = await getMeta("till_last_deletion_sync");

	const result = await hubFetch<{
		data: { table_name: string; record_key: string; deleted_at: string }[];
	}>(`/api/deletions${since ? `?since=${encodeURIComponent(since)}` : ""}`);

	let deleted = 0;
	const knownTables = new Set<string>(PULL_TABLES);

	for (const row of result.data) {
		if (knownTables.has(row.table_name)) {
			const keyCol = getPrimaryKeyForTable(row.table_name);
			await execute(`DELETE FROM \`${row.table_name}\` WHERE \`${keyCol}\` = ?`, [row.record_key]);
			deleted++;
		}
	}

	if (result.data.length > 0) {
		const lastDate = result.data[result.data.length - 1].deleted_at;
		await setMeta("till_last_deletion_sync", lastDate);
	}

	return deleted;
}

async function pushToHub(): Promise<{ invoices: number; purchases: number }> {
	let invoices = 0;
	let purchases = 0;

	const pendingInvoices = await query<{
		id: number;
		local_id: string;
		data: string;
		status: string;
	}>("SELECT * FROM `pending_invoices` WHERE `status` IN ('pending', 'failed') ORDER BY `created_at` ASC");

	for (const inv of pendingInvoices) {
		try {
			await execute("UPDATE `pending_invoices` SET `status` = 'syncing' WHERE `id` = ?", [inv.id]);

			await hubFetch("/api/push/invoice", {
				method: "POST",
				body: JSON.stringify({
					data: inv.data,
					local_id: inv.local_id,
					till_id: context!.tillId,
					customer_name: (inv as Record<string, unknown>).customer_name,
					grand_total: (inv as Record<string, unknown>).grand_total,
				}),
			});

			await execute(
				"UPDATE `pending_invoices` SET `status` = 'synced', `synced_at` = NOW() WHERE `id` = ?",
				[inv.id],
			);
			invoices++;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			await execute(
				"UPDATE `pending_invoices` SET `status` = 'failed', `error` = ?, `retry_count` = `retry_count` + 1 WHERE `id` = ?",
				[msg, inv.id],
			);
		}
	}

	const pendingPurchases = await query<{
		id: number;
		local_id: string;
		data: string;
		type: string;
		status: string;
	}>("SELECT * FROM `pending_purchases` WHERE `status` IN ('pending', 'failed') ORDER BY `created_at` ASC");

	for (const po of pendingPurchases) {
		try {
			await execute("UPDATE `pending_purchases` SET `status` = 'syncing' WHERE `id` = ?", [po.id]);

			await hubFetch("/api/push/purchase", {
				method: "POST",
				body: JSON.stringify({
					data: po.data,
					local_id: po.local_id,
					till_id: context!.tillId,
					type: po.type,
					supplier_name: (po as Record<string, unknown>).supplier_name,
					grand_total: (po as Record<string, unknown>).grand_total,
				}),
			});

			await execute(
				"UPDATE `pending_purchases` SET `status` = 'synced', `synced_at` = NOW() WHERE `id` = ?",
				[po.id],
			);
			purchases++;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			await execute(
				"UPDATE `pending_purchases` SET `status` = 'failed', `error` = ?, `retry_count` = `retry_count` + 1 WHERE `id` = ?",
				[msg, po.id],
			);
		}
	}

	const pendingExpenses = await query<{
		id: number;
		local_id: string;
		sync_status: string;
		expense_type: string;
		amount: number;
		description: string;
		posting_date: string;
		company: string;
		cost_center: string;
		mode_of_payment: string;
		user: string;
		pos_opening_shift_local_id: string;
	}>("SELECT * FROM `expenses` WHERE `sync_status` IN ('pending', 'failed') ORDER BY `id` ASC");

	for (const exp of pendingExpenses) {
		try {
			await execute("UPDATE `expenses` SET `sync_status` = 'syncing' WHERE `id` = ?", [exp.id]);

			await hubFetch("/api/push/expense", {
				method: "POST",
				body: JSON.stringify({
					local_id: exp.local_id,
					expense_type: exp.expense_type,
					amount: exp.amount,
					description: exp.description,
					posting_date: exp.posting_date,
					company: exp.company,
					cost_center: exp.cost_center,
					mode_of_payment: exp.mode_of_payment,
					user: exp.user,
					pos_opening_shift_local_id: exp.pos_opening_shift_local_id,
				}),
			});

			await execute("UPDATE `expenses` SET `sync_status` = 'synced' WHERE `id` = ?", [exp.id]);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			await execute("UPDATE `expenses` SET `sync_status` = 'failed' WHERE `id` = ?", [exp.id]);
		}
	}

	const pendingBankDrops = await query<{
		id: number;
		local_id: string;
		sync_status: string;
		amount: number;
		description: string;
		posting_date: string;
		company: string;
		mode_of_payment: string;
		user: string;
		pos_opening_shift_local_id: string;
	}>("SELECT * FROM `bank_drops` WHERE `sync_status` IN ('pending', 'failed') ORDER BY `id` ASC");

	for (const bd of pendingBankDrops) {
		try {
			await execute("UPDATE `bank_drops` SET `sync_status` = 'syncing' WHERE `id` = ?", [bd.id]);

			await hubFetch("/api/push/bank-drop", {
				method: "POST",
				body: JSON.stringify({
					local_id: bd.local_id,
					amount: bd.amount,
					description: bd.description,
					posting_date: bd.posting_date,
					company: bd.company,
					mode_of_payment: bd.mode_of_payment,
					user: bd.user,
					pos_opening_shift_local_id: bd.pos_opening_shift_local_id,
				}),
			});

			await execute("UPDATE `bank_drops` SET `sync_status` = 'synced' WHERE `id` = ?", [bd.id]);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			await execute("UPDATE `bank_drops` SET `sync_status` = 'failed' WHERE `id` = ?", [bd.id]);
		}
	}

	const pendingAdjustments = await query<{
		id: number;
		local_id: string;
		sync_status: string;
		item_code: string;
		warehouse: string;
		qty: number;
		adjustment_type: string;
		reason: string;
		posting_date: string;
		user: string;
	}>("SELECT * FROM `stock_adjustments` WHERE `sync_status` IN ('pending', 'failed') ORDER BY `id` ASC");

	for (const adj of pendingAdjustments) {
		try {
			await execute("UPDATE `stock_adjustments` SET `sync_status` = 'syncing' WHERE `id` = ?", [
				adj.id,
			]);

			await hubFetch("/api/push/stock-adjustment", {
				method: "POST",
				body: JSON.stringify({
					local_id: adj.local_id,
					item_code: adj.item_code,
					warehouse: adj.warehouse,
					qty: adj.qty,
					adjustment_type: adj.adjustment_type,
					reason: adj.reason,
					posting_date: adj.posting_date,
					user: adj.user,
				}),
			});

			await execute("UPDATE `stock_adjustments` SET `sync_status` = 'synced' WHERE `id` = ?", [adj.id]);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			await execute("UPDATE `stock_adjustments` SET `sync_status` = 'failed' WHERE `id` = ?", [adj.id]);
		}
	}

	return { invoices, purchases };
}

export async function initTillClient(hubUrl: string, tillId: string): Promise<void> {
	const hubSecret = (await getMeta("hub_api_secret")) || undefined;
	context = { hubUrl: hubUrl.replace(/\/$/, ""), tillId, hubSecret };
	log.info(`Initialized - hub: ${context.hubUrl}, till: ${tillId}, auth: ${hubSecret ? "yes" : "no"}`);
}

export async function runTillSync(): Promise<{
	pulled: number;
	deleted: number;
	pushed: { invoices: number; purchases: number };
}> {
	if (!context) throw new Error("Till client not initialized");

	const pulled = await pullFromHub();
	const deleted = await pullDeletionsFromHub();
	const pushed = await pushToHub();

	return { pulled, deleted, pushed };
}

export async function pingHub(): Promise<boolean> {
	try {
		const result = await hubFetch<{ status: string }>("/api/health");
		return result.status === "ok";
	} catch {
		return false;
	}
}
