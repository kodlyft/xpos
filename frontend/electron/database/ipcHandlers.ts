/**
 * IPC handlers for database operations.
 * Registered in Electron main process, called from renderer via preload bridge.
 *
 * Each handler maps to a "db:*" IPC channel.
 * The renderer never touches MariaDB directly - all access goes through here.
 */

import { ipcMain } from "electron";
import {
	query,
	queryOne,
	execute,
	upsertBatch,
	getMeta,
	setMeta,
	testConnection,
	initDatabase,
	getConfig,
	saveDbConfig,
	type DbConfig,
} from "./dbService";
import { createLogger } from "../logger";

const log = createLogger("DB-IPC");

const DEFAULT_LOCAL_SEARCH_COLUMNS = ["item_code", "item_name", "local_item_name", "description"];
const SAFE_COLUMN = /^[a-z_][a-z0-9_]*$/;

let localItemColumns: Set<string> | null = null;

async function getLocalItemColumns(): Promise<Set<string>> {
	if (!localItemColumns) {
		const rows = (await query(
			"SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'items'",
		)) as { COLUMN_NAME: string }[];
		localItemColumns = new Set(rows.map((r) => r.COLUMN_NAME));
	}
	return localItemColumns;
}

async function resolveItemSearchColumns(requested?: string[]): Promise<string[]> {
	const wanted = requested?.length ? requested : DEFAULT_LOCAL_SEARCH_COLUMNS;
	const available = await getLocalItemColumns();
	const mapped = wanted.map((f) => (f === "name" ? "item_code" : f));

	const usable = [...new Set(mapped.filter((f) => SAFE_COLUMN.test(f) && available.has(f)))];
	const dropped = [...new Set(mapped)].filter((f) => !usable.includes(f));
	if (dropped.length) {
		log.warn(
			`Offline item search ignoring field(s) with no local column: ${dropped.join(", ")}. ` +
				"Add them to schema.sql and the sync field list to search them offline.",
		);
	}

	return usable.length ? usable : ["item_code", "item_name"];
}

