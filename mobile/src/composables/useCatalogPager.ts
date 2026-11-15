import { onBeforeUnmount, ref, shallowRef, watch, type Ref } from "vue";
import type { CatalogItem } from "@mobile/ports";
import { getContainer } from "./useApp";

export const SEARCH_DEBOUNCE_MS = 200;
const PAGE = 40;

/** Bounded, keyset-paged list over the catalog repository. Never holds more than the pages loaded. */
export function useCatalogPager(scopeId: string, query: Ref<string>, opts: { variantsOnly?: boolean } = {}) {
	const items = shallowRef<CatalogItem[]>([]);
	const next = ref<string | undefined>();
	const loading = ref(false);
	const error = ref("");
	let token = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;

	async function load(reset: boolean) {
		const my = ++token;
		loading.value = true;
		error.value = "";
		try {
			const repo = getContainer().catalog;
			const q = query.value.trim();
			const after = reset ? undefined : next.value;
			const req = { after, limit: PAGE, variantsOnly: opts.variantsOnly };
			const p = q ? await repo.search(scopeId, q, req) : await repo.page(scopeId, req);
			if (my !== token) return; // a newer query superseded this one
			items.value = reset ? p.items : [...items.value, ...p.items];
			next.value = p.next;
		} catch (e) {
			if (my === token) error.value = e instanceof Error ? e.message : String(e);
		} finally {
			if (my === token) loading.value = false;
		}
	}

	watch(
		query,
		() => {
			clearTimeout(timer);
			timer = setTimeout(() => void load(true), SEARCH_DEBOUNCE_MS);
		},
		{ flush: "post" },
	);
	onBeforeUnmount(() => clearTimeout(timer));
	void load(true);

	return {
		items,
		loading,
		error,
		hasMore: () => !!next.value,
		loadMore: () => (next.value && !loading.value ? load(false) : undefined),
		reload: () => load(true),
	};
}
