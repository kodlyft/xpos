import { fingerprintOf, type Model } from "./model.ts";
import type { Step } from "./steps.ts";

export type SqlRow = Record<string, unknown>;

/** The only thing a driver must provide (node:sqlite on host; the Kotlin twin uses SQLiteDatabase). */
export interface SqlExecutor {
	exec(sql: string): void;
	all(sql: string, params?: (string | number | null)[]): SqlRow[];
}

export class SchemaChangeBlockedError extends Error {
	constructor(readonly blocked: string[]) {
		super(
			`Schema change needs an explicit step (src/db/steps.ts); nothing was changed:\n- ${blocked.join("\n- ")}`,
		);
		this.name = "SchemaChangeBlockedError";
	}
}

export interface SchemaPlan {
	createTables: string[];
	addColumns: { table: string; column: string; sql: string }[];
	createIndexes: { name: string; sql: string; recreate: boolean }[];
	/** Changes that are not safely automatic. Any entry blocks the whole sync. */
	blocked: string[];
	/** Present in the database but unknown to the models. Reported, never dropped. */
	unmanaged: string[];
}

export interface SyncReport {
	changed: boolean;
	readOnly: boolean;
	deviceWriterLevel: number;
	fingerprint: string;
	createdTables: string[];
	addedColumns: string[];
	indexes: string[];
	stepsRun: string[];
	unmanaged: string[];
}

const INTERNAL = new Set(["schema_state", "schema_steps", "schema_log"]);

export function writerLevelOf(steps: Step[]): number {
	return 1 + steps.filter((s) => s.breaksOlderWriters).length;
}

