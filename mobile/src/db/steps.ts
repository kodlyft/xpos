/**
 * Explicit, run-once steps for changes SchemaSync will not guess: renaming or dropping a column, changing a
 * type, backfilling data. Each step is plain SQL, has a permanent unique id and is never edited after release.
 * Steps run BEFORE the model diff, so after a rename the models already describe the new name.
 * Empty today: every change so far (adding fields, tables, indexes) is automatic.
 */
export interface Step {
	id: string;
	name: string;
	statements: string[];
	breaksOlderWriters?: boolean;
}

export const ALL_STEPS: Step[] = [];
