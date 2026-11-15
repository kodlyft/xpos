<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { onBeforeRouteLeave } from "vue-router";
import {
	ArrowLeft,
	ArrowRightLeft,
	FileCheck2,
	Loader2,
	PackageCheck,
	RefreshCw,
	RotateCcw,
	ScanBarcode,
	Search,
	Send,
	Save,
	WifiOff,
	ChevronRight,
} from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DateTimePicker } from "@/components/ui/datetime-picker";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/state";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import ReceivingLines from "@/components/receiving/ReceivingLines.vue";
import { useReceivingStore } from "@/stores/receivingStore";
import { useMoney } from "@/composables/useMoney";
import { toast } from "@/services/toast";
import { receiptIssues } from "@/services/receivingRules";
import __ from "@/lib/translate";

const store = useReceivingStore();
const { money, qty: fmtQty, percent } = useMoney();

const scan = ref("");
const scanInput = ref<HTMLInputElement | null>(null);
const search = ref("");
const leaveOpen = ref(false);
const pendingLeave = ref<null | (() => void)>(null);
const confirmClear = ref(false);
const confirmBack = ref(false);
let searchTimer: ReturnType<typeof setTimeout> | null = null;

const issues = computed(() => receiptIssues(store.lines));
const blockedReason = computed(() => {
	if (!store.online)
		return __("You are offline. Receiving needs a connection, nothing can be saved or submitted.");
	return "";
});
const returnsOnly = computed(() => store.totalQty === 0 && store.totalReturn > 0);
const canSaveDraft = computed(
	() => store.canDraft && !store.saving && !blockedReason.value && !issues.value.length && !store.draftDoc,
);
const canSubmit = computed(
	() =>
		store.canSubmit &&
		!store.saving &&
		!blockedReason.value &&
		!returnsOnly.value &&
		(store.draftDoc ? !store.dirty : !issues.value.length),
);
const needsLeaveGuard = computed(() => !!store.transfer && store.dirty);

function formatDate(d: string): string {
	return d ? new Date(d).toLocaleDateString() : "";
}

function onSearch(): void {
	if (searchTimer) clearTimeout(searchTimer);
	searchTimer = setTimeout(() => store.loadList(search.value.trim()), 250);
}

function focusScan(): void {
	nextTick(() => scanInput.value?.focus());
}

async function open(name: string): Promise<void> {
	if (await store.openTransfer(name)) focusScan();
}

function back(): void {
	if (store.dirty) {
		confirmBack.value = true;
		return;
	}
	closeAndRefresh();
}

function closeAndRefresh(): void {
	confirmBack.value = false;
	store.closeTransfer();
	store.loadList(search.value.trim());
}

async function onScanEnter(): Promise<void> {
	const code = scan.value.trim();
	scan.value = "";
	if (code) {
		try {
			const itemCode = await store.lookupItem(code);
			const result = itemCode ? store.countScan(itemCode) : "unknown";
			if (result === "unknown")
				toast.error(__("No item matches {0}.").replace("{0}", code), { id: "receiving-scan" });
			else if (result === "missing")
				toast.error(__("{0} is not on this transfer.").replace("{0}", itemCode ?? code), {
					id: "receiving-scan",
				});
			else if (result === "full")
				toast.warning(__("{0}: nothing more is in transit.").replace("{0}", itemCode ?? code), {
					id: "receiving-scan",
				});
		} catch (e) {
			toast.error(e instanceof Error ? e.message : String(e), { id: "receiving-scan" });
		}
	}
	focusScan();
}

async function run(action: "draft" | "submit"): Promise<void> {
	if (store.draftDoc && action === "submit") await store.submitDraft();
	else await store.save(action);
	if (!store.transfer) await store.loadList(search.value.trim());
	else focusScan();
}

function onOnline(): void {
	store.setOnline(true);
}
function onOffline(): void {
	store.setOnline(false);
}
function onBeforeUnload(e: BeforeUnloadEvent): void {
	if (needsLeaveGuard.value) {
		e.preventDefault();
		e.returnValue = "";
	}
}

onBeforeRouteLeave((_to, _from, next) => {
	if (!needsLeaveGuard.value) return next();
	pendingLeave.value = () => next();
	leaveOpen.value = true;
	next(false);
});

function leaveAnyway(): void {
	const go = pendingLeave.value;
	leaveOpen.value = false;
	store.dirty = false;
	go?.();
}

onMounted(async () => {
	window.addEventListener("online", onOnline);
	window.addEventListener("offline", onOffline);
	window.addEventListener("beforeunload", onBeforeUnload);
	await store.loadSetup();
	if (store.setupError) return;
	if (store.restore()) {
		toast.info(__("Your unsaved receiving work was restored."), { id: "receiving-restored" });
		if (store.uncertain) await store.reconcile().catch(() => undefined);
		focusScan();
	}
	await store.loadList();
});

