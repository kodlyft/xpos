<template>
	<div
		class="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden bg-background p-3 text-foreground antialiased sm:gap-4 sm:p-4"
		:dir="dir"
	>
		<header
			class="flex h-14 flex-none items-center gap-3 rounded-xl border border-border bg-card/70 px-3 shadow-raised backdrop-blur-sm"
		>
			<XposLogo :size="32" class="shrink-0" />
			<div class="flex min-w-0 flex-1 flex-col leading-tight">
				<span class="truncate text-base font-bold">{{ __("Price Checker") }}</span>
				<span class="truncate text-xs font-medium text-muted-foreground">{{ appName }}</span>
			</div>

			<Select
				v-if="profiles.length > 1"
				v-model="posProfile"
				:items="profiles.map((p) => ({ label: p.name, value: p.name }))"
				:aria-label="__('Store / Register')"
				class="max-w-[45vw] sm:max-w-xs"
			/>

			<Badge
				:variant="online ? 'success' : 'warning'"
				size="lg"
				role="status"
				data-testid="price-checker-status"
			>
				<span class="size-2 rounded-full bg-current" aria-hidden="true" />
				<span class="hidden sm:inline">{{ online ? __("Online") : __("Offline") }}</span>
			</Badge>
		</header>

		<main class="flex min-h-0 flex-1 flex-col items-center gap-4 overflow-y-auto px-1 py-2 sm:gap-6">
			<div class="relative w-full max-w-4xl shrink-0">
				<ScanBarcode
					class="pointer-events-none absolute inset-s-5 top-1/2 size-6 -translate-y-1/2 text-muted-foreground"
					aria-hidden="true"
				/>
				<input
					ref="scanRef"
					v-model="scanValue"
					type="text"
					inputmode="none"
					autocomplete="off"
					autocapitalize="off"
					spellcheck="false"
					:placeholder="__('Scan a barcode to check the price…')"
					:aria-label="__('Barcode')"
					data-testid="price-checker-input"
					class="h-16 w-full rounded-2xl border-2 border-input bg-surface-raised ps-15 pe-14 text-xl text-foreground shadow-inset outline-none transition-[border-color,box-shadow] duration-fast placeholder:text-muted-foreground focus:border-primary focus:ring-4 focus:ring-focus/25 sm:h-20 sm:text-2xl"
					@keydown.enter.prevent="doLookup(scanValue)"
				/>
				<button
					v-if="scanValue"
					type="button"
					:aria-label="__('Clear')"
					class="absolute inset-e-3 top-1/2 flex size-10 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
					@click="scanValue = ''"
				>
					<X class="size-5" aria-hidden="true" />
				</button>
			</div>

			<div class="flex min-h-0 w-full max-w-7xl flex-1 items-center justify-center">
				<div
					v-if="stage === 'idle'"
					class="flex flex-col items-center gap-3 text-center"
					data-testid="price-checker-idle"
				>
					<div
						class="flex size-20 items-center justify-center rounded-2xl bg-accent text-accent-foreground shadow-raised"
						aria-hidden="true"
					>
						<ScanBarcode class="size-10" />
					</div>
					<h2 class="text-2xl font-bold">{{ __("Scan a barcode to see its price") }}</h2>
					<p class="text-muted-foreground">
						{{ __("Hold the item's barcode under the scanner.") }}
					</p>
				</div>

				<div
					v-else-if="stage === 'notfound'"
					class="flex w-full max-w-xl flex-col items-center gap-3 rounded-2xl border border-destructive/30 bg-destructive-soft p-8 text-center text-destructive-soft-foreground"
					role="alert"
					data-testid="price-checker-notfound"
				>
					<SearchX class="size-12" aria-hidden="true" />
					<h2 class="text-2xl font-bold">{{ __("Barcode not recognised") }}</h2>
					<p>
						{{
							__('"{0}" isn\'t registered. Please scan again or ask a team member.', [
								lastQuery,
							])
						}}
					</p>
				</div>

				<article
					v-else-if="stage === 'found' && item"
					class="grid w-full animate-[pop_.18s_ease-out] grid-cols-1 items-start gap-6 lg:gap-10 rounded-2xl border border-border bg-surface-raised p-5 shadow-raised sm:grid-cols-[14rem_1fr] lg:grid-cols-[18rem_1fr] sm:p-8 lg:p-10"
					data-testid="price-checker-result"
				>
					<div
						class="grid aspect-square w-full max-w-56 lg:max-w-72 place-items-center justify-self-center overflow-hidden rounded-xl border border-border bg-surface-sunken shadow-inset"
					>
						<img
							v-if="item.image && !imageFailed"
							:src="item.image"
							alt=""
							class="size-full object-cover"
							@error="imageFailed = true"
						/>
						<Package v-else class="size-16 text-muted-foreground" aria-hidden="true" />
					</div>

					<div
						class="flex min-w-0 flex-col items-center gap-2 text-center sm:items-start sm:text-start"
					>
						<Badge v-if="item.item_group" variant="info" size="lg">{{ item.item_group }}</Badge>
						<h2 class="wrap-break-word text-3xl font-extrabold leading-tight sm:text-4xl">
							{{ item.item_name }}
						</h2>
						<p
							v-if="item.local_item_name && item.local_item_name !== item.item_name"
							class="text-lg text-muted-foreground"
						>
							{{ item.local_item_name }}
						</p>
						<p class="font-mono text-sm text-muted-foreground">
							{{ __("Code") }}: {{ item.item_code }}
						</p>
						<p
							v-if="item.description"
							class="wrap-break-word whitespace-pre-line text-base leading-relaxed text-muted-foreground"
						>
							{{ item.description }}
						</p>

						<div class="mt-2 flex flex-wrap items-baseline justify-center gap-3 sm:justify-start">
							<template v-if="item.has_price">
								<span
									class="text-5xl font-extrabold tabular-nums tracking-tight text-primary sm:text-6xl"
									data-testid="price-checker-price"
								>
									{{ money(item.symbol, item.rate) }}
								</span>
								<span class="text-base text-muted-foreground">{{
									__("per {0}", [item.uom])
								}}</span>
							</template>
							<Badge v-else variant="warning" size="lg" class="text-base">
								{{ __("Price on request") }}
							</Badge>
						</div>

						<div
							v-if="item.is_stock_item"
							class="mt-2 flex flex-wrap justify-center gap-2 sm:justify-start"
						>
							<Badge v-if="item.in_stock" variant="success" size="lg">
								<CircleCheck class="size-4" aria-hidden="true" />
								{{ __("In Stock") }}
							</Badge>
							<Badge v-else variant="destructive" size="lg">
								<CircleX class="size-4" aria-hidden="true" />
								{{ __("Out of stock") }}
							</Badge>
						</div>
					</div>
				</article>
			</div>
		</main>

		<footer class="flex-none text-center text-xs text-muted-foreground">
			{{ __("Barcode scanner ready · the last result stays until the next scan") }}
		</footer>
	</div>
