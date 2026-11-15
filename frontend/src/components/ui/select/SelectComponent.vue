<script setup lang="ts">
import { ref } from "vue";
import { SelectValue } from "radix-vue";
import Select from "./Select.vue";
import SelectTriggerStyled from "./SelectTriggerStyled.vue";
import SelectItemStyled from "./SelectItemStyled.vue";
import SelectContentStyled from "./SelectContentStyled.vue";

export interface SelectItem {
	label: string;
	value: string;
}

const props = withDefaults(
	defineProps<{
		items: SelectItem[];
		placeholder?: string;
		disabled?: boolean;
		class?: string;
		ariaLabel?: string;
		side?: "top" | "bottom" | "left" | "right";
	}>(),
	{
		placeholder: "Select...",
		disabled: false,
	},
);

const modelValue = defineModel<string | undefined>({ default: "" });
const triggerRef = ref<{ $el?: HTMLElement | null } | null>(null);

function getTriggerEl(): HTMLElement | null {
	return triggerRef.value?.$el ?? null;
}

function focus(): void {
	getTriggerEl()?.focus();
}

defineExpose({ focus, getTriggerEl });
</script>

<template>
	<Select :model-value="modelValue" @update:model-value="modelValue = $event">
		<SelectTriggerStyled
			ref="triggerRef"
			:placeholder="placeholder"
			:disabled="disabled"
			:aria-label="ariaLabel"
			:class="props.class"
		>
			<SelectValue :placeholder="placeholder" />
		</SelectTriggerStyled>
		<SelectContentStyled :placeholder="placeholder" :disabled="disabled" :side="side">
			<SelectItemStyled
				v-for="opt in items.filter((i) => i.value !== '')"
				:key="opt.value"
				:value="opt.value"
			>
				{{ opt.label }}
			</SelectItemStyled>
		</SelectContentStyled>
	</Select>
</template>