onBeforeUnmount(() => {
	window.removeEventListener("online", onOnline);
	window.removeEventListener("offline", onOffline);
	window.removeEventListener("beforeunload", onBeforeUnload);
	if (searchTimer) clearTimeout(searchTimer);
});
</script>

<template>
	<div class="flex h-full min-h-0 flex-col overflow-hidden">
		<h1 class="sr-only">{{ __("Stock Receiving") }}</h1>
		<LoadingState v-if="store.loadingSetup && !store.setup" class="m-auto" />
		<ErrorState
			v-else-if="store.setupError"
			:title="__('Stock receiving is not available')"
			:description="store.setupError"
			retryable
			class="m-auto"
			@retry="store.loadSetup()"
		/>

		<template v-else-if="store.setup">
			<div
				v-if="!store.online"
				role="status"
				class="mx-3 mt-3 flex items-center gap-2 rounded-xl border border-warning/30 bg-warning-soft px-4 py-2 text-sm text-warning"
			>
				<WifiOff class="size-4 shrink-0" />
				{{
					__(
						"You are offline. Stock receiving is online-only; your entries are kept on this device.",
					)
				}}
			</div>

			<div v-if="!store.transfer" class="flex min-h-0 flex-1 p-3">
				<section
					class="flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border bg-card/50 shadow-raised"
					:aria-label="__('In-transit stock')"
				>
					<div class="flex shrink-0 items-center gap-2 p-3 pb-1.5">
						<div
							class="relative flex h-12 min-w-0 flex-1 items-center rounded-xl border border-border bg-card shadow-inset transition-[border-color,box-shadow] duration-fast focus-within:border-primary focus-within:ring-4 focus-within:ring-primary/12"
						>
							<Search
								class="pointer-events-none absolute inset-s-3.5 size-5 text-muted-foreground"
								aria-hidden="true"
							/>
							<input
								v-model="search"
								type="text"
								autocomplete="off"
								enterkeyhint="search"
								class="h-full w-full min-w-0 bg-transparent ps-11 pe-4 text-base text-foreground placeholder:text-muted-foreground focus:outline-none"
								:placeholder="__('Search transfers...')"
								:aria-label="__('Search transfers')"
								@input="onSearch"
							/>
						</div>
						<Button
							variant="outline"
							size="icon"
							class="size-12 shrink-0 rounded-xl"
							:aria-label="__('Refresh')"
							:disabled="store.loadingList"
							@click="store.loadList(search.trim())"
						>
							<RefreshCw :class="{ 'animate-spin': store.loadingList }" />
						</Button>
					</div>

					<ScrollArea class="min-h-0 flex-1">
						<LoadingState
							v-if="store.loadingList && !store.transfers.length && !store.drafts.length"
							class="py-16"
						/>
						<ErrorState
							v-else-if="store.listError"
							:title="__('Could not load in-transit stock')"
							:description="store.listError"
							retryable
							@retry="store.loadList(search.trim())"
						/>
						<EmptyState
							v-else-if="!store.transfers.length && !store.drafts.length"
							:icon="ArrowRightLeft"
							:title="__('No in-transit stock')"
							:description="__('No material transfers are waiting to be received here.')"
						/>
						<template v-else>
							<div v-if="store.drafts.length" class="p-3 pb-0">
								<h2
									class="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
								>
									{{ __("Saved drafts") }}
								</h2>
								<ul
									class="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card shadow-raised"
								>
									<li
										v-for="d in store.drafts"
										:key="d.name"
										class="flex items-center gap-3 px-4 py-3"
									>
										<FileCheck2 class="size-5 shrink-0 text-info" />
										<div class="min-w-0 flex-1">
											<p class="truncate text-sm font-semibold">{{ d.name }}</p>
											<p class="truncate text-xs text-muted-foreground">
												{{ d.outgoing_stock_entry }} ·
												{{ formatDate(d.posting_date) }}
											</p>
										</div>
										<Button
											size="sm"
											:disabled="!store.canSubmit || store.saving || !store.online"
											@click="store.submitDraft(d.name)"
										>
											<Send />{{ __("Submit") }}
										</Button>
									</li>
								</ul>
							</div>

							<div class="p-3">
								<h2
									class="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
								>
									{{ __("Awaiting receipt") }}
								</h2>
								<ul
									class="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card shadow-raised"
								>
									<li v-for="t in store.transfers" :key="t.name">
										<button
											type="button"
											class="flex w-full items-center gap-3 px-4 py-3 text-start transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
											:disabled="store.loadingTransfer"
											@click="open(t.name)"
										>
											<span
												class="flex size-10 shrink-0 items-center justify-center rounded-full bg-info-soft"
											>
												<ArrowRightLeft class="size-5 text-info" />
											</span>
											<span class="min-w-0 flex-1">
												<span class="flex items-center justify-between gap-2">
													<span
														class="truncate text-sm font-semibold text-foreground"
														>{{ t.name }}</span
													>
													<Badge variant="secondary" class="shrink-0">
														{{
															t.open_rows === 1
																? __("1 item")
																: __("{0} items").replace(
																		"{0}",
																		String(t.open_rows),
																	)
														}}
													</Badge>
												</span>
												<span class="block truncate text-sm text-muted-foreground">
													{{ t.from_warehouse }} → {{ t.destination }}
												</span>
												<span
													class="mt-0.5 flex items-center gap-3 text-xs text-muted-foreground"
												>
													<span>{{ formatDate(t.posting_date) }}</span>
													<span class="tabular-nums"
														>{{ fmtQty(t.pending_qty) }}
														{{ __("in transit") }}</span
													>
													<span class="tabular-nums"
														>{{ percent(t.per_transferred, 0) }}
														{{ __("received") }}</span
													>
												</span>
											</span>
											<ChevronRight
												class="size-4 shrink-0 text-muted-foreground rtl:rotate-180"
											/>
										</button>
									</li>
								</ul>
							</div>
						</template>
					</ScrollArea>
				</section>
			</div>

			<div
				v-else
				class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 pb-24 lg:flex-row lg:overflow-hidden lg:pb-3"
			>
				<section
					class="flex min-h-96 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border bg-card/50 shadow-raised"
					:aria-label="__('Items to receive')"
				>
					<div class="shrink-0 space-y-2 p-3 pb-1.5">
						<div class="flex items-center gap-2">
							<Button
								variant="outline"
								size="icon"
								class="size-12 shrink-0 rounded-xl"
								:aria-label="__('Back to the list')"
								@click="back"
							>
								<ArrowLeft class="rtl:rotate-180" />
							</Button>
							<div class="min-w-0 flex-1">
								<p class="truncate text-base font-semibold text-foreground">
									{{ store.transfer.name }}
								</p>
								<p class="truncate text-xs text-muted-foreground">
									{{ store.transfer.from_warehouse }} → {{ store.transfer.destination }} ·
									{{ percent(store.transfer.per_transferred, 0) }} {{ __("received") }}
								</p>
							</div>
						</div>
						<div
							class="relative flex h-12 items-center rounded-xl border border-border bg-card shadow-inset transition-[border-color,box-shadow] duration-fast focus-within:border-primary focus-within:ring-4 focus-within:ring-primary/12"
						>
							<ScanBarcode
								class="pointer-events-none absolute inset-s-3.5 size-5 text-muted-foreground"
								aria-hidden="true"
							/>
							<input
								ref="scanInput"
								v-model="scan"
								type="text"
								autocomplete="off"
								enterkeyhint="done"
								data-testid="receiving-scan"
								class="h-full w-full min-w-0 bg-transparent ps-11 pe-4 text-base text-foreground placeholder:text-muted-foreground focus:outline-none"
								:placeholder="__('Scan a barcode or type an item code...')"
								:aria-label="__('Scan barcode')"
								@keydown.enter.prevent="onScanEnter"
							/>
						</div>
					</div>
					<ScrollArea class="min-h-0 flex-1">
						<LoadingState v-if="store.loadingTransfer" class="py-12" />
						<ReceivingLines
							v-else
							:lines="store.lines"
							:show-rates="store.seeRates"
							:disabled="store.saving"
							@change="store.touch()"
						/>
					</ScrollArea>
				</section>

				<section
					class="flex min-w-0 flex-none flex-col overflow-hidden rounded-2xl border border-border bg-card/50 shadow-raised lg:w-104"
					:aria-label="__('Receipt details')"
				>
					<div class="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
						<div>
							<p class="mb-1 text-xs font-medium text-muted-foreground">
								{{ __("Receiving at") }}
							</p>
							<p
								class="flex h-control items-center rounded-lg border border-border bg-muted px-3 text-sm font-medium text-foreground"
							>
								{{ store.transfer.destination }}
							</p>
						</div>
						<div>
							<label class="mb-1 block text-xs font-medium text-muted-foreground">{{
								__("Received on")
							}}</label>
							<DateTimePicker
								v-model="store.header.posting_date"
								mode="date"
								:clearable="false"
								:max-date="new Date().toISOString().slice(0, 10)"
								@change="store.touch()"
							/>
						</div>
						<div>
							<label class="mb-1 block text-xs font-medium text-muted-foreground">{{
								__("Remarks")
							}}</label>
							<Input
								v-model="store.header.remarks"
								:placeholder="__('e.g. missing or damaged items')"
								@input="store.touch()"
							/>
						</div>
					</div>

					<div class="shrink-0 space-y-2 border-t border-border bg-card p-3">
						<div
							v-if="store.draftDoc"
							role="status"
							class="flex items-center gap-2 rounded-lg border border-info/30 bg-info-soft px-3 py-2 text-sm text-info"
						>
							<FileCheck2 class="size-4 shrink-0" />
							<span>{{
								__(
									"{0} is saved as a draft. No stock has moved until it is submitted.",
								).replace("{0}", store.draftDoc.name)
							}}</span>
						</div>
						<div
							v-if="store.uncertain"
							role="alert"
							class="rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-warning"
						>
							{{
								__(
									"The last save got no answer. Saving again first checks with the server, so it cannot be made twice.",
								)
							}}
						</div>
						<p v-if="blockedReason" class="text-xs text-muted-foreground">{{ blockedReason }}</p>
						<p v-else-if="issues.length && !returnsOnly" class="text-xs text-destructive">
							{{ issues[0] }}
						</p>

						<dl class="grid grid-cols-3 gap-2 text-sm">
							<div>
								<dt class="text-xs text-muted-foreground">{{ __("Receiving") }}</dt>
								<dd class="font-semibold tabular-nums">{{ fmtQty(store.totalQty) }}</dd>
							</div>
							<div>
								<dt class="text-xs text-muted-foreground">{{ __("Returning") }}</dt>
								<dd class="font-semibold tabular-nums">{{ fmtQty(store.totalReturn) }}</dd>
							</div>
							<div v-if="store.seeRates">
								<dt class="text-xs text-muted-foreground">{{ __("Value") }}</dt>
								<dd class="font-semibold tabular-nums">{{ money(store.totalAmount) }}</dd>
							</div>
						</dl>

						<button
							v-if="!returnsOnly"
							type="button"
							class="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 text-base font-semibold text-primary-foreground shadow-primary transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-55 disabled:shadow-none"
							:disabled="!canSubmit"
							:aria-busy="store.saving"
							data-testid="receiving-submit"
							@click="run('submit')"
						>
							<Loader2 v-if="store.saving" class="size-5 animate-spin" /><PackageCheck
								v-else
								class="size-5"
							/>
							{{ store.draftDoc ? __("Submit draft") : __("Receive stock") }}
						</button>
						<button
							v-else
							type="button"
							class="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 text-base font-semibold text-primary-foreground shadow-primary transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-55 disabled:shadow-none"
							:disabled="store.saving || !store.canSubmit || !store.online"
							@click="store.returnShortage()"
						>
							<Send class="size-5" />{{ __("Return to source") }}
						</button>
						<div class="flex gap-2">
							<Button
								variant="outline"
								class="h-11 flex-1 rounded-xl"
								:disabled="!canSaveDraft"
								data-testid="receiving-draft"
								@click="run('draft')"
							>
								<Save />{{ __("Save draft") }}
							</Button>
							<Button
								variant="ghost"
								class="h-11 rounded-xl"
								:disabled="store.saving"
								@click="confirmClear = true"
							>
								<RotateCcw />{{ __("Reset") }}
							</Button>
						</div>
					</div>
				</section>
			</div>
		</template>

		<Dialog v-model:open="leaveOpen">
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{{ __("Leave without saving?") }}</DialogTitle>
					<DialogDescription>
						{{
							__(
								"This receipt has not been saved. It is kept on this device, but no document exists yet.",
							)
						}}
					</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button variant="outline" @click="leaveOpen = false">{{ __("Keep working") }}</Button>
					<Button variant="destructive" @click="leaveAnyway">{{ __("Leave") }}</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>

		<Dialog v-model:open="confirmBack">
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{{ __("Go back to the list?") }}</DialogTitle>
					<DialogDescription>{{
						__("What you entered for this transfer is discarded.")
					}}</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button variant="outline" @click="confirmBack = false">{{ __("Keep working") }}</Button>
					<Button variant="destructive" @click="closeAndRefresh">{{
						__("Discard and go back")
					}}</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>

		<Dialog v-model:open="confirmClear">
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{{ __("Reset the quantities?") }}</DialogTitle>
					<DialogDescription>{{
						__(
							"Quantities go back to everything in transit. A saved draft document is not deleted.",
						)
					}}</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button variant="outline" @click="confirmClear = false">{{ __("Cancel") }}</Button>
					<Button
						variant="destructive"
						@click="
							store.openTransfer(store.transfer!.name);
							confirmClear = false;
						"
						>{{ __("Reset") }}</Button
					>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	</div>
</template>