</template>

<script setup>
import { call } from "@/services/api";
import { formatFor } from "@/composables/useCurrency";
import { ref, reactive, watch, onMounted, onBeforeUnmount, nextTick } from "vue";
import __ from "@/lib/translate";
import { CircleCheck, CircleX, Package, ScanBarcode, SearchX, X } from "lucide-vue-next";
import { XposLogo } from "@/components/ui/brand";
import { Badge } from "@/components/ui/badge";
import { Select } from "@/components/ui/select";

const props = defineProps({
	appName: { type: String, default: "X POS" },
	csrfToken: { type: String, default: "" },
	lang: { type: String, default: "en" },
	dir: { type: String, default: "ltr" },
});

const scanRef = ref(null);
const scanValue = ref("");
const stage = ref("idle");
const item = reactive({});
const lastQuery = ref("");
const imageFailed = ref(false);
const online = ref(navigator.onLine);
const profiles = ref([]);
const posProfile = ref(null);

function money(sym, val) {
	const n = formatFor(item.currency, Number(val || 0));
	return (sym || "") + " " + n;
}

async function doLookup(raw) {
	const q = (raw || "").trim();
	if (!q) return;
	lastQuery.value = q;
	try {
		const params = { barcode: q };
		if (posProfile.value) params.pos_profile = posProfile.value;
		const d = await call("xpos.api.price_check.lookup", params);
		if (d.item_code) {
			Object.assign(item, d);
			imageFailed.value = false;
			stage.value = "found";
		} else {
			stage.value = "notfound";
		}
	} catch (e) {
		stage.value = "notfound";
	}
	scanValue.value = "";
}

function focusScan(e) {
	// Let the profile picker (header and its popup list) keep focus while it is used.
	const t = e?.target;
	if (t?.closest?.("header") || t?.closest?.("[role=listbox]")) return;
	scanRef.value?.focus();
}

function setOnline() {
	online.value = navigator.onLine;
}

watch(posProfile, () => nextTick(() => scanRef.value?.focus()));

onMounted(async () => {
	document.addEventListener("click", focusScan);
	window.addEventListener("focus", focusScan);
	window.addEventListener("online", setOnline);
	window.addEventListener("offline", setOnline);

	try {
		const ctx = await call("xpos.api.price_check.get_terminal_context", {});
		const list = (ctx && ctx.pos_profiles) || [];
		profiles.value = list;
		if (list.length >= 1) posProfile.value = list[0].name;
	} catch (e) {
		/* fall back to system defaults */
	}

	await nextTick();
	focusScan();
});

onBeforeUnmount(() => {
	document.removeEventListener("click", focusScan);
	window.removeEventListener("focus", focusScan);
	window.removeEventListener("online", setOnline);
	window.removeEventListener("offline", setOnline);
});
</script>

<style scoped>
@keyframes pop {
	from {
		opacity: 0;
		transform: translateY(10px) scale(0.99);
	}

	to {
		opacity: 1;
		transform: none;
	}
}
</style>
