<template>
	<div class="h-full min-h-0 flex flex-col bg-background text-foreground">
		<div class="flex items-center justify-between px-4 py-3 border-b border-border">
			<div>
				<h1 class="text-lg font-semibold">{{ __("Role Permissions") }}</h1>
				<p class="text-xs text-muted-foreground">
					{{ __("Configure which POS actions each role may perform.") }}
				</p>
			</div>
			<Button size="sm" variant="outline" :disabled="isLoading" @click="load">
				<RefreshCw class="w-4 h-4 me-1" :class="{ 'animate-spin': isLoading }" />
				{{ __("Refresh") }}
			</Button>
		</div>

		<div
			v-if="error"
			class="m-4 p-3 rounded border border-destructive/40 bg-destructive/10 text-sm text-destructive"
		>
			{{ error }}
		</div>

		<div
			v-else-if="!isLoading && roles.length === 0"
			class="flex-1 flex items-center justify-center text-sm text-muted-foreground"
		>
			{{ __("No POS roles found. Create a POS Role first.") }}
		</div>

		<template v-else>
			<div class="flex items-center gap-3 px-4 py-3 border-b border-border bg-muted/40">
				<span class="text-sm font-medium whitespace-nowrap">
					{{ __("Role") }}
				</span>
				<Autocomplete
					v-model="selectedRole"
					:options="roleOptions"
					:placeholder="__('Select a role')"
					:disabled="isLoading"
					:clearable="false"
					empty-text="No POS roles found"
					class="w-64"
				/>
				<span v-if="selectedRole" class="text-xs text-muted-foreground">
					{{ enabledCount }} {{ __("of") }} {{ totalCount }} {{ __("permissions enabled") }}
				</span>
			</div>

			<div v-if="selectedRole" class="flex-1 min-h-0 overflow-auto p-4 space-y-6">
				<section v-for="group in PERMISSION_GROUPS" :key="group.title">
					<h2 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
						{{ __(group.title) }}
					</h2>
					<ul class="rounded border border-border divide-y divide-border/60">
						<li
							v-for="item in group.items"
							:key="item.key"
							class="flex items-center justify-between gap-4 px-3 py-2.5 hover:bg-muted/50"
						>
							<label :for="`perm-${item.key}`" class="text-sm cursor-pointer select-none">
								{{ __(item.label) }}
							</label>
							<input
								:id="`perm-${item.key}`"
								type="checkbox"
								class="w-4 h-4 accent-primary cursor-pointer disabled:cursor-wait disabled:opacity-50"
								:checked="isEnabled(selectedRole, item.key)"
								:disabled="isSaving(selectedRole, item.key)"
								@change="onToggle(selectedRole, item.key, $event)"
							/>
						</li>
					</ul>
				</section>
			</div>

			<div v-else class="flex-1 flex items-center justify-center text-sm text-muted-foreground">
				{{ __("Select a role to view its permissions.") }}
			</div>
		</template>
	</div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { RefreshCw } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Autocomplete } from "@/components/ui/autocomplete";
import { call } from "@/services/api";
import { showError, showSuccess } from "@/composables/useToast";
import __ from "@/lib/translate";

interface Role {
	name: string;
	role_name: string;
}

interface PermissionMatrix {
	roles: Role[];
	permissions: { name: string; label: string; group: string }[];
	matrix: Record<string, Record<string, boolean>>;
}

const PERMISSION_GROUPS: { title: string; items: { key: string; label: string }[] }[] = [
	{
		title: "Billing & Invoicing",
		items: [
			{ key: "close_shift", label: "Close Shift" },
			{ key: "allow_reprint_invoice", label: "Reprint Invoice" },
			{ key: "print_draft_invoice", label: "Print Draft Invoice" },
			{ key: "shift_report", label: "Shift Report" },
			{ key: "view_expected_amount", label: "View Expected Amount" },
			{ key: "resolve_fiscal_check", label: "Resolve FBR Check" },
		],
	},
	{
		title: "Discounts & Pricing",
		items: [
			{ key: "apply_additional_discount", label: "Apply Additional Discount" },
			{ key: "show_edit_discount_field", label: "Edit Discount Field" },
			{ key: "allow_change_price", label: "Change Price" },
		],
	},
	{
		title: "Sales Operations",
		items: [
			{ key: "sale_return", label: "Sale Return" },
			{ key: "sell_gift_card", label: "Sell Gift Card" },
			{ key: "redeem_gift_card", label: "Accept Gift Card Payment" },
		],
	},
	{
		title: "Cash Management",
		items: [
			{ key: "expense", label: "Expense" },
			{ key: "bank_drop", label: "Bank Drop" },
		],
	},
	{
		title: "Reports",
		items: [
			{ key: "current_stock_by_brand", label: "Current Stock by Brand" },
			{ key: "current_stock_report", label: "Current Stock Report" },
		],
	},
	{
		title: "Administration",
		items: [{ key: "manage_role_permissions", label: "Manage Role Permissions" }],
	},
];

const roles = ref<Role[]>([]);
const matrix = ref<Record<string, Record<string, boolean>>>({});
const saving = ref<Record<string, boolean>>({});
const isLoading = ref(false);
const error = ref("");
const selectedRole = ref("");

const roleOptions = computed(() => roles.value.map((role) => ({ label: role.role_name, value: role.name })));

const totalCount = computed(() => PERMISSION_GROUPS.reduce((sum, group) => sum + group.items.length, 0));

const enabledCount = computed(() => {
	const perms = matrix.value[selectedRole.value] ?? {};
	return Object.values(perms).filter(Boolean).length;
});

function rowKey(role: string, item: string): string {
	return `${role}::${item}`;
}

function isEnabled(role: string, item: string): boolean {
	return Boolean(matrix.value[role]?.[item]);
}

function isSaving(role: string, item: string): boolean {
	return Boolean(saving.value[rowKey(role, item)]);
}

async function load(): Promise<void> {
	isLoading.value = true;
	error.value = "";
	try {
		const res = await call<PermissionMatrix>("xpos.api.auth.get_role_permission_matrix");
		roles.value = res.roles ?? [];
		matrix.value = res.matrix ?? {};
		if (!roles.value.some((role) => role.name === selectedRole.value)) {
			selectedRole.value = roles.value[0]?.name ?? "";
		}
	} catch (err) {
		error.value = err instanceof Error ? err.message : String(err);
	} finally {
		isLoading.value = false;
	}
}

async function onToggle(role: string, item: string, event: Event): Promise<void> {
	const checked = (event.target as HTMLInputElement).checked;
	const key = rowKey(role, item);
	saving.value = { ...saving.value, [key]: true };
	try {
		await call("xpos.api.auth.set_role_permission", {
			role,
			permission: item,
			enabled: checked ? 1 : 0,
		});
		if (!matrix.value[role]) matrix.value[role] = {};
		matrix.value[role][item] = checked;
		showSuccess(__("Permission updated"));
	} catch (err) {
		showError(err instanceof Error ? err.message : __("Failed to update permission"));
		await load();
	} finally {
		const next = { ...saving.value };
		delete next[key];
		saving.value = next;
	}
}

onMounted(load);
</script>
