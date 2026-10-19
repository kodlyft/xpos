/**
 * X POS Local MariaDB Database Service
 *
 * Runs in the Electron main process. Manages the connection pool
 * to a local MariaDB instance and provides typed query helpers.
 *
 * Replaces IndexedDB (Dexie) for the Electron desktop app while
 * the PWA/browser version continues to use IndexedDB.
 */

import mysql, {
	type Pool,
	type PoolConnection,
	type RowDataPacket,
	type ResultSetHeader,
} from "mysql2/promise";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { app } from "electron";
import { encryptSecret, decryptSecret, isEncrypted } from "./secureStore";
import { createLogger } from "../logger";

const log = createLogger("DB");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface DbConfig {
	host: string;
	port: number;
	user: string;
	password: string;
	database: string;
}

const DEFAULT_CONFIG: DbConfig = {
	host: "127.0.0.1",
	port: 3306,
	user: "xpos",
	password: "xpos",
	database: "xpos_local",
};

let pool: Pool | null = null;
let currentConfig: DbConfig = { ...DEFAULT_CONFIG };

function configFilePath(): string {
	return path.join(app.getPath("userData"), "db-config.json");
}

export function saveDbConfig(cfg: DbConfig): void {
	const pathsToWrite: string[] = [];
	try {
		pathsToWrite.push(path.join(app.getPath("userData"), "db-config.json"));
	} catch {
		/* ignore */
	}
	if (process.env.APPDATA) {
		pathsToWrite.push(path.join(process.env.APPDATA, "X POS", "db-config.json"));
		pathsToWrite.push(path.join(process.env.APPDATA, "xpos-frontend", "db-config.json"));
	}
	let toWrite: DbConfig = cfg;
	try {
		toWrite = { ...cfg, password: cfg.password ? encryptSecret(cfg.password) : cfg.password };
	} catch (err) {
		log.warn("Could not encrypt db-config password, writing as-is", err);
	}
	const data = JSON.stringify(toWrite, null, 2);
	for (const p of pathsToWrite) {
		try {
			fs.mkdirSync(path.dirname(p), { recursive: true });
			fs.writeFileSync(p, data, "utf-8");
		} catch (err) {
			log.warn(`Failed to save db-config.json to ${p}`, err);
		}
	}
}

export function loadDbConfig(): DbConfig {
	const candidates: string[] = [];
	try {
		candidates.push(path.join(app.getPath("userData"), "db-config.json"));
	} catch {}
	if (process.env.APPDATA) {
		candidates.push(path.join(process.env.APPDATA, "X POS", "db-config.json"));
		candidates.push(path.join(process.env.APPDATA, "xpos-frontend", "db-config.json"));
	}

	for (const candidate of candidates) {
		try {
			const raw = fs.readFileSync(candidate, "utf-8");
			const parsed = JSON.parse(raw) as Partial<DbConfig>;
			log.info(`Loaded DB config from: ${candidate}`);
			if (parsed.password) {
				try {
					parsed.password = decryptSecret(parsed.password) ?? parsed.password;
				} catch {
					/* use stored value as-is */
				}
			}
			return { ...DEFAULT_CONFIG, ...parsed };
		} catch {
			// try next candidate
		}
	}

	log.warn(`No db-config.json found (tried: ${candidates.join(", ")}), using defaults`);
	return { ...DEFAULT_CONFIG };
}

export function getPool(): Pool {
	if (!pool) {
		throw new Error("Database not initialized. Call initDatabase() first.");
	}
	return pool;
}

