/**
 * Writes the model classes (src/db/models) as JSON for the Android build, which cannot read TypeScript.
 * Runs automatically as part of `yarn build`; the output is generated, gitignored and never edited by hand.
 * Kotlin's SchemaSync applies exactly these statements, so models stay the single definition of the schema.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fingerprintOf } from "../src/db/model.ts";
import { ALL_MODELS } from "../src/db/models/index.ts";
import { ALL_STEPS } from "../src/db/steps.ts";

const out = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../android/app/src/main/assets/xpos-schema.json",
);
const doc = {
	fingerprint: fingerprintOf(
		ALL_MODELS,
		ALL_STEPS.map((s) => s.id),
	),
	models: ALL_MODELS.map((m) => {
		const spec = m.describe();
		return {
			table: m.table,
			createSql: m.createSql(),
			primaryKey: spec.primaryKey,
			checks: spec.checks,
			columns: spec.columns.map((c) => ({
				name: c.name,
				type: c.type,
				notNull: c.notNull,
				defaultSql: c.defaultSql,
				check: c.check,
				references: c.references,
				addSql: m.addColumnSql(c), // null when the column cannot be added to an existing table
			})),
			indexes: m.indexSqls().map((ix, i) => ({ ...spec.indexes[i], sql: ix.sql })),
		};
	}),
	steps: ALL_STEPS,
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(doc, null, 2) + "\n");
console.log(`wrote ${out}`);
