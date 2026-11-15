<template>
	<Dialog :open="isOpen" @update:open="handleOpenChange">
		<DialogContent
			class="max-w-xl p-0 gap-0 overflow-hidden"
			:hide-close="true"
			@pointerDownOutside="isOpen = false"
			@escapeKeyDown="isOpen = false"
		>
			<div class="flex items-center border-b border-border px-4">
				<Search class="w-5 h-5 text-muted-foreground shrink-0" />
				<input
					ref="searchInputRef"
					v-model="searchTerm"
					@input="onSearch"
					@keydown.down.prevent="navigateDown"
					@keydown.up.prevent="navigateUp"
					@keydown.enter.prevent="selectHighlighted"
					@keydown.escape.prevent="close"
					:placeholder="__('Search items, pages, actions...')"
					class="flex-1 h-12 px-3 text-sm bg-transparent border-0 outline-none focus:ring-0 text-foreground placeholder:text-muted-foreground"
				/>
				<kbd
					class="hidden sm:inline-flex items-center px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground bg-muted rounded border border-border"
				>
					ESC
				</kbd>
			</div>

			<div ref="resultsContainer" class="max-h-95 overflow-y-auto">
				<div v-if="isSearching" class="flex items-center justify-center py-8">
					<Loader2 class="w-5 h-5 animate-spin text-muted-foreground" />
				</div>

				<div v-else-if="!searchTerm && results.length === 0" class="py-6 px-4">
					<p class="text-sm text-muted-foreground mb-4 text-center">
						{{ __("Start typing to search") }}
					</p>
					<div class="grid grid-cols-2 gap-2 max-w-xs mx-auto">
						<div
							class="flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-muted-foreground bg-muted/50"
						>
							<kbd
								class="px-1.5 py-0.5 text-[10px] font-mono rounded border border-border bg-background"
								>go</kbd
							>
							<span>{{ __("Navigate") }}</span>
						</div>
						<div
							class="flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-muted-foreground bg-muted/50"
						>
							<kbd
								class="px-1.5 py-0.5 text-[10px] font-mono rounded border border-border bg-background"
								>=</kbd
							>
							<span>{{ __("Calculate") }}</span>
						</div>
						<div
							class="flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-muted-foreground bg-muted/50"
						>
							<kbd
								class="px-1.5 py-0.5 text-[10px] font-mono rounded border border-border bg-background"
								>?</kbd
							>
							<span>{{ __("Help") }}</span>
						</div>
						<div
							class="flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-muted-foreground bg-muted/50"
						>
							<kbd
								class="px-1.5 py-0.5 text-[10px] font-mono rounded border border-border bg-background"
								>item</kbd
							>
							<span>{{ __("Search items") }}</span>
						</div>
					</div>
				</div>

				<div
					v-else-if="searchTerm && results.length === 0 && !isSearching"
					class="py-8 text-center text-muted-foreground"
				>
					<Package class="w-10 h-10 mx-auto mb-2 text-muted-foreground/40" />
					<p class="text-sm">{{ __("No results found") }}</p>
				</div>

				<div v-else-if="results.length > 0" class="py-1">
					<template v-for="(group, gi) in groupedResults" :key="group.label">
						<div
							class="px-4 pt-3 pb-1 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider"
						>
							{{ __(group.label) }}
						</div>
						<button
							v-for="item in group.items"
							:key="item.id"
							:data-command-index="item._flatIndex"
							@click="executeResult(item)"
							@mouseenter="highlightedIndex = item._flatIndex!"
							class="w-full flex items-center gap-3 px-4 py-2.5 text-start transition-colors"
							:class="
								item._flatIndex === highlightedIndex
									? 'bg-primary/10 text-foreground'
									: 'text-foreground hover:bg-muted'
							"
						>
							<div
								class="w-8 h-8 rounded-md flex items-center justify-center shrink-0 text-base"
								:class="getResultIconBg(item.type)"
							>
								<component v-if="item.icon" :is="item.icon" class="w-4 h-4" />
								<span v-else>{{ getTypeEmoji(item.type) }}</span>
							</div>
							<div class="flex-1 min-w-0">
								<p class="text-sm font-medium truncate">{{ item.label }}</p>
								<p v-if="item.description" class="text-xs text-muted-foreground truncate">
									{{ item.description }}
								</p>
							</div>
							<div v-if="item.shortcut" class="flex items-center gap-0.5 shrink-0">
								<kbd
									v-for="(k, ki) in item.shortcut.split('+')"
									:key="ki"
									class="px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground bg-muted rounded border border-border"
								>
									{{ k }}
								</kbd>
							</div>
							<div v-if="item.type === 'item'" class="text-end shrink-0">
								<p class="text-sm font-medium text-success">
									{{ money((item.meta as POSItem)?.rate || 0) }}
								</p>
							</div>
						</button>
					</template>
				</div>
			</div>

			<div v-if="showHelp" class="absolute inset-0 bg-background z-10 flex flex-col">
				<div class="flex items-center justify-between px-4 py-3 border-b border-border">
					<h3 class="text-sm font-semibold text-foreground">
						{{ __("Command Search Help") }}
					</h3>
					<button
						@click="showHelp = false"
						class="w-6 h-6 flex items-center justify-center text-muted-foreground rounded hover:bg-muted"
					>
						<X class="w-4 h-4" />
					</button>
				</div>
				<div class="flex-1 overflow-y-auto p-4 space-y-3 text-sm">
					<div class="flex gap-3 items-start">
						<code class="shrink-0 px-2 py-0.5 rounded bg-muted text-xs font-mono">item name</code>
						<span class="text-muted-foreground">{{ __("Search items by name or code") }}</span>
					</div>
					<div class="flex gap-3 items-start">
						<code class="shrink-0 px-2 py-0.5 rounded bg-muted text-xs font-mono">go pos</code>
						<span class="text-muted-foreground">{{
							__("Navigate to a page (pos, orders, reports, expenses...)")
						}}</span>
					</div>
					<div class="flex gap-3 items-start">
						<code class="shrink-0 px-2 py-0.5 rounded bg-muted text-xs font-mono">=55+45</code>
						<span class="text-muted-foreground">{{
							__("Calculator - evaluate math expressions")
						}}</span>
					</div>
					<div class="flex gap-3 items-start">
						<code class="shrink-0 px-2 py-0.5 rounded bg-muted text-xs font-mono">new sale</code>
						<span class="text-muted-foreground">{{
							__("Quick actions: new sale, close shift, etc.")
						}}</span>
					</div>
					<div class="flex gap-3 items-start">
						<code class="shrink-0 px-2 py-0.5 rounded bg-muted text-xs font-mono">?</code>
						<span class="text-muted-foreground">{{ __("Show this help") }}</span>
					</div>
				</div>
			</div>

			<div
				class="flex items-center justify-between px-4 py-2 border-t border-border bg-muted/50 text-xs text-muted-foreground"
			>
				<div class="flex items-center gap-3">
					<span class="flex items-center gap-1">
						<kbd class="px-1 py-0.5 font-mono bg-background rounded border border-border"
							>&uarr;</kbd
						>
						<kbd class="px-1 py-0.5 font-mono bg-background rounded border border-border"
							>&darr;</kbd
						>
						{{ __("navigate") }}
					</span>
					<span class="flex items-center gap-1">
						<kbd class="px-1 py-0.5 font-mono bg-background rounded border border-border"
							>&crarr;</kbd
						>
						{{ __("select") }}
					</span>
				</div>
				<span class="flex items-center gap-1">
					<kbd class="px-1 py-0.5 font-mono bg-background rounded border border-border">esc</kbd>
					{{ __("close") }}
				</span>
			</div>
		</DialogContent>
	</Dialog>