export async function initDatabase(config?: Partial<DbConfig>): Promise<void> {
	const persisted = loadDbConfig();
	currentConfig = { ...persisted, ...(config || {}) };

	log.info(
		`DB init - host: ${currentConfig.host}, port: ${currentConfig.port}, user: ${currentConfig.user}, db: ${currentConfig.database}`,
	);

	saveDbConfig(currentConfig);

	const rootPool = mysql.createPool({
		host: currentConfig.host,
		port: currentConfig.port,
		user: currentConfig.user,
		password: currentConfig.password,
		waitForConnections: true,
		connectionLimit: 2,
		connectTimeout: 5000,
	});

	try {
		await rootPool.execute(
			`CREATE DATABASE IF NOT EXISTS \`${currentConfig.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
		);
	} finally {
		await rootPool.end();
	}

	pool = mysql.createPool({
		host: currentConfig.host,
		port: currentConfig.port,
		user: currentConfig.user,
		password: currentConfig.password,
		database: currentConfig.database,
		waitForConnections: true,
		connectionLimit: 10,
		queueLimit: 0,
		charset: "utf8mb4",
		timezone: "+00:00",
		connectTimeout: 5000,
	});

	const conn = await pool.getConnection();
	conn.release();

	await runSchema();

	log.info(`Connected to MariaDB: ${currentConfig.host} ${currentConfig.database}`);
}

export async function closeDatabase(): Promise<void> {
	if (pool) {
		await pool.end();
		pool = null;
		log.info("Connection pool closed");
	}
}

export function getConfig(): DbConfig {
	return { ...currentConfig };
}

async function runSchema(): Promise<void> {
	const candidates = [
		path.join(process.resourcesPath || "", "schema.sql"),
		path.join(__dirname, "schema.sql"),
		path.join(process.cwd(), "electron", "database", "schema.sql"),
	];

	for (const candidate of candidates) {
		if (candidate && fs.existsSync(candidate)) {
			await executeSchemaFile(candidate);
			await runMigrations();
			return;
		}
	}

	log.warn("schema.sql not found, skipping migrations");
}

/**
 * Incremental schema migrations that can't be expressed as CREATE TABLE IF NOT EXISTS.
 * Safe to run on every startup (idempotent).
 */
async function runMigrations(): Promise<void> {
	const db = getPool();

	// Drop the legacy `barcode` column from `items` (barcodes live in `item_barcodes` now)
	try {
		const [cols] = await db.execute<RowDataPacket[]>(
			"SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'items' AND COLUMN_NAME = 'barcode'",
		);
		if ((cols as RowDataPacket[]).length > 0) {
			await db.execute("ALTER TABLE `items` DROP INDEX `idx_barcode`").catch(() => {
				/* index may not exist */
			});
			await db.execute("ALTER TABLE `items` DROP COLUMN `barcode`");
			log.info("Migration: dropped items.barcode column");
		}
	} catch (err) {
		log.warn("Migration check for items.barcode failed", err);
	}

	try {
		const [cols] = await db.execute<RowDataPacket[]>(
			"SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'items' AND COLUMN_NAME = 'local_item_name'",
		);
		if ((cols as RowDataPacket[]).length === 0) {
			await db.execute(
				"ALTER TABLE `items` ADD COLUMN `local_item_name` VARCHAR(255) DEFAULT NULL AFTER `item_name`",
			);
			log.info("Migration: added items.local_item_name column");
		}
	} catch (err) {
		log.warn("Migration for items.local_item_name failed", err);
	}

	const customerMigrations: [string, string][] = [
		["discount", "DECIMAL(10,4) NOT NULL DEFAULT 0"],
		["default_price_list", "VARCHAR(255) DEFAULT NULL"],
	];
	for (const [col, typedef] of customerMigrations) {
		try {
			const [existing] = await db.execute<RowDataPacket[]>(
				"SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'customers' AND COLUMN_NAME = ?",
				[col],
			);
			if ((existing as RowDataPacket[]).length === 0) {
				await db.execute(`ALTER TABLE \`customers\` ADD COLUMN \`${col}\` ${typedef}`);
				log.info(`Migration: added customers.${col}`);
			}
		} catch (err) {
			log.warn(`Migration for customers.${col} failed`, err);
		}
	}

	const posProfileMigrations: [string, string][] = [
		["allow_rate_change", "TINYINT(1) NOT NULL DEFAULT 0"],
		["allow_change_posting_date", "TINYINT(1) NOT NULL DEFAULT 0"],
		["hide_images", "TINYINT(1) NOT NULL DEFAULT 0"],
		["hide_unavailable_items", "TINYINT(1) NOT NULL DEFAULT 0"],
		["block_sale_beyond_available_qty", "TINYINT(1) NOT NULL DEFAULT 0"],
		["cash_mode_of_payment", "VARCHAR(255) DEFAULT NULL"],
		["apply_customer_discount", "TINYINT(1) NOT NULL DEFAULT 0"],
		["allow_print_draft_invoices", "TINYINT(1) NOT NULL DEFAULT 0"],
		["use_offline_mode", "TINYINT(1) NOT NULL DEFAULT 0"],
		["force_price_from_customer_price_list", "TINYINT(1) NOT NULL DEFAULT 0"],
		["allow_zero_rated_items", "TINYINT(1) NOT NULL DEFAULT 0"],
		["use_delivery_charges", "TINYINT(1) NOT NULL DEFAULT 0"],
		["auto_set_delivery_charges", "TINYINT(1) NOT NULL DEFAULT 0"],
		["max_discount_percentage_allowed", "DECIMAL(10,4) NOT NULL DEFAULT 0"],
		["hide_expected_amount", "TINYINT(1) NOT NULL DEFAULT 0"],
		["use_customer_credit", "TINYINT(1) NOT NULL DEFAULT 0"],
	];
	for (const [col, typedef] of posProfileMigrations) {
		try {
			const [existing] = await db.execute<RowDataPacket[]>(
				"SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pos_profiles' AND COLUMN_NAME = ?",
				[col],
			);
			if ((existing as RowDataPacket[]).length === 0) {
				await db.execute(`ALTER TABLE \`pos_profiles\` ADD COLUMN \`${col}\` ${typedef}`);
				log.info(`Migration: added pos_profiles.${col}`);
			}
		} catch (err) {
			log.warn(`Migration for pos_profiles.${col} failed`, err);
		}
	}

	const posUserMigrations: [string, string][] = [
		["close_bill", "TINYINT(1) DEFAULT 1"],
		["close_shift", "TINYINT(1) DEFAULT 0"],
		["allow_reprint_invoice", "TINYINT(1) DEFAULT 0"],
		["shift_report", "TINYINT(1) DEFAULT 0"],
		["view_expected_amount", "TINYINT(1) DEFAULT 0"],
		["allow_cancel_invoice", "TINYINT(1) DEFAULT 0"],
		["unsettled_invoices", "TINYINT(1) DEFAULT 0"],
		["apply_additional_discount", "TINYINT(1) DEFAULT 0"],
		["apply_standard_discount", "TINYINT(1) DEFAULT 0"],
		["show_edit_discount_field", "TINYINT(1) DEFAULT 0"],
		["edit_tax_template", "TINYINT(1) DEFAULT 0"],
		["allow_change_price", "TINYINT(1) DEFAULT 0"],
		["quotation", "TINYINT(1) DEFAULT 0"],
		["sale_return", "TINYINT(1) DEFAULT 0"],
		["local_purchase", "TINYINT(1) DEFAULT 0"],
		["purchase_order", "TINYINT(1) DEFAULT 0"],
		["purchase_invoice", "TINYINT(1) DEFAULT 0"],
		["stock_adjustment", "TINYINT(1) DEFAULT 0"],
		["stock_entry", "TINYINT(1) DEFAULT 0"],
		["near_expiry_items", "TINYINT(1) DEFAULT 0"],
		["expense", "TINYINT(1) DEFAULT 0"],
		["bank_drop", "TINYINT(1) DEFAULT 0"],
		["list_of_invoices", "TINYINT(1) DEFAULT 1"],
		["list_of_cancelled_invoices", "TINYINT(1) DEFAULT 0"],
		["list_of_errors", "TINYINT(1) DEFAULT 0"],
		["list_of_purchase_invoices", "TINYINT(1) DEFAULT 0"],
		["list_of_quotations", "TINYINT(1) DEFAULT 0"],
		["list_of_stock_entries", "TINYINT(1) DEFAULT 0"],
		["list_of_local_purchases", "TINYINT(1) DEFAULT 0"],
		["list_of_stock_adjustments", "TINYINT(1) DEFAULT 0"],
		["list_of_expense", "TINYINT(1) DEFAULT 0"],
		["list_of_bank_drops", "TINYINT(1) DEFAULT 0"],
		["password_salt", "VARCHAR(64) DEFAULT NULL"],
		["invoice_settlement_report", "TINYINT(1) DEFAULT 0"],
		["sales_report_by_time", "TINYINT(1) DEFAULT 0"],
		["sales_summary_by_hour", "TINYINT(1) DEFAULT 0"],
		["current_stock_by_brand", "TINYINT(1) DEFAULT 0"],
		["stock_register", "TINYINT(1) DEFAULT 0"],
		["current_stock_report", "TINYINT(1) DEFAULT 0"],
		["discount_limit", "DECIMAL(18,6) DEFAULT 100"],
	];

	const posUserColumnExists = async (col: string): Promise<boolean> => {
		const [existing] = await db.execute<RowDataPacket[]>(
			"SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pos_users' AND COLUMN_NAME = ?",
			[col],
		);
		return (existing as RowDataPacket[]).length > 0;
	};

	for (const [col, typedef] of posUserMigrations) {
		try {
			if (!(await posUserColumnExists(col))) {
				await db.execute(`ALTER TABLE \`pos_users\` ADD COLUMN \`${col}\` ${typedef}`);
				log.info(`Migration: added pos_users.${col}`);
			}
		} catch (err) {
			log.warn(`Migration for pos_users.${col} failed`, err);
		}
	}

	const posUserRenames: [string, string][] = [
		["allow_return", "sale_return"],
		["allow_expense", "expense"],
		["allow_bank_drop", "bank_drop"],
		["show_edit_item_tax_template", "edit_tax_template"],
	];
	for (const [oldCol, newCol] of posUserRenames) {
		try {
			if (await posUserColumnExists(oldCol)) {
				await db.execute(`UPDATE \`pos_users\` SET \`${newCol}\` = \`${oldCol}\``);
				await db.execute(`ALTER TABLE \`pos_users\` DROP COLUMN \`${oldCol}\``);
				log.info(`Migration: renamed pos_users.${oldCol} -> ${newCol}`);
			}
		} catch (err) {
			log.warn(`Migration for pos_users rename ${oldCol} -> ${newCol} failed`, err);
		}
	}

	const columnMigrations: [string, string, string][] = [
		["sales_invoice_payments", "pos_tender_currency", "VARCHAR(10) DEFAULT NULL"],
		["sales_invoice_payments", "pos_tender_amount", "DECIMAL(18,6) DEFAULT NULL"],
		["sales_invoice_payments", "pos_exchange_rate", "DECIMAL(21,9) DEFAULT NULL"],
		["modes_of_payment", "pos_tender_currency", "VARCHAR(10) DEFAULT NULL"],
		["currencies", "number_format", "VARCHAR(20) DEFAULT NULL"],
		["currencies", "smallest_currency_fraction_value", "DECIMAL(18,6) DEFAULT 0"],
		["currencies", "symbol_on_right", "TINYINT(1) DEFAULT 0"],
	];
	for (const [table, col, typedef] of columnMigrations) {
		try {
			const [existing] = await db.execute<RowDataPacket[]>(
				"SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?",
				[table, col],
			);
			if ((existing as RowDataPacket[]).length === 0) {
				await db.execute(`ALTER TABLE \`${table}\` ADD COLUMN \`${col}\` ${typedef}`);
				log.info(`Migration: added ${table}.${col}`);
			}
		} catch (err) {
			log.warn(`Migration for ${table}.${col} failed`, err);
		}
	}

	for (const tbl of ["pending_invoices", "pending_purchases"]) {
		try {
			const [cols] = await db.execute<RowDataPacket[]>(
				"SELECT COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'status'",
				[tbl],
			);
			const colType = (cols as RowDataPacket[])[0]?.COLUMN_TYPE as string | undefined;
			if (colType && !colType.includes("dead_letter")) {
				await db.execute(
					`ALTER TABLE \`${tbl}\` MODIFY COLUMN \`status\` ` +
						"ENUM('pending','syncing','synced','failed','dead_letter') DEFAULT 'pending'",
				);
				log.info(`Migration: added 'dead_letter' status to ${tbl}`);
			}
		} catch (err) {
			log.warn(`Migration for ${tbl} dead_letter status failed`, err);
		}
	}
}

