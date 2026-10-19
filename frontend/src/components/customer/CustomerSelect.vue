<template>
	<Dialog
		:open="customerStore.showCustomerDialog"
		@update:open="
			(val: boolean) => {
				if (!val) close();
			}
		"
	>
		<DialogContent
			class="w-[calc(100vw-1.25rem)] max-w-none h-[min(92svh,40rem)] sm:w-[min(92vw,44rem)] sm:h-[min(88svh,44rem)] lg:w-[min(88vw,52rem)] lg:h-[min(86svh,48rem)] flex flex-col overflow-hidden p-0 gap-0"
		>
			<template v-if="!showNewForm">
				<DialogHeader class="shrink-0 px-5 pt-5 pb-3 space-y-3 border-b border-border">
					<div class="flex items-center justify-between">
						<DialogTitle>{{ __("Select Customer") }}</DialogTitle>
					</div>
					<DialogDescription class="sr-only">
						{{ __("Search for a customer or create a new one") }}
					</DialogDescription>

					<div class="relative">
						<Search
							class="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground"
						/>
						<Input
							ref="searchInput"
							v-model="search"
							type="text"
							:placeholder="__('Search by name, phone, email...')"
							class="ps-9"
							@input="debouncedSearch"
							@keydown.down.prevent="moveHighlight(1)"
							@keydown.up.prevent="moveHighlight(-1)"
							@keydown.enter.prevent="selectHighlighted"
						/>
					</div>
				</DialogHeader>

				<div ref="listContainer" class="flex-1 min-h-0 overflow-y-auto xpos-scrollbar">
					<div v-if="customerStore.isLoading" class="min-h-full p-4 space-y-3">
						<div v-for="i in 5" :key="i" class="skeleton h-14 w-full rounded-xl"></div>
					</div>

					<div v-else-if="customerStore.customers.length > 0" class="p-2">
						<button
							v-for="(cust, idx) in customerStore.customers"
							:key="cust.name"
							:ref="
								(el) => {
									if (el) customerRefs[idx] = el as HTMLButtonElement;
								}
							"
							@click="selectCustomer(cust)"
							@mouseenter="highlightedIndex = idx"
							class="w-full flex items-center gap-3 p-3 rounded-xl transition-colors text-start group"
							:class="
								idx === highlightedIndex
									? 'bg-primary/10 dark:bg-primary/20 ring-1 ring-primary/30 border border-primary/40'
									: 'hover:bg-accent border border-transparent'
							"
						>
							<Avatar class="shrink-0">
								<img
									v-if="cust.image"
									:src="cust.image as string"
									:alt="cust.customer_name"
									class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
									loading="lazy"
								/>
								<AvatarFallback v-else class="bg-primary/10 text-primary text-sm font-bold">
									{{ getInitials(cust.customer_name) }}
								</AvatarFallback>
							</Avatar>
							<div class="flex-1 min-w-0">
								<p class="text-sm font-medium text-foreground truncate">
									{{ cust.customer_name }}
								</p>
								<div class="flex items-center gap-2 text-[11px] text-muted-foreground">
									<span v-if="cust.mobile_no">{{ cust.mobile_no }}</span>
									<span v-if="cust.email_id && cust.mobile_no">&bull;</span>
									<span v-if="cust.email_id" class="truncate">{{ cust.email_id }}</span>
								</div>
							</div>
							<ChevronRight
								class="w-4 h-4 text-muted-foreground/40 group-hover:text-primary transition-colors"
							/>
						</button>
					</div>

					<div
						v-else
						class="flex h-full min-h-72 flex-col items-center justify-center text-muted-foreground"
					>
						<Users class="w-12 h-12 mb-3 text-muted-foreground/30" />
						<p class="text-sm font-medium">{{ __("No customers found") }}</p>
					</div>
				</div>

				<div class="shrink-0 border-t border-border px-5 py-4">
					<Button variant="default" class="w-full justify-center gap-2" @click="openNewForm">
						<UserPlus class="w-4 h-4" />
						{{ __("Create New Customer") }}
					</Button>
				</div>
			</template>

			<template v-else>
				<DialogHeader class="shrink-0 px-5 pt-5 pb-3 border-b border-border">
					<div class="flex items-center gap-3">
						<button
							@click="showNewForm = false"
							class="p-1 rounded-md hover:bg-accent transition-colors"
						>
							<ArrowLeft class="w-4 h-4 text-muted-foreground" />
						</button>
						<div>
							<DialogTitle>{{ __("New Customer") }}</DialogTitle>
							<DialogDescription class="text-xs text-muted-foreground mt-0.5">
								{{ __("Fill in customer details") }}
							</DialogDescription>
						</div>
					</div>
				</DialogHeader>

				<div class="flex-1 min-h-0 overflow-y-auto p-5 space-y-4 xpos-scrollbar">
					<div>
						<label class="text-xs font-medium text-muted-foreground mb-1 block"
							>{{ __("Customer Name") }} *</label
						>
						<Input
							ref="customerNameInput"
							v-model="newCustomer.customer_name"
							type="text"
							:placeholder="__('Full name')"
						/>
					</div>

					<div class="grid grid-cols-2 gap-3">
						<div>
							<label class="text-xs font-medium text-muted-foreground mb-1 block">{{
								__("Tax ID")
							}}</label>
							<Input v-model="newCustomer.tax_id" type="text" :placeholder="__('Tax ID')" />
						</div>
						<div>
							<label class="text-xs font-medium text-muted-foreground mb-1 block">{{
								__("Mobile No")
							}}</label>
							<Input
								v-model="newCustomer.mobile_no"
								type="tel"
								:placeholder="__('Mobile No')"
							/>
						</div>
					</div>

					<div class="grid grid-cols-2 gap-3">
						<div>
							<label class="text-xs font-medium text-muted-foreground mb-1 block">{{
								__("Email")
							}}</label>
							<Input v-model="newCustomer.email_id" type="email" :placeholder="__('Email')" />
						</div>
						<div>
							<label class="text-xs font-medium text-muted-foreground mb-1 block">{{
								__("Gender")
							}}</label>
							<Autocomplete
								v-model="newCustomer.gender"
								:options="genderOptions"
								:placeholder="__('Select gender')"
								:show-search-icon="false"
								:max-visible="5"
							/>
						</div>
					</div>

					<div>
						<label class="text-xs font-medium text-muted-foreground mb-1 block">{{
							__("Address")
						}}</label>
						<Input
							v-model="newCustomer.address_line1"
							type="text"
							:placeholder="__('Address line 1')"
						/>
					</div>

					<div class="grid grid-cols-2 gap-3">
						<div>
							<label class="text-xs font-medium text-muted-foreground mb-1 block">{{
								__("City")
							}}</label>
							<Input v-model="newCustomer.city" type="text" :placeholder="__('City')" />
						</div>
						<div>
							<label class="text-xs font-medium text-muted-foreground mb-1 block">{{
								__("Country")
							}}</label>
							<Autocomplete
								v-model="newCustomer.country"
								:options="countryOptions"
								:placeholder="__('Select country')"
								:show-search-icon="true"
								:max-visible="10"
							/>
						</div>
					</div>

					<div class="grid grid-cols-2 gap-3">
						<div>
							<label class="text-xs font-medium text-muted-foreground mb-1 block"
								>{{ __("Customer Group") }} *</label
							>
							<Autocomplete
								v-model="newCustomer.customer_group"
								:options="customerGroupOptions"
								:placeholder="__('Select group')"
								:show-search-icon="false"
								:max-visible="10"
							/>
						</div>
						<div>
							<label class="text-xs font-medium text-muted-foreground mb-1 block"
								>{{ __("Territory") }} *</label
							>
							<Autocomplete
								v-model="newCustomer.territory"
								:options="territoryOptions"
								:placeholder="__('Select territory')"
								:show-search-icon="true"
								:max-visible="10"
							/>
						</div>
					</div>

					<div class="grid grid-cols-2 gap-3">
						<div>
							<label class="text-xs font-medium text-muted-foreground mb-1 block">{{
								__("Referral Code")
							}}</label>
							<Input
								v-model="newCustomer.referral_code"
								type="text"
								:placeholder="__('Referral code')"
							/>
						</div>
						<div>
							<label class="text-xs font-medium text-muted-foreground mb-1 block">{{
								__("Birthday")
							}}</label>
							<DateTimePicker
								v-model="newCustomer.birthday"
								:placeholder="__('Select birthday')"
							/>
						</div>
					</div>
				</div>

				<DialogFooter class="shrink-0 border-t border-border px-5 py-4">
					<Button variant="outline" class="flex-1" @click="showNewForm = false">
						{{ __("Cancel") }}
					</Button>
					<Button
						class="flex-1 font-bold"
						:disabled="!canCreate || isCreating"
						@click="createAndSelect"
					>
						<Loader2 v-if="isCreating" class="w-4 h-4 animate-spin me-1" />
						{{ isCreating ? __("Creating...") : __("Create & Select") }}
					</Button>
				</DialogFooter>
			</template>
		</DialogContent>
	</Dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, nextTick } from "vue";