</template>

<script setup lang="ts">
import { commandSearchRequested } from "@/composables/useKeyboardShortcuts";
import { ref, computed, nextTick, onMounted, onUnmounted, type Component } from "vue";
import { useRouter } from "vue-router";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
	Search,
	Package,
	Loader2,
	X,
	LayoutGrid,
	FileText,
	BarChart3,
	ShoppingCart,
	ClipboardList,
	Receipt,
	PackageCheck,
	Wallet,
	Landmark,
	Barcode,
	LogOut,
	Repeat,
	RotateCcw,
	Printer,
	CreditCard,
	Users,
	Pause,
	Calculator,
	HelpCircle,
	Navigation,
	Keyboard,
	Info,
	Sun,
	Moon,
} from "lucide-vue-next";
import { call } from "@/services/api";
import { usePosStore } from "@/stores/posStore";
import { useMoney } from "@/composables/useMoney";
import { useCartStore } from "@/stores/cartStore";
import { useCustomerStore } from "@/stores/customerStore";
import { usePaymentStore } from "@/stores/paymentStore";
import type { POSItem } from "@/types/pos.types";
import __ from "@/lib/translate";

interface CommandResult {
	id: string;
	type: "page" | "action" | "item" | "calculator" | "help";
	label: string;
	description?: string;
	shortcut?: string;
	icon?: Component;
	action?: () => void;
	meta?: POSItem | Record<string, unknown>;
	_flatIndex?: number;
}

