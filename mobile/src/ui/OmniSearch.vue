<script setup lang="ts">
import { ref, watch } from "vue";
import type { CatalogItem } from "@mobile/ports";
import { formatMinor } from "@mobile/domain/money";
import { getContainer, useApp } from "@mobile/composables/useApp";
import { asScanned, lookupRemoteBarcode } from "@mobile/app/scan";
import SearchField from "./SearchField.vue";
import { toast } from "@mobile/composables/useToast";

/**
 * ONE bar for typing, handheld scanners (they type the code then Enter) and the camera button.
 * Typing filters the list by name/code prefix. Enter first tries an EXACT barcode match and adds that item;
 * with `strict` (Scan Counter) an unknown barcode is reported instead of falling back to text search.
 * Sticky: stays put while the list below scrolls.
 */
const props = defineProps<{
	scopeId: string;
	placeholder?: string;
	large?: boolean;
	strict?: boolean;
	minorDigits: number;
	autofocus?: boolean;
}>();
const query = defineModel<string>({ default: "" });
const emit = defineEmits<{ pick: [item: CatalogItem]; scanned: [item: CatalogItem] }>();

const { state } = useApp();
const message = ref("");
const tone = ref<"info" | "warning">("info");
watch(message, (text) => text && toast[tone.value](text));
const choices = ref<CatalogItem[]>([]);
const root = ref<HTMLElement>();

function focus() {
	root.value?.querySelector<HTMLInputElement>("input")?.focus();
}
defineExpose({ focus });

async function submit() {
	const code = query.value.trim();
	if (!code) return;
	const r = await getContainer().catalog.lookupBarcode(props.scopeId, code);
	choices.value = [];
	if (r.matches.length === 1) {
		query.value = "";
		message.value = "";
		emit("scanned", r.matches[0]);
		emit("pick", r.matches[0]);
	} else if (r.ambiguous) {
		tone.value = "warning";
		message.value = `Barcode ${code} is assigned to ${r.matches.length} items. Choose one (and tell a manager: this is a data error).`;
		choices.value = r.matches;
	} else if (state.online && state.cashier && (await scanOnServer(code))) {
		query.value = "";
		message.value = "";
	} else if (props.strict) {
		tone.value = "warning";
		message.value ||= `No item with barcode ${code}.`;
		query.value = "";
	}
	focus(); // handheld scanners keep typing into the same field
}
/** A barcode the local catalog does not hold (for example a box barcode): the server resolves it with its unit. */
async function scanOnServer(code: string): Promise<boolean> {
	const e = state.cashier!;
	try {
		const c = getContainer();
		const api = await c.session(e.site);
		const found = await lookupRemoteBarcode(api, e.profile, code, props.minorDigits);
		if (found.kind === "unsupported") {
			tone.value = "warning";
			message.value = found.reason;
			return false;
		}
		if (found.kind !== "found") return false;
		const item = await c.catalog.getItem(props.scopeId, found.itemCode);
		if (!item) return false;
		const sold = asScanned(item, found);
		emit("scanned", sold);
		emit("pick", sold);
		return true;
	} catch (err) {
		tone.value = "warning";
		message.value = err instanceof Error ? err.message : "";
		return false;
	}
}
function choose(it: CatalogItem) {
	choices.value = [];
	message.value = "";
	query.value = "";
	emit("scanned", it);
	emit("pick", it);
	focus();
}
const cameraNote = ref(false);
</script>

<template>
	<div ref="root" class="sticky top-0 z-10 -mx-3 bg-background px-3 pb-2 pt-2">
		<SearchField
			v-model="query"
			label="Search products or scan barcode"
			:placeholder="placeholder ?? 'Search products or scan barcode…'"
			:large="large"
			scan
			inputmode="search"
			@enter="submit"
			@scan="cameraNote = true"
		/>
		<p
			v-if="cameraNote"
			class="mt-2 rounded-xl border border-info/30 bg-info-soft px-3 py-2 text-xs text-info-soft-foreground"
			role="status"
		>
			Camera scanning is not implemented in this milestone. A handheld scanner that types into this bar
			works (no model tested yet).
		</p>
		<ul v-if="choices.length" class="mt-2 flex flex-col gap-2" aria-label="Items sharing this barcode">
			<li v-for="c in choices" :key="c.itemCode">
				<button
					type="button"
					class="flex min-h-11 w-full items-center justify-between gap-2 rounded-2xl border border-border bg-card p-3 text-left shadow-raised active:shadow-pressed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
					@click="choose(c)"
				>
					<span class="text-sm font-medium">{{ c.name }}</span
					><span class="text-sm tabular-nums">{{ formatMinor(c.priceMinor, minorDigits) }}</span>
				</button>
			</li>
		</ul>
	</div>
</template>
