<script setup lang="ts">
import { onMounted, ref } from "vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { CatalogScopeInfo, CatalogStats, PrinterCapabilities, ScannerCapabilities } from "@mobile/ports";
import { isCleartext } from "@mobile/domain/origin";
import { fingerprintOf } from "@mobile/db/model";
import { ALL_MODELS } from "@mobile/db/models";
import { ALL_STEPS } from "@mobile/db/steps";
import {
	getContainer,
	getLifecycle,
	lock,
	refreshCatalog,
	signOut,
	useApp,
} from "@mobile/composables/useApp";

const { state } = useApp();
const fingerprint = fingerprintOf(
	ALL_MODELS,
	ALL_STEPS.map((x) => x.id),
);
const c = getContainer();
const scopes = ref<(CatalogScopeInfo & { stats: CatalogStats })[]>([]);
const lease = ref<{ status: string; remainingMs: number } | null>(null);
const salesByStatus = ref<Record<string, number>>({});
const storage = ref("unknown");
const scanners = ref<ScannerCapabilities[]>([]);
const printers = ref<PrinterCapabilities[]>([]);

async function refresh() {
	const list = await c.catalog.listScopes();
	scopes.value = await Promise.all(
		list.map(async (s) => ({ ...s, stats: await c.catalog.stats(s.scopeId) })),
	);
	lease.value = await c.auth.leaseStatus();
	const counts: Record<string, number> = {};
	for (const sale of await c.transactions.listSales(
		["captured", "posting", "posted", "reprice", "uncertain", "held", "rejected", "fiscal_pending"],
		200,
	))
		counts[sale.status] = (counts[sale.status] ?? 0) + 1;
	salesByStatus.value = counts;
	scanners.value = c.scanner.capabilities();
	printers.value = c.printer.capabilities();
	try {
		const e = await navigator.storage?.estimate?.();
		if (e?.usage !== undefined)
			storage.value = `${(e.usage / 2 ** 20).toFixed(1)} MiB used${e.quota ? ` of ${(e.quota / 2 ** 20).toFixed(0)} MiB` : ""} (browser/WebView estimate)`;
	} catch {
		/* unavailable */
	}
}
onMounted(refresh);
const hours = (ms: number) => `${(ms / 3_600_000).toFixed(1)} h`;
</script>