interface ResultGroup {
	label: string;
	items: CommandResult[];
}

const props = defineProps<{
	posProfile?: string;
	currencySymbol?: string;
}>();

const emit = defineEmits<{
	selectItem: [item: POSItem];
}>();

const router = useRouter();
const posStore = usePosStore();
const { money } = useMoney();
const cartStore = useCartStore();
const customerStore = useCustomerStore();
const paymentStore = usePaymentStore();

const isOpen = ref(false);
const searchTerm = ref("");
const results = ref<CommandResult[]>([]);
const isSearching = ref(false);
const highlightedIndex = ref(0);
const searchInputRef = ref<HTMLInputElement | null>(null);
const resultsContainer = ref<HTMLElement | null>(null);
const showHelp = ref(false);

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

const pages: CommandResult[] = [
	{
		id: "page-pos",
		type: "page",
		label: __("Point of Sale"),
		description: __("Go to POS screen"),
		shortcut: "Alt+1",
		icon: LayoutGrid,
		action: () => router.push("/pos"),
	},
	{
		id: "page-orders",
		type: "page",
		label: __("Orders"),
		description: __("View sales orders"),
		shortcut: "Alt+2",
		icon: FileText,
		action: () => router.push("/orders"),
	},
	{
		id: "page-reports",
		type: "page",
		label: __("Reports"),
		description: __("Browse analytics reports"),
		shortcut: "Alt+9",
		icon: BarChart3,
		action: () => router.push("/reports"),
	},
	{
		id: "page-purchase-order",
		type: "page",
		label: __("Purchase Order"),
		description: __("Create purchase orders"),
		shortcut: "Alt+3",
		icon: ClipboardList,
		action: () => router.push("/purchase-order"),
	},
	{
		id: "page-purchase-invoice",
		type: "page",
		label: __("Purchase Invoice"),
		description: __("View purchase invoices"),
		shortcut: "Alt+4",
		icon: Receipt,
		action: () => router.push("/purchase-invoices"),
	},
	{
		id: "page-stock-receiving",
		type: "page",
		label: __("Stock Receiving"),
		description: __("Receive stock"),
		shortcut: "Alt+5",
		icon: PackageCheck,
		action: () => router.push("/stock-receiving"),
	},
	{
		id: "page-expenses",
		type: "page",
		label: __("Expenses"),
		description: __("Manage expenses"),
		shortcut: "Alt+6",
		icon: Wallet,
		action: () => router.push("/expenses"),
	},
	{
		id: "page-bank-drops",
		type: "page",
		label: __("Bank Drops"),
		description: __("Record bank drops"),
		shortcut: "Alt+7",
		icon: Landmark,
		action: () => router.push("/bank-drops"),
	},
	{
		id: "page-barcode-print",
		type: "page",
		label: __("Barcode Printer"),
		description: __("Print barcode labels"),
		icon: Barcode,
		action: () => router.push("/barcode-print"),
	},
];

