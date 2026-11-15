import { ref, watch, type Ref } from "vue";

/**
 * True from the first time `flag` is set. Lazily loaded dialogs mount on that first request and
 * then stay mounted, so they can still animate closed.
 */
export function useEverTrue(flag: Ref<boolean>): Ref<boolean> {
	const seen = ref(flag.value);
	watch(flag, (value) => {
		if (value) seen.value = true;
	});
	return seen;
}