async function executeSchemaFile(filePath: string): Promise<void> {
	const sql = fs.readFileSync(filePath, "utf-8");
	const statements = sql
		.split(";")
		.map((s) =>
			s
				.split("\n")
				.filter((line) => !line.trim().startsWith("--"))
				.join("\n")
				.trim(),
		)
		.filter((s) => s.length > 0);

	const db = getPool();
	for (const stmt of statements) {
		try {
			await db.execute(stmt);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (!msg.includes("already exists")) {
				log.error(`Schema error: ${msg}\nStatement: ${stmt.substring(0, 100)}`);
			}
		}
	}
	log.info("Schema applied");
}

export async function query<T = RowDataPacket>(sql: string, params: unknown[] = []): Promise<T[]> {
	const db = getPool();
	const [rows] = await db.execute<RowDataPacket[]>(sql, params as (string | number | null | Buffer)[]);
	return rows as T[];
}

export async function queryOne<T = RowDataPacket>(sql: string, params: unknown[] = []): Promise<T | null> {
	const rows = await query<T>(sql, params);
	return rows[0] || null;
}

export async function execute(
	sql: string,
	params: unknown[] = [],
): Promise<{ affectedRows: number; insertId: number }> {
	const db = getPool();
	const [result] = await db.execute<ResultSetHeader>(sql, params as (string | number | null | Buffer)[]);
	return { affectedRows: result.affectedRows, insertId: result.insertId };
}

