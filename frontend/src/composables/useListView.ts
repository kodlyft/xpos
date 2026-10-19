import { ref, reactive, computed, watch, isRef, type Ref } from "vue";
import { getList, getCount, searchLink } from "@/services/api";
import {
	getDoctypeMeta,
	getStandardFilterFields,
	getAllFilterableFields,
	type DoctypeMeta,
	type DocField,
} from "@/services/doctypeMeta";

export type FilterOperator =
	| "="
	| "!="
	| ">"
	| "<"
	| ">="
	| "<="
	| "like"
	| "not like"
	| "in"
	| "not in"
	| "is"
	| "is not"
	| "between";

export interface QueryFilter {
	field: string;
	operator: FilterOperator;
	value: string;
}

type MaybeRef<T> = T | Ref<T>;

export interface ListViewOptions {
	doctype: Ref<string> | string;
	fields?: string[];
	baseFilters?: MaybeRef<Record<string, unknown> | undefined>;
	defaultOrderBy?: string;
	defaultPageSize?: number;
	autoFetch?: boolean;
}

const TEXT_FILTER_TYPES = new Set(["Data", "Small Text", "Text", "Long Text"]);

function normalizeOrderByClause(orderByValue: string, doctype: string): string {
	const tableName = `\`tab${doctype}\``;

	return orderByValue
		.split(",")
		.map((part) => {
			const trimmed = part.trim();
			if (!trimmed) return "";

			const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\s+(asc|desc))?$/i);
			if (!match) return trimmed;

			const [, fieldname, direction] = match;
			return `${tableName}.\`${fieldname}\`${direction ? ` ${direction.toLowerCase()}` : ""}`;
		})
		.filter(Boolean)
		.join(", ");
}

