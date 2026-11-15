import { fnv1a64 } from "./hash.ts";
import {
	createIndexSql,
	TableBuilder,
	type ColumnSpec,
	type IndexSpec,
	type TableSpec,
} from "./schemaBuilder.ts";

/**
 * A table, written as a class. Add a field in `columns()` (or an index in `indexes()`) and the app updates
 * the on-device schema on its next start (SchemaSync). Additive changes are automatic; rename, drop and type
 * changes need an explicit Step (src/db/steps.ts) and are never guessed.
 */
export abstract class Model {
	abstract readonly table: string;
	abstract columns(t: TableBuilder): void;
	indexes(): { name: string; columns: string[]; unique?: boolean }[] {
		return [];
	}

	builder(): TableBuilder {
		const t = new TableBuilder(this.table);
		this.columns(t);
		return t;
	}

	describe(): TableSpec & { indexes: IndexSpec[] } {
		return {
			...this.builder().spec(),
			indexes: this.indexes().map((i) => ({ name: i.name, columns: i.columns, unique: !!i.unique })),
		};
	}

	createSql(): string {
		return this.builder().createSql();
	}

	indexSqls(): { name: string; sql: string }[] {
		return this.describe().indexes.map((ix) => ({ name: ix.name, sql: createIndexSql(this.table, ix) }));
	}

	addColumnSql(column: ColumnSpec): string | null {
		const def = this.builder().defs.find((d) => d.name === column.name);
		return def && def.canAddToExisting() ? `ALTER TABLE ${this.table} ADD COLUMN ${def.sql()}` : null;
	}
}

export function fingerprintOf(models: Model[], stepIds: string[]): string {
	return fnv1a64(JSON.stringify({ models: models.map((m) => m.describe()), steps: stepIds }));
}