const actions: CommandResult[] = [
	{
		id: "act-new-sale",
		type: "action",
		label: __("New Sale"),
		description: __("Clear cart and start new sale"),
		shortcut: "Ctrl+N",
		icon: ShoppingCart,
		action: () => window.dispatchEvent(new CustomEvent("xpos:clear-cart")),
	},
	{
		id: "act-payment",
		type: "action",
		label: __("Process Payment"),
		description: __("Submit current cart"),
		shortcut: "F4",
		icon: CreditCard,
		action: () => window.dispatchEvent(new CustomEvent("xpos:process-payment")),
	},
	{
		id: "act-customer",
		type: "action",
		label: __("Select Customer"),
		description: __("Choose or create customer"),
		shortcut: "F6",
		icon: Users,
		action: () => {
			customerStore.showCustomerDialog = true;
		},
	},
	{
		id: "act-repeat",
		type: "action",
		label: __("Repeat Invoice"),
		description: __("Repeat a previous invoice"),
		shortcut: "Ctrl+G",
		icon: Repeat,
		action: () => window.dispatchEvent(new CustomEvent("xpos:show-repeat-dialog")),
	},
	{
		id: "act-return",
		type: "action",
		label: __("Return Invoice"),
		description: __("Process a return"),
		shortcut: "Ctrl+R",
		icon: RotateCcw,
		action: () => {
			window.dispatchEvent(new CustomEvent("xpos:show-return-dialog"));
		},
	},
	{
		id: "act-print",
		type: "action",
		label: __("Print Last Receipt"),
		description: __("Print last invoice"),
		shortcut: "Ctrl+P",
		icon: Printer,
		action: () => window.dispatchEvent(new CustomEvent("xpos:print-last")),
	},
	{
		id: "act-hold",
		type: "action",
		label: __("Hold Invoice"),
		description: __("Park current invoice as draft"),
		shortcut: "Ctrl+H",
		icon: Pause,
		action: () => window.dispatchEvent(new CustomEvent("xpos:hold-invoice")),
	},
	{
		id: "act-drafts",
		type: "action",
		label: __("Held Invoices"),
		description: __("View held/draft invoices"),
		shortcut: "F8",
		icon: FileText,
		action: () => window.dispatchEvent(new CustomEvent("xpos:show-drafts")),
	},
	{
		id: "act-close-shift",
		type: "action",
		label: __("Close Shift"),
		description: __("Close the current POS shift"),
		shortcut: "Ctrl+Shift+O",
		icon: LogOut,
		action: () => window.dispatchEvent(new CustomEvent("xpos:close-shift")),
	},
	{
		id: "act-expense",
		type: "action",
		label: __("Cash Expense"),
		description: __("Record a POS expense"),
		shortcut: "Ctrl+E",
		icon: Wallet,
		action: () => window.dispatchEvent(new CustomEvent("xpos:cash-expense")),
	},
	{
		id: "act-deposit",
		type: "action",
		label: __("Cash Deposit"),
		description: __("Record a cash deposit"),
		shortcut: "Ctrl+Shift+D",
		icon: Landmark,
		action: () => window.dispatchEvent(new CustomEvent("xpos:cash-deposit")),
	},
	{
		id: "act-shortcuts",
		type: "action",
		label: __("Keyboard Shortcuts"),
		description: __("View all keyboard shortcuts"),
		shortcut: "Ctrl+/",
		icon: Keyboard,
		action: () => window.dispatchEvent(new CustomEvent("xpos:show-shortcuts-dialog")),
	},
	{
		id: "act-about",
		type: "action",
		label: __("About X POS"),
		description: __("Version and system information"),
		icon: Info,
		action: () => window.dispatchEvent(new CustomEvent("xpos:show-about-dialog")),
	},
	{
		id: "act-theme",
		type: "action",
		label: __("Toggle Theme"),
		description: __("Switch between light/dark/system"),
		icon: Sun,
		action: () => {
			const el = document.querySelector<HTMLButtonElement>("[data-theme-toggle]");
			el?.click();
		},
	},
];