export function useListView(options: ListViewOptions) {
	const doctypeRef = typeof options.doctype === "string" ? ref(options.doctype) : options.doctype;
	const baseFiltersRef = isRef(options.baseFilters) ? options.baseFilters : ref(options.baseFilters);

	const data = ref<Record<string, unknown>[]>([]);
	const total = ref(0);
	const isLoading = ref(false);
	const meta = ref<DoctypeMeta | null>(null);
	const standardFilterFields = ref<DocField[]>([]);
	const allFilterableFields = ref<DocField[]>([]);

	const currentPage = ref(1);
	const pageSize = ref(options.defaultPageSize ?? 20);
	const orderBy = ref(options.defaultOrderBy ?? "modified desc");

	const filters = reactive<Record<string, unknown>>({});

	const queryFilters = ref<QueryFilter[]>([]);

	const frappeFilters = computed(() => {
		const result: [string, string, FilterOperator | string, unknown][] = [];

		if (baseFiltersRef.value) {
			for (const [field, value] of Object.entries(baseFiltersRef.value)) {
				result.push([doctypeRef.value, field, "=", value]);
			}
		}

		for (const [field, value] of Object.entries(filters)) {
			if (value === undefined || value === null || value === "" || value === "__all__") continue;
			const fieldDef = standardFilterFields.value.find((f) => f.fieldname === field);
			const fieldtype = fieldDef?.fieldtype || "Data";
			if (TEXT_FILTER_TYPES.has(fieldtype)) {
				result.push([doctypeRef.value, field, "like", `%${value}%`]);
			} else {
				result.push([doctypeRef.value, field, "=", value]);
			}
		}

		for (const qf of queryFilters.value) {
			if (!qf.field || !qf.operator) continue;
			if (!qf.value && !["is", "is not"].includes(qf.operator)) continue;

			let filterDoctype = doctypeRef.value;
			let fieldname = qf.field;

			const dotIdx = qf.field.indexOf(".");
			if (dotIdx !== -1) {
				const tableFieldname = qf.field.slice(0, dotIdx);
				const childFieldname = qf.field.slice(dotIdx + 1);
				const tableField = meta.value?.fields.find((f) => f.fieldname === tableFieldname);
				if (tableField?.options) {
					filterDoctype = tableField.options;
					fieldname = childFieldname;
				}
			}

			let val: unknown = qf.value;
			if (qf.operator === "like" || qf.operator === "not like") {
				val = `%${qf.value}%`;
			}
			result.push([filterDoctype, fieldname, qf.operator, val]);
		}

		return result;
	});

	async function fetch() {
		isLoading.value = true;
		try {
			const listArgs: Record<string, unknown> = {
				filters: frappeFilters.value,
				order_by: normalizeOrderByClause(orderBy.value, doctypeRef.value),
				limit_start: (currentPage.value - 1) * pageSize.value,
				limit_page_length: pageSize.value,
			};

			if (options.fields && options.fields.length > 0) {
				listArgs.fields = options.fields;
			}

			const [rows, count] = await Promise.all([
				getList<Record<string, unknown>>(doctypeRef.value, listArgs),
				getCount(doctypeRef.value, frappeFilters.value),
			]);

			data.value = rows;
			total.value = count;
		} catch (error) {
			console.error(`[useListView] Error fetching ${doctypeRef.value}:`, error);
			data.value = [];
			total.value = 0;
		} finally {
			isLoading.value = false;
		}
	}

	async function loadMeta() {
		try {
			const m = await getDoctypeMeta(doctypeRef.value);
			meta.value = m;
			standardFilterFields.value = getStandardFilterFields(m);

			const parentFields = getAllFilterableFields(m);

			const tableFields = m.fields.filter(
				(f) =>
					(f.fieldtype === "Table" || f.fieldtype === "Table MultiSelect") &&
					f.options &&
					!f.hidden,
			);

			const childFieldsBuffer: DocField[] = [];
			if (tableFields.length > 0) {
				const results = await Promise.allSettled(
					tableFields.map(async (tf) => {
						const childMeta = await getDoctypeMeta(tf.options!);
						return { tableField: tf, childMeta };
					}),
				);
				for (const r of results) {
					if (r.status !== "fulfilled") continue;
					const { tableField, childMeta } = r.value;
					const childFilterable = getAllFilterableFields(childMeta);
					for (const cf of childFilterable) {
						childFieldsBuffer.push({
							...cf,
							fieldname: `${tableField.fieldname}.${cf.fieldname}`,
							label: `${cf.label || cf.fieldname} (${tableField.label || tableField.fieldname})`,
						});
					}
				}
			}

			allFilterableFields.value = [...parentFields, ...childFieldsBuffer];
		} catch (error) {
			console.error(`[useListView] Error loading meta for ${doctypeRef.value}:`, error);
		}
	}

	function setFilter(field: string, value: unknown) {
		filters[field] = value;
	}

	function removeFilter(field: string) {
		delete filters[field];
	}

	function clearFilters() {
		for (const key of Object.keys(filters)) {
			delete filters[key];
		}
		queryFilters.value = [];
	}

	function setQueryFilters(qf: QueryFilter[]) {
		queryFilters.value = qf;
	}

	function setPage(page: number) {
		currentPage.value = page;
	}

	function setPageSize(size: number) {
		pageSize.value = size;
		currentPage.value = 1;
	}

	function setOrderBy(value: string) {
		orderBy.value = value;
	}

	function refresh() {
		currentPage.value = 1;
		fetch();
	}

	async function fetchLinkOptions(
		linkDoctype: string,
		txt: string,
	): Promise<{ label: string; value: string; description?: string }[]> {
		try {
			const results = await searchLink(linkDoctype, txt);
			return results.map((r) => ({
				label: r.description ? `${r.value} - ${r.description}` : r.value,
				value: r.value,
				description: r.description,
			}));
		} catch {
			return [];
		}
	}

	watch([currentPage, pageSize, orderBy], () => {
		fetch();
	});

	watch(
		() => JSON.stringify(filters),
		() => {
			currentPage.value = 1;
			fetch();
		},
	);

	watch(
		() => JSON.stringify(queryFilters.value),
		() => {
			currentPage.value = 1;
			fetch();
		},
	);

	watch(
		() => JSON.stringify(baseFiltersRef.value ?? {}),
		() => {
			currentPage.value = 1;
			fetch();
		},
	);

	watch(doctypeRef, () => {
		clearFilters();
		loadMeta();
		fetch();
	});

	if (options.autoFetch !== false) {
		loadMeta().then(() => fetch());
	}

	return {
		data,
		total,
		isLoading,
		meta,
		standardFilterFields,
		allFilterableFields,
		currentPage,
		pageSize,
		orderBy,
		filters,
		queryFilters,
		fetch,
		loadMeta,
		setFilter,
		removeFilter,
		clearFilters,
		setQueryFilters,
		setPage,
		setPageSize,
		setOrderBy,
		refresh,
		fetchLinkOptions,
	};
}
