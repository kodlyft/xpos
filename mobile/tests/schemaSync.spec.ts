import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { HostSqlite } from "./support/hostSqlite";
import { Model } from "../src/db/model";
import { ALL_MODELS } from "../src/db/models";
import { SchemaChangeBlockedError, SchemaSync, type SqlExecutor } from "../src/db/schemaSync";
import type { TableBuilder } from "../src/db/schemaBuilder";
import type { Step } from "../src/db/steps";
import { collect } from "./support/synthetic";

function exec(db: DatabaseSync): SqlExecutor {
	return {
		exec: (s) => db.exec(s),
		all: (s, p = []) => db.prepare(s).all(...p) as Record<string, unknown>[],
	};
}

class Fruit extends Model {
	readonly table = "fruit";
	constructor(private readonly extra?: (t: TableBuilder) => void) {
		super();
	}
	columns(t: TableBuilder): void {
		t.text("id").primary();
		t.text("name").notNull();
		this.extra?.(t);
	}
	indexes() {
		return [{ name: "fruit_name_idx", columns: ["name"] }];
	}
}

describe("SchemaSync (model classes -> database, on startup)", () => {
	it("fresh install creates every table, column and index from the models", () => {
		const db = new DatabaseSync(":memory:");
		const r = new SchemaSync(exec(db), ALL_MODELS).sync();
		expect(r.changed).toBe(true);
		expect(r.createdTables).toHaveLength(ALL_MODELS.length);
		const cols = db
			.prepare("PRAGMA table_info(item)")
			.all()
			.map((c) => c.name);
		expect(cols).toContain("brand");
		expect(
			db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='item_brand_idx'").get(),
		).toBeDefined();
	});

	it("is a cheap no-op when nothing changed", () => {
		const db = new DatabaseSync(":memory:");
		const s = new SchemaSync(exec(db), ALL_MODELS);
		s.sync();
		expect(s.sync()).toMatchObject({ changed: false, createdTables: [], addedColumns: [] });
	});

	it("adding a field to a model adds the column on next start and keeps existing rows", () => {
		const db = new DatabaseSync(":memory:");
		new SchemaSync(exec(db), [new Fruit()]).sync();
		db.exec("INSERT INTO fruit (id, name) VALUES ('1', 'apple')");
		const r = new SchemaSync(exec(db), [new Fruit((t) => t.text("colour"))]).sync();
		expect(r.addedColumns).toEqual(["fruit.colour"]);
		expect(db.prepare("SELECT id, name, colour FROM fruit").get()).toMatchObject({
			id: "1",
			name: "apple",
			colour: null,
		});
	});

	it("a NOT NULL field with a default is added; without a default it is refused and nothing changes", () => {
		const db = new DatabaseSync(":memory:");
		new SchemaSync(exec(db), [new Fruit()]).sync();
		db.exec("INSERT INTO fruit (id, name) VALUES ('1', 'apple')");
		new SchemaSync(exec(db), [new Fruit((t) => t.integer("qty").notNull().default(0))]).sync();
		expect(db.prepare("SELECT qty FROM fruit").get()).toMatchObject({ qty: 0 });
		const strict = new SchemaSync(exec(db), [
			new Fruit((t) => {
				t.integer("qty").notNull().default(0);
				t.text("must").notNull();
			}),
		]);
		expect(() => strict.sync()).toThrow(SchemaChangeBlockedError);
		expect(
			db
				.prepare("PRAGMA table_info(fruit)")
				.all()
				.map((c) => c.name),
		).not.toContain("must");
	});

	it("type or NOT NULL changes are refused (never guessed) and the database is untouched", () => {
		const db = new DatabaseSync(":memory:");
		new SchemaSync(exec(db), [new Fruit()]).sync();
		class Retyped extends Model {
			readonly table = "fruit";
			columns(t: TableBuilder) {
				t.text("id").primary();
				t.integer("name").notNull();
			}
		}
		expect(() => new SchemaSync(exec(db), [new Retyped()]).sync()).toThrow(
			/type changed \(TEXT -> INTEGER\)/,
		);
		class Dropped extends Model {
			readonly table = "fruit";
			columns(t: TableBuilder) {
				t.text("id").primary();
			}
		}
		const r = new SchemaSync(exec(db), [new Dropped()]).sync();
		expect(r.unmanaged).toContain("column fruit.name"); // a removed field is kept, never dropped
		expect(
			db
				.prepare("PRAGMA table_info(fruit)")
				.all()
				.map((c) => c.name),
		).toContain("name");
	});

	it("rebuilds an index whose columns changed, and reports tables it does not manage", () => {
		const db = new DatabaseSync(":memory:");
		new SchemaSync(exec(db), [new Fruit()]).sync();
		db.exec("CREATE TABLE legacy (a INTEGER)");
		class Reindexed extends Fruit {
			indexes() {
				return [{ name: "fruit_name_idx", columns: ["name", "id"] }];
			}
		}
		const r = new SchemaSync(exec(db), [new Reindexed()]).sync();
		expect(r.indexes).toEqual(["fruit_name_idx"]);
		expect(r.unmanaged).toContain("table legacy");
		expect(
			db
				.prepare("PRAGMA index_info(fruit_name_idx)")
				.all()
				.map((c) => c.name),
		).toEqual(["name", "id"]);
	});

	it("an older build keeps working on a database a newer build extended (downgrade is safe)", () => {
		const db = new DatabaseSync(":memory:");
		new SchemaSync(exec(db), [new Fruit((t) => t.text("colour"))]).sync();
		db.exec("INSERT INTO fruit (id, name, colour) VALUES ('1', 'apple', 'red')");
		const old = new SchemaSync(exec(db), [new Fruit()]);
		expect(() => old.sync()).not.toThrow();
		db.exec("INSERT INTO fruit (id, name) VALUES ('2', 'pear')"); // old build inserts without the unknown column
		expect(db.prepare("SELECT COUNT(*) n FROM fruit").get()).toMatchObject({ n: 2 });
	});

	it("explicit steps run once, in order, before the diff (rename example)", () => {
		const db = new DatabaseSync(":memory:");
		new SchemaSync(exec(db), [new Fruit()]).sync();
		db.exec("INSERT INTO fruit (id, name) VALUES ('1', 'apple')");
		class Renamed extends Model {
			readonly table = "fruit";
			columns(t: TableBuilder) {
				t.text("id").primary();
				t.text("title").notNull();
			}
			indexes() {
				return [];
			}
		}
		const steps: Step[] = [
			{
				id: "2026-10-rename-fruit-name",
				name: "rename name to title",
				statements: ["DROP INDEX fruit_name_idx", "ALTER TABLE fruit RENAME COLUMN name TO title"],
			},
		];
		const r = new SchemaSync(exec(db), [new Renamed()], steps).sync();
		expect(r.stepsRun).toEqual(["2026-10-rename-fruit-name"]);
		expect(db.prepare("SELECT title FROM fruit").get()).toMatchObject({ title: "apple" });
		expect(new SchemaSync(exec(db), [new Renamed()], steps).sync().stepsRun).toEqual([]); // not re-run
	});

	it("a failing apply rolls back completely", () => {
		const db = new DatabaseSync(":memory:");
		new SchemaSync(exec(db), [new Fruit()]).sync();
		class Boom extends Fruit {
			indexes() {
				return [
					{ name: "fruit_name_idx", columns: ["name"] },
					{ name: "bad_idx", columns: ["does_not_exist"] },
				];
			}
		}
		expect(() => new SchemaSync(exec(db), [new Boom((t) => t.text("colour"))]).sync()).toThrow();
		expect(
			db
				.prepare("PRAGMA table_info(fruit)")
				.all()
				.map((c) => c.name),
		).not.toContain("colour");
	});

	it("upgrading a real on-disk database from an older install preserves rows and adds the new field (user installs the latest version)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "xpos-sync-"));
		const path = join(dir, "t.db");
		try {
			// An older install: the item table had no `brand` column.
			const old = new DatabaseSync(path);
			const itemModel = ALL_MODELS.find((m) => m.table === "item")!;
			new SchemaSync(
				exec(old),
				ALL_MODELS.filter((m) => m !== itemModel),
			).sync();
			old.exec(itemModel.createSql().replace("brand TEXT,\n  ", ""));
			expect(
				old
					.prepare("PRAGMA table_info(item)")
					.all()
					.map((c) => c.name),
			).not.toContain("brand");
			old.exec(
				"INSERT INTO catalog_scope (scope_id,site,currency,minor_digits,created_at,active_gen) VALUES ('s','x','PKR',2,0,1)",
			);
			old.exec(
				"INSERT INTO item (scope_id,gen,item_code,name,name_norm,code_norm,item_group,uom,price_minor) VALUES ('s',1,'A','Apple','apple','a','G','Nos',100)",
			);
			old.close();

			const latest = new HostSqlite({ path }); // opening the latest app runs the schema check
			const item = await latest.getItem("s", "A");
			expect(item).toMatchObject({ itemCode: "A", priceMinor: 100, brand: null });
			expect(
				latest.db
					.prepare("SELECT change FROM schema_log")
					.all()
					.map((r) => r.change),
			).toContain("add column item.brand");
			latest.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
