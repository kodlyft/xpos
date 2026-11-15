<script setup lang="ts">
import { cn } from "@/lib/utils";
import type { HTMLAttributes } from "vue";
import { cardVariants, type CardVariants } from ".";
const props = defineProps<{
	class?: HTMLAttributes["class"];
	variant?: CardVariants["variant"];
	interactive?: boolean;
}>();

function onKeydown(event: KeyboardEvent) {
	if (event.target !== event.currentTarget) return;
	if (event.key !== "Enter" && event.key !== " ") return;
	event.preventDefault();
	(event.currentTarget as HTMLElement).click();
}
</script>
<template>
	<div
		:class="cn(cardVariants({ variant: interactive ? 'interactive' : variant }), props.class)"
		:role="interactive ? 'button' : undefined"
		:tabindex="interactive ? 0 : undefined"
		@keydown="interactive ? onKeydown($event) : undefined"
	>
		<slot />
	</div>
</template>