import { useCartStore } from "@/stores/cartStore";
import { useCustomerStore } from "@/stores/customerStore";
import { usePosStore } from "@/stores/posStore";
import { showSuccess, showError, showInfo, call } from "@/services/api";
import {
	cacheCustomerGroups,
	getCachedCustomerGroups,
	cacheTerritories,
	getCachedTerritories,
	cacheCountries,
	getCachedCountries,
} from "@/services/dbBridge";
import { isOnline } from "@/utils";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Autocomplete } from "@/components/ui/autocomplete";
import type { AutocompleteOption } from "@/components/ui/autocomplete";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Search, ChevronRight, Users, UserPlus, ArrowLeft, Loader2 } from "lucide-vue-next";
import __ from "@/lib/translate";
import DateTimeInput from "../ui/date-time-input/DateTimeInput.vue";
import DateTimePicker from "../ui/datetime-picker/DateTimePicker.vue";

const cartStore = useCartStore();
const customerStore = useCustomerStore();
const posStore = usePosStore();

const searchInput = ref<InstanceType<typeof Input> | null>(null);
const customerNameInput = ref<InstanceType<typeof Input> | null>(null);
const listContainer = ref<HTMLElement | null>(null);
const customerRefs: Record<number, HTMLButtonElement> = {};
const search = ref("");
const showNewForm = ref(false);
const isCreating = ref(false);
const highlightedIndex = ref(-1);
const customerGroups = ref<string[]>([]);
const territories = ref<string[]>([]);
const countries = ref<string[]>([]);

