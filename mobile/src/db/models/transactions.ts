import { Model } from "../model.ts";
import type { TableBuilder } from "../schemaBuilder.ts";

/** Sample-only transactions (prototype). Never posted to ERPNext. */
export class SampleTxn extends Model {
	readonly table = "sample_txn";
	columns(t: TableBuilder): void {
		t.text("txn_id").primary();
		t.text("content_hash").notNull();
		t.text("scope_id").notNull();
		t.text("currency").notNull();
		t.integer("minor_digits").notNull();
		t.integer("total_minor").notNull();
		t.text("sale_json").notNull();
		t.text("receipt_json").notNull();
		t.integer("created_at").notNull();
	}
}

export class Sale extends Model {
	readonly table = "sale";
	columns(t: TableBuilder): void {
		t.text("txn_id").primary();
		t.text("scope_id").notNull();
		t.text("status")
			.notNull()
			.check(
				"status IN ('captured', 'posting', 'posted', 'reprice', 'uncertain', 'held', 'rejected', 'fiscal_pending')",
			);
		t.text("body_json").notNull();
		t.text("content_hash").notNull();
		t.text("currency").notNull();
		t.integer("minor_digits").notNull();
		t.integer("payable_minor").notNull();
		t.text("evidence_json").notNull();
		t.text("server_json");
		t.text("invoice");
		t.text("message").notNull().default("");
		t.integer("attempts").notNull().default(0);
		t.integer("created_at").notNull();
		t.integer("updated_at").notNull();
	}
	indexes() {
		return [{ name: "sale_status_idx", columns: ["status", "created_at"] }];
	}
}

/** One queue for the foreground and WorkManager processors. SAMPLE rows are blocked in the database itself. */
export class Outbox extends Model {
	readonly table = "outbox";
	columns(t: TableBuilder): void {
		t.text("command_id").primary();
		t.text("txn_id").notNull();
		t.text("kind").notNull();
		t.text("state").notNull().check("state IN ('pending', 'claimed', 'done', 'blocked', 'needs_review')");
		t.text("claim_token");
		t.integer("claim_until");
		t.integer("attempts").notNull().default(0);
		t.text("blocked_reason");
		t.integer("created_at").notNull();
		t.check("kind <> 'SAMPLE' OR (state = 'blocked' AND blocked_reason IS NOT NULL)");
	}
	indexes() {
		return [{ name: "outbox_claim_idx", columns: ["state", "claim_until"] }];
	}
}

export class DeviceMeta extends Model {
	readonly table = "device_meta";
	columns(t: TableBuilder): void {
		t.text("k").primary();
		t.text("v").notNull();
	}
}
