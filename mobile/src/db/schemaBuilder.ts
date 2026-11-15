/**
 * Describes tables, columns and indexes and renders SQLite DDL (valid on Android API 24+: no RETURNING,
 * row values or FTS). Models (src/db/models) are written with this API; SchemaSync diffs them against the
 * real database. Imports are relative with .ts extensions so Node can run this module directly (export script).
 */

export type ColumnType = "TEXT" | "INTEGER" | "REAL" | "BLOB";

export interface ColumnSpec {
	name: string;
	type: ColumnType;
	notNull: boolean;
	primary: boolean;
	defaultSql: string | null;
	check: string | null;
	references: string | null;
}

export class ColumnDef {
	private notNullFlag = false;
	private primaryFlag = false;
	private defaultValue: string | null = null;
	private checkExpr: string | null = null;
	private ref: string | null = null;
	constructor(
		readonly name: string,
		readonly type: ColumnType,
	) {}
	notNull(): this {
		this.notNullFlag = true;
		return this;
	}
	primary(): this {
		this.primaryFlag = true;
		return this;
	}
	default(value: string | number): this {
		this.defaultValue = typeof value === "number" ? String(value) : `'${value.replace(/'/g, "''")}'`;
		return this;
	}
	check(expr: string): this {
		this.checkExpr = expr;
		return this;
	}
	references(table: string, column: string, onDelete?: "CASCADE" | "RESTRICT" | "SET NULL"): this {
		this.ref = `REFERENCES ${table} (${column})${onDelete ? ` ON DELETE ${onDelete}` : ""}`;
		return this;
	}
	spec(): ColumnSpec {
		return {
			name: this.name,
			type: this.type,
			notNull: this.notNullFlag,
			primary: this.primaryFlag,
			defaultSql: this.defaultValue,
			check: this.checkExpr,
			references: this.ref,
		};
	}
	sql(): string {
		const s = this.spec();
		return [
			s.name,
			s.type,
			s.primary ? "PRIMARY KEY" : "",
			s.notNull ? "NOT NULL" : "",
			s.defaultSql !== null ? `DEFAULT ${s.defaultSql}` : "",
			s.check ? `CHECK (${s.check})` : "",
			s.references ?? "",
		]
			.filter(Boolean)
			.join(" ");
	}
	/** True when SQLite can add this column to an existing table (nullable or with a default, not a key). */
	canAddToExisting(): boolean {
		const s = this.spec();
		return !s.primary && (!s.notNull || s.defaultSql !== null);
	}
}

export interface TableSpec {
	table: string;
	columns: ColumnSpec[];
	primaryKey: string[];
	withoutRowId: boolean;
	checks: string[];
}

export class TableBuilder {
	readonly defs: ColumnDef[] = [];
	private pk: string[] = [];
	private checkList: string[] = [];
	private rowid = true;
	constructor(readonly name: string) {}
	private add(name: string, type: ColumnType): ColumnDef {
		const c = new ColumnDef(name, type);
		this.defs.push(c);
		return c;
	}
	text(name: string): ColumnDef {
		return this.add(name, "TEXT");
	}
	integer(name: string): ColumnDef {
		return this.add(name, "INTEGER");
	}
	real(name: string): ColumnDef {
		return this.add(name, "REAL");
	}
	blob(name: string): ColumnDef {
		return this.add(name, "BLOB");
	}
	primaryKey(...cols: string[]): this {
		this.pk = cols;
		return this;
	}
	check(expr: string): this {
		this.checkList.push(expr);
		return this;
	}
	withoutRowId(): this {
		this.rowid = false;
		return this;
	}
	spec(): TableSpec {
		const columns = this.defs.map((d) => d.spec());
		const primaryKey = this.pk.length ? this.pk : columns.filter((c) => c.primary).map((c) => c.name);
		return { table: this.name, columns, primaryKey, withoutRowId: !this.rowid, checks: this.checkList };
	}
	createSql(): string {
		const body = this.defs.map((c) => c.sql());
		if (this.pk.length) body.push(`PRIMARY KEY (${this.pk.join(", ")})`);
		for (const c of this.checkList) body.push(`CHECK (${c})`);
		return `CREATE TABLE ${this.name} (\n  ${body.join(",\n  ")}\n)${this.rowid ? "" : " WITHOUT ROWID"}`;
	}
}

export interface IndexSpec {
	name: string;
	columns: string[];
	unique: boolean;
}

export function createIndexSql(table: string, ix: IndexSpec): string {
	return `CREATE ${ix.unique ? "UNIQUE " : ""}INDEX ${ix.name} ON ${table} (${ix.columns.join(", ")})`;
}
