<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { usePurchaseStore } from "@/stores/purchaseStore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import __ from "@/lib/translate";

const props = defineProps<{
	open: boolean;
	initialName?: string;
}>();

const emit = defineEmits<{
	"update:open": [value: boolean];
	created: [];
}>();

const purchaseStore = usePurchaseStore();

const newSupplier = ref({
	supplier_name: "",
	supplier_type: "Company",
	mobile_no: "",
	email_id: "",
	tax_id: "",
});
const isCreating = ref(false);

const dialogOpen = computed({
	get: () => props.open,
	set: (val) => emit("update:open", val),
});

watch(
	() => props.open,
	(val) => {
		if (val) {
			newSupplier.value = {
				supplier_name: props.initialName || "",
				supplier_type: "Company",
				mobile_no: "",
				email_id: "",
				tax_id: "",
			};
		}
	},
);

async function handleCreate(): Promise<void> {
	if (!newSupplier.value.supplier_name.trim()) return;
	isCreating.value = true;
	try {
		await purchaseStore.createSupplier(newSupplier.value);
		emit("created");
		dialogOpen.value = false;
	} finally {
		isCreating.value = false;
	}
}
</script>

<template>
	<Dialog v-model:open="dialogOpen">
		<DialogContent class="max-w-md">
			<DialogHeader>
				<DialogTitle>{{ __("Create New Supplier") }}</DialogTitle>
				<DialogDescription>{{ __("Add a new supplier") }}</DialogDescription>
			</DialogHeader>
			<form @submit.prevent="handleCreate" class="space-y-4 mt-4">
				<div>
					<label class="text-sm font-medium mb-1 block">{{ __("Supplier Name") }} *</label>
					<Input v-model="newSupplier.supplier_name" required />
				</div>
				<div class="grid grid-cols-2 gap-4">
					<div>
						<label class="text-sm font-medium mb-1 block">{{ __("Type") }}</label>
						<Select
							v-model="newSupplier.supplier_type"
							:items="[
								{ label: __('Company'), value: 'Company' },
								{ label: __('Individual'), value: 'Individual' },
							]"
						/>
					</div>
					<div>
						<label class="text-sm font-medium mb-1 block">{{ __("Tax ID") }}</label>
						<Input v-model="newSupplier.tax_id" />
					</div>
				</div>
				<div>
					<label class="text-sm font-medium mb-1 block">{{ __("Mobile") }}</label>
					<Input v-model="newSupplier.mobile_no" />
				</div>
				<div>
					<label class="text-sm font-medium mb-1 block">{{ __("Email") }}</label>
					<Input v-model="newSupplier.email_id" type="email" />
				</div>
				<div class="flex justify-end gap-2 pt-4">
					<Button type="button" variant="outline" @click="dialogOpen = false">
						{{ __("Cancel") }}
					</Button>
					<Button type="submit" :disabled="isCreating || !newSupplier.supplier_name.trim()">
						{{ isCreating ? __("Creating...") : __("Create") }}
					</Button>
				</div>
			</form>
		</DialogContent>
	</Dialog>
</template>
