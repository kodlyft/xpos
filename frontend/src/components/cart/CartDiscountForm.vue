<template>
	<div class="space-y-3">
		<p class="text-sm font-semibold">{{ __("Additional Discount") }}</p>
		<div class="flex items-center gap-2">
			<div class="inline-flex shrink-0 gap-1 rounded-xl border border-border bg-surface-sunken p-1">
				<Button
					:variant="type === 'percentage' ? 'default' : 'ghost'"
					size="sm"
					class="px-3"
					:aria-pressed="type === 'percentage'"
					@click="type = 'percentage'"
				>
					%
				</Button>
				<Button
					:variant="type === 'amount' ? 'default' : 'ghost'"
					size="sm"
					class="px-3"
					:aria-pressed="type === 'amount'"
					@click="type = 'amount'"
				>
					{{ symbol }}
				</Button>
			</div>
			<NumberInput
				ref="inputRef"
				v-model="value"
				:min="0"
				:max="type === 'percentage' ? 100 : undefined"
				:precision="precision"
				class="flex-1"
				:placeholder="type === 'percentage' ? __('Discount %') : __('Discount amount')"
				@change="$emit('apply')"
				@keydown.enter="$emit('done')"
			/>
		</div>
	</div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { Button } from "@/components/ui/button";
import { NumberInput } from "@/components/ui/number-input";
import __ from "@/lib/translate";

defineProps<{ symbol: string; precision: number }>();
defineEmits<{ (e: "apply"): void; (e: "done"): void }>();

const type = defineModel<string>("type", { required: true });
const value = defineModel<number>("value", { required: true });
const inputRef = ref<InstanceType<typeof NumberInput> | null>(null);

defineExpose({ focus: () => inputRef.value?.focus() });
</script>
