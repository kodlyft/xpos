import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Model } from "../src/db/model";
import { extractChecks, SchemaChangeBlockedError, SchemaSync, type SqlExecutor } from "../src/db/schemaSync";
import type { TableBuilder } from "../src/db/schemaBuilder";
import type { Step } from "../src/db/steps";

const exec = (db: DatabaseSync): SqlExecutor => ({
	exec: (s) => db.exec(s),
	all: (s, p = []) => db.prepare(s).all(...p) as Record<string, unknown>[],
});

class Thing extends Model {
	readonly table = "thing";
	constructor(private readonly extra: (t: TableBuilder) => void = () => {}) {
		super();
	}
	columns(t: TableBuilder): void {
		t.text("id").primary();
		t.text("state").notNull().default("new").check("state IN ('new', 'done')");
		this.extra(t);
	}
}

describe("schema safety beyond additive changes", () => {
	it("extracts nested CHECK expressions", () => {
		expect(extractChecks("CREATE TABLE t (a INTEGER CHECK (a IN (1, 2)), CHECK (b > (1 + 2)))")).toEqual([
			"a IN (1, 2)",
			"b > (1 + 2)",
		]);
	});

	it("blocks a changed default, CHECK or foreign key instead of silently ignoring it", () => {
		const db = new DatabaseSync(":memory:");
		new SchemaSync(exec(db), [new Thing()]).sync();
		class OtherDefault extends Model {
			readonly table = "thing";
			columns(t: TableBuilder) {
				t.text("id").primary();
				t.text("state").notNull().default("old").check("state IN ('new', 'done')");
			}
		}
		class OtherCheck extends Model {
			readonly table = "thing";
			columns(t: TableBuilder) {
				t.text("id").primary();
				t.text("state").notNull().default("new").check("state IN ('new', 'done', 'x')");
			}
		}
		class WithFk extends Model {
			readonly table = "thing";
			columns(t: TableBuilder) {
				t.text("id").primary();
				t.text("state").notNull().default("new").check("state IN ('new', 'done')");
				t.text("parent").references("thing", "id");
			}
		}
		for (const m of [new OtherDefault(), new OtherCheck()])
			expect(() => new SchemaSync(exec(db), [m]).sync()).toThrow(SchemaChangeBlockedError);
		// a new column that carries a foreign key is a new constraint on an existing table: also needs a step
		expect(() => new SchemaSync(exec(db), [new WithFk()]).sync()).toThrow(SchemaChangeBlockedError);
	});

	it("an unchanged schema is not flagged by the constraint checks (fresh and re-run)", () => {
		const db = new DatabaseSync(":memory:");
		new SchemaSync(exec(db), [new Thing()]).sync();
		const again = new SchemaSync(exec(db), [new Thing(), new Thing()].slice(0, 1), [
			{ id: "noop", name: "noop", statements: [] },
		]);
		expect(() => again.sync()).not.toThrow();
	});

	it("an older build opens a database written by a newer incompatible build read-only and changes nothing", () => {
		const db = new DatabaseSync(":memory:");
		const breaking: Step = { id: "s1", name: "rename", statements: [], breaksOlderWriters: true };
		const newer = new SchemaSync(exec(db), [new Thing()], [breaking]);
		expect(newer.sync()).toMatchObject({ readOnly: false, deviceWriterLevel: 2 });
		const older = new SchemaSync(exec(db), [new Thing((t) => t.text("extra"))], []).sync();
		expect(older).toMatchObject({ readOnly: true, changed: false, deviceWriterLevel: 2 });
		expect(
			db
				.prepare("PRAGMA table_info(thing)")
				.all()
				.map((c) => c.name),
		).not.toContain("extra");
	});

	it("an additive-only newer build leaves older builds writable", () => {
		const db = new DatabaseSync(":memory:");
		new SchemaSync(exec(db), [new Thing((t) => t.text("note"))]).sync();
		expect(new SchemaSync(exec(db), [new Thing()]).sync()).toMatchObject({ readOnly: false });
	});

	it("a step that fails half way changes nothing and the next start can complete it", () => {
		const db = new DatabaseSync(":memory:");
		new SchemaSync(exec(db), [new Thing()]).sync();
		db.exec("INSERT INTO thing (id) VALUES ('a')");
		const bad: Step = {
			id: "fill",
			name: "backfill",
			statements: ["UPDATE thing SET state = 'done'", "SELECT * FROM does_not_exist"],
		};
		expect(() => new SchemaSync(exec(db), [new Thing()], [bad]).sync()).toThrow();
		expect(db.prepare("SELECT state FROM thing").get()).toMatchObject({ state: "new" }); // rolled back
		expect(db.prepare("SELECT COUNT(*) n FROM schema_steps").get()).toMatchObject({ n: 0 });
		const fixed: Step = { ...bad, statements: ["UPDATE thing SET state = 'done'"] };
		expect(new SchemaSync(exec(db), [new Thing()], [fixed]).sync().stepsRun).toEqual(["fill"]);
		expect(db.prepare("SELECT state FROM thing").get()).toMatchObject({ state: "done" });
	});

	it("databases from before writer levels existed are upgraded in place", () => {
		const db = new DatabaseSync(":memory:");
		db.exec(
			"CREATE TABLE schema_state (id INTEGER PRIMARY KEY CHECK (id = 1), fingerprint TEXT NOT NULL, updated_at INTEGER NOT NULL)",
		);
		db.exec("INSERT INTO schema_state VALUES (1, 'old', 0)");
		const r = new SchemaSync(exec(db), [new Thing()]).sync();
		expect(r).toMatchObject({ readOnly: false, createdTables: ["thing"] });
		expect(db.prepare("SELECT writer_level FROM schema_state").get()).toMatchObject({ writer_level: 1 });
	});
});
