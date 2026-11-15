<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Pencil, Search, UserPlus, UserRound, X } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	createCustomer,
	searchCustomers,
	updateCustomer,
	type CustomerDetail,
	type CustomerSummary,
} from "@mobile/app/customers";
import { formatMinor } from "@mobile/domain/money";
import { getContainer, useApp } from "@mobile/composables/useApp";
import { useCustomer } from "@mobile/composables/useCustomer";
import { toast, toastOn } from "@mobile/composables/useToast";

const open = defineModel<boolean>({ default: false });
const { state } = useApp();
const { customer: sale, name, displayName, isDefault, choose, useDefault, load } = useCustomer();

type Mode = "search" | "form";
const mode = ref<Mode>("search");
const term = ref("");
const results = ref<CustomerSummary[]>([]);
const searching = ref(false);
const busy = ref(false);
const error = ref("");
toastOn(error);
const editing = ref<string | null>(null);
const form = ref({ customerName: "", mobileNo: "", emailId: "", customerGroup: "" });

const digits = computed(() => state.cashier?.minorDigits ?? 2);
const current = computed<CustomerDetail | null>(() => sale.customer);
const canCreate = computed(() => state.context.canCreateCustomer);
const canEdit = computed(() => state.context.canEditCustomer);

let timer: ReturnType<typeof setTimeout> | undefined;
let asked = 0;
async function search() {
	const e = state.cashier;
	if (!e || !state.online) return;
	const mine = ++asked;
	searching.value = true;
	try {
		const api = await getContainer().session(e.site);
		const rows = await searchCustomers(api, e.profile, term.value);
		if (mine === asked) results.value = rows;
	} catch (err) {
		if (mine === asked) error.value = err instanceof Error ? err.message : "The search failed.";
	} finally {
		if (mine === asked) searching.value = false;
	}
}
watch(term, () => {
	clearTimeout(timer);
	timer = setTimeout(search, 250);
});
watch(open, (on) => {
	if (!on) return;
	mode.value = "search";
	term.value = "";
	results.value = [];
	void search();
});

async function pick(c: CustomerSummary) {
	busy.value = true;
	try {
		await choose(c);
		open.value = false;
	} catch (err) {
		error.value = err instanceof Error ? err.message : "The customer could not be loaded.";
	} finally {
		busy.value = false;
	}
}
async function walkIn() {
	await useDefault();
	open.value = false;
}

function startNew() {
	editing.value = null;
	form.value = { customerName: "", mobileNo: "", emailId: "", customerGroup: "" };
	mode.value = "form";
}
async function startEdit() {
	const c = current.value ?? (await load(name.value));
	editing.value = c.name;
	form.value = {
		customerName: c.customerName,
		mobileNo: c.mobileNo ?? "",
		emailId: c.emailId ?? "",
		customerGroup: c.customerGroup,
	};
	mode.value = "form";
}
async function save() {
	const e = state.cashier;
	if (!e || !form.value.customerName.trim()) {
		error.value = "Enter the customer's name.";
		return;
	}
	busy.value = true;
	try {
		const api = await getContainer().session(e.site);
		const detail = editing.value
			? await updateCustomer(
					api,
					e.profile,
					editing.value,
					{
						customerName: form.value.customerName.trim(),
						mobileNo: form.value.mobileNo.trim(),
						emailId: form.value.emailId.trim(),
					},
					e.minorDigits,
				)
			: await createCustomer(
					api,
					e.profile,
					{
						customerName: form.value.customerName.trim(),
						mobileNo: form.value.mobileNo.trim(),
						emailId: form.value.emailId.trim(),
						customerGroup: form.value.customerGroup.trim(),
					},
					e.minorDigits,
				);
		if (editing.value && editing.value === name.value && sale.customer) sale.customer = detail;
		else await choose(detail);
		toast.info(editing.value ? "Customer saved." : `${detail.customerName} is now on this sale.`);
		open.value = false;
	} catch (err) {
		error.value = err instanceof Error ? err.message : "The customer could not be saved.";
	} finally {
		busy.value = false;
	}
}
</script>