export async function transaction<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
	const db = getPool();
	const conn = await db.getConnection();
	try {
		await conn.beginTransaction();
		const result = await fn(conn);
		await conn.commit();
		return result;
	} catch (err) {
		await conn.rollback();
		throw err;
	} finally {
		conn.release();
	}
}

export async function upsertBatch(
	table: string,
	rows: Record<string, unknown>[],
	primaryKey: string,
): Promise<number> {
	if (rows.length === 0) return 0;

	const columns = Object.keys(rows[0]);
	const placeholders = columns.map(() => "?").join(", ");
	const updateCols = columns
		.filter((c) => c !== primaryKey)
		.map((c) => `\`${c}\` = VALUES(\`${c}\`)`)
		.join(", ");

	const db = getPool();
	let affected = 0;

	const CHUNK = 100;
	for (let i = 0; i < rows.length; i += CHUNK) {
		const chunk = rows.slice(i, i + CHUNK);
		const valuesSql = chunk.map(() => `(${placeholders})`).join(", ");
		const flatParams = chunk.flatMap((row) => columns.map((c) => row[c] ?? null));

		const sql = `INSERT INTO \`${table}\` (${columns.map((c) => `\`${c}\``).join(", ")})
      VALUES ${valuesSql}
      ON DUPLICATE KEY UPDATE ${updateCols}`;

		const result = await db.execute<ResultSetHeader>(
			sql,
			flatParams as (string | number | null | Buffer)[],
		);
		affected += result[0].affectedRows;
	}

	return affected;
}

const SENSITIVE_META_KEYS = new Set(["api_key", "api_secret", "hub_api_secret"]);

async function writeMetaRow(key: string, value: string): Promise<void> {
	await execute(
		`INSERT INTO \`sync_meta\` (\`key\`, \`value\`, \`updated_at\`)
     VALUES (?, ?, NOW())
     ON DUPLICATE KEY UPDATE \`value\` = VALUES(\`value\`), \`updated_at\` = NOW()`,
		[key, value],
	);
}