const groupedResults = computed<ResultGroup[]>(() => {
	const groups: ResultGroup[] = [];
	let flatIdx = 0;

	const pageResults = results.value.filter((r) => r.type === "page");
	const actionResults = results.value.filter((r) => r.type === "action");
	const itemResults = results.value.filter((r) => r.type === "item");
	const calcResults = results.value.filter((r) => r.type === "calculator");
	const helpResults = results.value.filter((r) => r.type === "help");

	if (calcResults.length > 0) {
		groups.push({
			label: "Calculator",
			items: calcResults.map((r) => ({ ...r, _flatIndex: flatIdx++ })),
		});
	}
	if (actionResults.length > 0) {
		groups.push({
			label: "Actions",
			items: actionResults.map((r) => ({ ...r, _flatIndex: flatIdx++ })),
		});
	}
	if (pageResults.length > 0) {
		groups.push({
			label: "Pages",
			items: pageResults.map((r) => ({ ...r, _flatIndex: flatIdx++ })),
		});
	}
	if (itemResults.length > 0) {
		groups.push({
			label: "Items",
			items: itemResults.map((r) => ({ ...r, _flatIndex: flatIdx++ })),
		});
	}
	if (helpResults.length > 0) {
		groups.push({
			label: "Help",
			items: helpResults.map((r) => ({ ...r, _flatIndex: flatIdx++ })),
		});
	}

	return groups;
});

function getResultIconBg(type: string): string {
	switch (type) {
		case "page":
			return "bg-info-soft text-info";
		case "action":
			return "bg-success-soft text-success";
		case "item":
			return "bg-muted";
		case "calculator":
			return "bg-warning-soft text-warning";
		case "help":
			return "bg-primary/10 text-primary";
		default:
			return "bg-muted";
	}
}

function getTypeEmoji(type: string): string {
	switch (type) {
		case "page":
			return "📄";
		case "action":
			return "⚡";
		case "item":
			return "📦";
		case "calculator":
			return "🔢";
		case "help":
			return "❓";
		default:
			return "📝";
	}
}

function open() {
	isOpen.value = true;
	searchTerm.value = "";
	results.value = [];
	highlightedIndex.value = 0;
	showHelp.value = false;
	nextTick(() => searchInputRef.value?.focus());
}

function close() {
	isOpen.value = false;
	searchTerm.value = "";
	results.value = [];
	showHelp.value = false;
}

function handleOpenChange(open: boolean) {
	if (!open) close();
}

function scoreMatch(text: string, query: string): number {
	const lower = text.toLowerCase();
	const q = query.toLowerCase();
	if (lower === q) return 100;
	if (lower.startsWith(q)) return 80;
	if (lower.includes(q)) return 60;
	// Word-boundary match
	const words = lower.split(/\s+/);
	for (const w of words) {
		if (w.startsWith(q)) return 70;
	}
	return 0;
}