const genderOptions: AutocompleteOption[] = [
	{ label: __("Male"), value: "Male" },
	{ label: __("Female"), value: "Female" },
	{ label: __("Other"), value: "Other" },
	{ label: __("Prefer not to say"), value: "Prefer not to say" },
];

const customerGroupOptions = computed<AutocompleteOption[]>(() =>
	customerGroups.value.map((g) => ({ label: g, value: g })),
);

const territoryOptions = computed<AutocompleteOption[]>(() =>
	territories.value.map((t) => ({ label: t, value: t })),
);

const countryOptions = computed<AutocompleteOption[]>(() =>
	countries.value.map((c) => ({ label: c, value: c })),
);

const defaultNewCustomer = () => ({
	customer_name: "",
	tax_id: "",
	mobile_no: "",
	address_line1: "",
	city: "",
	country: "",
	email_id: "",
	gender: "Male",
	referral_code: "",
	birthday: "",
	customer_group: "Individual",
	territory: "Rest Of The World",
});

const newCustomer = ref(defaultNewCustomer());

const canCreate = computed(
	() =>
		!!newCustomer.value.customer_name.trim() &&
		!!newCustomer.value.customer_group &&
		!!newCustomer.value.territory,
);

let searchTimeout: ReturnType<typeof setTimeout> | null = null;

watch(
	() => customerStore.customers.length,
	() => {
		highlightedIndex.value = customerStore.customers.length > 0 ? 0 : -1;
	},
);

onMounted(() => {
	nextTick(() => {
		const el = searchInput.value?.$el as HTMLElement | undefined;
		const input = el?.querySelector?.("input") || el;
		(input as HTMLInputElement)?.focus();
	});

	loadDropdownData();
});

function loadDropdownData() {
	const boot = window.xpos?.boot;
	if (boot?.countries?.length) {
		countries.value = boot.countries.map((c) => c.name || "").filter(Boolean);
	}
	if (boot?.territories?.length) {
		territories.value = boot.territories.map((t) => t.name || t.territory_name || "").filter(Boolean);
	}

	fetchDropdownOptions();
}