export async function getMeta(key: string): Promise<string | null> {
	const row = await queryOne<{ value: string }>("SELECT `value` FROM `sync_meta` WHERE `key` = ?", [key]);
	const stored = row?.value ?? null;
	if (stored == null || !SENSITIVE_META_KEYS.has(key)) return stored;

	if (!isEncrypted(stored)) {
		const reEncrypted = encryptSecret(stored);
		if (isEncrypted(reEncrypted)) {
			await writeMetaRow(key, reEncrypted).catch(() => {
				/* best-effort migration */
			});
		}
		return stored;
	}
	return decryptSecret(stored);
}

export async function setMeta(key: string, value: string): Promise<void> {
	const toStore = SENSITIVE_META_KEYS.has(key) && value ? encryptSecret(value) : value;
	await writeMetaRow(key, toStore);
}

export async function testConnection(
	config: Partial<DbConfig>,
): Promise<{ success: boolean; error?: string }> {
	const testConfig = { ...currentConfig, ...config };
	let testPool: Pool | null = null;
	try {
		testPool = mysql.createPool({
			host: testConfig.host,
			port: testConfig.port,
			user: testConfig.user,
			password: testConfig.password,
			connectionLimit: 1,
		});
		const conn = await testPool.getConnection();
		conn.release();
		return { success: true };
	} catch (err) {
		return { success: false, error: err instanceof Error ? err.message : String(err) };
	} finally {
		if (testPool) await testPool.end();
	}
}