/** `CHECK (...)` expressions in a CREATE TABLE statement, whitespace-normalised, in source order. */
export function extractChecks(createSql: string): string[] {
	const out: string[] = [];
	const re = /\bCHECK\s*\(/gi;
	for (let m = re.exec(createSql); m; m = re.exec(createSql)) {
		let depth = 1;
		let i = m.index + m[0].length;
		const start = i;
		for (; i < createSql.length && depth > 0; i++) {
			if (createSql[i] === "(") depth++;
			else if (createSql[i] === ")") depth--;
		}
		out.push(
			createSql
				.slice(start, i - 1)
				.replace(/\s+/g, " ")
				.trim(),
		);
	}
	return out;
}

function normalizeRef(table: string, from: string, to: string, onDelete: string): string {
	return `${from}->${table}.${to}/${(onDelete || "NO ACTION").toUpperCase()}`;
}

function modelRef(column: string, ref: string): string | null {
	const m = /REFERENCES\s+(\w+)\s*\((\w+)\)(?:\s+ON DELETE\s+([A-Z ]+))?/i.exec(ref);
	return m ? normalizeRef(m[1], column, m[2], m[3] ?? "NO ACTION") : null;
}

const STATE_DDL = [
	"CREATE TABLE IF NOT EXISTS schema_state (id INTEGER PRIMARY KEY CHECK (id = 1), fingerprint TEXT NOT NULL, updated_at INTEGER NOT NULL, writer_level INTEGER NOT NULL DEFAULT 1)",
	"CREATE TABLE IF NOT EXISTS schema_steps (id TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)",
	"CREATE TABLE IF NOT EXISTS schema_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, change TEXT NOT NULL)",
];

/**
 * Compares the model classes with the real database at startup and applies the difference.
 *  - fresh install: creates everything;
 *  - new field / table / index in a model: added automatically, existing rows kept;
 *  - rename, drop, type or NOT NULL change: refused with a clear error (needs a Step), database untouched;
 *  - extra tables/columns/indexes the models do not know (e.g. written by a newer build): kept, reported.
 * A downgrade is safe only while every change since that build was additive. Steps that break an older writer raise the
 * writer level stored on the device; a build with a lower level then opens the database read-only (see sync()).
 */
export class SchemaSync {
	constructor(
		private readonly db: SqlExecutor,
		private readonly models: Model[],
		private readonly steps: Step[] = [],
		private readonly now: () => number = Date.now,
	) {}

	get fingerprint(): string {
		return fingerprintOf(
			this.models,
			this.steps.map((s) => s.id),
		);
	}

	private ensureState(): void {
		for (const ddl of STATE_DDL) this.db.exec(ddl);
		if (!this.db.all("PRAGMA table_info(schema_state)").some((r) => String(r.name) === "writer_level"))
			this.db.exec("ALTER TABLE schema_state ADD COLUMN writer_level INTEGER NOT NULL DEFAULT 1");
	}

	private storedWriterLevel(): number {
		const r = this.db.all("SELECT writer_level FROM schema_state WHERE id = 1")[0];
		return r ? Number(r.writer_level) : 0;
	}

	private storedFingerprint(): string | null {
		const r = this.db.all("SELECT fingerprint FROM schema_state WHERE id = 1")[0];
		return r ? String(r.fingerprint) : null;
	}

	/** Introspects the live database. Never mutates it. */
	plan(): SchemaPlan {
		const plan: SchemaPlan = {
			createTables: [],
			addColumns: [],
			createIndexes: [],
			blocked: [],
			unmanaged: [],
		};
		const tables = new Set(
			this.db
				.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
				.map((r) => String(r.name)),
		);
		for (const m of this.models) {
			const spec = m.describe();
			if (!tables.has(m.table)) {
				plan.createTables.push(m.table);
				for (const ix of m.indexSqls()) plan.createIndexes.push({ ...ix, recreate: false });
				continue;
			}
			const info = this.db.all(`PRAGMA table_info(${m.table})`);
			const actual = new Map(info.map((r) => [String(r.name), r]));
			const actualPk = info
				.filter((r) => Number(r.pk) > 0)
				.sort((a, b) => Number(a.pk) - Number(b.pk))
				.map((r) => String(r.name));
			if (actualPk.join(",") !== spec.primaryKey.join(","))
				plan.blocked.push(
					`${m.table}: primary key changed (${actualPk.join(", ") || "none"} -> ${spec.primaryKey.join(", ")})`,
				);
			for (const c of spec.columns) {
				const a = actual.get(c.name);
				if (!a) {
					const sql = m.addColumnSql(c);
					if (sql) plan.addColumns.push({ table: m.table, column: c.name, sql });
					else
						plan.blocked.push(
							`${m.table}.${c.name}: new column is NOT NULL (or a key) without a DEFAULT, so existing rows cannot be filled`,
						);
					continue;
				}
				if (String(a.type).toUpperCase() !== c.type)
					plan.blocked.push(`${m.table}.${c.name}: type changed (${a.type} -> ${c.type})`);
				if (!spec.primaryKey.includes(c.name) && Boolean(Number(a.notnull)) !== c.notNull)
					plan.blocked.push(
						`${m.table}.${c.name}: NOT NULL changed (${Number(a.notnull) ? "NOT NULL" : "nullable"} -> ${c.notNull ? "NOT NULL" : "nullable"})`,
					);
			}
			for (const c of spec.columns) {
				const a = actual.get(c.name);
				if (a && (a.dflt_value ?? null) !== c.defaultSql)
					plan.blocked.push(
						`${m.table}.${c.name}: default changed (${a.dflt_value ?? "none"} -> ${c.defaultSql ?? "none"})`,
					);
			}
			const wantRefs = spec.columns
				.filter((c) => c.references)
				.map((c) => modelRef(c.name, c.references!))
				.sort();
			const haveRefs = this.db
				.all(`PRAGMA foreign_key_list(${m.table})`)
				.map((r) => normalizeRef(String(r.table), String(r.from), String(r.to), String(r.on_delete)))
				.sort();
			if (wantRefs.join("|") !== haveRefs.join("|"))
				plan.blocked.push(
					`${m.table}: foreign keys changed (${haveRefs.join(", ") || "none"} -> ${wantRefs.join(", ") || "none"})`,
				);
			const wantChecks = [
				...spec.columns.map((c) => c.check).filter((x): x is string => !!x),
				...spec.checks,
			]
				.map((x) => x.replace(/\s+/g, " ").trim())
				.sort();
			const haveSql = String(
				this.db.all("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", [m.table])[0]
					?.sql ?? "",
			);
			const haveChecks = extractChecks(haveSql).sort();
			if (wantChecks.join("|") !== haveChecks.join("|"))
				plan.blocked.push(`${m.table}: CHECK constraints changed`);
			const modelCols = new Set(spec.columns.map((c) => c.name));
			for (const name of actual.keys())
				if (!modelCols.has(name)) plan.unmanaged.push(`column ${m.table}.${name}`);

			const actualIdx = new Map<string, { columns: string[]; unique: boolean }>();
			for (const ix of this.db.all(`PRAGMA index_list(${m.table})`)) {
				if (String(ix.origin) !== "c") continue; // only indexes made by CREATE INDEX; skip PK/UNIQUE autoindexes
				const cols = this.db
					.all(`PRAGMA index_info(${ix.name})`)
					.sort((x, y) => Number(x.seqno) - Number(y.seqno))
					.map((r) => String(r.name));
				actualIdx.set(String(ix.name), { columns: cols, unique: Boolean(Number(ix.unique)) });
			}
			const sqls = new Map(m.indexSqls().map((x) => [x.name, x.sql]));
			for (const ix of spec.indexes) {
				const cur = actualIdx.get(ix.name);
				if (!cur)
					plan.createIndexes.push({ name: ix.name, sql: sqls.get(ix.name)!, recreate: false });
				else if (cur.columns.join(",") !== ix.columns.join(",") || cur.unique !== ix.unique)
					plan.createIndexes.push({ name: ix.name, sql: sqls.get(ix.name)!, recreate: true }); // indexes hold no data: safe to rebuild
			}
			const modelIdx = new Set(spec.indexes.map((i) => i.name));
			for (const name of actualIdx.keys())
				if (!modelIdx.has(name)) plan.unmanaged.push(`index ${name}`);
		}
		const known = new Set(this.models.map((m) => m.table));
		for (const t of tables) if (!known.has(t) && !INTERNAL.has(t)) plan.unmanaged.push(`table ${t}`);
		return plan;
	}

	/** Brings the database in line with the models. Cheap when nothing changed (one row read). */
	sync(): SyncReport {
		this.ensureState();
		const fingerprint = this.fingerprint;
		const ownLevel = writerLevelOf(this.steps);
		const deviceLevel = this.storedWriterLevel();
		if (deviceLevel > ownLevel)
			return {
				changed: false,
				readOnly: true,
				deviceWriterLevel: deviceLevel,
				fingerprint,
				createdTables: [],
				addedColumns: [],
				indexes: [],
				stepsRun: [],
				unmanaged: [],
			};
		const applied = new Set(this.db.all("SELECT id FROM schema_steps").map((r) => String(r.id)));
		const pending = this.steps.filter((s) => !applied.has(s.id));
		if (this.storedFingerprint() === fingerprint && !pending.length)
			return {
				changed: false,
				readOnly: false,
				deviceWriterLevel: deviceLevel,
				fingerprint,
				createdTables: [],
				addedColumns: [],
				indexes: [],
				stepsRun: [],
				unmanaged: [],
			};

		const stepsRun: string[] = [];
		for (const s of pending) {
			this.transaction(() => {
				for (const sql of s.statements) this.db.exec(sql);
				this.db.exec(
					`INSERT INTO schema_steps (id, name, applied_at) VALUES ('${esc(s.id)}', '${esc(s.name)}', ${this.now()})`,
				);
				this.log(`step ${s.id}: ${s.name}`);
			});
			stepsRun.push(s.id);
		}

		const plan = this.plan();
		if (plan.blocked.length) throw new SchemaChangeBlockedError(plan.blocked);

		this.transaction(() => {
			for (const m of this.models) if (plan.createTables.includes(m.table)) this.db.exec(m.createSql());
			for (const c of plan.addColumns) {
				this.db.exec(c.sql);
				this.log(`add column ${c.table}.${c.column}`);
			}
			for (const ix of plan.createIndexes) {
				if (ix.recreate) this.db.exec(`DROP INDEX IF EXISTS ${ix.name}`);
				this.db.exec(ix.sql);
			}
			for (const t of plan.createTables) this.log(`create table ${t}`);
			this.db.exec(
				`INSERT OR REPLACE INTO schema_state (id, fingerprint, updated_at, writer_level) VALUES (1, '${fingerprint}', ${this.now()}, ${Math.max(ownLevel, deviceLevel)})`,
			);
		});
		return {
			changed:
				plan.createTables.length +
					plan.addColumns.length +
					plan.createIndexes.length +
					stepsRun.length >
				0,
			readOnly: false,
			deviceWriterLevel: Math.max(ownLevel, deviceLevel),
			fingerprint,
			createdTables: plan.createTables,
			addedColumns: plan.addColumns.map((c) => `${c.table}.${c.column}`),
			indexes: plan.createIndexes.map((i) => i.name),
			stepsRun,
			unmanaged: plan.unmanaged,
		};
	}

	private log(change: string): void {
		this.db.exec(`INSERT INTO schema_log (at, change) VALUES (${this.now()}, '${esc(change)}')`);
	}

	private transaction(fn: () => void): void {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			fn();
			this.db.exec("COMMIT");
		} catch (e) {
			this.db.exec("ROLLBACK");
			throw e;
		}
	}
}

function esc(s: string): string {
	return s.replace(/'/g, "''");
}