async function fetchDropdownOptions() {
	const [cachedGroups, cachedTerritories, cachedCountries] = await Promise.all([
		getCachedCustomerGroups(),
		getCachedTerritories(),
		getCachedCountries(),
	]);

	if (cachedGroups.length) customerGroups.value = cachedGroups;
	if (!territories.value.length && cachedTerritories.length) territories.value = cachedTerritories;
	if (!countries.value.length && cachedCountries.length) countries.value = cachedCountries;

	if (!isOnline()) {
		if (!customerGroups.value.length) customerGroups.value = ["All Customer Groups"];
		if (!territories.value.length) territories.value = ["All Territories"];
		if (!countries.value.length) countries.value = ["Pakistan"];
		return;
	}

	try {
		const groupsResult = await call<string[]>("xpos.api.customers.get_customer_groups").catch(
			() => [] as string[],
		);
		if (groupsResult?.length) {
			customerGroups.value = groupsResult;
			await cacheCustomerGroups(groupsResult).catch(() => {});
		} else if (!customerGroups.value.length) {
			customerGroups.value = ["All Customer Groups"];
		}

		if (territories.value.length) {
			await cacheTerritories(territories.value).catch(() => {});
		} else {
			territories.value = ["All Territories"];
		}

		if (countries.value.length) {
			await cacheCountries(countries.value).catch(() => {});
		} else {
			countries.value = ["Pakistan"];
		}
	} catch {
		if (!customerGroups.value.length) customerGroups.value = ["All Customer Groups"];
		if (!territories.value.length) territories.value = ["All Territories"];
		if (!countries.value.length) countries.value = ["Pakistan"];
	}
}

function openNewForm() {
	showNewForm.value = true;
	nextTick(() => {
		const el = customerNameInput.value?.$el as HTMLElement | undefined;
		const input = el?.querySelector?.("input") || el;
		(input as HTMLInputElement)?.focus();
	});
}

function debouncedSearch() {
	if (searchTimeout) clearTimeout(searchTimeout);
	highlightedIndex.value = -1;
	searchTimeout = setTimeout(() => {
		customerStore.searchCustomers(search.value);
	}, 300);
}

function moveHighlight(direction: number) {
	const len = customerStore.customers.length;
	if (len === 0) return;

	let newIdx = highlightedIndex.value + direction;
	if (newIdx < 0) newIdx = len - 1;
	if (newIdx >= len) newIdx = 0;
	highlightedIndex.value = newIdx;

	nextTick(() => {
		const btn = customerRefs[newIdx];
		if (btn) {
			btn.scrollIntoView({ block: "nearest", behavior: "smooth" });
		}
	});
}

function selectHighlighted() {
	const idx = highlightedIndex.value;
	if (idx >= 0 && idx < customerStore.customers.length) {
		selectCustomer(customerStore.customers[idx]);
	}
}

function selectCustomer(cust: {
	name: string;
	customer_name?: string;
	image?: string;
	mobile_no?: string;
	email_id?: string;
	customer_group?: string;
	territory?: string;
}) {
	cartStore.setCustomer(cust);
	close();
}

async function createAndSelect() {
	if (!canCreate.value) return;
	isCreating.value = true;

	try {
		const payload: Record<string, unknown> = {
			customer_name: newCustomer.value.customer_name,
			mobile_no: newCustomer.value.mobile_no || undefined,
			email_id: newCustomer.value.email_id || undefined,
			tax_id: newCustomer.value.tax_id || undefined,
			gender: newCustomer.value.gender || undefined,
			referral_code: newCustomer.value.referral_code || undefined,
			birthday: newCustomer.value.birthday || undefined,
			customer_group: newCustomer.value.customer_group || undefined,
			territory: newCustomer.value.territory || undefined,
			address_line1: newCustomer.value.address_line1 || undefined,
			city: newCustomer.value.city || undefined,
			country: newCustomer.value.country || undefined,
			pos_profile: posStore.profileName || undefined,
		};

		Object.keys(payload).forEach((key) => {
			if (payload[key] === undefined) delete payload[key];
		});

		const result = await customerStore.createCustomer(payload);
		cartStore.setCustomer(result);
		const created = result as Record<string, unknown>;
		showSuccess(
			created.referral_code
				? __("Customer created with referral code {0}", [String(created.referral_code)])
				: __("Customer created successfully!"),
		);
		if (created.referral_note) showInfo(String(created.referral_note));
		close();
	} catch (error: unknown) {
		showError(__("Failed to create customer: ") + ((error as Error)?.message || error));
	} finally {
		isCreating.value = false;
	}
}

function getInitials(name: string) {
	if (!name) return "?";
	return name
		.split(" ")
		.slice(0, 2)
		.map((w: string) => w[0])
		.join("")
		.toUpperCase();
}

function close() {
	customerStore.showCustomerDialog = false;
	showNewForm.value = false;
	search.value = "";
	newCustomer.value = defaultNewCustomer();
}
</script>