<template>
	<div class="pad-safe-x mx-auto flex max-w-3xl flex-col gap-4 py-4">
		<h1 class="text-xl font-bold">Device &amp; storage diagnostics</h1>

		<section class="rounded-2xl border border-border bg-card p-4 shadow-raised" aria-labelledby="d-impl">
			<h2 id="d-impl" class="mb-2 font-semibold">Implementation in use</h2>
			<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
				<dt class="text-muted-foreground">Catalog store</dt>
				<dd>{{ c.catalog.kind }}</dd>
				<dt class="text-muted-foreground">Transactions</dt>
				<dd>{{ c.transactions.kind }}</dd>
				<dt class="text-muted-foreground">Schema</dt>
				<dd>{{ ALL_MODELS.length }} tables, checked at startup ({{ fingerprint }})</dd>
				<dt class="text-muted-foreground">Server</dt>
				<dd class="break-all">
					{{ state.cashier?.site ?? state.origin ?? "n/a"
					}}{{ isCleartext(state.cashier?.site ?? state.origin) ? " (not encrypted)" : "" }}
				</dd>
				<dt class="text-muted-foreground">Cashier</dt>
				<dd>{{ state.cashier?.user ?? "n/a" }}</dd>
				<dt class="text-muted-foreground">Connectivity</dt>
				<dd>{{ getLifecycle().isOnline() ? "online" : "offline" }}</dd>
				<dt class="text-muted-foreground">Storage</dt>
				<dd>{{ storage }}</dd>
				<dt class="text-muted-foreground">Platform</dt>
				<dd>
					{{
						state.kind === "native"
							? "Android app (native SQLite, Keystore)"
							: "Browser development (not Keystore-secured)"
					}}
				</dd>
				<dt class="text-muted-foreground">ERPNext / Frappe</dt>
				<dd>
					{{ state.context.erpnextVersion ?? "ERPNext version not reported" }} /
					{{ state.context.frappeVersion || "unknown" }}
				</dd>
				<dt class="text-muted-foreground">POS Profile</dt>
				<dd>
					{{ state.cashier?.profile }} · {{ state.context.company }} ·
					{{ state.context.warehouse }} ·
					{{ state.context.priceList ?? "no price list" }}
				</dd>
				<dt class="text-muted-foreground">Shift</dt>
				<dd>{{ state.context.openShift ?? "none open" }}</dd>
				<dt v-if="state.kind === 'native'" class="text-muted-foreground">Application ID</dt>
				<dd v-if="state.kind === 'native'">
					com.kodlyft.xpos.mobile.dev (provisional; finalize before Play)
				</dd>
			</dl>
		</section>

		<section class="rounded-2xl border border-border bg-card p-4 shadow-raised" aria-labelledby="d-lease">
			<h2 id="d-lease" class="mb-2 font-semibold">Offline authorization</h2>
			<p v-if="lease" class="text-sm">
				<Badge :variant="lease.status === 'valid' ? 'success' : 'destructive'">{{
					lease.status
				}}</Badge>
				{{ hours(lease.remainingMs) }} remaining. New sales
				{{ lease.status === "valid" ? "are allowed" : "are blocked; queued data is kept" }}.
			</p>
			<p v-else class="text-sm text-muted-foreground">No lease (not enrolled).</p>
			<p class="mt-2 text-xs text-muted-foreground">
				Local unlock never renews ERPNext authorization; permissions are re-checked by the server
				before anything is posted.
			</p>
		</section>

		<section class="rounded-2xl border border-border bg-card p-4 shadow-raised" aria-labelledby="d-cat">
			<h2 id="d-cat" class="mb-2 font-semibold">Catalog</h2>
			<p class="mb-1 text-sm font-medium tabular-nums">
				{{ state.catalog.items.toLocaleString() }}
				<template v-if="state.catalog.total > state.catalog.items"
					>of {{ state.catalog.total.toLocaleString() }}</template
				>
				items on this device
			</p>
			<p class="mb-2 text-sm" role="status">
				<template v-if="state.catalog.syncing"
					>Downloading: {{ state.catalog.downloaded.toLocaleString() }} of
					{{ state.catalog.total.toLocaleString() }} items</template
				>
				<template v-else-if="state.catalog.syncedAt"
					>Last successful refresh {{ new Date(state.catalog.syncedAt).toLocaleString() }} ({{
						state.catalog.lastMode === "delta" ? "changes only" : "full download"
					}})</template
				>
				<template v-else>Not refreshed in this session</template>
				<template v-if="state.catalog.unpriced">
					· {{ state.catalog.unpriced }} items have no price and cannot be sold</template
				>
				<template v-if="state.catalog.skippedBarcodes">
					· {{ state.catalog.skippedBarcodes }} barcodes skipped (sold in a unit the app cannot
					price yet; scanning them reports "not found")</template
				>
			</p>
			<Button
				variant="outline"
				class="mb-3 h-11"
				:loading="state.catalog.syncing"
				@click="refreshCatalog"
				>Refresh catalog now</Button
			>
			<ul class="flex flex-col gap-2 text-sm">
				<li v-for="s in scopes" :key="s.scopeId" class="rounded-md border border-border p-2">
					<p class="font-medium">
						{{ s.scopeId }}
					</p>
					<p class="text-muted-foreground">
						{{ s.stats.items.toLocaleString() }} items ·
						{{ s.stats.barcodes.toLocaleString() }} barcodes · generation
						{{ s.activeGen ?? "none" }} · {{ s.currency }} ({{ s.minorDigits }} minor digits)
					</p>
				</li>
				<li v-if="!scopes.length" class="text-muted-foreground">No scopes yet.</li>
			</ul>
		</section>

		<section class="rounded-2xl border border-border bg-card p-4 shadow-raised" aria-labelledby="d-queue">
			<h2 id="d-queue" class="mb-2 font-semibold">Sales &amp; synchronization</h2>
			<p class="text-sm">
				Sales on this device by status:
				{{
					Object.entries(salesByStatus)
						.map(([k, v]) => `${v} ${k.replace("_", " ")}`)
						.join(", ") || "none"
				}}
			</p>
			<p class="mt-1 text-xs text-muted-foreground">
				Sales are sent to ERPNext when you charge, and again whenever the device is back online or the
				app is reopened. Offline selling is switched off: stock, serial/batch and receipt checks still
				need the server. Not implemented yet: background sending while the app is closed, offline
				sales, returns, shift closing, printing.
			</p>
		</section>

		<section class="rounded-2xl border border-border bg-card p-4 shadow-raised" aria-labelledby="d-hw">
			<h2 id="d-hw" class="mb-2 font-semibold">Scanners &amp; printers (capability report)</h2>
			<ul class="flex flex-col gap-2 text-sm">
				<li v-for="s in scanners" :key="s.kind">
					<strong>Scanner · {{ s.kind }}</strong
					>: {{ s.supported ? "available" : "unsupported" }},
					{{ s.tested ? "tested" : "not tested on hardware" }}. {{ s.note }}
				</li>
				<li v-for="p in printers" :key="p.kind">
					<strong>Printer · {{ p.kind }}</strong
					>: {{ p.supported ? "available" : "unsupported" }},
					{{ p.tested ? "tested" : "not tested on hardware" }}. {{ p.note }}
				</li>
			</ul>
			<p class="mt-2 text-xs text-muted-foreground">
				Evaluation candidates (untested): Samsung Galaxy A26 5G, Epson TM-P20II (Bluetooth), Zebra
				DS2278, SUNMI V3 PLUS (Google Play availability varies by configuration).
			</p>
		</section>

		<div class="flex flex-wrap gap-2">
			<Button variant="outline" @click="refresh">Refresh</Button>
			<Button variant="outline" @click="lock('Locked from diagnostics')">Lock now</Button>
			<Button variant="destructive" @click="signOut">Sign out</Button>
		</div>
	</div>
</template>