function onSearch() {
	if (debounceTimer) clearTimeout(debounceTimer);

	const term = searchTerm.value.trim();

	// Instant: help
	if (term === "?") {
		showHelp.value = true;
		results.value = [];
		return;
	}
	showHelp.value = false;

	// Instant: calculator
	if (term.startsWith("=") || /^\(?\d+[\d\s+\-*/().%]+/.test(term)) {
		handleCalculator(term);
		return;
	}

	// Build local results immediately (pages + actions)
	const localResults: CommandResult[] = [];
	const query = term.toLowerCase();

	if (query) {
		// "go ..." prefix for page navigation
		const isGoPrefix = query.startsWith("go ");
		const goQuery = isGoPrefix ? query.slice(3).trim() : query;

		for (const page of pages) {
			const score = scoreMatch(page.label, isGoPrefix ? goQuery : query);
			if (score > 0 || (isGoPrefix && goQuery === "")) {
				localResults.push(page);
			}
		}

		// "new ..." prefix for actions
		const isNewPrefix = query.startsWith("new ");
		const newQuery = isNewPrefix ? query.slice(4).trim() : "";

		for (const action of actions) {
			const actionLabel = action.label.toLowerCase();
			if (isNewPrefix) {
				if (!newQuery || actionLabel.includes(newQuery)) {
					localResults.push(action);
				}
			} else {
				const score = scoreMatch(action.label, query);
				if (score > 0) {
					localResults.push(action);
				}
			}
		}
	}

	results.value = localResults;
	highlightedIndex.value = 0;

	// Debounced item search (skip if prefix commands)
	if (query && !query.startsWith("go ") && !query.startsWith("=") && query !== "?") {
		debounceTimer = setTimeout(() => fetchItems(query), 250);
	}
}

function handleCalculator(term: string) {
	const expr = term.startsWith("=") ? term.slice(1) : term;
	try {
		// Safe evaluation - only allow math operations
		const sanitized = expr.replace(/[^0-9+\-*/().%\s]/g, "");
		if (!sanitized.trim()) {
			results.value = [];
			return;
		}
		const calcResult = Function(`"use strict"; return (${sanitized})`)();
		if (typeof calcResult === "number" && isFinite(calcResult)) {
			results.value = [
				{
					id: "calc-result",
					type: "calculator",
					label: `${expr} = ${calcResult}`,
					description: __("Press Enter to copy result"),
					icon: Calculator,
					action: () => {
						navigator.clipboard?.writeText(String(calcResult));
					},
				},
			];
			highlightedIndex.value = 0;
		} else {
			results.value = [];
		}
	} catch {
		results.value = [];
	}
}

async function fetchItems(query: string) {
	isSearching.value = true;
	try {
		const result = await call<POSItem[]>("xpos.api.items.get_pos_items", {
			pos_profile: props.posProfile,
			search_term: query,
			start: 0,
			page_length: 10,
		});
		if (result && result.length > 0) {
			const itemResults: CommandResult[] = result.map((item, i) => ({
				id: `item-${item.item_code}`,
				type: "item" as const,
				label: item.item_name,
				description: item.item_code,
				icon: Package,
				meta: item,
				action: () => emit("selectItem", item),
			}));
			// Merge: keep existing local results, append items
			const nonItems = results.value.filter((r) => r.type !== "item");
			results.value = [...nonItems, ...itemResults];
		}
	} catch {
		// Keep existing local results on error
	} finally {
		isSearching.value = false;
	}
}

function navigateDown() {
	const total = results.value.length;
	if (total === 0) return;
	highlightedIndex.value = Math.min(highlightedIndex.value + 1, total - 1);
	scrollHighlightedIntoView();
}

function navigateUp() {
	if (results.value.length === 0) return;
	highlightedIndex.value = Math.max(highlightedIndex.value - 1, 0);
	scrollHighlightedIntoView();
}

function scrollHighlightedIntoView() {
	nextTick(() => {
		const el = resultsContainer.value?.querySelector(`[data-command-index="${highlightedIndex.value}"]`);
		el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
	});
}

function selectHighlighted() {
	// Find the item at the current flat index
	for (const group of groupedResults.value) {
		for (const item of group.items) {
			if (item._flatIndex === highlightedIndex.value) {
				executeResult(item);
				return;
			}
		}
	}
}

function executeResult(item: CommandResult) {
	if (item.action) {
		item.action();
	}
	close();
}

function toggle() {
	if (isOpen.value) close();
	else open();
}

onMounted(() => {
	window.addEventListener("xpos:toggle-command-search", toggle);
	if (commandSearchRequested.value) {
		commandSearchRequested.value = false;
		open();
	}
});

onUnmounted(() => {
	window.removeEventListener("xpos:toggle-command-search", toggle);
});

defineExpose({ open, close });
</script>
