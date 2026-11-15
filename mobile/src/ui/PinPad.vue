<script setup lang="ts">
import { Delete } from "@lucide/vue";
import { computed } from "vue";
import { Button } from "@/components/ui/button";

const props = defineProps<{ length?: number; disabled?: boolean; label: string }>();
const model = defineModel<string>({ default: "" });
const emit = defineEmits<{ complete: [pin: string] }>();
const len = computed(() => props.length ?? 6);

function press(d: string) {
	if (props.disabled || model.value.length >= len.value) return;
	const next = model.value + d; // defineModel updates after the parent re-renders; don't re-read it here
	model.value = next;
	if (next.length === len.value) emit("complete", next);
}
function back() {
	model.value = model.value.slice(0, -1);
}
</script>

<template>
	<div>
		<div
			class="mb-4 flex justify-center gap-3"
			role="img"
			:aria-label="`${label}: ${model.length} of ${len} digits entered`"
		>
			<span
				v-for="i in len"
				:key="i"
				class="size-3.5 rounded-full border border-input shadow-inset"
				:class="i <= model.length ? 'border-primary bg-primary' : 'bg-card'"
			/>
		</div>
		<div class="mx-auto grid max-w-xs grid-cols-3 gap-3">
			<Button
				v-for="d in ['1', '2', '3', '4', '5', '6', '7', '8', '9']"
				:key="d"
				variant="outline"
				class="h-14 rounded-xl text-xl font-semibold"
				:disabled="disabled"
				@click="press(d)"
				>{{ d }}</Button
			>
			<span />
			<Button
				variant="outline"
				class="h-14 rounded-xl text-xl font-semibold"
				:disabled="disabled"
				@click="press('0')"
				>0</Button
			>
			<Button
				variant="outline"
				class="h-14 rounded-xl"
				aria-label="Delete last digit"
				:disabled="disabled"
				@click="back"
				><Delete class="size-5!" aria-hidden="true"
			/></Button>
		</div>
	</div>
</template>
