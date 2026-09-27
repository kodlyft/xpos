import { defineStore } from "pinia";
import { reactive } from "vue";
export interface CacheState {
	profile: string;
	count: number;
	complete: boolean;
	updatedAt: number;
	loading: boolean;
	error: boolean;
}
/** Completeness is for the selected profile's eligible records, never the whole ERP. */
export const useCacheStatus = defineStore("cacheStatus", () => {
	const states = reactive<Record<string, CacheState>>({});
	function begin(kind: string, profile: string): boolean {
		if (states[kind]?.loading && states[kind].profile === profile) return false;
		states[kind] = { profile, count: 0, complete: false, updatedAt: 0, loading: true, error: false };
		return true;
	}
	function finish(kind: string, profile: string, count: number, complete: boolean) {
		states[kind] = { profile, count, complete, updatedAt: Date.now(), loading: false, error: false };
	}
	function fail(kind: string) {
		if (states[kind]) {
			states[kind].loading = false;
			states[kind].error = true;
		}
	}
	return { states, begin, finish, fail };
});