<template>
	<div
		v-if="open"
		class="fixed inset-0 z-30 flex flex-col justify-end bg-[hsl(var(--scrim)/0.5)] md:items-center md:justify-center"
		@click.self="open = false"
		@keydown.esc="open = false"
	>
		<div
			class="relative flex max-h-[92%] min-h-[55%] w-full flex-col overflow-hidden rounded-t-2xl border border-border bg-card shadow-overlay md:max-w-lg md:rounded-2xl"
			role="dialog"
			aria-modal="true"
			aria-label="Customer"
		>
			<header class="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-3">
				<h2 class="text-lg font-bold">
					{{ mode === "form" ? (editing ? "Edit customer" : "New customer") : "Customer" }}
				</h2>
				<Button variant="ghost" size="icon" class="size-11" aria-label="Close" @click="open = false"
					><X
				/></Button>
			</header>

			<div v-if="mode === 'search'" class="flex min-h-0 flex-1 flex-col gap-3 px-4 py-3">
				<div class="rounded-xl border border-border bg-surface-raised p-3 text-sm shadow-raised">
					<p class="text-xs uppercase tracking-wide text-muted-foreground">On this sale</p>
					<p class="text-base font-semibold">{{ displayName }}</p>
					<p v-if="isDefault" class="text-xs text-muted-foreground">
						The POS Profile's default customer.
					</p>
					<dl v-else-if="current" class="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
						<dt class="text-muted-foreground">Price list</dt>
						<dd>{{ current.priceList ?? "-" }}</dd>
						<dt v-if="current.discountPct" class="text-muted-foreground">Discount</dt>
						<dd v-if="current.discountPct">{{ current.discountPct }}%</dd>
						<dt class="text-muted-foreground">Balance</dt>
						<dd class="tabular-nums">{{ formatMinor(current.balanceMinor, digits) }}</dd>
						<dt v-if="current.creditLimitMinor" class="text-muted-foreground">Credit limit</dt>
						<dd v-if="current.creditLimitMinor" class="tabular-nums">
							{{ formatMinor(current.creditLimitMinor, digits) }}
						</dd>
						<dt v-if="current.loyaltyProgram" class="text-muted-foreground">Loyalty points</dt>
						<dd v-if="current.loyaltyProgram" class="tabular-nums">
							{{ current.loyaltyPoints }}
						</dd>
					</dl>
					<div class="mt-2 flex flex-wrap gap-2">
						<Button v-if="!isDefault" variant="outline" class="h-11" @click="walkIn"
							><UserRound /> Use the default customer</Button
						>
						<Button v-if="canEdit" variant="outline" class="h-11" @click="startEdit"
							><Pencil /> Edit</Button
						>
					</div>
				</div>

				<div class="relative">
					<Search
						class="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
						aria-hidden="true"
					/>
					<Input
						v-model="term"
						class="h-12 ps-9 text-base"
						inputmode="search"
						placeholder="Search by name or mobile number"
						aria-label="Search customers"
						:disabled="!state.online"
					/>
				</div>
				<p v-if="!state.online" class="text-xs text-muted-foreground" role="status">
					Customers are looked up on the server, so searching needs a connection.
				</p>
				<ul
					class="xpos-scrollbar min-h-0 flex-1 space-y-2 overflow-y-auto"
					aria-label="Customers"
					:aria-busy="searching"
				>
					<li v-for="c in results" :key="c.name">
						<button
							type="button"
							class="flex min-h-14 w-full items-center justify-between gap-3 rounded-xl border border-border bg-surface-raised px-3 py-2 text-start shadow-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus active:shadow-pressed"
							:class="c.name === name ? 'border-primary' : ''"
							:disabled="busy"
							@click="pick(c)"
						>
							<span class="min-w-0">
								<span class="block truncate text-sm font-semibold">{{ c.customerName }}</span>
								<span class="block truncate text-xs text-muted-foreground"
									>{{ c.mobileNo || "No mobile number" }} · {{ c.customerGroup }}</span
								>
							</span>
							<span class="shrink-0 text-end text-xs text-muted-foreground">
								<span class="block">{{ c.priceList ?? "" }}</span>
								<span v-if="c.discountPct" class="block">{{ c.discountPct }}% off</span>
							</span>
						</button>
					</li>
					<li
						v-if="!results.length && !searching && state.online"
						class="py-6 text-center text-sm text-muted-foreground"
					>
						No customers found.
					</li>
				</ul>
				<Button v-if="canCreate" class="h-12 text-base font-semibold" @click="startNew"
					><UserPlus /> New customer</Button
				>
			</div>

			<form v-else class="flex min-h-0 flex-1 flex-col gap-3 px-4 py-3" @submit.prevent="save">
				<label class="space-y-1 text-sm font-medium"
					>Name
					<Input v-model="form.customerName" class="h-11 text-base" autocomplete="off" />
				</label>
				<label class="space-y-1 text-sm font-medium"
					>Mobile number
					<Input
						v-model="form.mobileNo"
						class="h-11 text-base"
						inputmode="tel"
						autocomplete="off"
					/>
				</label>
				<label class="space-y-1 text-sm font-medium"
					>Email
					<Input
						v-model="form.emailId"
						class="h-11 text-base"
						inputmode="email"
						autocomplete="off"
					/>
				</label>
				<label v-if="!editing" class="space-y-1 text-sm font-medium"
					>Customer group (optional)
					<Input v-model="form.customerGroup" class="h-11 text-base" autocomplete="off" />
				</label>
				<p v-else class="text-xs text-muted-foreground">
					The customer group and discount are changed in ERPNext, not on the phone.
				</p>
				<div class="mt-auto flex gap-2">
					<Button type="button" variant="outline" class="h-12 flex-1" @click="mode = 'search'"
						>Back</Button
					>
					<Button type="submit" class="h-12 flex-2 text-base font-semibold" :loading="busy"
						>Save</Button
					>
				</div>
			</form>
		</div>
	</div>
</template>
