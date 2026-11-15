import { Model } from "../model.ts";
import type { TableBuilder } from "../schemaBuilder.ts";

export class CatalogScope extends Model {
	readonly table = "catalog_scope";
	columns(t: TableBuilder): void {
		t.text("scope_id").primary();
		t.text("site").notNull();
		t.text("company");
		t.text("warehouse");
		t.text("price_list");
		t.text("currency").notNull();
		t.integer("minor_digits").notNull().check("minor_digits BETWEEN 0 AND 4");
		t.integer("active_gen");
		t.integer("created_at").notNull();
	}
}

export class CatalogGeneration extends Model {
	readonly table = "catalog_generation";
	columns(t: TableBuilder): void {
		t.text("scope_id").notNull().references("catalog_scope", "scope_id", "CASCADE");
		t.integer("gen").notNull();
		t.text("state").notNull().check("state IN ('staging', 'active', 'retired')");
		t.integer("item_count").notNull().default(0);
		t.integer("created_at").notNull();
		t.primaryKey("scope_id", "gen");
	}
}

export class Item extends Model {
	readonly table = "item";
	columns(t: TableBuilder): void {
		t.text("scope_id").notNull();
		t.integer("gen").notNull();
		t.text("item_code").notNull();
		t.text("variant_of");
		t.text("name").notNull();
		t.text("name_norm").notNull();
		t.text("code_norm").notNull();
		t.text("item_group").notNull();
		t.text("uom").notNull();
		t.integer("price_minor").notNull();
		t.integer("priced").notNull().default(0); // 1 = the price list has a price (0.00 included); 0 = no price
		t.text("brand");
		t.primaryKey("scope_id", "gen", "item_code").withoutRowId();
	}
	indexes() {
		return [
			{ name: "item_name_idx", columns: ["scope_id", "gen", "name_norm", "item_code"] },
			{ name: "item_code_idx", columns: ["scope_id", "gen", "code_norm"] },
			{ name: "item_variant_idx", columns: ["scope_id", "gen", "variant_of"] },
			{ name: "item_brand_idx", columns: ["scope_id", "gen", "brand"] },
		];
	}
}

/** The key includes item_code: one barcode on two items keeps both rows and lookup reports `ambiguous`. */
export class ItemBarcode extends Model {
	readonly table = "item_barcode";
	columns(t: TableBuilder): void {
		t.text("scope_id").notNull();
		t.integer("gen").notNull();
		t.text("barcode").notNull();
		t.text("item_code").notNull();
		t.text("uom");
		t.primaryKey("scope_id", "gen", "barcode", "item_code").withoutRowId();
	}
	indexes() {
		return [{ name: "item_barcode_item_idx", columns: ["scope_id", "gen", "item_code"] }];
	}
}

export class ItemAttr extends Model {
	readonly table = "item_attr";
	columns(t: TableBuilder): void {
		t.text("scope_id").notNull();
		t.integer("gen").notNull();
		t.text("item_code").notNull();
		t.text("attr").notNull();
		t.text("value").notNull();
		t.primaryKey("scope_id", "gen", "item_code", "attr").withoutRowId();
	}
}

/** Future tracking associations: not populated or enforced in the foundation milestone. */
export class SerialKnown extends Model {
	readonly table = "serial_known";
	columns(t: TableBuilder): void {
		t.text("scope_id").notNull();
		t.text("serial_no").notNull();
		t.text("item_code").notNull();
		t.text("state").notNull();
		t.primaryKey("scope_id", "serial_no").withoutRowId();
	}
}

export class BatchKnown extends Model {
	readonly table = "batch_known";
	columns(t: TableBuilder): void {
		t.text("scope_id").notNull();
		t.text("batch_no").notNull();
		t.text("item_code").notNull();
		t.text("expiry_day");
		t.primaryKey("scope_id", "batch_no", "item_code").withoutRowId();
	}
}