export function registerDbHandlers(): void {
	ipcMain.handle("db:get-setting", async (_e, key: string) => {
		const row = await queryOne<{ value: string }>("SELECT `value` FROM `app_settings` WHERE `key` = ?", [
			key,
		]);
		return row?.value ?? null;
	});

	ipcMain.handle("db:set-setting", async (_e, key: string, value: string, category?: string) => {
		await execute(
			`INSERT INTO \`app_settings\` (\`key\`, \`value\`, \`category\`)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE \`value\` = VALUES(\`value\`), \`category\` = VALUES(\`category\`)`,
			[key, value, category || "general"],
		);
		return true;
	});

	ipcMain.handle("db:get-settings-by-category", async (_e, category: string) => {
		return query("SELECT `key`, `value` FROM `app_settings` WHERE `category` = ?", [category]);
	});

	ipcMain.handle("db:get-all-settings", async () => {
		return query("SELECT `key`, `value`, `category` FROM `app_settings` ORDER BY `category`, `key`");
	});

	ipcMain.handle("db:test-connection", async (_e, config: Partial<DbConfig>) => {
		return testConnection(config);
	});

	ipcMain.handle("db:get-config", () => {
		const cfg = getConfig();
		return { ...cfg, password: cfg.password ? "****" : "" };
	});

	ipcMain.handle("db:reinit", async (_e, config: Partial<DbConfig>) => {
		try {
			await initDatabase(config);
			return { success: true };
		} catch (err) {
			log.error("db:reinit failed", err);
			return { success: false, error: err instanceof Error ? err.message : String(err) };
		}
	});

	ipcMain.handle(
		"db:get-items",
		async (
			_e,
			opts?: {
				search?: string;
				searchFields?: string[];
				group?: string;
				limit?: number;
				offset?: number;
				priceList?: string;
				warehouse?: string;
			},
		) => {
			// Correlated subqueries for price and stock avoid duplicate rows from JOINs.
			// The item_barcodes LEFT JOIN is only for search filtering.
			const params: unknown[] = [
				opts?.priceList || "", // price subquery
				opts?.warehouse || "", // stock_cache subquery
				opts?.warehouse || "", // bins subquery
			];

			let sql = `SELECT DISTINCT i.*,
      COALESCE(
        (SELECT ip.\`price_list_rate\` FROM \`item_prices\` ip
         WHERE ip.\`item_code\` = i.\`item_code\` AND ip.\`price_list\` = ? AND ip.\`selling\` = 1
         ORDER BY ip.\`valid_from\` DESC LIMIT 1),
        i.\`standard_rate\`, 0
      ) AS rate,
      i.\`stock_uom\` AS uom,
      COALESCE(
        (SELECT sc.\`actual_qty\` FROM \`stock_cache\` sc
         WHERE sc.\`item_code\` = i.\`item_code\` AND sc.\`warehouse\` = ? LIMIT 1),
        (SELECT b.\`actual_qty\` FROM \`bins\` b
         WHERE b.\`item_code\` = i.\`item_code\` AND b.\`warehouse\` = ? LIMIT 1),
        0
      ) AS actual_qty
      FROM \`items\` i
      LEFT JOIN \`item_barcodes\` ib ON ib.\`parent\` = i.\`item_code\`
      WHERE i.\`disabled\` = 0`;

			if (opts?.group && opts.group !== "All Item Groups") {
				sql += " AND i.`item_group` = ?";
				params.push(opts.group);
			}
			if (opts?.search) {
				const columns = await resolveItemSearchColumns(opts.searchFields);
				const clauses = columns.map((c) => `COALESCE(i.\`${c}\`, '') LIKE ?`);
				clauses.push("ib.`barcode` LIKE ?");
				sql += ` AND (${clauses.join(" OR ")})`;
				const like = `%${opts.search}%`;
				for (let i = 0; i < clauses.length; i++) params.push(like);
			}
			sql += " ORDER BY i.`item_name` ASC";
			if (opts?.limit) {
				sql += " LIMIT ?";
				params.push(opts.limit);
				if (opts?.offset) {
					sql += " OFFSET ?";
					params.push(opts.offset);
				}
			}
			return query(sql, params);
		},
	);

	ipcMain.handle("db:get-item", async (_e, itemCode: string) => {
		return queryOne("SELECT * FROM `items` WHERE `item_code` = ?", [itemCode]);
	});

	ipcMain.handle("db:upsert-items", async (_e, rows: Record<string, unknown>[]) => {
		return upsertBatch("items", rows, "item_code");
	});

	ipcMain.handle("db:count-items", async () => {
		const row = await queryOne<{ cnt: number }>(
			"SELECT COUNT(*) as cnt FROM `items` WHERE `disabled` = 0",
		);
		return row?.cnt ?? 0;
	});

	ipcMain.handle("db:clear-items", async () => {
		await execute("DELETE FROM `items`");
		return true;
	});

	ipcMain.handle("db:get-item-groups", async () => {
		return query("SELECT * FROM `item_groups` ORDER BY `name`");
	});

	ipcMain.handle("db:upsert-item-groups", async (_e, rows: Record<string, unknown>[]) => {
		return upsertBatch("item_groups", rows, "name");
	});

	ipcMain.handle("db:get-customers", async (_e, opts?: { search?: string; limit?: number }) => {
		let sql = "SELECT * FROM `customers` WHERE `disabled` = 0";
		const params: unknown[] = [];

		if (opts?.search) {
			sql +=
				" AND (`name` LIKE ? OR `customer_name` LIKE ? OR `mobile_no` LIKE ? OR `email_id` LIKE ?)";
			const like = `%${opts.search}%`;
			params.push(like, like, like, like);
		}
		sql += " ORDER BY `customer_name` ASC";
		if (opts?.limit) {
			sql += " LIMIT ?";
			params.push(opts.limit);
		}
		return query(sql, params);
	});

	ipcMain.handle("db:get-customer", async (_e, name: string) => {
		return queryOne("SELECT * FROM `customers` WHERE `name` = ?", [name]);
	});

	ipcMain.handle("db:upsert-customers", async (_e, rows: Record<string, unknown>[]) => {
		return upsertBatch("customers", rows, "name");
	});

	ipcMain.handle("db:add-local-customer", async (_e, customer: Record<string, unknown>) => {
		const localId = `local_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
		await execute(
			`INSERT INTO \`customers\` (\`name\`, \`customer_name\`, \`customer_group\`, \`territory\`,
        \`mobile_no\`, \`email_id\`, \`default_currency\`, \`is_local\`, \`local_id\`)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
			[
				localId,
				customer.customer_name,
				customer.customer_group || null,
				customer.territory || null,
				customer.mobile_no || null,
				customer.email_id || null,
				customer.default_currency || null,
				localId,
			],
		);
		return { name: localId, local_id: localId };
	});

	ipcMain.handle("db:get-suppliers", async (_e, opts?: { search?: string; limit?: number }) => {
		let sql = "SELECT * FROM `suppliers`";
		const params: unknown[] = [];

		if (opts?.search) {
			sql += " WHERE (`name` LIKE ? OR `supplier_name` LIKE ? OR `mobile_no` LIKE ?)";
			const like = `%${opts.search}%`;
			params.push(like, like, like);
		}
		sql += " ORDER BY `supplier_name` ASC";
		if (opts?.limit) {
			sql += " LIMIT ?";
			params.push(opts.limit);
		}
		return query(sql, params);
	});

	ipcMain.handle("db:upsert-suppliers", async (_e, rows: Record<string, unknown>[]) => {
		return upsertBatch("suppliers", rows, "name");
	});

	ipcMain.handle("db:get-stock", async (_e, warehouse: string, itemCode?: string) => {
		if (itemCode) {
			return queryOne("SELECT * FROM `stock_cache` WHERE `warehouse` = ? AND `item_code` = ?", [
				warehouse,
				itemCode,
			]);
		}
		return query("SELECT * FROM `stock_cache` WHERE `warehouse` = ?", [warehouse]);
	});

	ipcMain.handle(
		"db:upsert-stock",
		async (_e, warehouse: string, entries: { item_code: string; actual_qty: number }[]) => {
			const rows = entries.map((e) => ({
				cache_key: `${warehouse}::${e.item_code}`,
				warehouse,
				item_code: e.item_code,
				actual_qty: e.actual_qty,
			}));
			return upsertBatch("stock_cache", rows, "cache_key");
		},
	);

	ipcMain.handle("db:update-stock-qty", async (_e, warehouse: string, itemCode: string, qty: number) => {
		await execute(
			`INSERT INTO \`stock_cache\` (\`cache_key\`, \`warehouse\`, \`item_code\`, \`actual_qty\`)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE \`actual_qty\` = ?`,
			[`${warehouse}::${itemCode}`, warehouse, itemCode, qty, qty],
		);
		return true;
	});

	ipcMain.handle(
		"db:add-pending-invoice",
		async (
			_e,
			record: {
				data: unknown;
				customer_name?: string;
				grand_total?: number;
			},
		) => {
			const localId = `inv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
			const result = await execute(
				`INSERT INTO \`pending_invoices\` (\`local_id\`, \`data\`, \`status\`, \`customer_name\`, \`grand_total\`)
       VALUES (?, ?, 'pending', ?, ?)`,
				[localId, JSON.stringify(record.data), record.customer_name || null, record.grand_total || 0],
			);
			return { id: result.insertId, local_id: localId };
		},
	);

	ipcMain.handle("db:get-pending-invoice", async (_e, id: number) => {
		const row = await queryOne<{
			id: number;
			local_id: string;
			data: string;
			status: string;
			customer_name: string | null;
			grand_total: number;
			is_return: number;
			is_draft: number;
		}>(`SELECT * FROM \`pending_invoices\` WHERE \`id\` = ?`, [id]);
		if (!row) return null;
		return {
			...row,
			data: JSON.parse(row.data || "{}"),
			is_return: row.is_return === 1,
			is_draft: row.is_draft === 1,
		};
	});

	ipcMain.handle("db:get-pending-invoices", async (_e, status?: string) => {
		if (status) {
			return query("SELECT * FROM `pending_invoices` WHERE `status` = ? ORDER BY `created_at`", [
				status,
			]);
		}
		return query("SELECT * FROM `pending_invoices` ORDER BY `created_at`");
	});

	ipcMain.handle("db:update-pending-invoice", async (_e, id: number, updates: Record<string, unknown>) => {
		const setClauses = Object.keys(updates)
			.map((k) => `\`${k}\` = ?`)
			.join(", ");
		const params = [...Object.values(updates), id];
		await execute(`UPDATE \`pending_invoices\` SET ${setClauses} WHERE \`id\` = ?`, params);
		return true;
	});

	ipcMain.handle("db:delete-pending-invoice", async (_e, id: number) => {
		await execute("DELETE FROM `pending_invoices` WHERE `id` = ?", [id]);
		return true;
	});

	ipcMain.handle("db:count-pending-invoices", async () => {
		const row = await queryOne<{ cnt: number }>(
			"SELECT COUNT(*) as cnt FROM `pending_invoices` WHERE `status` IN ('pending','failed')",
		);
		return row?.cnt ?? 0;
	});

	ipcMain.handle(
		"db:add-pending-purchase",
		async (
			_e,
			record: {
				type: string;
				data: unknown;
				supplier_name?: string;
				grand_total?: number;
			},
		) => {
			const localId = `pur_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
			const result = await execute(
				`INSERT INTO \`pending_purchases\` (\`local_id\`, \`type\`, \`data\`, \`status\`, \`supplier_name\`, \`grand_total\`)
       VALUES (?, ?, ?, 'pending', ?, ?)`,
				[
					localId,
					record.type,
					JSON.stringify(record.data),
					record.supplier_name || null,
					record.grand_total || 0,
				],
			);
			return { id: result.insertId, local_id: localId };
		},
	);

	ipcMain.handle("db:get-pending-purchases", async (_e, opts?: { type?: string; status?: string }) => {
		let sql = "SELECT * FROM `pending_purchases`";
		const conditions: string[] = [];
		const params: unknown[] = [];

		if (opts?.type) {
			conditions.push("`type` = ?");
			params.push(opts.type);
		}
		if (opts?.status) {
			conditions.push("`status` = ?");
			params.push(opts.status);
		}
		if (conditions.length) sql += " WHERE " + conditions.join(" AND ");
		sql += " ORDER BY `created_at`";
		return query(sql, params);
	});

	ipcMain.handle("db:update-pending-purchase", async (_e, id: number, updates: Record<string, unknown>) => {
		const setClauses = Object.keys(updates)
			.map((k) => `\`${k}\` = ?`)
			.join(", ");
		const params = [...Object.values(updates), id];
		await execute(`UPDATE \`pending_purchases\` SET ${setClauses} WHERE \`id\` = ?`, params);
		return true;
	});

	ipcMain.handle("db:delete-pending-purchase", async (_e, id: number) => {
		await execute("DELETE FROM `pending_purchases` WHERE `id` = ?", [id]);
		return true;
	});

	ipcMain.handle("db:count-pending-purchases", async () => {
		const rows = await query<{ cnt: number }>(
			"SELECT COUNT(*) as cnt FROM `pending_purchases` WHERE `status` IN ('pending','failed')",
		);
		return rows[0]?.cnt ?? 0;
	});

	ipcMain.handle("db:get-dead-letters", async () => {
		const invoices = await query(
			"SELECT * FROM `pending_invoices` WHERE `status` = 'dead_letter' ORDER BY `created_at`",
		);
		const purchases = await query(
			"SELECT * FROM `pending_purchases` WHERE `status` = 'dead_letter' ORDER BY `created_at`",
		);
		return { invoices, purchases };
	});

	ipcMain.handle("db:count-dead-letters", async () => {
		const inv = await queryOne<{ cnt: number }>(
			"SELECT COUNT(*) as cnt FROM `pending_invoices` WHERE `status` = 'dead_letter'",
		);
		const pur = await queryOne<{ cnt: number }>(
			"SELECT COUNT(*) as cnt FROM `pending_purchases` WHERE `status` = 'dead_letter'",
		);
		return (inv?.cnt ?? 0) + (pur?.cnt ?? 0);
	});

	ipcMain.handle("db:retry-dead-letter", async (_e, table: string, id: number) => {
		if (table !== "pending_invoices" && table !== "pending_purchases") {
			throw new Error(`Invalid dead-letter table: ${table}`);
		}
		await execute(
			`UPDATE \`${table}\` SET \`status\` = 'pending', \`retry_count\` = 0, \`error\` = NULL WHERE \`id\` = ? AND \`status\` = 'dead_letter'`,
			[id],
		);
		return true;
	});

	ipcMain.handle("db:add-sync-id", async (_e, localId: string, serverName: string, doctype: string) => {
		await execute(
			`INSERT INTO \`sync_id_map\` (\`local_id\`, \`server_name\`, \`doctype\`)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE \`server_name\` = VALUES(\`server_name\`)`,
			[localId, serverName, doctype],
		);
		return true;
	});

	ipcMain.handle("db:get-server-name", async (_e, localId: string) => {
		const row = await queryOne<{ server_name: string }>(
			"SELECT `server_name` FROM `sync_id_map` WHERE `local_id` = ?",
			[localId],
		);
		return row?.server_name ?? null;
	});

	ipcMain.handle("db:get-meta", async (_e, key: string) => getMeta(key));
	ipcMain.handle("db:set-meta", async (_e, key: string, value: string) => {
		await setMeta(key, value);
		return true;
	});

	ipcMain.handle("db:cache-pos-data", async (_e, name: string, data: unknown) => {
		await execute(
			`INSERT INTO \`pos_profile_cache\` (\`name\`, \`data\`)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE \`data\` = VALUES(\`data\`)`,
			[name, JSON.stringify(data)],
		);
		return true;
	});

	ipcMain.handle("db:get-cached-pos-data", async (_e, name: string) => {
		const row = await queryOne<{ data: string }>(
			"SELECT `data` FROM `pos_profile_cache` WHERE `name` = ?",
			[name],
		);
		return row ? JSON.parse(row.data) : null;
	});

	ipcMain.handle(
		"db:cache-item-tax",
		async (
			_e,
			itemCode: string,
			company: string,
			data: {
				item_tax_template: string | null;
				item_tax_map: Record<string, number>;
			},
		) => {
			await execute(
				`INSERT INTO \`item_tax_cache\` (\`cache_key\`, \`item_code\`, \`company\`, \`item_tax_template\`, \`item_tax_map\`)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE \`item_tax_template\` = VALUES(\`item_tax_template\`), \`item_tax_map\` = VALUES(\`item_tax_map\`)`,
				[
					`${company}::${itemCode}`,
					itemCode,
					company,
					data.item_tax_template,
					JSON.stringify(data.item_tax_map),
				],
			);
			return true;
		},
	);

	ipcMain.handle("db:get-cached-item-tax", async (_e, itemCode: string, company: string) => {
		const row = await queryOne<{ item_tax_template: string; item_tax_map: string }>(
			"SELECT `item_tax_template`, `item_tax_map` FROM `item_tax_cache` WHERE `cache_key` = ?",
			[`${company}::${itemCode}`],
		);
		if (!row) return null;
		return {
			item_tax_template: row.item_tax_template,
			item_tax_map: row.item_tax_map ? JSON.parse(row.item_tax_map) : {},
		};
	});

	ipcMain.handle("db:get-companies", async () => {
		return query("SELECT * FROM `companies` ORDER BY `company_name`");
	});

	ipcMain.handle("db:upsert-companies", async (_e, rows: Record<string, unknown>[]) => {
		return upsertBatch("companies", rows, "name");
	});

	ipcMain.handle("db:get-cost-centers", async (_e, company?: string) => {
		if (company) {
			return query("SELECT * FROM `cost_centers` WHERE `company` = ? ORDER BY `name`", [company]);
		}
		return query("SELECT * FROM `cost_centers` ORDER BY `name`");
	});

	ipcMain.handle("db:upsert-cost-centers", async (_e, rows: Record<string, unknown>[]) => {
		return upsertBatch("cost_centers", rows, "name");
	});

	ipcMain.handle("db:get-countries", async () => {
		return query("SELECT * FROM `countries` ORDER BY `name`");
	});

	ipcMain.handle("db:upsert-countries", async (_e, rows: Record<string, unknown>[]) => {
		return upsertBatch("countries", rows, "name");
	});

	ipcMain.handle("db:get-currencies", async () => {
		return query("SELECT * FROM `currencies` WHERE `enabled` = 1 ORDER BY `name`");
	});

	ipcMain.handle("db:upsert-currencies", async (_e, rows: Record<string, unknown>[]) => {
		return upsertBatch("currencies", rows, "name");
	});

	ipcMain.handle("db:get-warehouses", async (_e, opts?: { company?: string; isGroup?: boolean }) => {
		let sql = "SELECT * FROM `warehouses` WHERE `disabled` = 0";
		const params: unknown[] = [];
		if (opts?.company) {
			sql += " AND `company` = ?";
			params.push(opts.company);
		}
		if (opts?.isGroup !== undefined) {
			sql += " AND `is_group` = ?";
			params.push(opts.isGroup ? 1 : 0);
		}
		sql += " ORDER BY `warehouse_name`";
		return query(sql, params);
	});

	ipcMain.handle("db:upsert-warehouses", async (_e, rows: Record<string, unknown>[]) => {
		return upsertBatch("warehouses", rows, "name");
	});

	ipcMain.handle(
		"db:get-accounts",
		async (_e, opts?: { company?: string; accountType?: string; rootType?: string }) => {
			let sql = "SELECT * FROM `accounts` WHERE `disabled` = 0";
			const params: unknown[] = [];
			if (opts?.company) {
				sql += " AND `company` = ?";
				params.push(opts.company);
			}
			if (opts?.accountType) {
				sql += " AND `account_type` = ?";
				params.push(opts.accountType);
			}
			if (opts?.rootType) {
				sql += " AND `root_type` = ?";
				params.push(opts.rootType);
			}
			sql += " ORDER BY `name`";
			return query(sql, params);
		},
	);

	ipcMain.handle("db:upsert-accounts", async (_e, rows: Record<string, unknown>[]) => {
		return upsertBatch("accounts", rows, "name");
	});

	ipcMain.handle("db:get-price-lists", async (_e, selling?: boolean) => {
		if (selling !== undefined) {
			return query(
				"SELECT * FROM `price_lists` WHERE `enabled` = 1 AND `selling` = ? ORDER BY `name`",
				[selling ? 1 : 0],
			);
		}
		return query("SELECT * FROM `price_lists` WHERE `enabled` = 1 ORDER BY `name`");
	});

	ipcMain.handle("db:upsert-price-lists", async (_e, rows: Record<string, unknown>[]) => {
		return upsertBatch("price_lists", rows, "name");
	});

	ipcMain.handle("db:get-uom", async () => {
		return query("SELECT * FROM `uom` WHERE `enabled` = 1 ORDER BY `name`");
	});

	ipcMain.handle("db:upsert-uom", async (_e, rows: Record<string, unknown>[]) => {
		return upsertBatch("uom", rows, "name");
	});

	ipcMain.handle("db:get-uom-conversions", async (_e, itemCode: string) => {
		return query("SELECT * FROM `uom_conversion_details` WHERE `parent` = ?", [itemCode]);
	});

	ipcMain.handle("db:upsert-uom-conversions", async (_e, rows: Record<string, unknown>[]) => {
		return upsertBatch("uom_conversion_details", rows, "name");
	});

	ipcMain.handle("db:get-brands", async () => {
		return query("SELECT * FROM `brands` ORDER BY `name`");
	});

	ipcMain.handle("db:upsert-brands", async (_e, rows: Record<string, unknown>[]) => {
		return upsertBatch("brands", rows, "name");
	});

	ipcMain.handle("db:get-industries", async () => {
		return query("SELECT * FROM `industries` ORDER BY `name`");
	});

	ipcMain.handle("db:upsert-industries", async (_e, rows: Record<string, unknown>[]) => {
		return upsertBatch("industries", rows, "name");
	});

	ipcMain.handle("db:get-modes-of-payment", async () => {
		return query("SELECT * FROM `modes_of_payment` WHERE `enabled` = 1 ORDER BY `name`");
	});

	ipcMain.handle("db:upsert-modes-of-payment", async (_e, rows: Record<string, unknown>[]) => {
		return upsertBatch("modes_of_payment", rows, "name");
	});

	ipcMain.handle("db:get-mode-of-payment-accounts", async (_e, company: string) => {
		return query("SELECT * FROM `mode_of_payment_accounts` WHERE `company` = ?", [company]);
	});

	ipcMain.handle("db:upsert-mode-of-payment-accounts", async (_e, rows: Record<string, unknown>[]) => {
		return upsertBatch("mode_of_payment_accounts", rows, "name");
	});

	ipcMain.handle("db:get-item-by-barcode", async (_e, barcode: string) => {
		const bc = await queryOne<{ parent: string }>(
			"SELECT `parent` FROM `item_barcodes` WHERE `barcode` = ?",
			[barcode],
		);
		if (!bc) return null;
		return queryOne("SELECT * FROM `items` WHERE `item_code` = ?", [bc.parent]);
	});

	ipcMain.handle("db:upsert-item-barcodes", async (_e, rows: Record<string, unknown>[]) => {
		return upsertBatch("item_barcodes", rows, "name");
	});

	ipcMain.handle("db:get-item-price", async (_e, itemCode: string, priceList: string) => {
		return queryOne(
			`SELECT * FROM \`item_prices\`
       WHERE \`item_code\` = ? AND \`price_list\` = ?
       AND (\`valid_from\` IS NULL OR \`valid_from\` <= CURDATE())
       AND (\`valid_upto\` IS NULL OR \`valid_upto\` >= CURDATE())
       ORDER BY \`valid_from\` DESC LIMIT 1`,
			[itemCode, priceList],
		);
	});

	ipcMain.handle("db:get-item-prices", async (_e, opts?: { priceList?: string; selling?: boolean }) => {
		let sql = "SELECT * FROM `item_prices` WHERE 1=1";
		const params: unknown[] = [];
		if (opts?.priceList) {
			sql += " AND `price_list` = ?";
			params.push(opts.priceList);
		}
		if (opts?.selling !== undefined) {
			sql += " AND `selling` = ?";
			params.push(opts.selling ? 1 : 0);
		}
		sql += " ORDER BY `item_code`";
		return query(sql, params);
	});

	ipcMain.handle("db:upsert-item-prices", async (_e, rows: Record<string, unknown>[]) => {
		return upsertBatch("item_prices", rows, "name");
	});

	ipcMain.handle("db:get-item-tax-templates", async (_e, company?: string) => {
		let sql = "SELECT * FROM `item_tax_templates` WHERE `disabled` = 0";
		const params: unknown[] = [];
		if (company) {
			sql += " AND `company` = ?";
			params.push(company);
		}
		return query(sql, params);
	});

	ipcMain.handle("db:upsert-item-tax-templates", async (_e, rows: Record<string, unknown>[]) => {
		return upsertBatch("item_tax_templates", rows, "name");
	});

	ipcMain.handle("db:get-item-tax-template-details", async (_e, templateName: string) => {
		return query("SELECT * FROM `item_tax_template_details` WHERE `parent` = ?", [templateName]);
	});

	ipcMain.handle("db:upsert-item-tax-template-details", async (_e, rows: Record<string, unknown>[]) => {
		return upsertBatch("item_tax_template_details", rows, "name");
	});

	ipcMain.handle("db:get-item-taxes", async (_e, itemCode: string) => {
		return query("SELECT * FROM `item_taxes` WHERE `parent` = ?", [itemCode]);
	});

	ipcMain.handle("db:upsert-item-taxes", async (_e, rows: Record<string, unknown>[]) => {
		return upsertBatch("item_taxes", rows, "name");
	});

	ipcMain.handle("db:get-item-vendors", async (_e, itemCode: string) => {
		return query("SELECT * FROM `item_vendors` WHERE `parent` = ?", [itemCode]);
	});

	ipcMain.handle("db:upsert-item-vendors", async (_e, rows: Record<string, unknown>[]) => {
		return upsertBatch("item_vendors", rows, "name");
	});

	ipcMain.handle("db:get-item-reorder-levels", async (_e, itemCode: string) => {
		return query("SELECT * FROM `item_reorder_levels` WHERE `parent` = ?", [itemCode]);
	});

	ipcMain.handle("db:upsert-item-reorder-levels", async (_e, rows: Record<string, unknown>[]) => {
		return upsertBatch("item_reorder_levels", rows, "name");
	});

	ipcMain.handle("db:get-pos-profiles", async (_e, company?: string) => {
		let sql = "SELECT * FROM `pos_profiles` WHERE `disabled` = 0";
		const params: unknown[] = [];
		if (company) {
			sql += " AND `company` = ?";
			params.push(company);
		}
		sql += " ORDER BY `name`";
		return query(sql, params);
	});

	ipcMain.handle("db:get-pos-profile", async (_e, name: string) => {
		return queryOne("SELECT * FROM `pos_profiles` WHERE `name` = ?", [name]);
	});

	ipcMain.handle("db:upsert-pos-profiles", async (_e, rows: Record<string, unknown>[]) => {
		return upsertBatch("pos_profiles", rows, "name");
	});

	ipcMain.handle("db:get-pos-payment-methods", async (_e, posProfile: string) => {
		return query("SELECT * FROM `pos_payment_methods` WHERE `parent` = ? ORDER BY `idx`", [posProfile]);
	});

	ipcMain.handle("db:upsert-pos-payment-methods", async (_e, rows: Record<string, unknown>[]) => {
		return upsertBatch("pos_payment_methods", rows, "name");
	});

	ipcMain.handle("db:get-pos-users", async () => {
		return query("SELECT * FROM `pos_users` ORDER BY `full_name`");
	});

	ipcMain.handle("db:get-pos-user", async (_e, username: string) => {
		return queryOne("SELECT * FROM `pos_users` WHERE `username` = ? OR `name` = ?", [username, username]);
	});

	ipcMain.handle("db:upsert-pos-users", async (_e, rows: Record<string, unknown>[]) => {
		return upsertBatch("pos_users", rows, "name");
	});

	ipcMain.handle(
		"db:create-local-user",
		async (
			_e,
			user: {
				username: string;
				password: string;
				fullName: string;
				role?: string;
			},
		) => {
			const { hashPassword } = await import("./passwordHash");
			const { hash, salt } = await hashPassword(user.password);
			await execute(
				`INSERT INTO \`pos_users\` (\`name\`, \`username\`, \`full_name\`, \`password_hash\`, \`password_salt\`, \`role\`, \`enabled\`)
       VALUES (?, ?, ?, ?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE \`password_hash\` = VALUES(\`password_hash\`), \`password_salt\` = VALUES(\`password_salt\`), \`full_name\` = VALUES(\`full_name\`)`,
				[
					user.username,
					user.username,
					user.fullName || user.username,
					hash,
					salt,
					user.role || "Manager",
				],
			);
			return true;
		},
	);

	ipcMain.handle("db:verify-password", async (_e, username: string, password: string) => {
		const row = await queryOne<{ name: string; password_hash: string; password_salt: string | null }>(
			"SELECT `name`, `password_hash`, `password_salt` FROM `pos_users` WHERE `username` = ? OR `name` = ?",
			[username, username],
		);
		if (!row || !row.password_hash) return false;

		const { verifyPassword, hashPassword } = await import("./passwordHash");
		const { valid, needsUpgrade } = await verifyPassword(password, row.password_hash, row.password_salt);
		if (!valid) return false;

		if (needsUpgrade) {
			try {
				const { hash, salt } = await hashPassword(password);
				await execute(
					"UPDATE `pos_users` SET `password_hash` = ?, `password_salt` = ? WHERE `name` = ?",
					[hash, salt, row.name],
				);
			} catch (err) {
				log.warn("Password hash upgrade failed", err);
			}
		}
		return true;
	});

	ipcMain.handle("db:get-sales-tax-templates", async (_e, company?: string) => {
		let sql = "SELECT * FROM `sales_taxes_templates` WHERE `disabled` = 0";
		const params: unknown[] = [];
		if (company) {
			sql += " AND `company` = ?";
			params.push(company);
		}
		return query(sql, params);
	});

	ipcMain.handle("db:upsert-sales-tax-templates", async (_e, rows: Record<string, unknown>[]) => {
		return upsertBatch("sales_taxes_templates", rows, "name");
	});

	ipcMain.handle("db:get-sales-tax-charges", async (_e, templateName: string) => {
		return query("SELECT * FROM `sales_taxes_charges` WHERE `parent` = ? ORDER BY `idx`", [templateName]);
	});

	ipcMain.handle("db:upsert-sales-tax-charges", async (_e, rows: Record<string, unknown>[]) => {
		return upsertBatch("sales_taxes_charges", rows, "name");
	});

	ipcMain.handle("db:get-pricing-rules", async (_e, opts?: { company?: string; itemCode?: string }) => {
		let sql = "SELECT * FROM `pricing_rules` WHERE `disable` = 0";
		const params: unknown[] = [];
		if (opts?.company) {
			sql += " AND (`company` = ? OR `company` IS NULL OR `company` = '')";
			params.push(opts.company);
		}
		sql += " ORDER BY `priority` DESC, `name`";
		return query(sql, params);
	});

	ipcMain.handle("db:get-pricing-rule-items", async (_e, parent: string) => {
		return query("SELECT * FROM `pricing_rule_item_codes` WHERE `parent` = ?", [parent]);
	});

	ipcMain.handle("db:get-pricing-rule-groups", async (_e, parent: string) => {
		return query("SELECT * FROM `pricing_rule_item_groups` WHERE `parent` = ?", [parent]);
	});

	ipcMain.handle("db:get-pricing-rule-brands", async (_e, parent: string) => {
		return query("SELECT * FROM `pricing_rule_brands` WHERE `parent` = ?", [parent]);
	});

	ipcMain.handle("db:upsert-pricing-rules", async (_e, rows: Record<string, unknown>[]) => {
		return upsertBatch("pricing_rules", rows, "name");
	});

	ipcMain.handle("db:upsert-pricing-rule-item-codes", async (_e, rows: Record<string, unknown>[]) => {
		return upsertBatch("pricing_rule_item_codes", rows, "name");
	});

	ipcMain.handle("db:upsert-pricing-rule-item-groups", async (_e, rows: Record<string, unknown>[]) => {
		return upsertBatch("pricing_rule_item_groups", rows, "name");
	});

	ipcMain.handle("db:upsert-pricing-rule-brands", async (_e, rows: Record<string, unknown>[]) => {
		return upsertBatch("pricing_rule_brands", rows, "name");
	});

	ipcMain.handle("db:get-bin", async (_e, itemCode: string, warehouse: string) => {
		return queryOne("SELECT * FROM `bins` WHERE `item_code` = ? AND `warehouse` = ?", [
			itemCode,
			warehouse,
		]);
	});

	ipcMain.handle("db:get-bins", async (_e, warehouse?: string) => {
		if (warehouse) {
			return query("SELECT * FROM `bins` WHERE `warehouse` = ?", [warehouse]);
		}
		return query("SELECT * FROM `bins`");
	});

	ipcMain.handle("db:upsert-bins", async (_e, rows: Record<string, unknown>[]) => {
		return upsertBatch("bins", rows, "name");
	});

	ipcMain.handle("db:create-pos-opening-shift", async (_e, shift: Record<string, unknown>) => {
		// Check if there's already an open shift for this user
		const existingShift = await queryOne<Record<string, unknown>>(
			"SELECT * FROM `pos_opening_shifts` WHERE `user` = ? AND `status` = 'Open' ORDER BY `id` DESC LIMIT 1",
			[shift.user],
		);

		if (existingShift) {
			// Return the existing shift instead of creating a new one
			log.info(`Reusing existing open shift ${existingShift.id} for user ${shift.user}`);
			return { id: existingShift.id, existing: true };
		}

		const result = await execute(
			`INSERT INTO \`pos_opening_shifts\`
       (\`pos_profile\`, \`user\`, \`company\`, \`posting_date\`, \`period_start_date\`, \`status\`)
       VALUES (?, ?, ?, ?, NOW(), 'Open')`,
			[
				shift.pos_profile,
				shift.user,
				shift.company,
				shift.opening_date || new Date().toISOString().slice(0, 10),
			],
		);
		const shiftId = result.insertId;
		const payments = shift.opening_amounts as
			| Array<{ mode_of_payment: string; opening_amount: number }>
			| undefined;
		if (payments?.length) {
			for (const p of payments) {
				await execute(
					`INSERT INTO \`pos_opening_entry_details\`
           (\`parent_id\`, \`mode_of_payment\`, \`opening_amount\`)
           VALUES (?, ?, ?)`,
					[shiftId, p.mode_of_payment, p.opening_amount || 0],
				);
			}
		}
		return { id: shiftId };
	});

	ipcMain.handle("db:get-open-shift", async (_e, user: string) => {
		const shift = await queryOne(
			"SELECT * FROM `pos_opening_shifts` WHERE `user` = ? AND `status` = 'Open' ORDER BY `id` DESC LIMIT 1",
			[user],
		);
		if (!shift) return null;
		const details = await query("SELECT * FROM `pos_opening_entry_details` WHERE `parent_id` = ?", [
			(shift as Record<string, unknown>).id,
		]);
		return { ...(shift as Record<string, unknown>), opening_amounts: details };
	});

	ipcMain.handle("db:check-open-shift", async (_e, user: string) => {
		const shift = await queryOne<Record<string, unknown>>(
			"SELECT * FROM `pos_opening_shifts` WHERE `user` = ? AND `status` = 'Open' ORDER BY `id` DESC LIMIT 1",
			[user],
		);

		if (!shift) return null;

		const posProfileName = shift.pos_profile as string;

		const profile = await queryOne<Record<string, unknown>>(
			"SELECT * FROM `pos_profiles` WHERE `name` = ?",
			[posProfileName],
		);

		// If the POS Profile hasn't synced yet, build a minimal stand-in so the POS
		// can open without showing the opening dialog on every startup.
		const profileData = profile || { name: posProfileName, company: shift.company, disabled: 0 };

		const payments = await query<Record<string, unknown>>(
			"SELECT `mode_of_payment`, `default` FROM `pos_payment_methods` WHERE `parent` = ?",
			[posProfileName],
		);
		const profileWithPayments = { ...profileData, payments };

		const companyName = (profileData.company || shift.company) as string;
		const companyRow = companyName
			? await queryOne<Record<string, unknown>>("SELECT * FROM `companies` WHERE `name` = ?", [
					companyName,
				])
			: null;

		const balanceDetails = await query<Record<string, unknown>>(
			"SELECT `mode_of_payment`, `opening_amount` FROM `pos_opening_entry_details` WHERE `parent_id` = ?",
			[shift.id as number],
		);

		const posOpeningShift = {
			name: String(shift.id),
			pos_profile: posProfileName,
			company: companyName,
			user: shift.user,
			period_start_date: shift.period_start_date || shift.posting_date,
			posting_date: shift.posting_date,
			balance_details: balanceDetails,
		};

		return {
			pos_opening_shift: posOpeningShift,
			pos_profile: profileWithPayments,
			company: companyRow || {
				name: companyName,
				company_name: companyName,
				default_currency: (profileData.currency as string) || "",
			},
			stock_settings: {},
			taxes: [],
			tax_inclusive: false,
			disable_rounded_total: false,
			print_settings: null,
		};
	});

	ipcMain.handle("db:get-opening-data", async () => {
		const profiles = await query<Record<string, unknown>>(
			"SELECT * FROM `pos_profiles` WHERE `disabled` = 0 ORDER BY `name`",
		);
		const companies = await query<Record<string, unknown>>("SELECT * FROM `companies` ORDER BY `name`");

		const profilesWithPayments = await Promise.all(
			profiles.map(async (p) => {
				const payments = await query<Record<string, unknown>>(
					"SELECT `mode_of_payment`, `default` FROM `pos_payment_methods` WHERE `parent` = ?",
					[p.name as string],
				);
				return { ...p, payments };
			}),
		);

		return {
			pos_profiles: profilesWithPayments,
			companies,
			payment_methods: [],
		};
	});

	ipcMain.handle("db:close-pos-shift", async (_e, shiftId: string | number) => {
		await execute("UPDATE `pos_opening_shifts` SET `status` = 'Closed' WHERE `id` = ?", [shiftId]);
		return true;
	});

	ipcMain.handle("db:get-pos-opening-shifts", async (_e, opts?: { user?: string; status?: string }) => {
		let sql = "SELECT * FROM `pos_opening_shifts`";
		const conditions: string[] = [];
		const params: unknown[] = [];
		if (opts?.user) {
			conditions.push("`user` = ?");
			params.push(opts.user);
		}
		if (opts?.status) {
			conditions.push("`status` = ?");
			params.push(opts.status);
		}
		if (conditions.length) sql += " WHERE " + conditions.join(" AND ");
		sql += " ORDER BY `id` DESC";
		return query(sql, params);
	});

	ipcMain.handle("db:create-pos-closing-entry", async (_e, entry: Record<string, unknown>) => {
		const openingEntryId = entry.pos_opening_entry_id
			? Number(entry.pos_opening_entry_id)
			: entry.pos_opening_shift_local_id
				? Number(entry.pos_opening_shift_local_id)
				: null;
		const result = await execute(
			`INSERT INTO \`pos_closing_entries\`
       (\`pos_profile\`, \`user\`, \`company\`, \`pos_opening_entry_id\`,
        \`posting_date\`, \`period_end_date\`, \`sync_status\`)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
			[
				entry.pos_profile,
				entry.user,
				entry.company,
				openingEntryId,
				entry.posting_date || entry.closing_date || new Date().toISOString().slice(0, 10),
				entry.period_end_date || entry.posting_date || new Date().toISOString().slice(0, 10),
			],
		);
		const payments = entry.payment_details as
			| Array<{
					mode_of_payment: string;
					opening_amount: number;
					expected_amount: number;
					closing_amount: number;
					difference: number;
			  }>
			| undefined;
		if (payments?.length) {
			for (const p of payments) {
				await execute(
					`INSERT INTO \`pos_closing_entry_details\`
           (\`parent_id\`, \`mode_of_payment\`, \`opening_amount\`, \`expected_amount\`, \`closing_amount\`, \`difference\`)
           VALUES (?, ?, ?, ?, ?, ?)`,
					[
						result.insertId,
						p.mode_of_payment,
						p.opening_amount || 0,
						p.expected_amount || 0,
						p.closing_amount || 0,
						p.difference || 0,
					],
				);
			}
		}
		return { id: result.insertId };
	});

	ipcMain.handle("db:get-pos-closing-entries", async (_e, opts?: { user?: string; status?: string }) => {
		let sql = "SELECT * FROM `pos_closing_entries`";
		const conditions: string[] = [];
		const params: unknown[] = [];
		if (opts?.user) {
			conditions.push("`user` = ?");
			params.push(opts.user);
		}
		if (opts?.status) {
			conditions.push("`sync_status` = ?");
			params.push(opts.status);
		}
		if (conditions.length) sql += " WHERE " + conditions.join(" AND ");
		sql += " ORDER BY `id` DESC";
		return query(sql, params);
	});

	ipcMain.handle("db:get-pos-closing-entry-details", async (_e, parentId: number) => {
		return query("SELECT * FROM `pos_closing_entry_details` WHERE `parent_id` = ?", [parentId]);
	});

	ipcMain.handle("db:save-sales-invoice", async (_e, invoice: Record<string, unknown>) => {
		const localId = `sinv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
		const openingEntryId = invoice.pos_opening_entry_id
			? Number(invoice.pos_opening_entry_id)
			: invoice.pos_opening_shift_local_id
				? Number(invoice.pos_opening_shift_local_id)
				: null;
		const result = await execute(
			`INSERT INTO \`sales_invoices\`
       (\`local_id\`, \`name\`, \`customer\`, \`customer_name\`, \`pos_profile\`,
        \`posting_date\`, \`grand_total\`, \`net_total\`,
        \`total_taxes_and_charges\`, \`discount_amount\`,
        \`is_return\`, \`return_against\`, \`status\`, \`pos_opening_entry_id\`)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				localId,
				invoice.name || localId,
				invoice.customer,
				invoice.customer_name,
				invoice.pos_profile,
				invoice.posting_date || new Date().toISOString().slice(0, 10),
				invoice.grand_total || 0,
				invoice.net_total || 0,
				invoice.total_taxes_and_charges || 0,
				invoice.discount_amount || 0,
				invoice.is_return ? 1 : 0,
				invoice.return_against || null,
				invoice.status || "Draft",
				openingEntryId,
			],
		);
		const invoiceId = result.insertId;
		const items = invoice.items as Array<Record<string, unknown>> | undefined;
		if (items?.length) {
			for (const item of items) {
				await execute(
					`INSERT INTO \`sales_invoice_items\`
           (\`parent_id\`, \`item_code\`, \`item_name\`, \`qty\`, \`rate\`,
            \`amount\`, \`uom\`, \`discount_percentage\`, \`discount_amount\`)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					[
						invoiceId,
						item.item_code,
						item.item_name,
						item.qty || 0,
						item.rate || 0,
						item.amount || 0,
						item.uom || null,
						item.discount_percentage || 0,
						item.discount_amount || 0,
					],
				);
			}
		}
		const payments = invoice.payments as Array<Record<string, unknown>> | undefined;
		if (payments?.length) {
			for (const p of payments) {
				await execute(
					`INSERT INTO \`sales_invoice_payments\`
           (\`parent_id\`, \`mode_of_payment\`, \`amount\`, \`account\`,
            \`pos_tender_currency\`, \`pos_tender_amount\`, \`pos_exchange_rate\`)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
					[
						invoiceId,
						p.mode_of_payment,
						p.amount || 0,
						p.account || null,
						p.pos_tender_currency || null,
						p.pos_tender_amount ?? null,
						p.pos_exchange_rate ?? null,
					],
				);
			}
		}

		const changeLegs = invoice.pos_change_legs as Array<Record<string, unknown>> | undefined;
		if (changeLegs?.length) {
			for (const leg of changeLegs) {
				await execute(
					`INSERT INTO \`sales_invoice_change_legs\`
           (\`parent_id\`, \`mode_of_payment\`, \`currency\`, \`amount\`, \`base_amount\`, \`exchange_rate\`)
           VALUES (?, ?, ?, ?, ?, ?)`,
					[
						invoiceId,
						leg.mode_of_payment,
						leg.currency || null,
						leg.amount || 0,
						leg.base_amount || 0,
						leg.exchange_rate ?? null,
					],
				);
			}
		}
		return { id: invoiceId, local_id: localId };
	});

	ipcMain.handle(
		"db:get-sales-invoices",
		async (
			_e,
			opts?: {
				customer?: string;
				posProfile?: string;
				shiftLocalId?: string;
				fromDate?: string;
				toDate?: string;
				limit?: number;
			},
		) => {
			let sql = "SELECT * FROM `sales_invoices`";
			const conditions: string[] = [];
			const params: unknown[] = [];
			if (opts?.customer) {
				conditions.push("`customer` = ?");
				params.push(opts.customer);
			}
			if (opts?.posProfile) {
				conditions.push("`pos_profile` = ?");
				params.push(opts.posProfile);
			}
			if (opts?.shiftLocalId) {
				conditions.push("`pos_opening_entry_id` = ?");
				params.push(Number(opts.shiftLocalId));
			}
			if (opts?.fromDate) {
				conditions.push("`posting_date` >= ?");
				params.push(opts.fromDate);
			}
			if (opts?.toDate) {
				conditions.push("`posting_date` <= ?");
				params.push(opts.toDate);
			}
			if (conditions.length) sql += " WHERE " + conditions.join(" AND ");
			sql += " ORDER BY `id` DESC";
			if (opts?.limit) {
				sql += " LIMIT ?";
				params.push(opts.limit);
			}
			return query(sql, params);
		},
	);

	ipcMain.handle("db:get-sales-invoice", async (_e, localId: string) => {
		const invoice = await queryOne("SELECT * FROM `sales_invoices` WHERE `local_id` = ?", [localId]);
		if (!invoice) return null;
		const inv = invoice as Record<string, unknown>;
		const items = await query("SELECT * FROM `sales_invoice_items` WHERE `parent_id` = ?", [inv.id]);
		const payments = await query("SELECT * FROM `sales_invoice_payments` WHERE `parent_id` = ?", [
			inv.id,
		]);
		const posChangeLegs = await query("SELECT * FROM `sales_invoice_change_legs` WHERE `parent_id` = ?", [
			inv.id,
		]);
		return { ...inv, items, payments, pos_change_legs: posChangeLegs };
	});

	ipcMain.handle("db:get-shift-sales-summary", async (_e, shiftId: string | number) => {
		const shiftIdNum = Number(shiftId);
		const summary = await queryOne<{ total: number; count: number }>(
			`SELECT COALESCE(SUM(\`grand_total\`), 0) as total,
              COUNT(*) as count
       FROM \`sales_invoices\`
       WHERE \`pos_opening_entry_id\` = ? AND \`status\` != 'Cancelled'`,
			[shiftIdNum],
		);
		const collected = await query<{ mode_of_payment: string; currency: string | null; total: number }>(
			`SELECT sip.\`mode_of_payment\`,
              sip.\`pos_tender_currency\` as currency,
              COALESCE(SUM(CASE WHEN sip.\`pos_tender_currency\` IS NOT NULL
                                THEN sip.\`pos_tender_amount\` ELSE sip.\`amount\` END), 0) as total
       FROM \`sales_invoice_payments\` sip
       JOIN \`sales_invoices\` si ON si.\`id\` = sip.\`parent_id\`
       WHERE si.\`pos_opening_entry_id\` = ? AND si.\`status\` != 'Cancelled'
       GROUP BY sip.\`mode_of_payment\`, sip.\`pos_tender_currency\``,
			[shiftIdNum],
		);

		const returned = await query<{ mode_of_payment: string; currency: string | null; total: number }>(
			`SELECT scl.\`mode_of_payment\`, scl.\`currency\` as currency,
              COALESCE(SUM(scl.\`amount\`), 0) as total
       FROM \`sales_invoice_change_legs\` scl
       JOIN \`sales_invoices\` si ON si.\`id\` = scl.\`parent_id\`
       WHERE si.\`pos_opening_entry_id\` = ? AND si.\`status\` != 'Cancelled'
       GROUP BY scl.\`mode_of_payment\`, scl.\`currency\``,
			[shiftIdNum],
		);

		const byMode = new Map<string, { mode_of_payment: string; currency: string | null; total: number }>();
		const accumulate = (
			row: { mode_of_payment: string; currency: string | null; total: number },
			sign: number,
		) => {
			if (!row.mode_of_payment) return;
			const existing = byMode.get(row.mode_of_payment);
			if (existing) {
				existing.total += sign * Number(row.total || 0);
				existing.currency = existing.currency || row.currency;
				return;
			}
			byMode.set(row.mode_of_payment, {
				mode_of_payment: row.mode_of_payment,
				currency: row.currency,
				total: sign * Number(row.total || 0),
			});
		};

		for (const row of collected) accumulate(row, 1);
		for (const row of returned) accumulate(row, -1);

		return { ...(summary ?? { total: 0, count: 0 }), payment_breakdown: [...byMode.values()] };
	});

	ipcMain.handle("db:create-expense", async (_e, expense: Record<string, unknown>) => {
		const openingEntryId = expense.pos_opening_entry_id
			? Number(expense.pos_opening_entry_id)
			: expense.pos_opening_shift_local_id
				? Number(expense.pos_opening_shift_local_id)
				: null;
		const result = await execute(
			`INSERT INTO \`expenses\`
       (\`to_account\`, \`amount\`, \`posting_date\`, \`remarks\`,
        \`owner\`, \`pos_opening_entry_id\`, \`sync_status\`)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
			[
				expense.expense_type || expense.to_account || "General",
				expense.amount || 0,
				expense.posting_date || new Date().toISOString().slice(0, 10),
				expense.description || expense.remarks || null,
				expense.user || expense.owner || null,
				openingEntryId,
			],
		);
		return { id: result.insertId };
	});

	ipcMain.handle(
		"db:get-expenses",
		async (
			_e,
			opts?: {
				user?: string;
				fromDate?: string;
				toDate?: string;
				shiftLocalId?: string;
				syncStatus?: string;
			},
		) => {
			let sql = "SELECT * FROM `expenses`";
			const conditions: string[] = [];
			const params: unknown[] = [];
			if (opts?.user) {
				conditions.push("`owner` = ?");
				params.push(opts.user);
			}
			if (opts?.fromDate) {
				conditions.push("`posting_date` >= ?");
				params.push(opts.fromDate);
			}
			if (opts?.toDate) {
				conditions.push("`posting_date` <= ?");
				params.push(opts.toDate);
			}
			if (opts?.shiftLocalId) {
				conditions.push("`pos_opening_entry_id` = ?");
				params.push(Number(opts.shiftLocalId));
			}
			if (opts?.syncStatus) {
				conditions.push("`sync_status` = ?");
				params.push(opts.syncStatus);
			}
			if (conditions.length) sql += " WHERE " + conditions.join(" AND ");
			sql += " ORDER BY `id` DESC";
			return query(sql, params);
		},
	);

	ipcMain.handle("db:delete-expense", async (_e, id: number) => {
		await execute("DELETE FROM `expenses` WHERE `id` = ? AND `sync_status` = 'pending'", [id]);
		return true;
	});

	ipcMain.handle("db:create-bank-drop", async (_e, drop: Record<string, unknown>) => {
		const openingEntryId = drop.pos_opening_entry_id
			? Number(drop.pos_opening_entry_id)
			: drop.pos_opening_shift_local_id
				? Number(drop.pos_opening_shift_local_id)
				: null;
		const result = await execute(
			`INSERT INTO \`bank_drops\`
       (\`to_account\`, \`amount\`, \`posting_date\`, \`remarks\`,
        \`owner\`, \`pos_opening_entry_id\`, \`sync_status\`)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
			[
				drop.mode_of_payment || drop.to_account || "Cash",
				drop.amount || 0,
				drop.posting_date || new Date().toISOString().slice(0, 10),
				drop.description || drop.remarks || null,
				drop.user || drop.owner || null,
				openingEntryId,
			],
		);
		return { id: result.insertId };
	});

	ipcMain.handle(
		"db:get-bank-drops",
		async (
			_e,
			opts?: {
				user?: string;
				fromDate?: string;
				toDate?: string;
				shiftLocalId?: string;
				syncStatus?: string;
			},
		) => {
			let sql = "SELECT * FROM `bank_drops`";
			const conditions: string[] = [];
			const params: unknown[] = [];
			if (opts?.user) {
				conditions.push("`owner` = ?");
				params.push(opts.user);
			}
			if (opts?.fromDate) {
				conditions.push("`posting_date` >= ?");
				params.push(opts.fromDate);
			}
			if (opts?.toDate) {
				conditions.push("`posting_date` <= ?");
				params.push(opts.toDate);
			}
			if (opts?.shiftLocalId) {
				conditions.push("`pos_opening_entry_id` = ?");
				params.push(Number(opts.shiftLocalId));
			}
			if (opts?.syncStatus) {
				conditions.push("`sync_status` = ?");
				params.push(opts.syncStatus);
			}
			if (conditions.length) sql += " WHERE " + conditions.join(" AND ");
			sql += " ORDER BY `id` DESC";
			return query(sql, params);
		},
	);

	ipcMain.handle("db:delete-bank-drop", async (_e, id: number) => {
		await execute("DELETE FROM `bank_drops` WHERE `id` = ? AND `sync_status` = 'pending'", [id]);
		return true;
	});

	ipcMain.handle("db:create-stock-adjustment", async (_e, adj: Record<string, unknown>) => {
		const result = await execute(
			`INSERT INTO \`stock_adjustments\`
       (\`item_code\`, \`warehouse\`, \`qty\`, \`reason\`,
        \`owner\`, \`sync_status\`)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
			[
				adj.item_code,
				adj.warehouse,
				adj.qty || 0,
				adj.reason || adj.adjustment_type || null,
				adj.user || adj.owner || null,
			],
		);
		return { id: result.insertId };
	});

	ipcMain.handle(
		"db:get-stock-adjustments",
		async (
			_e,
			opts?: {
				warehouse?: string;
				syncStatus?: string;
				fromDate?: string;
				toDate?: string;
			},
		) => {
			let sql = "SELECT * FROM `stock_adjustments`";
			const conditions: string[] = [];
			const params: unknown[] = [];
			if (opts?.warehouse) {
				conditions.push("`warehouse` = ?");
				params.push(opts.warehouse);
			}
			if (opts?.syncStatus) {
				conditions.push("`sync_status` = ?");
				params.push(opts.syncStatus);
			}
			if (opts?.fromDate) {
				conditions.push("`posting_date` >= ?");
				params.push(opts.fromDate);
			}
			if (opts?.toDate) {
				conditions.push("`posting_date` <= ?");
				params.push(opts.toDate);
			}
			if (conditions.length) sql += " WHERE " + conditions.join(" AND ");
			sql += " ORDER BY `id` DESC";
			return query(sql, params);
		},
	);

	ipcMain.handle("db:save-quotation", async (_e, quotation: Record<string, unknown>) => {
		const localId = `qt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
		await execute(
			`INSERT INTO \`quotations\`
       (\`local_id\`, \`customer\`, \`customer_name\`, \`posting_date\`,
        \`grand_total\`, \`net_total\`, \`status\`, \`data\`, \`sync_status\`)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
			[
				localId,
				quotation.customer,
				quotation.customer_name,
				quotation.posting_date || new Date().toISOString().slice(0, 10),
				quotation.grand_total || 0,
				quotation.net_total || 0,
				quotation.status || "Draft",
				JSON.stringify(quotation),
			],
		);
		return { local_id: localId };
	});

	ipcMain.handle(
		"db:get-quotations",
		async (
			_e,
			opts?: {
				customer?: string;
				fromDate?: string;
				toDate?: string;
				status?: string;
				limit?: number;
			},
		) => {
			let sql = "SELECT * FROM `quotations`";
			const conditions: string[] = [];
			const params: unknown[] = [];
			if (opts?.customer) {
				conditions.push("`customer` = ?");
				params.push(opts.customer);
			}
			if (opts?.fromDate) {
				conditions.push("`posting_date` >= ?");
				params.push(opts.fromDate);
			}
			if (opts?.toDate) {
				conditions.push("`posting_date` <= ?");
				params.push(opts.toDate);
			}
			if (opts?.status) {
				conditions.push("`status` = ?");
				params.push(opts.status);
			}
			if (conditions.length) sql += " WHERE " + conditions.join(" AND ");
			sql += " ORDER BY `id` DESC";
			if (opts?.limit) {
				sql += " LIMIT ?";
				params.push(opts.limit);
			}
			return query(sql, params);
		},
	);

	ipcMain.handle(
		"db:upsert-table",
		async (_e, table: string, rows: Record<string, unknown>[], keyField: string) => {
			const allowedTables = new Set([
				"companies",
				"cost_centers",
				"countries",
				"currencies",
				"warehouses",
				"accounts",
				"price_lists",
				"uom",
				"uom_conversion_details",
				"brands",
				"industries",
				"items",
				"item_groups",
				"item_barcodes",
				"item_prices",
				"item_reorder_levels",
				"item_tax_templates",
				"item_tax_template_details",
				"item_taxes",
				"item_vendors",
				"modes_of_payment",
				"mode_of_payment_accounts",
				"pos_profiles",
				"pos_payment_methods",
				"customers",
				"suppliers",
				"bins",
				"sales_taxes_templates",
				"sales_taxes_charges",
				"pricing_rules",
				"pricing_rule_item_codes",
				"pricing_rule_item_groups",
				"pricing_rule_brands",
				"pos_users",
			]);
			if (!allowedTables.has(table)) {
				throw new Error(`Table "${table}" is not allowed for generic upsert`);
			}
			return upsertBatch(table, rows, keyField);
		},
	);

	ipcMain.handle("db:clear-table", async (_e, table: string) => {
		const allowedTables = new Set([
			"companies",
			"cost_centers",
			"countries",
			"currencies",
			"warehouses",
			"accounts",
			"price_lists",
			"uom",
			"uom_conversion_details",
			"brands",
			"industries",
			"items",
			"item_groups",
			"item_barcodes",
			"item_prices",
			"item_reorder_levels",
			"item_tax_templates",
			"item_tax_template_details",
			"item_taxes",
			"item_vendors",
			"modes_of_payment",
			"mode_of_payment_accounts",
			"pos_profiles",
			"pos_payment_methods",
			"customers",
			"suppliers",
			"bins",
			"sales_taxes_templates",
			"sales_taxes_charges",
			"pricing_rules",
			"pricing_rule_item_codes",
			"pricing_rule_item_groups",
			"pricing_rule_brands",
			"pos_users",
			"stock_cache",
			"pos_profile_cache",
			"item_tax_cache",
		]);
		if (!allowedTables.has(table)) {
			throw new Error(`Table "${table}" is not allowed for clear`);
		}
		await execute(`DELETE FROM \`${table}\``);
		return true;
	});

	ipcMain.handle("db:clear-cached-data", async () => {
		const tables = [
			"items",
			"item_groups",
			"item_barcodes",
			"item_prices",
			"item_tax_templates",
			"item_tax_template_details",
			"item_taxes",
			"item_vendors",
			"item_reorder_levels",
			"uom_conversion_details",
			"customers",
			"suppliers",
			"stock_cache",
			"bins",
			"companies",
			"cost_centers",
			"countries",
			"currencies",
			"warehouses",
			"accounts",
			"price_lists",
			"uom",
			"brands",
			"industries",
			"modes_of_payment",
			"mode_of_payment_accounts",
			"pos_profiles",
			"pos_payment_methods",
			"pos_users",
			"sales_taxes_templates",
			"sales_taxes_charges",
			"pricing_rules",
			"pricing_rule_item_codes",
			"pricing_rule_item_groups",
			"pricing_rule_brands",
			"sync_meta",
			"pos_profile_cache",
			"item_tax_cache",
			"sync_id_map",
		];
		for (const t of tables) {
			await execute(`DELETE FROM \`${t}\``);
		}
		return true;
	});

	ipcMain.handle("db:clear-all-data", async () => {
		const tables = [
			"items",
			"item_groups",
			"item_barcodes",
			"item_prices",
			"item_tax_templates",
			"item_tax_template_details",
			"item_taxes",
			"item_vendors",
			"item_reorder_levels",
			"uom_conversion_details",
			"customers",
			"suppliers",
			"stock_cache",
			"bins",
			"companies",
			"cost_centers",
			"countries",
			"currencies",
			"warehouses",
			"accounts",
			"price_lists",
			"uom",
			"brands",
			"industries",
			"modes_of_payment",
			"mode_of_payment_accounts",
			"pos_profiles",
			"pos_payment_methods",
			"pos_users",
			"sales_taxes_templates",
			"sales_taxes_charges",
			"pricing_rules",
			"pricing_rule_item_codes",
			"pricing_rule_item_groups",
			"pricing_rule_brands",
			"sync_meta",
			"pos_profile_cache",
			"item_tax_cache",
			"sync_id_map",
		];
		for (const t of tables) {
			await execute(`DELETE FROM \`${t}\``);
		}
		return true;
	});

	ipcMain.handle("db:clear-pending-data", async () => {
		await execute("DELETE FROM `pending_invoices`");
		await execute("DELETE FROM `pending_purchases`");
		return true;
	});

	log.info("All handlers registered");
}
